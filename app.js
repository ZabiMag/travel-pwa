(function(){
  "use strict";

  const STORAGE_KEY = "slady-podrozy:status:v1";
  // 50m = wyższa rozdzielczość granic niż 110m i zawiera mikropaństwa (Andora, Monako,
  // Watykan, San Marino, Liechtenstein), których nie ma w danych 110m.
  const WORLD_DATA_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json";
  const RUSSIA_ID = "643";

  // Blokada zoomu CAŁEGO interfejsu. touch-action w CSS chroni tylko przed gestami
  // dotykowymi — przybliżanie touchpadem (i Ctrl+scroll) przeglądarka wysyła jako
  // zwykłe zdarzenie "wheel" z ctrlKey=true, więc trzeba je łapać osobno. Mapa ma
  // własny zoom (d3-zoom), który sam robi preventDefault na swoim elemencie, więc
  // to nie koliduje z przybliżaniem mapy.
  document.addEventListener("wheel", (e)=>{
    if(e.ctrlKey) e.preventDefault();
  }, { passive: false });
  // Safari (WebKit) na trackpadzie/gestach dotykowych wysyła osobne zdarzenia gesture*.
  document.addEventListener("gesturestart", (e)=> e.preventDefault());
  document.addEventListener("gesturechange", (e)=> e.preventDefault());

  /** @type {Record<string,'visited'|'planned'>} */
  let statusMap = loadStatus();
  let countries = []; // {id, name, nameEn, feature}
  let activeCountryId = null;
  let currentFilter = "all";
  let searchTerm = "";

  // Dane mapy (topojson) używają ID krajów jako 3-cyfrowych stringów z zerami
  // wiodącymi (np. "004" dla Afganistanu), podczas gdy słowniki nazw/powierzchni
  // używają ID bez zer wiodących ("4"). Normalizujemy wszędzie do tej drugiej formy.
  function normId(id){
    return String(Number(id));
  }

  // Zabezpieczenie przed błędem "cała mapa się zamalowuje" (d3-geo/geoPath z
  // klipowaniem antymerydianu potrafi odczytać źle nawinięty kontur jako
  // dopełnienie sfery i narysować gigantyczny dodatkowy kształt) — może się
  // zdarzyć przy sklejaniu kilku osobnych źródłowych poligonów w jeden MultiPolygon.
  // UWAGA: ten stos (geoNaturalEarth1 + preclip antymerydianu) chce zewnętrzne
  // kontury ZGODNIE z ruchem wskazówek zegara (ujemne pole ze wzoru Gaussa/
  // shoelace) — to ODWROTNOŚĆ standardu GeoJSON RFC 7946 (CCW), ale empirycznie
  // tak są nawinięte już działające dane (Naddniestrze) i tego wymaga to
  // konkretne renderowanie; zweryfikowane na błędzie, który dawało poprawne
  // (wg RFC) nawinięcie CCW. Dane w occupied-territories.js są już poprawione
  // u źródła, to tylko tania druga linia obrony na wypadek przyszłych dodatków.
  function ringSignedArea(ring){
    let sum = 0;
    for(let i = 0; i < ring.length - 1; i++){
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
      sum += x1 * y2 - x2 * y1;
    }
    return sum / 2;
  }
  function rewindRing(ring, wantsPositive){
    return (ringSignedArea(ring) > 0) === wantsPositive ? ring : ring.slice().reverse();
  }
  function rewindPolygonCoords(coords){
    return coords.map((ring, i) => rewindRing(ring, i !== 0)); // zewnętrzny (i=0) chce CW = NIE dodatni
  }
  function rewindGeoJson(featureCollection){
    featureCollection.features.forEach(f=>{
      const g = f.geometry;
      if(g.type === "Polygon") g.coordinates = rewindPolygonCoords(g.coordinates);
      else if(g.type === "MultiPolygon") g.coordinates = g.coordinates.map(rewindPolygonCoords);
    });
    return featureCollection;
  }
  rewindGeoJson(OCCUPIED_TERRITORIES);

  function slugify(name){
    const s = (name || "unknown").toString()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    return s || "unknown";
  }

  // Kilka jednostek w danych mapy (Kosowo, Cypr Północny, Somaliland) nie ma
  // przypisanego kodu ISO numeric (id = null), więc wszystkie normalizowałyby się
  // do tego samego id i byłyby traktowane jak jeden kraj. Nadajemy im tu stabilne,
  // unikalne identyfikatory oparte na nazwie i zapamiętujemy je na obiekcie feature.
  function assignFeatureIds(features){
    const used = new Set();
    features.forEach(f=>{
      const raw = f.id;
      let id = (raw === null || raw === undefined || raw === "") ? null : normId(raw);
      if(id === null || used.has(id)){
        const base = "x-" + slugify(f.properties && f.properties.name);
        id = base;
        let n = 2;
        while(used.has(id)){ id = base + "-" + n; n++; }
      }
      used.add(id);
      f.__id = id;
    });
  }

  function loadStatus(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const normalized = {};
      Object.keys(parsed).forEach(k => { normalized[normId(k)] = parsed[k]; });
      return normalized;
    }catch(e){ return {}; }
  }
  function saveStatus(){
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(statusMap)); }catch(e){}
  }

  function countryName(id, fallbackEn){
    return COUNTRY_NAMES_PL[id] || fallbackEn || "Nieznany kraj";
  }

  // ---------- STATS ----------
  function updateStats(){
    let visited = 0, lived = 0, planned = 0;
    Object.entries(statusMap).forEach(([id, s])=>{
      if(s === "visited") visited++;
      else if(s === "lived") lived++;
      else if(s === "planned") planned++;
    });
    document.getElementById("stat-visited").textContent = visited;
    document.getElementById("stat-lived").textContent = lived;
    document.getElementById("stat-planned").textContent = planned;
    document.getElementById("stat-percent").textContent = worldAreaPercent() + "%";
  }

  // % świata liczony wg powierzchni krajów (odwiedzone + mieszkane), nie ich liczby.
  function worldAreaPercent(){
    let coveredArea = 0, totalArea = 0;
    const source = countries.length ? countries.map(c => c.id) : Object.keys(COUNTRY_AREAS);
    source.forEach(id=>{
      const area = COUNTRY_AREAS[id] || 0;
      totalArea += area;
      const s = statusMap[id];
      if(s === "visited" || s === "lived") coveredArea += area;
    });
    if(!totalArea) return 0;
    return Math.round((coveredArea/totalArea)*1000)/10;
  }

  // ---------- MAP ----------
  let svg, gMap, gOccupied, gMicroMarkers, projection, pathGen, zoomBehavior;
  let microMarkerCandidates = [];
  const MICRO_MARKER_AREA_KM2 = 5000; // kraje mniejsze niż to są kandydatami na "kółeczko"
  const BASE_WIDTH = 960, BASE_HEIGHT = 500;
  const BASE_SCALE = 155;
  const BASE_TRANSLATE = [BASE_WIDTH / 2, BASE_HEIGHT / 2];
  const MAX_ZOOM = 60;

  // Jednostki, które nie są realnymi krajami do odwiedzenia (rysowane na mapie,
  // ale pomijane na liście/w statystykach) — Antarktyda oraz kilka niezamieszkanych
  // spornych terenów obecnych w danych 50m.
  const EXCLUDED_FROM_LIST = new Set([
    "10", "x-indian-ocean-ter", "x-siachen-glacier", "x-ashmore-and-cartier-is", "248"
  ]);

  // Dane bazowej mapy przypisują Krym do kształtu Rosji (de facto kontrola).
  // Krym jest jednak de iure częścią Ukrainy, więc klikanie w niego oraz statystyki
  // (odwiedzone/powierzchnia) powinny dotyczyć Ukrainy — okupacja jest pokazywana
  // wyłącznie jako osobna, zakreskowana nakładka (patrz updateOccupiedTerritories).
  // Tu wycinamy z MultiPolygon Rosji część(-ci) geometrii leżącą w obrębie Krymu
  // i doklejamy ją do MultiPolygon Ukrainy.
  const UKRAINE_ID = "804";
  const CRIMEA_BBOX = { minLon: 32.2, maxLon: 36.8, minLat: 43.9, maxLat: 46.4 };
  function relocateCrimeaToUkraine(features){
    const russia = features.find(f => normId(f.id) === RUSSIA_ID);
    const ukraine = features.find(f => normId(f.id) === UKRAINE_ID);
    if(!russia || !ukraine) return;

    const asMultiPolygon = (geom) => geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    const ringInsideBbox = (ring) => ring.every(([lon, lat]) =>
      lon >= CRIMEA_BBOX.minLon && lon <= CRIMEA_BBOX.maxLon &&
      lat >= CRIMEA_BBOX.minLat && lat <= CRIMEA_BBOX.maxLat
    );

    const russiaPolys = asMultiPolygon(russia.geometry);
    const kept = [], moved = [];
    russiaPolys.forEach(poly => {
      (ringInsideBbox(poly[0]) ? moved : kept).push(poly);
    });
    if(moved.length === 0) return;

    russia.geometry = { type: "MultiPolygon", coordinates: kept };
    ukraine.geometry = { type: "MultiPolygon", coordinates: asMultiPolygon(ukraine.geometry).concat(moved) };
  }

  // Terytoria bez własnego statusu, których wygląd/klikalność ma w pełni należeć
  // do kraju-rodzica (Kosowo -> Serbia, Cypr Płn. -> Cypr, Somaliland -> Somalia,
  // Sahara Zachodnia -> Maroko) — doklejamy ich geometrię do wielokąta rodzica
  // (ta sama technika co relocateCrimeaToUkraine, tylko całe terytorium naraz, nie
  // wycinek wg bbox) i wykluczamy z osobnego renderowania/listy. Wizualne
  // zakreskowanie tych terenów pokazuje osobna, nieinteraktywna warstwa
  // (occupied-territories.js + gOccupied), niezależnie od tego scalenia.
  const MERGE_INTO_PARENT = [
    ["x-kosovo", "688"],      // Kosowo -> Serbia
    ["x-n-cyprus", "196"],    // Cypr Płn. -> Cypr
    ["x-somaliland", "706"],  // Somaliland -> Somalia
    ["732", "504"]            // Sahara Zachodnia -> Maroko
  ];
  const MERGED_INTO_PARENT = new Set(MERGE_INTO_PARENT.map(([childId]) => childId));
  function mergeChildIntoParent(features, childId, parentId){
    const asMultiPolygon = (geom) => geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    const child = features.find(f => f.__id === childId);
    const parent = features.find(f => f.__id === parentId);
    if(!child || !parent) return;
    parent.geometry = {
      type: "MultiPolygon",
      coordinates: asMultiPolygon(parent.geometry).concat(asMultiPolygon(child.geometry))
    };
  }

  function initMap(worldTopo){
    const svgEl = document.getElementById("map-svg");
    svg = d3.select(svgEl);
    projection = d3.geoNaturalEarth1().scale(BASE_SCALE).translate(BASE_TRANSLATE.slice());
    pathGen = d3.geoPath(projection);

    const featureCollection = topojson.feature(worldTopo, worldTopo.objects.countries);
    relocateCrimeaToUkraine(featureCollection.features);
    assignFeatureIds(featureCollection.features);
    MERGE_INTO_PARENT.forEach(([childId, parentId]) => mergeChildIntoParent(featureCollection.features, childId, parentId));

    // Po scaleniu renderujemy/liczymy tylko to, co nie zostało wchłonięte przez rodzica.
    const renderableFeatures = featureCollection.features.filter(f => !MERGED_INTO_PARENT.has(f.__id));

    countries = renderableFeatures
      .filter(f => !EXCLUDED_FROM_LIST.has(f.__id))
      .map(f => ({
        id: f.__id,
        nameEn: f.properties && f.properties.name,
        name: countryName(f.__id, f.properties && f.properties.name),
        feature: f
      }));

    gMap = svg.append("g").attr("class", "countries-layer");

    gMap.selectAll("path.country")
      .data(renderableFeatures)
      .join("path")
      .attr("class", d => "country" + statusClass(d.__id))
      .attr("d", pathGen)
      .attr("data-id", d => d.__id)
      .on("click", (event, d) => {
        event.stopPropagation();
        openSheet(d.__id);
      });

    // Warstwa terytoriów spornych/okupowanych/samozwańczych — bez własnego statusu,
    // tylko wizualnie odziedziczony po parentId lub (dla Krymu/Donbasu/Abchazji/
    // Osetii Płd.) priorytetowo po Rosji jako faktycznym okupancie — patrz
    // updateOccupiedTerritories(). Klik przechodzi do kraju pod spodem — de iure
    // rodzica (pointer-events:none), więc nie zmienia sposobu oznaczania.
    gOccupied = gMap.append("g").attr("class", "occupied-layer");
    const occupiedPaths = gOccupied.selectAll("path.occupied")
      .data(OCCUPIED_TERRITORIES.features)
      .join("path")
      .attr("class", "occupied")
      .attr("d", pathGen);
    occupiedPaths.append("title").text(d => d.properties.name);
    updateOccupiedTerritories();

    // Kółeczka zastępcze dla mikropaństw/wysp, które są za małe, by je zobaczyć albo
    // trafić w nie palcem (Watykan, Monako, Św. Łucja...). Widoczne tylko dopóki
    // realny kształt kraju jest za mały na ekranie — gdy przybliżenie już go pokazuje,
    // kropka znika (patrz updateMicroMarkers). Gdy widoczna, ma stały rozmiar na ekranie.
    gMicroMarkers = gMap.append("g").attr("class", "micro-markers-layer");
    microMarkerCandidates = countries.filter(c => {
      const area = COUNTRY_AREAS[c.id];
      return area != null && area < MICRO_MARKER_AREA_KM2 && c.feature;
    });
    updateMicroMarkers(1);

    zoomBehavior = d3.zoom()
      .scaleExtent([1, MAX_ZOOM])
      .on("zoom", (event) => {
        gMap.attr("transform", event.transform);
        updateMicroMarkers(event.transform.k);
      })
      .on("end", (event) => bakeZoomTransform(event.transform));
    svg.call(zoomBehavior);

    document.getElementById("load-status").style.display = "none";
    updateStats();
    renderList();

    setTimeout(()=>{ document.getElementById("map-hint").style.opacity = "0"; }, 3500);
  }

  // Podczas aktywnego gestu zoom/pan mapa jedzie na szybkiej ścieżce — transform
  // SVG na grupie krajów (gMap), bez przeliczania ~250 ścieżek na klatkę. Problem:
  // Chrome renderuje wtedy przeskalowaną bitmapę zamiast wektora, więc po
  // zatrzymaniu gestu mapa potrafi zostać rozmyta. Naprawiamy to "wypalając"
  // finalny transform bezpośrednio w projekcji d3 na koniec gestu (.on("end", ...))
  // i przerysowując wszystkie ścieżki na nowo natywnie z d3.geoPath — w spoczynku
  // nic nie jest wtedy skalowaną bitmapą, więc nie ma czego rozmywać.
  function bakeZoomTransform(transform){
    const { x, y, k } = transform;
    if(k === 1 && x === 0 && y === 0) return; // identyczność = już wypalone (chroni przed rekursją niżej)

    const newScale = projection.scale() * k;
    const newTranslate = transform.apply(projection.translate());
    projection.scale(newScale).translate(newTranslate);

    gMap.attr("transform", null);
    gMap.selectAll("path.country").attr("d", pathGen);
    gOccupied.selectAll("path.occupied").attr("d", pathGen);
    updateMicroMarkers(1);

    zoomBehavior.scaleExtent([BASE_SCALE / newScale, (BASE_SCALE * MAX_ZOOM) / newScale]);
    zoomBehavior.transform(svg, d3.zoomIdentity); // resetuje śledzenie d3-zoom do bazy (chwyta guard wyżej)
  }

  // Promień w lokalnych jednostkach = stała / k, więc po przemnożeniu przez transform
  // grupy (scale(k)) na ekranie kółeczko zawsze ma ten sam rozmiar (MICRO_MARKER_R px).
  const MICRO_MARKER_R = 3.2;
  // Kropka znika, gdy oba wymiary realnego kształtu przekroczą to (px na ekranie) —
  // czyli kraj jest już wystarczająco widoczny sam z siebie.
  const MICRO_MARKER_VISIBLE_PX = 10;
  function updateMicroMarkers(k){
    if(!gMicroMarkers) return;
    const visible = microMarkerCandidates.filter(c=>{
      const b = pathGen.bounds(c.feature);
      const w = (b[1][0] - b[0][0]) * k;
      const h = (b[1][1] - b[0][1]) * k;
      return w < MICRO_MARKER_VISIBLE_PX || h < MICRO_MARKER_VISIBLE_PX;
    });
    const r = MICRO_MARKER_R / k;
    const markers = gMicroMarkers.selectAll("circle.micro-marker")
      .data(visible, d => d.id)
      .join(enter =>
        enter.append("circle")
          .attr("data-id", d => d.id)
          .on("click", (event, d) => { event.stopPropagation(); openSheet(d.id); })
          .call(sel => sel.append("title").text(d => d.name))
      );
    markers
      .attr("class", d => "micro-marker" + statusClass(d.id))
      .attr("r", r)
      .attr("cx", d => pathGen.centroid(d.feature)[0])
      .attr("cy", d => pathGen.centroid(d.feature)[1]);
  }

  function statusClass(id){
    const s = statusMap[id];
    if(s === "visited") return " status-visited";
    if(s === "lived") return " status-lived";
    if(s === "planned") return " status-planned";
    return "";
  }

  function refreshMapColors(){
    if(!gMap) return;
    gMap.selectAll("path.country")
      .attr("class", d => "country" + statusClass(d.__id));
    if(gMicroMarkers){
      gMicroMarkers.selectAll("circle.micro-marker")
        .attr("class", d => "micro-marker" + statusClass(d.id));
    }
    updateOccupiedTerritories();
  }

  // Terytoria okupowane/sporne nie mają własnego statusu — dziedziczą wizualnie
  // po de iure właścicielu (parentId), pokazując JEGO kolor (bo tak jest już
  // pomalowany jako część jego kształtu — patrz mergeChildIntoParent/
  // relocateCrimeaToUkraine) przekreślony szarymi paskami. Tylko kilka cech
  // (Krym+Donbas, Abchazja, Osetia Płd. — te z jawnym "occupierId") ma
  // DODATKOWO faktycznego okupanta z pierwszeństwem: jeśli on ma status,
  // pokazuje się JEGO kolor w paskach (jak dotąd), bo to on faktycznie
  // kontroluje teren. Reszta (Kosowo, Cypr Płn., Naddniestrze, Somaliland,
  // Sahara Zachodnia) ma tylko parentId, bez takiego drugiego poziomu.
  function updateOccupiedTerritories(){
    if(!gOccupied) return;
    gOccupied.selectAll("path.occupied").attr("fill", d => {
      const occupierStatus = d.properties.occupierId ? statusMap[d.properties.occupierId] : null;
      if(occupierStatus) return `url(#hatch-${occupierStatus})`;
      const parentStatus = statusMap[d.properties.parentId];
      return parentStatus ? "url(#hatch-inverse)" : "none";
    });
  }

  document.getElementById("zoom-in").addEventListener("click", ()=>{
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 1.5);
  });
  document.getElementById("zoom-out").addEventListener("click", ()=>{
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 0.67);
  });
  document.getElementById("zoom-reset").addEventListener("click", ()=>{
    svg.transition().duration(300).call(zoomBehavior.transform, zoomTransformToReach(BASE_SCALE, BASE_TRANSLATE));
  });

  // Transform potrzebny, by z AKTUALNEGO stanu projekcji dotrzeć do zadanej
  // skali/przesunięcia — np. do stanu bazowego dla przycisku resetu zoomu.
  // Trzeba liczyć na żywo (nie da się użyć samego d3.zoomIdentity), bo po
  // "wypaleniu" zoomu (patrz bakeZoomTransform) tożsamość d3-zoom oznacza
  // "zostań tam, gdzie jesteś", a nie "wróć do początku".
  function zoomTransformToReach(targetScale, targetTranslate){
    const k = targetScale / projection.scale();
    const cur = projection.translate();
    return d3.zoomIdentity
      .translate(targetTranslate[0] - k * cur[0], targetTranslate[1] - k * cur[1])
      .scale(k);
  }

  // Przybliżenie mapy do konkretnego kraju (przycisk "lupka" na liście).
  function zoomToCountry(id){
    const c = countries.find(c => c.id === id);
    if(!c || !c.feature || !pathGen) return;
    switchToView("map-view");
    const [[x0, y0], [x1, y1]] = pathGen.bounds(c.feature);
    const dx = Math.max(x1 - x0, 0.01), dy = Math.max(y1 - y0, 0.01);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    // dx/dy/cx/cy są liczone względem AKTUALNEJ (być może już przybliżonej)
    // projekcji, więc "scale" tu to współczynnik WZGLĘDEM bieżącego stanu —
    // legalnie może wyjść < 1 (zoom OUT), np. gdy poprzednio byliśmy mocno
    // przybliżeni do małego kraju, a teraz celujemy w duży. Nie wolno tego
    // sztywno podbijać do minimum 1 (to właśnie psuło ten przypadek) ani
    // ręcznie ograniczać górnej granicy — o to dba już scaleExtent zoomBehavior,
    // przeliczany na bieżąco po każdym "wypaleniu" zoomu (patrz bakeZoomTransform).
    const scale = 0.7 / Math.max(dx / BASE_WIDTH, dy / BASE_HEIGHT);
    const translate = [BASE_WIDTH / 2 - scale * cx, BASE_HEIGHT / 2 - scale * cy];
    svg.transition().duration(700).call(
      zoomBehavior.transform,
      d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
    );
  }

  // ---------- BOTTOM SHEET ----------
  const sheet = document.getElementById("sheet");
  const backdrop = document.getElementById("sheet-backdrop");

  function openSheet(id){
    activeCountryId = id;
    const c = countries.find(c => c.id === id);
    const name = c ? c.name : (COUNTRY_NAMES_PL[id] || "Kraj");
    const nameEn = c ? c.nameEn : "";
    document.getElementById("sheet-country").textContent = name;
    document.getElementById("sheet-region").textContent = (nameEn && nameEn !== name) ? nameEn : "";
    syncSheetButtons();
    sheet.classList.add("show");
    backdrop.classList.add("show");
  }
  function closeSheet(){
    sheet.classList.remove("show");
    backdrop.classList.remove("show");
    activeCountryId = null;
  }
  function syncSheetButtons(){
    const s = statusMap[activeCountryId];
    document.getElementById("btn-visited").className = "status-btn" + (s === "visited" ? " active-visited" : "");
    document.getElementById("btn-lived").className = "status-btn" + (s === "lived" ? " active-lived" : "");
    document.getElementById("btn-planned").className = "status-btn" + (s === "planned" ? " active-planned" : "");
  }
  async function setStatus(id, status){
    const prevStatus = statusMap[id];
    if(prevStatus === "visited" && status !== "visited"){
      const relatedTrips = trips.filter(t => t.countryIds.includes(id));
      if(relatedTrips.length > 0){
        const name = COUNTRY_NAMES_PL[id] || id;
        const question = relatedTrips.length === 1
          ? `${name} występuje w zapisanej podróży. Odznaczenie "Odwiedzone" usunie też tę podróż (razem ze zdjęciami). Kontynuować?`
          : `${name} występuje w ${relatedTrips.length} zapisanych podróżach. Odznaczenie "Odwiedzone" usunie też te podróże (razem ze zdjęciami). Kontynuować?`;
        if(!confirm(question)) return;
        await deleteTripsForCountryUnmark(relatedTrips);
      }
    }
    if(status === null){ delete statusMap[id]; }
    else { statusMap[id] = status; }
    saveStatus();
    refreshMapColors();
    updateStats();
    renderList();
    if(id === activeCountryId) syncSheetButtons();
  }

  backdrop.addEventListener("click", closeSheet);
  document.getElementById("btn-visited").addEventListener("click", ()=>{
    const cur = statusMap[activeCountryId];
    setStatus(activeCountryId, cur === "visited" ? null : "visited");
  });
  document.getElementById("btn-lived").addEventListener("click", ()=>{
    const cur = statusMap[activeCountryId];
    setStatus(activeCountryId, cur === "lived" ? null : "lived");
  });
  document.getElementById("btn-planned").addEventListener("click", ()=>{
    const cur = statusMap[activeCountryId];
    setStatus(activeCountryId, cur === "planned" ? null : "planned");
  });
  document.getElementById("btn-clear").addEventListener("click", ()=>{
    setStatus(activeCountryId, null);
  });

  // ---------- LIST VIEW ----------
  const listEl = document.getElementById("country-list");

  function renderList(){
    let items = countries.slice().sort((a,b)=> a.name.localeCompare(b.name, "pl"));
    if(searchTerm){
      const t = searchTerm.toLowerCase();
      items = items.filter(c => c.name.toLowerCase().includes(t) || (c.nameEn||"").toLowerCase().includes(t));
    }
    if(currentFilter !== "all"){
      items = items.filter(c => {
        const s = statusMap[c.id];
        if(currentFilter === "none") return !s;
        return s === currentFilter;
      });
    }

    if(items.length === 0){
      listEl.innerHTML = `<div class="empty-state">Brak krajów pasujących do wyszukiwania.</div>`;
      return;
    }

    listEl.innerHTML = items.map(c => {
      const s = statusMap[c.id];
      return `
        <div class="country-row" data-id="${c.id}">
          <div class="name">${escapeHtml(c.name)}</div>
          <div class="row-buttons">
            <button class="row-btn row-btn-zoom" data-action="zoom" title="Pokaż na mapie" aria-label="Pokaż na mapie">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7"></circle>
                <line x1="21" y1="21" x2="16.2" y2="16.2"></line>
              </svg>
            </button>
            <button class="row-btn ${s==='visited'?'on-visited':''}" data-action="visited" title="Odwiedzone">✓</button>
            <button class="row-btn ${s==='lived'?'on-lived':''}" data-action="lived" title="Mieszkane">⌂</button>
            <button class="row-btn ${s==='planned'?'on-planned':''}" data-action="planned" title="Planowane">☆</button>
          </div>
        </div>`;
    }).join("");
  }

  function escapeHtml(str){
    return str.replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
  }

  listEl.addEventListener("click", (e)=>{
    const btn = e.target.closest(".row-btn");
    if(!btn) return;
    const row = e.target.closest(".country-row");
    const id = row.getAttribute("data-id");
    const action = btn.getAttribute("data-action");
    if(action === "zoom"){ zoomToCountry(id); return; }
    const cur = statusMap[id];
    setStatus(id, cur === action ? null : action);
  });

  document.getElementById("search-input").addEventListener("input", (e)=>{
    searchTerm = e.target.value.trim();
    renderList();
  });

  document.querySelectorAll(".chip").forEach(chip=>{
    chip.addEventListener("click", ()=>{
      document.querySelectorAll(".chip").forEach(c=>c.classList.remove("active"));
      chip.classList.add("active");
      currentFilter = chip.getAttribute("data-filter");
      renderList();
    });
  });

  // ---------- TABS ----------
  function switchToView(viewId){
    document.querySelectorAll(".tab-btn").forEach(b=>b.classList.toggle("active", b.getAttribute("data-view") === viewId));
    document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active", v.id === viewId));
  }
  document.querySelectorAll(".tab-btn").forEach(btn=>{
    btn.addEventListener("click", ()=> switchToView(btn.getAttribute("data-view")));
  });

  // ---------- PODRÓŻE (trips) ----------
  const TRIPS_DB_NAME = "slady-podrozy-db";
  const TRIPS_DB_VERSION = 1;
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
  const MAX_PHOTOS_PER_TRIP = 20;
  const MAX_PHOTOS_PER_ACCOUNT = 150;
  const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

  let trips = [];
  let totalPhotoCount = 0;
  let tripCountrySelected = [];
  let tripCountrySearch = "";
  let tripRating = 0;
  let pendingPhotos = []; // {tempId, file, url, size, type} -- nowe, jeszcze niezapisane
  let existingPhotos = []; // {id, blob, url, size, type, markedForDelete} -- już w bazie (tryb edycji)
  let editingTripId = null; // id edytowanej podróży, null = dodawanie nowej
  let activeDetailTripId = null;
  let coverObjectUrls = [];
  let detailObjectUrls = [];

  const ALL_TRIP_COUNTRIES = Object.keys(COUNTRY_NAMES_PL)
    .filter(id => id !== "10")
    .map(id => ({ id, name: COUNTRY_NAMES_PL[id] }))
    .sort((a, b) => a.name.localeCompare(b.name, "pl"));

  function cryptoRandomId(){
    if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  let tripsDbPromise = null;
  function getTripsDB(){
    if(!tripsDbPromise){
      tripsDbPromise = new Promise((resolve, reject)=>{
        const req = indexedDB.open(TRIPS_DB_NAME, TRIPS_DB_VERSION);
        req.onupgradeneeded = (e)=>{
          const db = e.target.result;
          if(!db.objectStoreNames.contains("trips")){
            db.createObjectStore("trips", { keyPath: "id" });
          }
          if(!db.objectStoreNames.contains("photos")){
            const store = db.createObjectStore("photos", { keyPath: "id" });
            store.createIndex("tripId", "tripId", { unique: false });
          }
        };
        req.onsuccess = ()=> resolve(req.result);
        req.onerror = ()=> reject(req.error);
      });
    }
    return tripsDbPromise;
  }
  function idbRequest(req){
    return new Promise((resolve, reject)=>{
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> reject(req.error);
    });
  }
  function txDone(tx){
    return new Promise((resolve, reject)=>{
      tx.oncomplete = ()=> resolve();
      tx.onerror = ()=> reject(tx.error);
      tx.onabort = ()=> reject(tx.error);
    });
  }
  async function dbGetAllTrips(){
    const db = await getTripsDB();
    return idbRequest(db.transaction("trips", "readonly").objectStore("trips").getAll());
  }
  async function dbPutTrip(trip){
    const db = await getTripsDB();
    const tx = db.transaction("trips", "readwrite");
    tx.objectStore("trips").put(trip);
    return txDone(tx);
  }
  async function dbPutPhoto(photo){
    const db = await getTripsDB();
    const tx = db.transaction("photos", "readwrite");
    tx.objectStore("photos").put(photo);
    return txDone(tx);
  }
  async function dbGetPhotosForTrip(tripId){
    const db = await getTripsDB();
    const idx = db.transaction("photos", "readonly").objectStore("photos").index("tripId");
    return idbRequest(idx.getAll(IDBKeyRange.only(tripId)));
  }
  async function dbDeleteTrip(tripId){
    const photos = await dbGetPhotosForTrip(tripId);
    const db = await getTripsDB();
    const tx = db.transaction(["trips", "photos"], "readwrite");
    tx.objectStore("trips").delete(tripId);
    const photoStore = tx.objectStore("photos");
    photos.forEach(p => photoStore.delete(p.id));
    await txDone(tx);
    return photos.length;
  }
  async function dbCountPhotos(){
    const db = await getTripsDB();
    return idbRequest(db.transaction("photos", "readonly").objectStore("photos").count());
  }
  async function dbDeletePhoto(photoId){
    const db = await getTripsDB();
    const tx = db.transaction("photos", "readwrite");
    tx.objectStore("photos").delete(photoId);
    return txDone(tx);
  }

  // Wywoływane z setStatus, gdy użytkownik odznacza "Odwiedzone" dla kraju, który
  // ma zapisane podróże — po potwierdzeniu usuwa te podróże w całości (razem ze
  // zdjęciami), także jeśli obejmowały dodatkowo inne kraje.
  async function deleteTripsForCountryUnmark(relatedTrips){
    for(const trip of relatedTrips){
      try{
        const removedCount = await dbDeleteTrip(trip.id);
        totalPhotoCount = Math.max(0, totalPhotoCount - removedCount);
      }catch(err){
        console.error(err);
      }
    }
    const removedIds = new Set(relatedTrips.map(t => t.id));
    trips = trips.filter(t => !removedIds.has(t.id));
    await renderTripsList();
  }

  // ---- formularz: wybór krajów ----
  function renderTripCountryOptions(){
    const box = document.getElementById("trip-country-options");
    const term = tripCountrySearch.trim().toLowerCase();
    let items = ALL_TRIP_COUNTRIES;
    if(term) items = items.filter(c => c.name.toLowerCase().includes(term));
    if(items.length === 0){
      box.innerHTML = `<div class="trip-country-option">Brak wyników</div>`;
      return;
    }
    box.innerHTML = items.map(c=>{
      const sel = tripCountrySelected.includes(c.id);
      return `<div class="trip-country-option${sel ? ' selected' : ''}" data-id="${c.id}">${escapeHtml(c.name)}${sel ? ' ✓' : ''}</div>`;
    }).join("");
  }
  function renderTripCountryChips(){
    const box = document.getElementById("trip-country-selected");
    box.innerHTML = tripCountrySelected.map(id=>{
      const name = COUNTRY_NAMES_PL[id] || id;
      return `<div class="trip-country-chip" data-id="${id}">${escapeHtml(name)}<span class="x">✕</span></div>`;
    }).join("");
  }
  document.getElementById("trip-country-options").addEventListener("click", (e)=>{
    const opt = e.target.closest(".trip-country-option");
    if(!opt || !opt.getAttribute("data-id")) return;
    const id = opt.getAttribute("data-id");
    const idx = tripCountrySelected.indexOf(id);
    if(idx === -1) tripCountrySelected.push(id); else tripCountrySelected.splice(idx, 1);
    renderTripCountryChips();
    renderTripCountryOptions();
  });
  document.getElementById("trip-country-selected").addEventListener("click", (e)=>{
    const chip = e.target.closest(".trip-country-chip");
    if(!chip) return;
    const id = chip.getAttribute("data-id");
    tripCountrySelected = tripCountrySelected.filter(x => x !== id);
    renderTripCountryChips();
    renderTripCountryOptions();
  });
  document.getElementById("trip-country-search").addEventListener("input", (e)=>{
    tripCountrySearch = e.target.value;
    renderTripCountryOptions();
  });

  // ---- formularz: ocena gwiazdkowa ----
  function renderStars(){
    document.querySelectorAll("#trip-rating .star-btn").forEach(b=>{
      b.classList.toggle("on", Number(b.getAttribute("data-star")) <= tripRating);
    });
  }
  document.getElementById("trip-rating").addEventListener("click", (e)=>{
    const btn = e.target.closest(".star-btn");
    if(!btn) return;
    const val = Number(btn.getAttribute("data-star"));
    tripRating = (tripRating === val) ? 0 : val;
    renderStars();
  });

  // ---- formularz: zdjęcia (walidacja typu, rozmiaru i limitów) ----
  // Łączy dwa źródła: zdjęcia już zapisane w bazie (existingPhotos, tryb edycji —
  // usunięcie tylko oznacza je do skasowania przy zapisie) i nowo wybrane, jeszcze
  // niezapisane pliki (pendingPhotos).
  function currentPhotoCount(){
    return existingPhotos.filter(p => !p.markedForDelete).length + pendingPhotos.length;
  }
  function renderPendingPhotos(){
    document.getElementById("trip-photo-count").textContent = currentPhotoCount();
    const existingHtml = existingPhotos.filter(p => !p.markedForDelete).map(p => `
      <div class="trip-photo-thumb">
        <img src="${p.url}" alt="">
        <button type="button" class="remove" data-existing-id="${p.id}">✕</button>
      </div>`).join("");
    const pendingHtml = pendingPhotos.map(p => `
      <div class="trip-photo-thumb">
        <img src="${p.url}" alt="">
        <button type="button" class="remove" data-temp-id="${p.tempId}">✕</button>
      </div>`).join("");
    document.getElementById("trip-photo-grid").innerHTML = existingHtml + pendingHtml;
  }
  async function handleNewPhotoFiles(files){
    const messages = [];
    for(const file of files){
      if(currentPhotoCount() >= MAX_PHOTOS_PER_TRIP){
        messages.push(`Limit ${MAX_PHOTOS_PER_TRIP} zdjęć na podróż osiągnięty.`);
        break;
      }
      if(totalPhotoCount + pendingPhotos.length >= MAX_PHOTOS_PER_ACCOUNT){
        messages.push(`Limit ${MAX_PHOTOS_PER_ACCOUNT} zdjęć na koncie osiągnięty.`);
        break;
      }
      if(!ALLOWED_PHOTO_TYPES.includes(file.type)){
        messages.push(`${file.name}: dozwolone są tylko zdjęcia (JPG, PNG, WEBP, GIF).`);
        continue;
      }
      if(file.size > MAX_PHOTO_BYTES){
        messages.push(`${file.name}: plik za duży (max 5 MB).`);
        continue;
      }
      pendingPhotos.push({ tempId: cryptoRandomId(), file, url: URL.createObjectURL(file), size: file.size, type: file.type });
    }
    renderPendingPhotos();
    const note = document.getElementById("trip-quota-note");
    note.textContent = messages.join(" ");
    note.classList.toggle("warn", messages.length > 0);
  }
  document.getElementById("btn-add-photos").addEventListener("click", ()=>{
    document.getElementById("trip-photo-input").click();
  });
  document.getElementById("trip-photo-input").addEventListener("change", (e)=>{
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    handleNewPhotoFiles(files);
  });
  document.getElementById("trip-photo-grid").addEventListener("click", (e)=>{
    const btn = e.target.closest(".remove");
    if(!btn) return;
    const tempId = btn.getAttribute("data-temp-id");
    const existingId = btn.getAttribute("data-existing-id");
    if(tempId){
      const p = pendingPhotos.find(x => x.tempId === tempId);
      if(p) URL.revokeObjectURL(p.url);
      pendingPhotos = pendingPhotos.filter(x => x.tempId !== tempId);
    }else if(existingId){
      const p = existingPhotos.find(x => x.id === existingId);
      if(p) p.markedForDelete = true;
    }
    renderPendingPhotos();
  });

  // ---- formularz: otwieranie / zamykanie ----
  const tripSheet = document.getElementById("trip-sheet");
  const tripSheetBackdrop = document.getElementById("trip-sheet-backdrop");

  // Bez argumentu = dodawanie nowej podróży; z id istniejącej podróży = edycja
  // (formularz wypełnia się jej danymi, łącznie z już zapisanymi zdjęciami).
  async function openTripSheet(editId){
    editingTripId = editId || null;
    const trip = editingTripId ? trips.find(t => t.id === editingTripId) : null;

    tripCountrySelected = trip ? trip.countryIds.slice() : [];
    tripCountrySearch = "";
    tripRating = trip ? (trip.rating || 0) : 0;
    pendingPhotos.forEach(p => URL.revokeObjectURL(p.url));
    pendingPhotos = [];
    existingPhotos.forEach(p => URL.revokeObjectURL(p.url));
    existingPhotos = [];

    document.getElementById("trip-sheet-title").textContent = trip ? "Edytuj podróż" : "Nowa podróż";
    document.getElementById("btn-save-trip").textContent = trip ? "Zapisz zmiany" : "Zapisz podróż";
    document.getElementById("trip-country-search").value = "";
    document.getElementById("trip-start-date").value = trip ? (trip.startDate || "") : "";
    document.getElementById("trip-end-date").value = trip ? (trip.endDate || "") : "";
    document.getElementById("trip-note").value = trip ? (trip.note || "") : "";
    document.getElementById("trip-quota-note").textContent = "";
    document.getElementById("trip-quota-note").classList.remove("warn");
    renderTripCountryChips();
    renderTripCountryOptions();
    renderStars();

    if(trip){
      try{
        const photos = await dbGetPhotosForTrip(trip.id);
        existingPhotos = photos.map(p => ({
          id: p.id, blob: p.blob, url: URL.createObjectURL(p.blob),
          size: p.size, type: p.type, markedForDelete: false
        }));
      }catch(err){ console.error(err); }
    }
    renderPendingPhotos();

    tripSheet.classList.add("show");
    tripSheetBackdrop.classList.add("show");
  }
  function closeTripSheet(){
    tripSheet.classList.remove("show");
    tripSheetBackdrop.classList.remove("show");
    existingPhotos.forEach(p => URL.revokeObjectURL(p.url));
    existingPhotos = [];
    editingTripId = null;
  }
  document.getElementById("btn-add-trip").addEventListener("click", ()=> openTripSheet());
  document.getElementById("btn-cancel-trip").addEventListener("click", closeTripSheet);
  tripSheetBackdrop.addEventListener("click", closeTripSheet);

  // Dodanie podróży do danego kraju oznacza go jako Odwiedzone (chyba że jest już Mieszkane).
  function markCountriesVisited(countryIds){
    let changed = false;
    countryIds.forEach(id=>{
      if(statusMap[id] !== "lived" && statusMap[id] !== "visited"){
        statusMap[id] = "visited";
        changed = true;
      }
    });
    if(!changed) return;
    saveStatus();
    refreshMapColors();
    updateStats();
    renderList();
    if(activeCountryId && countryIds.includes(activeCountryId)) syncSheetButtons();
  }

  // Wywoływane po usunięciu podróży (lub usunięciu kraju z edytowanej podróży),
  // gdy dany kraj nie jest już objęty żadną inną zapisaną podróżą — pyta, czy
  // zdjąć mu status Odwiedzone.
  async function handleRemovedTripCountries(removedCountryIds){
    if(!removedCountryIds || removedCountryIds.length === 0) return;
    const stillCovered = new Set();
    trips.forEach(t => t.countryIds.forEach(id => stillCovered.add(id)));
    const orphaned = removedCountryIds.filter(id => !stillCovered.has(id) && statusMap[id] === "visited");
    if(orphaned.length === 0) return;
    const names = orphaned.map(id => COUNTRY_NAMES_PL[id] || id).join(", ");
    const question = orphaned.length === 1
      ? `Usunąć też ${names} z listy Odwiedzone?`
      : `Usunąć też te kraje z listy Odwiedzone?\n${names}`;
    if(confirm(question)){
      orphaned.forEach(id => delete statusMap[id]);
      saveStatus();
      refreshMapColors();
      updateStats();
      renderList();
    }
  }

  document.getElementById("btn-save-trip").addEventListener("click", async ()=>{
    if(tripCountrySelected.length === 0){
      alert("Wybierz przynajmniej jeden kraj.");
      return;
    }
    const startDate = document.getElementById("trip-start-date").value;
    const endDate = document.getElementById("trip-end-date").value;
    if(startDate && endDate && endDate < startDate){
      alert("Data końca nie może być wcześniejsza niż data początku.");
      return;
    }
    const isEdit = !!editingTripId;
    const saveBtn = document.getElementById("btn-save-trip");
    saveBtn.disabled = true;
    saveBtn.textContent = "Zapisywanie…";
    try{
      const original = isEdit ? trips.find(t => t.id === editingTripId) : null;
      const tripId = isEdit ? editingTripId : cryptoRandomId();
      const trip = {
        id: tripId,
        countryIds: tripCountrySelected.slice(),
        startDate: startDate || null,
        endDate: endDate || null,
        rating: tripRating,
        note: document.getElementById("trip-note").value.trim(),
        createdAt: isEdit && original ? original.createdAt : Date.now()
      };
      await dbPutTrip(trip);

      for(const p of existingPhotos){
        if(!p.markedForDelete) continue;
        try{
          await dbDeletePhoto(p.id);
          totalPhotoCount = Math.max(0, totalPhotoCount - 1);
        }catch(err){ console.error(err); }
      }
      for(const p of pendingPhotos){
        await dbPutPhoto({ id: cryptoRandomId(), tripId, blob: p.file, type: p.type, size: p.size, createdAt: Date.now() });
        totalPhotoCount++;
      }
      pendingPhotos.forEach(p => URL.revokeObjectURL(p.url));
      pendingPhotos = [];
      existingPhotos.forEach(p => URL.revokeObjectURL(p.url));
      existingPhotos = [];

      if(isEdit){
        trips = trips.map(t => t.id === tripId ? trip : t);
      }else{
        trips.push(trip);
      }

      const prevCountryIds = original ? original.countryIds : [];
      markCountriesVisited(trip.countryIds.filter(id => !prevCountryIds.includes(id)));
      await renderTripsList();
      closeTripSheet();
      if(isEdit){
        await handleRemovedTripCountries(prevCountryIds.filter(id => !trip.countryIds.includes(id)));
      }
    }catch(err){
      console.error(err);
      alert("Nie udało się zapisać podróży. Spróbuj ponownie.");
    }finally{
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? "Zapisz zmiany" : "Zapisz podróż";
    }
  });

  // ---- lista podróży ----
  function tripCountriesLabel(trip){
    return trip.countryIds.map(id => COUNTRY_NAMES_PL[id] || id).join(", ");
  }
  function formatTripDates(trip){
    const fmt = (d)=> new Date(d + "T00:00:00").toLocaleDateString("pl-PL", { day: "numeric", month: "short", year: "numeric" });
    if(trip.startDate && trip.endDate) return `${fmt(trip.startDate)} – ${fmt(trip.endDate)}`;
    if(trip.startDate || trip.endDate) return fmt(trip.startDate || trip.endDate);
    return "Brak dat";
  }
  function starsLabel(rating){
    if(!rating) return "";
    return "★".repeat(rating) + "☆".repeat(5 - rating);
  }
  function revokeCoverUrls(){
    coverObjectUrls.forEach(u => URL.revokeObjectURL(u));
    coverObjectUrls = [];
  }
  async function renderTripsList(){
    const listEl = document.getElementById("trips-list");
    revokeCoverUrls();
    if(trips.length === 0){
      listEl.innerHTML = `<div class="empty-state">Brak zapisanych podróży.<br>Dodaj swoją pierwszą podróż!<br><button type="button" class="hint-btn" id="empty-add-trip">+ Dodaj podróż</button></div>`;
      const btn = document.getElementById("empty-add-trip");
      if(btn) btn.addEventListener("click", ()=> openTripSheet());
      return;
    }
    const sorted = trips.slice().sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
    const cards = await Promise.all(sorted.map(async trip=>{
      const photos = await dbGetPhotosForTrip(trip.id);
      const cover = photos[0];
      let coverStyle = "";
      if(cover){
        const url = URL.createObjectURL(cover.blob);
        coverObjectUrls.push(url);
        coverStyle = ` style="background-image:url('${url}')"`;
      }
      return `
        <div class="trip-card">
          <button type="button" class="trip-card-main" data-id="${trip.id}" data-action="open">
            <div class="trip-card-photo"${coverStyle}>${cover ? '' : '✈'}</div>
            <div class="trip-card-body">
              <div class="trip-card-countries">${escapeHtml(tripCountriesLabel(trip))}</div>
              <div class="trip-card-dates">${formatTripDates(trip)}</div>
              <div class="trip-card-rating">${starsLabel(trip.rating)}</div>
            </div>
          </button>
          <div class="trip-card-actions">
            <button type="button" class="trip-card-icon-btn" data-id="${trip.id}" data-action="edit" title="Edytuj">✎</button>
            <button type="button" class="trip-card-icon-btn delete" data-id="${trip.id}" data-action="delete" title="Usuń">🗑</button>
          </div>
        </div>`;
    }));
    listEl.innerHTML = cards.join("");
  }
  document.getElementById("trips-list").addEventListener("click", (e)=>{
    const btn = e.target.closest("[data-action]");
    if(!btn) return;
    const id = btn.getAttribute("data-id");
    const action = btn.getAttribute("data-action");
    if(action === "open") openTripDetail(id);
    else if(action === "edit") openTripSheet(id);
    else if(action === "delete") deleteTrip(id);
  });

  // ---- szczegóły podróży ----
  const tripDetailSheet = document.getElementById("trip-detail-sheet");
  const tripDetailBackdrop = document.getElementById("trip-detail-backdrop");

  function revokeDetailUrls(){
    detailObjectUrls.forEach(u => URL.revokeObjectURL(u));
    detailObjectUrls = [];
  }
  async function openTripDetail(tripId){
    const trip = trips.find(t => t.id === tripId);
    if(!trip) return;
    activeDetailTripId = tripId;
    document.getElementById("detail-countries").textContent = tripCountriesLabel(trip);
    document.getElementById("detail-dates").textContent = formatTripDates(trip);
    document.getElementById("detail-rating").textContent = trip.rating ? starsLabel(trip.rating) : "Brak oceny";
    const noteEl = document.getElementById("detail-note");
    noteEl.textContent = trip.note || "";
    noteEl.style.display = trip.note ? "block" : "none";
    revokeDetailUrls();
    const photos = await dbGetPhotosForTrip(tripId);
    document.getElementById("detail-photos").innerHTML = photos.map(p=>{
      const url = URL.createObjectURL(p.blob);
      detailObjectUrls.push(url);
      return `<img src="${url}" alt="">`;
    }).join("");
    tripDetailSheet.classList.add("show");
    tripDetailBackdrop.classList.add("show");
  }
  function closeTripDetail(){
    tripDetailSheet.classList.remove("show");
    tripDetailBackdrop.classList.remove("show");
    activeDetailTripId = null;
  }
  tripDetailBackdrop.addEventListener("click", closeTripDetail);
  document.getElementById("detail-photos").addEventListener("click", (e)=>{
    const img = e.target.closest("img");
    if(!img) return;
    openLightbox(img.getAttribute("src"));
  });
  // Usuwanie podróży — wywoływane z ikony kosza na liście (nie ma go już w podglądzie).
  async function deleteTrip(tripId){
    const trip = trips.find(t => t.id === tripId);
    if(!trip) return;
    if(!confirm("Usunąć tę podróż wraz ze zdjęciami?")) return;
    try{
      const removedCount = await dbDeleteTrip(tripId);
      totalPhotoCount = Math.max(0, totalPhotoCount - removedCount);
      trips = trips.filter(t => t.id !== tripId);
      if(activeDetailTripId === tripId) closeTripDetail();
      await renderTripsList();
      await handleRemovedTripCountries(trip.countryIds);
    }catch(err){
      console.error(err);
      alert("Nie udało się usunąć podróży.");
    }
  }

  // ---- lightbox ----
  const lightbox = document.getElementById("lightbox");
  function openLightbox(url){
    document.getElementById("lightbox-img").src = url;
    lightbox.classList.add("show");
  }
  function closeLightbox(){
    lightbox.classList.remove("show");
    document.getElementById("lightbox-img").src = "";
  }
  document.getElementById("lightbox-close").addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e)=>{ if(e.target === lightbox) closeLightbox(); });

  async function initTrips(){
    try{
      trips = await dbGetAllTrips();
      totalPhotoCount = await dbCountPhotos();
      await renderTripsList();
    }catch(err){
      console.error("Nie udało się wczytać podróży", err);
      document.getElementById("trips-list").innerHTML = `<div class="empty-state">Nie udało się wczytać zapisanych podróży.<br>Twoja przeglądarka może nie wspierać zapisu lokalnego (IndexedDB).</div>`;
    }
  }
  initTrips();

  // ---------- BOOT ----------
  fetch(WORLD_DATA_URL)
    .then(r => r.json())
    .then(worldTopo => initMap(worldTopo))
    .catch(err => {
      document.getElementById("load-status").innerHTML =
        "Nie udało się wczytać mapy.<br>Sprawdź połączenie z internetem i odśwież.";
      console.error(err);
    });

  // Service worker registration
  if("serviceWorker" in navigator){
    window.addEventListener("load", ()=>{
      navigator.serviceWorker.register("sw.js").catch(()=>{});
    });
  }
})();
