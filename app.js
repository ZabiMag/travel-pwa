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

  function loadStatus(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
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
    let visited = 0, planned = 0;
    Object.values(statusMap).forEach(s=>{
      if(s === "visited") visited++;
      else if(s === "planned") planned++;
    });
    document.getElementById("stat-visited").textContent = visited;
    document.getElementById("stat-planned").textContent = planned;
    const total = countries.length || 195;
    const pct = total ? Math.round((visited/total)*100) : 0;
    document.getElementById("stat-percent").textContent = pct + "%";
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
      .filter(f => f.id !== "010") // pomijamy Antarktydę na liście/mapie głównej interakcji, ale rysujemy szaro
      .map(f => ({
        id: String(f.id),
        nameEn: f.properties && f.properties.name,
        name: countryName(String(f.id), f.properties && f.properties.name),
        feature: f
      }));

    gMap = svg.append("g").attr("class", "countries-layer");

    gMap.selectAll("path.country")
      .data(featureCollection.features)
      .join("path")
      .attr("class", d => "country" + statusClass(String(d.id)))
      .attr("d", pathGen)
      .attr("data-id", d => d.id)
      .on("click", (event, d) => {
        event.stopPropagation();
        openSheet(String(d.id));
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
    if(s === "planned") return " status-planned";
    return "";
  }

  function refreshMapColors(){
    if(!gMap) return;
    gMap.selectAll("path.country")
      .attr("class", d => "country" + statusClass(String(d.id)));
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
