(function(){
  "use strict";

  const STORAGE_KEY = "slady-podrozy:status:v1";
  const WORLD_DATA_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

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
  let svg, gMap, projection, pathGen, zoomBehavior;

  function initMap(worldTopo){
    const svgEl = document.getElementById("map-svg");
    svg = d3.select(svgEl);
    const width = 960, height = 500;
    projection = d3.geoNaturalEarth1().scale(155).translate([width/2, height/2]);
    pathGen = d3.geoPath(projection);

    const featureCollection = topojson.feature(worldTopo, worldTopo.objects.countries);
    countries = featureCollection.features
      .filter(f => normId(f.id) !== "10") // pomijamy Antarktydę na liście/mapie głównej interakcji, ale rysujemy szaro
      .map(f => ({
        id: normId(f.id),
        nameEn: f.properties && f.properties.name,
        name: countryName(normId(f.id), f.properties && f.properties.name),
        feature: f
      }));

    gMap = svg.append("g").attr("class", "countries-layer");

    gMap.selectAll("path.country")
      .data(featureCollection.features)
      .join("path")
      .attr("class", d => "country" + statusClass(normId(d.id)))
      .attr("d", pathGen)
      .attr("data-id", d => normId(d.id))
      .on("click", (event, d) => {
        event.stopPropagation();
        openSheet(normId(d.id));
      });

    zoomBehavior = d3.zoom()
      .scaleExtent([1, 8])
      .on("zoom", (event) => {
        gMap.attr("transform", event.transform);
      });
    svg.call(zoomBehavior);

    document.getElementById("load-status").style.display = "none";
    updateStats();
    renderList();

    setTimeout(()=>{ document.getElementById("map-hint").style.opacity = "0"; }, 3500);
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
      .attr("class", d => "country" + statusClass(normId(d.id)));
  }

  document.getElementById("zoom-in").addEventListener("click", ()=>{
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 1.5);
  });
  document.getElementById("zoom-out").addEventListener("click", ()=>{
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 0.67);
  });
  document.getElementById("zoom-reset").addEventListener("click", ()=>{
    svg.transition().duration(300).call(zoomBehavior.transform, d3.zoomIdentity);
  });

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
  function setStatus(id, status){
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
  document.querySelectorAll(".tab-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      const viewId = btn.getAttribute("data-view");
      document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
      document.getElementById(viewId).classList.add("active");
    });
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
  let pendingPhotos = []; // {tempId, file, url, size, type}
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
  function renderPendingPhotos(){
    document.getElementById("trip-photo-count").textContent = pendingPhotos.length;
    document.getElementById("trip-photo-grid").innerHTML = pendingPhotos.map(p => `
      <div class="trip-photo-thumb">
        <img src="${p.url}" alt="">
        <button type="button" class="remove" data-temp-id="${p.tempId}">✕</button>
      </div>`).join("");
  }
  async function handleNewPhotoFiles(files){
    const messages = [];
    for(const file of files){
      if(pendingPhotos.length >= MAX_PHOTOS_PER_TRIP){
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
    const id = btn.getAttribute("data-temp-id");
    const p = pendingPhotos.find(x => x.tempId === id);
    if(p) URL.revokeObjectURL(p.url);
    pendingPhotos = pendingPhotos.filter(x => x.tempId !== id);
    renderPendingPhotos();
  });

  // ---- formularz: otwieranie / zamykanie ----
  const tripSheet = document.getElementById("trip-sheet");
  const tripSheetBackdrop = document.getElementById("trip-sheet-backdrop");

  function openTripSheet(){
    tripCountrySelected = [];
    tripCountrySearch = "";
    tripRating = 0;
    pendingPhotos.forEach(p => URL.revokeObjectURL(p.url));
    pendingPhotos = [];
    document.getElementById("trip-country-search").value = "";
    document.getElementById("trip-start-date").value = "";
    document.getElementById("trip-end-date").value = "";
    document.getElementById("trip-note").value = "";
    document.getElementById("trip-quota-note").textContent = "";
    document.getElementById("trip-quota-note").classList.remove("warn");
    renderTripCountryChips();
    renderTripCountryOptions();
    renderStars();
    renderPendingPhotos();
    tripSheet.classList.add("show");
    tripSheetBackdrop.classList.add("show");
  }
  function closeTripSheet(){
    tripSheet.classList.remove("show");
    tripSheetBackdrop.classList.remove("show");
  }
  document.getElementById("btn-add-trip").addEventListener("click", openTripSheet);
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
    const saveBtn = document.getElementById("btn-save-trip");
    saveBtn.disabled = true;
    saveBtn.textContent = "Zapisywanie…";
    try{
      const tripId = cryptoRandomId();
      const trip = {
        id: tripId,
        countryIds: tripCountrySelected.slice(),
        startDate: startDate || null,
        endDate: endDate || null,
        rating: tripRating,
        note: document.getElementById("trip-note").value.trim(),
        createdAt: Date.now()
      };
      await dbPutTrip(trip);
      for(const p of pendingPhotos){
        await dbPutPhoto({ id: cryptoRandomId(), tripId, blob: p.file, type: p.type, size: p.size, createdAt: Date.now() });
        totalPhotoCount++;
      }
      pendingPhotos.forEach(p => URL.revokeObjectURL(p.url));
      pendingPhotos = [];
      trips.push(trip);
      markCountriesVisited(trip.countryIds);
      await renderTripsList();
      closeTripSheet();
    }catch(err){
      console.error(err);
      alert("Nie udało się zapisać podróży. Spróbuj ponownie.");
    }finally{
      saveBtn.disabled = false;
      saveBtn.textContent = "Zapisz podróż";
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
      if(btn) btn.addEventListener("click", openTripSheet);
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
        <button type="button" class="trip-card" data-id="${trip.id}">
          <div class="trip-card-photo"${coverStyle}>${cover ? '' : '✈'}</div>
          <div class="trip-card-body">
            <div class="trip-card-countries">${escapeHtml(tripCountriesLabel(trip))}</div>
            <div class="trip-card-dates">${formatTripDates(trip)}</div>
            <div class="trip-card-rating">${starsLabel(trip.rating)}</div>
          </div>
        </button>`;
    }));
    listEl.innerHTML = cards.join("");
  }
  document.getElementById("trips-list").addEventListener("click", (e)=>{
    const card = e.target.closest(".trip-card");
    if(!card) return;
    openTripDetail(card.getAttribute("data-id"));
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
  document.getElementById("btn-delete-trip").addEventListener("click", async ()=>{
    if(!activeDetailTripId) return;
    if(!confirm("Usunąć tę podróż wraz ze zdjęciami?")) return;
    const tripId = activeDetailTripId;
    const deletedTrip = trips.find(t => t.id === tripId);
    try{
      const removedCount = await dbDeleteTrip(tripId);
      totalPhotoCount = Math.max(0, totalPhotoCount - removedCount);
      trips = trips.filter(t => t.id !== tripId);
      closeTripDetail();
      await renderTripsList();

      if(deletedTrip){
        const stillCovered = new Set();
        trips.forEach(t => t.countryIds.forEach(id => stillCovered.add(id)));
        const orphaned = deletedTrip.countryIds.filter(id =>
          !stillCovered.has(id) && statusMap[id] === "visited"
        );
        if(orphaned.length > 0){
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
      }
    }catch(err){
      console.error(err);
      alert("Nie udało się usunąć podróży.");
    }
  });

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
