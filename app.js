(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const won = (n) => "₩" + Math.round(n).toLocaleString("ko-KR");
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const validFileId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{10,120}$/.test(s);
  const WD = ["월", "화", "수", "목", "금", "토", "일"];
  const KINDS = ["러닝", "걷기", "헬스", "수영", "자전거", "등산", "요가·필라테스", "구기 종목"];
  const KEY_STORE = "healthy.key";
  const API = (window.HEALTHY_CONFIG && window.HEALTHY_CONFIG.apiUrl) || "";

  const S = {
    me: null, members: [], entries: [], settings: null, loaded: false,
    view: (() => { try { const v = localStorage.getItem("healthy.view"); return v === "month" || v === "me" ? v : "week"; } catch (_) { return "week"; } })(),
    weekOffset: 0, monthOffset: 0, mineOnly: false,
    editingId: null, photoFile: null, photoRemoved: false, intensity: "normal",
    bodies: {}, inbody: [], reactions: [],
  };

  // ---------- key: 링크의 #k=… 를 이 기기에 저장하고 주소창에서는 지움 ----------
  function readKey() {
    const m = location.hash.match(/k=([A-Za-z0-9]+)/);
    if (m) {
      try { localStorage.setItem(KEY_STORE, m[1]); } catch (_) {}
      history.replaceState(null, "", location.pathname + location.search);
      return m[1];
    }
    try { return localStorage.getItem(KEY_STORE) || ""; } catch (_) { return ""; }
  }
  let KEY = readKey();
  // 페이지가 열린 상태에서 다른 링크(#k=…)로 들어오면 그 키로 다시 시작
  window.addEventListener("hashchange", () => { if (/k=[A-Za-z0-9]+/.test(location.hash)) { readKey(); location.reload(); } });

  function showGate(title, text) {
    $("#app").hidden = true; $("#fab").hidden = true; $("#gate").hidden = false;
    if (title) $("#gateTitle").textContent = title;
    if (text) $("#gateText").textContent = text;
  }

  // ---------- API ----------
  async function api(action, payload = {}) {
    let res;
    try {
      // Content-Type을 지정하지 않아야(text/plain) Apps Script가 CORS 사전 요청 없이 받음
      res = await fetch(API, { method: "POST", body: JSON.stringify({ k: KEY, action, ...payload }) });
    } catch (_) {
      throw { error: "network", message: "서버에 연결하지 못했어요. 인터넷 연결을 확인해주세요." };
    }
    let data;
    try { data = await res.json(); } catch (_) { throw { error: "bad_response", message: "서버 응답을 읽지 못했어요. Apps Script 배포 설정을 확인해주세요." }; }
    if (!data.ok) {
      if (data.error === "invalid_key") {
        try { localStorage.removeItem(KEY_STORE); localStorage.removeItem("healthy.state"); } catch (_) {}
        showGate("링크가 더 이상 유효하지 않아요", "링크가 재발급되었거나 참가자 목록에서 빠졌어요. 내기를 만든 친구에게 새 링크를 받아주세요.");
      }
      throw data;
    }
    return data;
  }
  const errText = (e) => {
    if (e && e.error === "unknown_action") return "서버 코드가 예전 버전이에요. Apps Script에 새 Code.gs를 붙여넣고 새 버전으로 배포해주세요.";
    return (e && e.message) || "저장하지 못했어요. 잠시 뒤 다시 시도해주세요.";
  };

  function apply(data, fromCache) {
    if (data.me) S.me = data.me;
    if (data.members) S.members = data.members;
    if (data.entries) S.entries = data.entries;
    if (data.settings) S.settings = data.settings;
    if (data.bodies) S.bodies = data.bodies;
    if (data.inbody) S.inbody = data.inbody;
    if (data.reactions) S.reactions = data.reactions;
    if (data.push) S.push = data.push;
    S.loaded = true;
    if (!fromCache && data.me && data.entries) saveCache();
    render();
  }

  // 마지막으로 받은 내용을 이 기기에 저장해 두고, 다음에 열 때 바로 보여줌
  const CACHE_STORE = "healthy.state";
  function saveCache() {
    const data = { me: S.me, members: S.members, entries: S.entries, settings: S.settings, bodies: S.bodies, inbody: S.inbody, reactions: S.reactions };
    try { localStorage.setItem(CACHE_STORE, JSON.stringify({ k: KEY, data })); } catch (_) {}
  }
  function readCache() {
    try { const c = JSON.parse(localStorage.getItem(CACHE_STORE) || "null"); return c && c.k === KEY ? c.data : null; } catch (_) { return null; }
  }
  function dropCache() { try { localStorage.removeItem(CACHE_STORE); } catch (_) {} }
  const setSync = (on) => { $("#syncNote").hidden = !on; };

  async function load() {
    setSync(S.loaded);
    try { apply(await api("state")); }
    catch (e) {
      if (e && e.error === "invalid_key") return;
      if (!S.loaded) $("#board").innerHTML = `<div class="empty"><strong>기록을 불러오지 못했어요</strong>${esc(errText(e))}</div>`;
      else toast("최신 기록을 불러오지 못했어요. 저장된 기록을 보여드리고 있어요");
    } finally { setSync(false); }
  }

  // ---------- config ----------
  function cfg() {
    const c = S.settings || {};
    const fine = Number(c.fine);
    return {
      title: (c.title || "").trim() || "주 3회 운동 내기",
      goal: Math.min(7, Math.max(1, Number(c.goal) || 3)),
      fine: Number.isFinite(fine) && fine >= 0 ? fine : 10000,
      start: validDate(c.start) ? c.start : ymd(mondayOf(new Date())),
      rules: parseRules(c),
      fineHistory: Array.isArray(c.fineHistory) ? c.fineHistory.filter((x) => x && validDate(x.from)).sort((a, b) => (a.from < b.from ? -1 : 1)) : [],
    };
  }
  // 그 주에 정해져 있던 벌금 (금액을 바꿔도 지난 주는 예전 금액 그대로)
  function fineFor(monday) {
    const c = cfg(), key = ymd(monday);
    let amt = c.fine;
    if (c.fineHistory.length) {
      amt = c.fineHistory[0].fine;
      c.fineHistory.forEach((x) => { if (x.from <= key) amt = Number(x.fine); });
    }
    return Math.max(0, Number(amt) || 0);
  }
  // 추가 규칙 목록. 예전 버전의 '벌금 사용처 / 메모'는 첫 규칙으로 보여줌
  function parseRules(c) {
    let r = c.rules;
    if (typeof r === "string") { try { r = JSON.parse(r || "[]"); } catch (_) { r = []; } }
    r = Array.isArray(r) ? r.map((x) => String(x).trim()).filter(Boolean) : [];
    if (!r.length && c.note) r = [String(c.note)];
    return r;
  }

  // ---------- derived ----------
  function members() {
    const byId = {};
    const list = S.members.map((m) => (byId[m.id] = { ...m, list: [] }));
    for (const e of S.entries) if (byId[e.memberId] && validDate(e.date)) byId[e.memberId].list.push(e);
    return list;
  }
  function daysIn(list, monday) {
    const a = ymd(monday), b = ymd(addDays(monday, 6));
    const set = new Set();
    for (const e of list) if (e.date >= a && e.date <= b) set.add(e.date);
    return set;
  }
  function minutesIn(list, monday) {
    const a = ymd(monday), b = ymd(addDays(monday, 6));
    return list.reduce((t, e) => t + (e.date >= a && e.date <= b ? Number(e.minutes) || 0 : 0), 0);
  }
  // 벌금이 생긴 주 목록: 벌금 시작 주(또는 참가한 주)부터 지난주까지, 목표를 못 채운 주
  // 벌금은 그 주 일요일이 지나면 확정되고, 일요일이 속한 달의 벌금으로 셈
  function fineWeeks(m) {
    const c = cfg();
    const thisMon = mondayOf(new Date());
    let w = mondayOf(parseYmd(c.start));
    if (m.joinedAt) { const j = mondayOf(new Date(m.joinedAt)); if (j > w) w = j; }
    const out = [];
    let guard = 0;
    while (w < thisMon && guard++ < 520) {
      const days = daysIn(m.list, w).size;
      if (days < c.goal) { const fine = fineFor(w); if (fine > 0) out.push({ mon: w, sun: addDays(w, 6), days, fine }); }
      w = addDays(w, 7);
    }
    return out;
  }
  const missedWeeks = (m) => fineWeeks(m).length;
  const fineSum = (weeks) => weeks.reduce((s, w) => s + w.fine, 0);
  const weekRangeText = (w) => `${w.mon.getMonth() + 1}.${w.mon.getDate()}–${w.sun.getMonth() + 1}.${w.sun.getDate()}`;
  const selMonday = () => addDays(mondayOf(new Date()), S.weekOffset * 7);
  const selMonth = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth() + S.monthOffset, 1); };
  const hueOf = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  // 기록권 아이콘과 "기록권만 있는 날" 판별
  const TICKET = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.2V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1.2a1.8 1.8 0 0 0 0 3.6V10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8.8a1.8 1.8 0 0 0 0-3.6zM10 3.5v7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-dasharray="0"/></svg>`;
  const passOnlyDays = (list) => {
    const real = new Set(list.filter((e) => !e.pass).map((e) => e.date));
    return new Set(list.filter((e) => e.pass && !real.has(e.date)).map((e) => e.date));
  };
  const kcalIn = (list, a, b) => list.reduce((t, e) => t + (e.date >= a && e.date <= b ? Number(e.kcal) || 0 : 0), 0);
  // 나만의 한 마디: 비어 있으면 흐린 기본 문구, 내 것은 연필 버튼으로 바로 고침
  const PENCIL = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M11.3 2.3a1.6 1.6 0 0 1 2.3 2.3L5.4 12.8 2.5 13.5l.7-2.9z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  const mottoHtml = (m, cls) => {
    const mine = S.me && m.id === S.me.id;
    const text = (m.motto || "").trim();
    return `<div class="motto ${cls || ""}${text ? "" : " unset"}" data-motto="${esc(m.id)}" title="${esc(text || "운동하자!")}"><span class="mtext">${esc(text || "운동하자!")}</span>${mine ? `<button type="button" class="mottoedit" data-motto-edit aria-label="한 마디 고치기">${PENCIL}</button>` : ""}</div>`;
  };
  const nameBtn = (m) => `<button type="button" class="namebtn" data-member="${esc(m.id)}">${esc(m.name || "친구")}</button>`;
  const fmtMinutes = (n) => (n >= 60 ? `${Math.floor(n / 60)}시간${n % 60 ? ` ${n % 60}분` : ""}` : `${n}분`);

  // 프로필 사진이 있으면 사진, 없거나 못 불러오면 이름 첫 글자
  function avatar(m, previewUrl) {
    const h = hueOf(m.id);
    const initial = (m.name || "?").trim().charAt(0) || "?";
    const style = `background:hsl(${h} 55% 42%)`;
    const src = previewUrl || (validFileId(m.avatar) ? photoSrc(m.avatar, 200) : "");
    if (src) return `<img class="avatar" src="${esc(src)}" data-initial="${esc(initial)}" style="${style}" alt="" referrerpolicy="no-referrer">`;
    return `<span class="avatar" style="${style}" aria-hidden="true">${esc(initial)}</span>`;
  }
  document.addEventListener("error", (ev) => {
    const img = ev.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains("avatar")) return;
    const span = document.createElement("span");
    span.className = "avatar";
    span.setAttribute("style", img.getAttribute("style") || "");
    span.setAttribute("aria-hidden", "true");
    span.textContent = img.dataset.initial || "?";
    img.replaceWith(span);
  }, true);
  const photoSrc = (id, w) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${w}`;
  const photoAlt = (id, w) => `https://lh3.googleusercontent.com/d/${encodeURIComponent(id)}=w${w}`;

  // ---------- render ----------
  function render() {
    if (!S.loaded) return;
    $("#gate").hidden = true; $("#app").hidden = false;
    const c = cfg();
    const ms = members();
    const isAdmin = S.me && S.me.role === "admin";

    // header
    document.title = c.title + " · JJJ Healthy Girl";
    $("#title").textContent = c.title;
    const pot = ms.reduce((t, m) => t + fineSum(fineWeeks(m)), 0);
    const startD = mondayOf(parseYmd(c.start)); // 실제로 벌금 계산이 시작되는 월요일
    $("#rules").innerHTML =
      `<span class="rule">주 ${c.goal}일 이상</span>` +
      `<span class="rule">미달 시 ${esc(won(c.fine))}</span>` +
      `<span class="rule">벌금은 ${startD.getMonth() + 1}월 ${startD.getDate()}일(월) 주부터</span>` +
      `<span class="rule pot">모인 벌금 <span class="num">${esc(won(pot))}</span></span>` +
      (isAdmin ? `<button class="linkbtn" type="button" id="editRules">규칙 수정</button>` : "");
    $("#ruleList").innerHTML = c.rules.map((r) => `<li>${esc(r)}</li>`).join("");
    $("#ruleList").hidden = !c.rules.length;

    // 기간: 주간 또는 월별
    const isWeek = S.view === "week";
    $("#viewWeek").setAttribute("aria-pressed", String(isWeek));
    $("#viewMonth").setAttribute("aria-pressed", String(S.view === "month"));
    $("#viewMe").setAttribute("aria-pressed", String(S.view === "me"));
    const meView = S.view === "me";
    ["#periodNav", "#secMembers", "#secFeed"].forEach((sel) => ($(sel).hidden = meView));
    $("#mePage").hidden = !meView;
    if (meView) renderMePage();
    const mon = selMonday();
    const sun = addDays(mon, 6);
    const m1 = selMonth();
    const mEnd = new Date(m1.getFullYear(), m1.getMonth() + 1, 0);
    const isCurrent = isWeek ? S.weekOffset === 0 : S.monthOffset === 0;
    if (isWeek) {
      $("#weekTitle").textContent = isCurrent ? "이번 주" : S.weekOffset === -1 ? "지난 주" : `${-S.weekOffset}주 전`;
      $("#weekRange").textContent = `${mon.getMonth() + 1}.${mon.getDate()} – ${sun.getMonth() + 1}.${sun.getDate()}`;
    } else {
      $("#weekTitle").textContent = isCurrent ? "이번 달" : S.monthOffset === -1 ? "지난 달" : `${-S.monthOffset}개월 전`;
      $("#weekRange").textContent = `${m1.getFullYear()}년 ${m1.getMonth() + 1}월`;
    }
    $("#next").disabled = isCurrent;
    // 벌금 계산 시작 주보다 이전 주(예: 베타 테스트 기간)는 기록만 보여주고 벌금은 없음
    const fineStart = mondayOf(parseYmd(c.start));
    const beforeFines = isWeek && mon < fineStart;
    $("#noFineNote").hidden = !beforeFines;
    if (beforeFines) $("#noFineNote").textContent = `벌금 계산 시작(${fineStart.getMonth() + 1}월 ${fineStart.getDate()}일 주) 전이라 이 주는 벌금이 없어요. 운동 기록은 그대로 남아 있어요.`;
    $("#boardSub").textContent = isWeek ? "요일별 운동한 날" : "날짜별 운동한 멤버";
    const rangeA = isWeek ? ymd(mon) : ymd(m1);
    const rangeB = isWeek ? ymd(sun) : ymd(mEnd);

    // board
    const today = ymd(new Date());
    const daysLeft = 7 - ((new Date().getDay() + 6) % 7); // 오늘 포함
    const board = $("#board");
    if (!ms.length) {
      board.innerHTML = `<div class="empty"><strong>아직 참가한 사람이 없어요</strong>${isAdmin ? "아래 ‘참가자 관리’에서 친구를 추가하고 링크를 보내주세요." : "친구들이 참가하면 여기에 표시돼요."}</div>`;
    } else if (!isWeek) {
      board.innerHTML = monthBoard(ms, m1, mEnd, today);
    } else {
      const rows = ms.map((m) => ({ m, days: daysIn(m.list, mon), mins: minutesIn(m.list, mon), kcal: kcalIn(m.list, ymd(mon), ymd(sun)), missed: missedWeeks(m) }))
        .sort((a, b) => b.days.size - a.days.size || b.mins - a.mins || String(a.m.name).localeCompare(String(b.m.name), "ko"));
      const anyRec = rows.some((r) => r.days.size > 0);
      board.innerHTML = rows.map((r, i) => {
        const done = r.days.size;
        let chip;
        if (done >= c.goal) chip = `<span class="chip good">달성</span>`;
        else if (beforeFines || (r.m.joinedAt && mon < mondayOf(new Date(r.m.joinedAt)))) chip = `<span class="chip off">벌금 없음</span>`;
        else if (!isCurrent) chip = fineFor(mon) > 0 ? `<span class="chip bad">벌금 ${esc(won(fineFor(mon)))}</span>` : `<span class="chip off">벌금 없음</span>`;
        else if (c.goal - done > daysLeft) chip = `<span class="chip bad">미달 확정</span>`;
        else chip = `<span class="chip wait">${c.goal - done}일 더</span>`;
        const passDays = passOnlyDays(r.m.list);
        const dots = WD.map((w, k) => {
          const d = ymd(addDays(mon, k));
          const pass = passDays.has(d);
          return `<span class="dot${r.days.has(d) ? (pass ? " pass" : " on") : ""}${d === today ? " today" : ""}" title="${d}${pass ? " 기록권" : ""}">${w}</span>`;
        }).join("");
        const isMe = S.me && r.m.id === S.me.id;
        // 누적 벌금은 월별 보기(전체)와 내 페이지(나)에서 따로 보여줌
        const owed = "";
        return `<div class="mcard${isMe ? " mine" : ""}">
          <div class="mtop">${avatar(r.m)}${medalsHtml(r.m.id)}${anyRec ? `<span class="rank">${i + 1}위</span>` : ""}</div>
          <div class="name">${nameBtn(r.m)}${isMe ? `<span class="me">나</span>` : ""}${mottoHtml(r.m, "inline")}</div>
          <div class="mscore"><span class="count">${done}<small>/${c.goal}일</small></span>${chip}</div>
          <div class="dots">${dots}</div>
          ${r.kcal ? `<span class="kcalsum">약 ${r.kcal.toLocaleString("ko-KR")}kcal</span>` : ""}
          ${r.m.passes > 0 ? (isMe ? `<button type="button" class="passchip" data-usepass>${TICKET}기록권 ${r.m.passes}장 · 쓰기</button>` : `<span class="passchip">${TICKET}기록권 ${r.m.passes}장</span>`) : ""}
          ${owed}
        </div>`;
      }).join("");
      board.innerHTML = `<div class="mstrip">${board.innerHTML}</div>`;
    }
    $("#boardKcalNote").hidden = !ms.some((m) => kcalIn(m.list, rangeA, rangeB) > 0);

    // feed
    const a = rangeA, b = rangeB;
    const byId = Object.fromEntries(ms.map((m) => [m.id, m]));
    let entries = S.entries.filter((e) => byId[e.memberId] && e.date >= a && e.date <= b);
    if (S.mineOnly && S.me) entries = entries.filter((e) => e.memberId === S.me.id);
    entries.sort((x, y) => y.date.localeCompare(x.date) || (Number(y.createdAt) || 0) - (Number(x.createdAt) || 0));
    $("#feedCount").textContent = `${entries.length}개`;
    $("#feedKcalNote").hidden = !entries.some((e) => e.kcal > 0);
    const feed = $("#feed");
    if (!entries.length) {
      feed.innerHTML = `<div class="card veiled"><div class="empty"><strong>${isWeek ? (isCurrent ? "이번 주" : "이 주") : (isCurrent ? "이번 달" : "이 달")} 기록이 아직 없어요</strong>운동하고 ‘+ 기록하기’로 날짜, 종목, 시간, 사진을 남기면 여기에 쌓여요.</div></div>`;
    } else {
      let lastDate = "";
      feed.innerHTML = entries.map((e) => {
        const m = byId[e.memberId];
        const mine = S.me && e.memberId === S.me.id;
        const d = parseYmd(e.date);
        let head = "";
        if (e.date !== lastDate) { lastDate = e.date; head = `<div class="daylabel">${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[(d.getDay() + 6) % 7]}요일</div>`; }
        const stats = [
          Number(e.minutes) > 0 ? `${Number(e.minutes)}분` : "",
          Number(e.km) > 0 ? `${Number(e.km)}km` : "",
          Number(e.speed) > 0 ? `${Number(e.speed)}km/h` : "",
          Number(e.steps) > 0 ? `${Number(e.steps).toLocaleString("ko-KR")}걸음` : "",
          e.kcal > 0 ? `약 ${Number(e.kcal).toLocaleString("ko-KR")}kcal` : "",
        ].filter(Boolean).join(" · ");
        if (e.pass) {
          const passActs = mine
            ? `<div class="actions"><button type="button" class="act danger" data-act="del" data-id="${esc(e.id)}">기록권 사용 취소</button></div>`
            : isAdmin ? `<div class="actions"><button type="button" class="act danger" data-act="del" data-id="${esc(e.id)}">관리자 취소 (기록권 돌려주기)</button></div>` : "";
          return `${head}<article class="card passcard" id="entry-${esc(e.id)}">
            <div class="card-head">${avatar(m)}<span class="name">${esc(m.name || "친구")}</span><span class="badge pass">${TICKET}기록권</span><span class="when num">${d.getMonth() + 1}.${d.getDate()}</span></div>
            <p class="passline">기록권으로 채운 날이에요. 이번 주 운동한 날로 인정돼요.</p>
            ${e.memo ? `<p class="memo">${esc(e.memo)}</p>` : ""}${reactionBar(e)}${passActs}
          </article>`;
        }
        const veiled = e.hidden && !mine;
        const photo = !veiled && validFileId(e.photo)
          ? `<button type="button" class="photo" data-act="zoom" data-id="${esc(e.photo)}"><img src="${esc(photoSrc(e.photo, 1200))}" data-alt="${esc(photoAlt(e.photo, 1200))}" alt="${esc(m.name)}의 운동 사진" loading="lazy" referrerpolicy="no-referrer"></button>` : "";
        const memo = !veiled && e.memo ? `<p class="memo">${esc(e.memo)}</p>` : "";
        let actions = "";
        if (mine) {
          actions = `<div class="actions">
            <button type="button" class="act" data-act="edit" data-id="${esc(e.id)}">수정</button>
            <button type="button" class="act" data-act="hide" data-id="${esc(e.id)}">${e.hidden ? "공개하기" : "숨기기"}</button>
            <button type="button" class="act danger" data-act="del" data-id="${esc(e.id)}">삭제</button>
          </div>`;
        } else if (isAdmin) {
          actions = `<div class="actions"><button type="button" class="act danger" data-act="del" data-id="${esc(e.id)}">관리자 삭제</button></div>`;
        }
        return `${head}<article class="card${veiled ? " veiled" : ""}" id="entry-${esc(e.id)}">
          <div class="card-head">${avatar(m)}<span class="name">${esc(m.name || "친구")}</span>${e.hidden ? `<span class="badge">${mine ? "숨김 · 나만 보기" : "숨긴 기록"}</span>` : ""}<span class="when num">${d.getMonth() + 1}.${d.getDate()}</span></div>
          <div class="what"><span class="kind">${esc(e.kind || "운동")}</span>${stats ? `<span class="stats">${esc(stats)}</span>` : ""}</div>
          ${veiled ? `<p class="veil-note">사진과 메모는 숨겨져 있어요. 운동한 날은 멤버 현황에 반영돼요.</p>` : ""}
          ${memo}${photo}${reactionBar(e)}${actions}
        </article>`;
      }).join("");
      feed.querySelectorAll(".photo img").forEach((img) => img.addEventListener("error", function onErr() {
        if (img.dataset.alt) { img.src = img.dataset.alt; img.dataset.alt = ""; return; }
        img.removeEventListener("error", onErr);
        const btn = img.parentElement; btn.classList.add("broken"); btn.textContent = "사진을 불러올 수 없어요"; btn.disabled = true;
      }));
    }

    // footer / fab
    $("#meLine").textContent = S.me ? `${S.me.name || "나"}(으)로 참여 중` : "";
    $("#manage").hidden = !isAdmin;
    $("#fab").hidden = false;
    updateNotiBadge();
  }

  // 월별 보기: 달력(날짜마다 운동한 멤버 색 점) + 멤버별 합계
  // 월별 보기: 전체 멤버 벌금 누계 + 이 달에 확정된 벌금
  function fineBox(ms, m1, mEnd) {
    const c = cfg();
    const fs = mondayOf(parseYmd(c.start));
    const rows = ms.map((m) => {
      const weeks = fineWeeks(m);
      const inMonth = weeks.filter((w) => w.sun >= m1 && w.sun <= mEnd);
      return { m, total: weeks.length, month: inMonth.length, totalAmt: fineSum(weeks), monthAmt: fineSum(inMonth) };
    }).sort((x, y) => y.totalAmt - x.totalAmt || y.monthAmt - x.monthAmt || String(x.m.name).localeCompare(String(y.m.name), "ko"));
    const sumAll = rows.reduce((s, r) => s + r.totalAmt, 0);
    const sumMonth = rows.reduce((s, r) => s + r.monthAmt, 0);
    const monthName = `${m1.getMonth() + 1}월`;
    return `<div class="finebox">
      <div class="finehead">
        <b>벌금</b>
        <span>전체 누계 <b class="num">${esc(won(sumAll))}</b></span>
        <span>${monthName} 확정 <b class="num">${esc(won(sumMonth))}</b></span>
      </div>
      <div class="finetable" role="table" aria-label="멤버별 벌금">
        <div class="fr fh" role="row"><span role="columnheader">멤버</span><span role="columnheader">${monthName}</span><span role="columnheader">누계</span></div>
        ${rows.map((r) => `<div class="fr" role="row">
          <span role="cell" class="fname">${avatar(r.m)}${esc(r.m.name || "친구")}</span>
          <span role="cell" class="amt">${r.month ? `<b class="num">${esc(won(r.monthAmt))}</b><small>${r.month}주</small>` : "–"}</span>
          <span role="cell" class="amt${r.total ? " owe" : ""}">${r.total ? `<b class="num">${esc(won(r.totalAmt))}</b><small>${r.total}주</small>` : "없음"}</span>
        </div>`).join("")}
      </div>
      <p class="veil-note">벌금은 매주 일요일이 지나면 확정되고, 그 일요일이 속한 달에 들어가요. 금액은 그 주에 정해져 있던 금액으로 고정돼요. ${fs.getMonth() + 1}월 ${fs.getDate()}일 주부터 계산해요.</p>
    </div>`;
  }

  function monthBoard(ms, m1, mEnd, today) {
    const a = ymd(m1), b = ymd(mEnd);
    const byDate = {};
    const rows = ms.map((m) => {
      const list = m.list.filter((e) => e.date >= a && e.date <= b);
      const days = new Set(list.map((e) => e.date));
      const po = passOnlyDays(list);
      days.forEach((d) => (byDate[d] = byDate[d] || []).push({ m, pass: po.has(d) }));
      return {
        m, days: days.size, n: list.length,
        mins: list.reduce((t, e) => t + (Number(e.minutes) || 0), 0),
        km: Math.round(list.reduce((t, e) => t + (Number(e.km) || 0), 0) * 10) / 10,
        kcal: kcalIn(list, a, b),
      };
    }).sort((x, y) => y.days - x.days || y.mins - x.mins || String(x.m.name).localeCompare(String(y.m.name), "ko"));

    let cal = WD.map((w) => `<div class="wd">${w}</div>`).join("");
    cal += "<div></div>".repeat((m1.getDay() + 6) % 7);
    for (let d = 1; d <= mEnd.getDate(); d++) {
      const ds = ymd(new Date(m1.getFullYear(), m1.getMonth(), d));
      const who = byDate[ds] || [];
      const dots = who.slice(0, 6).map(({ m, pass }) => pass
          ? `<i class="pass" style="border-color:hsl(${hueOf(m.id)} 55% 42%)" title="${esc(m.name)} (기록권)"></i>`
          : `<i style="background:hsl(${hueOf(m.id)} 55% 42%)" title="${esc(m.name)}"></i>`).join("")
        + (who.length > 6 ? `<em>+${who.length - 6}</em>` : "");
      const label = `${m1.getMonth() + 1}월 ${d}일${who.length ? ": " + who.map(({ m, pass }) => m.name + (pass ? "(기록권)" : "")).join(", ") : ""}`;
      cal += `<div class="cday${who.length ? " has" : ""}${ds === today ? " today" : ""}${ds > today ? " future" : ""}" title="${esc(label)}" aria-label="${esc(label)}"><span class="cnum">${d}</span><span class="cdots">${dots}</span></div>`;
    }

    const anyRec = rows.some((r) => r.days > 0);
    const list = rows.map((r, i) => {
      const isMe = S.me && r.m.id === S.me.id;
      const stats = r.n
        ? `<span>총 <span class="num">${esc(fmtMinutes(r.mins))}</span>${r.km ? ` · <span class="num">${r.km}</span>km` : ""}</span>`
          + (r.kcal ? `<span>약 <span class="num">${r.kcal.toLocaleString("ko-KR")}</span>kcal</span>` : "")
          + `<span>기록 <span class="num">${r.n}</span>개</span>`
        : "<span>아직 기록 없음</span>";
      return `<div class="mcard${isMe ? " mine" : ""}">
        <div class="mtop">${avatar(r.m)}${medalsHtml(r.m.id)}${anyRec ? `<span class="rank">${i + 1}위</span>` : ""}</div>
        <div class="name">${nameBtn(r.m)}${isMe ? `<span class="me">나</span>` : ""}${mottoHtml(r.m, "inline")}</div>
        <div class="mscore"><span class="count">${r.days}<small>일</small></span></div>
        <div class="mstats">${stats}</div>
      </div>`;
    }).join("");
    return `<div class="cal">${cal}</div><div class="mstrip">${list}</div>${fineBox(ms, m1, mEnd)}`;
  }

  let toastTimer;
  function toast(t) {
    const el = $("#toast"); el.textContent = t; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  // ---------- sheets ----------
  const anySheetOpen = () => [...document.querySelectorAll(".scrim")].some((s) => !s.hidden);
  function openSheet(id) {
    document.querySelectorAll(".scrim").forEach((s) => (s.hidden = s.id !== id));
    const sheet = document.querySelector(`#${id} .sheet`);
    if (sheet) sheet.scrollTop = 0;
  }
  function closeSheets() { document.querySelectorAll(".scrim").forEach((s) => (s.hidden = true)); }
  document.querySelectorAll(".scrim:not(.confirm)").forEach((s) => {
    s.addEventListener("click", (ev) => { if (ev.target === s || ev.target.closest("[data-close]")) closeSheets(); });
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { closeSheets(); $("#lightbox").hidden = true; } });

  // 추가 기록 (거리 · 속도 · 걸음 수): 버튼을 누르면 입력칸이 열리고, 다시 누르면 닫히며 값도 지움
  const METRICS = ["km", "speed", "steps"];
  const metricOn = (k) => $(`#metricChips [data-metric="${k}"]`).getAttribute("aria-pressed") === "true";
  function setMetric(k, on) {
    $(`#metricChips [data-metric="${k}"]`).setAttribute("aria-pressed", String(on));
    document.querySelector(`.metrics [data-for="${k}"]`).hidden = !on;
    if (!on) $("#f-" + k).value = "";
  }
  $("#metricChips").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-metric]"); if (!b) return;
    const k = b.dataset.metric, on = !metricOn(k);
    setMetric(k, on);
    if (on) $("#f-" + k).focus();
  });

  // intensity
  function setIntensity(v) {
    S.intensity = ["light", "normal", "hard"].includes(v) ? v : "normal";
    $("#f-int").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === S.intensity)));
  }
  $("#f-int").addEventListener("click", (ev) => { const b = ev.target.closest("button[data-v]"); if (b) setIntensity(b.dataset.v); });

  // kinds
  $("#kindChips").innerHTML = KINDS.map((k) => `<button type="button" data-kind="${esc(k)}" aria-pressed="false">${esc(k)}</button>`).join("");
  function syncKinds() {
    const v = $("#f-kind").value.trim();
    $("#kindChips").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === v)));
  }
  $("#kindChips").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-kind]"); if (!b) return;
    $("#f-kind").value = b.dataset.kind; syncKinds();
  });
  $("#f-kind").addEventListener("input", syncKinds);

  // photo
  let previewUrl = null;
  function setPreview(src) {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    const img = $("#f-preview");
    if (src) { img.src = src; img.hidden = false; } else { img.removeAttribute("src"); img.hidden = true; }
    $("#removePhoto").hidden = !src;
    $("#pickLabel").textContent = src ? "다른 사진" : "사진 선택";
  }
  $("#f-photo").addEventListener("change", () => {
    const f = $("#f-photo").files[0]; if (!f) return;
    S.photoFile = f; S.photoRemoved = false;
    setPreview(null);
    previewUrl = URL.createObjectURL(f);
    $("#f-preview").src = previewUrl; $("#f-preview").hidden = false;
    $("#removePhoto").hidden = false; $("#pickLabel").textContent = "다른 사진";
  });
  $("#removePhoto").addEventListener("click", () => { S.photoFile = null; S.photoRemoved = true; $("#f-photo").value = ""; setPreview(null); });

  // 긴 변 1600px JPEG로 줄여서 업로드 시간을 줄임
  async function shrink(file) {
    if (file.type === "image/gif") return file;
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
      cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
      const out = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.82));
      return out || file;
    } catch (_) { return file; }
  }
  const toBase64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  function openEntry(id) {
    const e = id ? S.entries.find((x) => x.id === id) : null;
    S.editingId = e ? id : null; S.photoFile = null; S.photoRemoved = false;
    $("#entryTitle").textContent = e ? "기록 수정하기" : "운동 기록하기";
    $("#f-date").value = e?.date || ymd(new Date());
    $("#f-date").max = ymd(new Date());
    $("#f-min").value = e?.minutes || "";
    $("#f-kind").value = e?.kind || "";
    // 추가 기록: 값이 있는 항목만 열어 둠
    METRICS.forEach((k) => {
      const v = e && Number(e[k]) > 0 ? e[k] : "";
      $("#f-" + k).value = v;
      setMetric(k, !!v);
    });
    $("#f-memo").value = e?.memo || "";
    $("#f-hidden").checked = !!e?.hidden;
    setIntensity(e?.intensity || "normal");
    $("#passHint").hidden = !!e || !myPasses();
    if (!$("#passHint").hidden) $("#passHint").querySelector("button").textContent = `기록권 쓰기 (${myPasses()}장 남음)`;
    $("#f-photo").value = "";
    setPreview(e && validFileId(e.photo) ? photoSrc(e.photo, 800) : null);
    $("#entryErr").hidden = true;
    syncKinds();
    openSheet("entrySheet");
  }

  $("#entryForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = $("#entryErr");
    const date = $("#f-date").value;
    const kind = $("#f-kind").value.trim();
    if (!validDate(date)) { err.textContent = "날짜를 골라주세요."; err.hidden = false; return; }
    if (date > ymd(new Date())) { err.textContent = "미래 날짜에는 기록할 수 없어요."; err.hidden = false; return; }
    if (!kind) { err.textContent = "종목을 고르거나 직접 입력해주세요."; err.hidden = false; return; }
    err.hidden = true;
    const btn = $("#entrySave"); btn.disabled = true;
    try {
      const entry = {
        id: S.editingId || undefined,
        date, kind,
        minutes: Math.round(Number($("#f-min").value) || 0),
        km: metricOn("km") ? Math.round((Number($("#f-km").value) || 0) * 10) / 10 : 0,
        speed: metricOn("speed") ? Math.round((Number($("#f-speed").value) || 0) * 10) / 10 : 0,
        steps: metricOn("steps") ? Math.round(Number($("#f-steps").value) || 0) : 0,
        memo: $("#f-memo").value.trim().slice(0, 1000),
        hidden: $("#f-hidden").checked,
        intensity: S.intensity,
        removePhoto: S.photoRemoved,
      };
      if (S.photoFile) {
        btn.textContent = "사진 올리는 중…";
        const blob = await shrink(S.photoFile);
        entry.photo = { mime: blob.type || "image/jpeg", data: await toBase64(blob) };
      } else {
        btn.textContent = "저장 중…";
      }
      apply(await api("saveEntry", { entry }));
      closeSheets();
      toast(S.editingId ? "수정했어요" : "기록했어요");
      const saved = parseYmd(date), now = new Date();
      S.weekOffset = Math.round((mondayOf(saved) - mondayOf(now)) / (7 * 864e5));
      S.monthOffset = (saved.getFullYear() - now.getFullYear()) * 12 + saved.getMonth() - now.getMonth();
      render();
    } catch (e) {
      if (e && e.error === "invalid_key") return;
      err.textContent = errText(e); err.hidden = false;
    } finally { btn.disabled = false; btn.textContent = "저장"; }
  });

  // profile: 이름 + 프로필 사진
  const P = { file: null, removed: false, url: null };
  const myMember = () => (S.me && S.members.find((m) => m.id === S.me.id)) || S.me || { id: "", name: "" };
  function drawProfilePreview() {
    const m = { ...myMember(), name: $("#n-name").value.trim() || myMember().name };
    if (P.removed) m.avatar = "";
    $("#p-preview").innerHTML = avatar(m, P.url);
    const has = !!P.url || (!P.removed && validFileId(m.avatar));
    $("#p-remove").hidden = !has;
    $("#p-pick").textContent = has ? "사진 바꾸기" : "사진 올리기";
  }
  function resetProfilePhoto() {
    if (P.url) URL.revokeObjectURL(P.url);
    P.file = null; P.url = null; P.removed = false; $("#p-photo").value = "";
  }
  $("#rename").addEventListener("click", () => {
    resetProfilePhoto();
    $("#n-name").value = S.me?.name || ""; $("#nameErr").hidden = true;
    drawProfilePreview();
    openSheet("nameSheet");
  });
  $("#n-name").addEventListener("input", drawProfilePreview);
  $("#p-photo").addEventListener("change", () => {
    const f = $("#p-photo").files[0]; if (!f) return;
    if (P.url) URL.revokeObjectURL(P.url);
    P.file = f; P.url = URL.createObjectURL(f); P.removed = false;
    drawProfilePreview();
  });
  $("#p-remove").addEventListener("click", () => {
    if (P.url) URL.revokeObjectURL(P.url);
    P.file = null; P.url = null; P.removed = true; $("#p-photo").value = "";
    drawProfilePreview();
  });
  // 가운데를 정사각형으로 잘라 400px로 줄임
  async function squareCrop(file) {
    try {
      const bmp = await createImageBitmap(file);
      const side = Math.min(bmp.width, bmp.height), out = Math.min(400, side);
      const cv = document.createElement("canvas"); cv.width = cv.height = out;
      cv.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
      return (await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.85))) || file;
    } catch (_) { return file; }
  }
  $("#nameForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = $("#n-name").value.trim();
    if (!name) { $("#nameErr").textContent = "이름을 입력해주세요."; $("#nameErr").hidden = false; return; }
    const btn = $("#p-save"); btn.disabled = true;
    try {
      if (P.file) {
        btn.textContent = "사진 올리는 중…";
        const blob = await squareCrop(P.file);
        apply(await api("updateProfile", { name, photo: { mime: blob.type || "image/jpeg", data: await toBase64(blob) } }));
      } else if (P.removed) {
        apply(await api("updateProfile", { name, removePhoto: true }));
      } else {
        apply(await api("rename", { name }));
      }
      resetProfilePhoto(); closeSheets(); toast("프로필을 바꿨어요");
    } catch (e) { $("#nameErr").textContent = errText(e); $("#nameErr").hidden = false; }
    finally { btn.disabled = false; btn.textContent = "저장"; }
  });

  // rules (admin): 기본 규칙 + 추가 규칙 목록(추가·수정·삭제)
  const MAX_RULES = 20;
  function addRuleRow(text, focus) {
    const box = $("#ruleEdit");
    const row = document.createElement("div");
    row.className = "rrow";
    row.innerHTML = `<span class="rno"></span><input type="text" maxlength="80" placeholder="예: 운동 인증은 사진 필수"><button type="button" class="act danger" data-del>삭제</button>`;
    row.querySelector("input").value = text || "";
    box.appendChild(row);
    numberRules();
    if (focus) row.querySelector("input").focus();
  }
  function numberRules() {
    const rows = [...$("#ruleEdit").children];
    rows.forEach((r, i) => { r.querySelector(".rno").textContent = i + 1; r.querySelector("input").setAttribute("aria-label", `추가 규칙 ${i + 1}`); });
    $("#addRule").disabled = rows.length >= MAX_RULES;
  }
  $("#addRule").addEventListener("click", () => addRuleRow("", true));
  $("#ruleEdit").addEventListener("click", (ev) => {
    if (!ev.target.closest("[data-del]")) return;
    ev.target.closest(".rrow").remove();
    numberRules();
  });
  // 고른 날짜가 속한 주를 바로 보여줌 (예: 11/8(일)을 고르면 11/2(월) 주부터 계산)
  function showStartNote() {
    const v = $("#r-start").value;
    if (!validDate(v)) { $("#startNote").textContent = ""; return; }
    const mon = mondayOf(parseYmd(v)), sun = addDays(mon, 6);
    $("#startNote").textContent = `→ ${mon.getMonth() + 1}월 ${mon.getDate()}일(월)~${sun.getMonth() + 1}월 ${sun.getDate()}일(일) 주부터 벌금을 계산해요. 그 전 주들은 벌금이 없어요.`;
  }
  $("#r-start").addEventListener("input", showStartNote);
  function openRules() {
    const c = cfg();
    $("#r-title").value = c.title; $("#r-goal").value = c.goal; $("#r-fine").value = c.fine;
    $("#r-start").value = c.start; $("#rulesErr").hidden = true;
    showStartNote();
    $("#ruleEdit").innerHTML = "";
    c.rules.forEach((r) => addRuleRow(r));
    numberRules();
    openSheet("rulesSheet");
  }
  $("#rulesForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const rules = [...$("#ruleEdit").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
    // 예전 서버 코드는 rules를 모르니, 그때는 규칙을 메모 칸에 합쳐서라도 남김
    const serverKnowsRules = !!(S.settings && "rules" in S.settings);
    const settings = {
      title: $("#r-title").value.trim(), goal: $("#r-goal").value, fine: $("#r-fine").value,
      start: $("#r-start").value, rules, note: serverKnowsRules ? "" : rules.join(" / ").slice(0, 60),
    };
    try {
      apply(await api("saveSettings", { settings }));
      closeSheets();
      toast(serverKnowsRules || rules.length < 2 ? "규칙을 저장했어요" : "저장했어요. 규칙을 따로따로 보려면 Apps Script를 새 버전으로 배포해주세요");
    } catch (e) { $("#rulesErr").textContent = errText(e); $("#rulesErr").hidden = false; }
  });

  // members (admin)
  const linkFor = (key) => location.origin + location.pathname + "#k=" + key;
  function renderRoster(roster) {
    $("#roster").innerHTML = roster.map((m) => `<div class="mrow">
        ${avatar(m)}<span class="mname">${esc(m.name)}${m.role === "admin" ? " · 관리자" : ""}</span>
        <span class="passctl" aria-label="${esc(m.name)}의 기록권">${TICKET}<button type="button" class="act" data-act="pass-" data-id="${esc(m.id)}" aria-label="기록권 한 장 빼기"${m.passes ? "" : " disabled"}>−</button><b class="num">${m.passes || 0}</b><button type="button" class="act" data-act="pass+" data-id="${esc(m.id)}" aria-label="기록권 한 장 주기">+</button></span>
        <span class="mbtns">
          <button type="button" class="act" data-act="copy" data-id="${esc(m.id)}">링크 복사</button>
          ${m.role === "admin" ? "" : `<button type="button" class="act" data-act="reset" data-id="${esc(m.id)}">재발급</button>
          <button type="button" class="act danger" data-act="remove" data-id="${esc(m.id)}">내보내기</button>`}
        </span>
        <input class="linkbox" type="text" readonly value="${esc(linkFor(m.key))}" data-link="${esc(m.id)}" aria-label="${esc(m.name)}의 링크" hidden>
      </div>`).join("");
  }
  async function openManage() {
    $("#manageErr").hidden = true; $("#a-name").value = "";
    $("#roster").innerHTML = `<div class="empty">불러오는 중…</div>`;
    openSheet("manageSheet");
    loadBackup();
    try { renderRoster((await api("members")).roster); }
    catch (e) { $("#manageErr").textContent = errText(e); $("#manageErr").hidden = false; }
  }

  // 백업 상태 (관리자)
  function renderBackup(b) {
    const parts = [];
    parts.push(b.last ? `마지막 백업: <b>${esc(b.lastText)}</b>${b.note ? ` · ${esc(b.note)}` : ""}` : "아직 백업한 적이 없어요.");
    if (b.auto === true) parts.push("자동 백업 켜짐: 매주 월요일 새벽 4~5시");
    else parts.push("자동 백업이 아직 꺼져 있어요. Apps Script 편집기에서 <b>setupBackup</b>을 한 번 실행하면 켜져요.");
    $("#backupInfo").innerHTML = parts.join("<br>");
    $("#backupOpen").hidden = !b.folderUrl;
    if (b.folderUrl) $("#backupOpen").href = b.folderUrl;
  }
  async function loadBackup() {
    $("#backupInfo").textContent = "불러오는 중…"; $("#backupOpen").hidden = true;
    try { renderBackup((await api("backupStatus")).backup); }
    catch (e) {
      $("#backupInfo").textContent = e && e.error === "unknown_action"
        ? "Apps Script를 새 버전으로 배포하면 쓸 수 있어요."
        : errText(e);
    }
  }
  $("#backupNow").addEventListener("click", async () => {
    const btn = $("#backupNow");
    btn.disabled = true; btn.textContent = "백업 중… (사진이 많으면 몇 분 걸려요)";
    try { renderBackup((await api("backupNow")).backup); toast("백업했어요"); }
    catch (e) { $("#backupInfo").textContent = e && e.error === "unknown_action" ? "Apps Script를 새 버전으로 배포하면 쓸 수 있어요." : errText(e); }
    finally { btn.disabled = false; btn.textContent = "지금 백업하기"; }
  });
  $("#addForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const name = $("#a-name").value.trim();
    if (!name) { $("#manageErr").textContent = "이름을 입력해주세요."; $("#manageErr").hidden = false; return; }
    try {
      const data = await api("addMember", { name });
      apply(data); renderRoster(data.roster); $("#a-name").value = ""; $("#manageErr").hidden = true;
      toast(`${name}을(를) 추가했어요. ‘링크 복사’로 보내주세요`);
    } catch (e) { $("#manageErr").textContent = errText(e); $("#manageErr").hidden = false; }
  });
  $("#roster").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-act]"); if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.act === "pass+" || b.dataset.act === "pass-") {
      const cur = Number(b.parentElement.querySelector("b").textContent) || 0;
      const count = Math.max(0, cur + (b.dataset.act === "pass+" ? 1 : -1));
      b.parentElement.querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        const data = await api("setPasses", { id, count });
        apply(data); renderRoster(data.roster);
        toast(b.dataset.act === "pass+" ? "기록권을 한 장 줬어요" : "기록권을 한 장 뺐어요");
      } catch (e) { $("#manageErr").textContent = errText(e); $("#manageErr").hidden = false; renderRoster((await api("members")).roster); }
      return;
    }
    if (b.dataset.act === "copy") {
      const box = $(`#roster [data-link="${CSS.escape(id)}"]`);
      try { await navigator.clipboard.writeText(box.value); toast("링크를 복사했어요"); }
      catch (_) { box.hidden = false; box.focus(); box.select(); toast("링크를 길게 눌러 복사해주세요"); }
      return;
    }
    if (!b.classList.contains("armed")) {
      b.classList.add("armed");
      const orig = b.textContent; b.textContent = b.dataset.act === "reset" ? "예전 링크 막기?" : "정말 내보내기?";
      setTimeout(() => { if (b.isConnected) { b.classList.remove("armed"); b.textContent = orig; } }, 3500);
      return;
    }
    b.disabled = true;
    try {
      const data = await api(b.dataset.act === "reset" ? "resetKey" : "removeMember", { id });
      if (data.members) apply(data);
      renderRoster(data.roster);
      toast(b.dataset.act === "reset" ? "새 링크를 만들었어요. 다시 보내주세요" : "내보냈어요");
    } catch (e) { $("#manageErr").textContent = errText(e); $("#manageErr").hidden = false; b.disabled = false; }
  });

  // ---------- 내 몸 기록 · 인바디 · 멤버 상세 ----------
  const BODY_LABELS = { height: "키", weight: "몸무게", birthYear: "출생 연도", sex: "성별" };
  const SEX_LABEL = { F: "여성", M: "남성" };
  const IB_FIELDS = [
    ["weight", "체중", "kg"], ["muscle", "골격근량", "kg"], ["fatMass", "체지방량", "kg"], ["fatPct", "체지방률", "%"],
    ["bmi", "BMI", ""], ["bmr", "기초대사량", "kcal"], ["score", "인바디 점수", "점"],
  ];
  const TREND = [["weight", "체중", "kg"], ["muscle", "골격근량", "kg"], ["fatPct", "체지방률", "%"]];
  const fmtDate = (s) => { const d = parseYmd(s); return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`; };
  const bodyText = (k, v) => (k === "height" ? `${v}cm` : k === "weight" ? `${v}kg` : k === "birthYear" ? `${v}년생` : SEX_LABEL[v] || "");
  const myBody = () => (S.me && S.bodies[S.me.id]) || {};
  const inbodyOf = (id) => S.inbody.filter((r) => r.memberId === id);
  const adminName = () => (S.members.find((m) => m.admin) || {}).name || "관리자";

  function openZoom(id) {
    const img = $("#lightImg");
    img.dataset.alt = photoAlt(id, 2400); img.src = photoSrc(id, 2400);
    $("#lightbox").hidden = false;
  }

  // 저장 전에 무엇이 공개되는지 보여주고 확인을 받음
  function confirmVisibility({ title, pub, priv, notes }) {
    return new Promise((resolve) => {
      const li = (xs) => (xs.length ? xs.map((x) => `<li>${esc(x)}</li>`).join("") : `<li class="none">없음</li>`);
      $("#cfTitle").textContent = title;
      $("#cfPub").innerHTML = li(pub);
      $("#cfPriv").innerHTML = li(priv);
      $("#cfNotes").innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join("");
      const sheet = $("#confirmSheet");
      const done = (v) => { sheet.hidden = true; sheet.onclick = null; resolve(v); };
      $("#cfOk").onclick = () => done(true);
      $("#cfBack").onclick = () => done(false);
      sheet.onclick = (ev) => { if (ev.target === sheet) done(false); };
      sheet.hidden = false;
      $("#cfOk").focus();
    });
  }
  function privacyNotes(includesWeight) {
    const notes = [];
    if (includesWeight) notes.push("몸무게는 운동 칼로리 계산에 쓰여요. 몸무게를 공개하지 않아도 칼로리 숫자는 친구들에게 보여요.");
    notes.push("나만 보기 정보는 구글 백업 시트에 저장되고 관리자만 볼 수 있어요.");
    return notes;
  }

  // Mifflin-St Jeor 공식으로 기초대사량 추정
  function estimateBmr(b) {
    const w = latestWeight(S.me && S.me.id) || b.weight;
    if (!w || !b.height || !b.birthYear || !b.sex) return 0;
    const age = new Date().getFullYear() - b.birthYear;
    return Math.round(10 * w + 6.25 * b.height - 5 * age + (b.sex === "M" ? 5 : -161));
  }
  function latestWeight(id) {
    const list = inbodyOf(id).filter((r) => r.weight);
    return list.length ? list[list.length - 1].weight : 0;
  }

  // 측정값 하나당 작은 선 그래프 하나 (단위가 달라 한 축에 겹치지 않음)
  function trendHtml(records, metrics) {
    const W = 300, H = 92, L = 34, R = 10, T = 10, B = 20;
    const charts = (metrics || TREND).map(([k, label, unit]) => {
      const pts = records.filter((r) => r[k] != null).map((r) => ({ d: r.date, v: r[k] }));
      if (!pts.length) return "";
      const first = pts[0], last = pts[pts.length - 1];
      const delta = Math.round((last.v - first.v) * 10) / 10;
      const sub = pts.length > 1 ? `처음(${fmtDate(first.d)})보다 ${delta > 0 ? "+" : ""}${delta}${unit}` : `${fmtDate(last.d)} 측정`;
      let svg = "";
      if (pts.length > 1) {
        const ts = pts.map((p) => parseYmd(p.d).getTime());
        const t0 = ts[0], t1 = ts[ts.length - 1];
        const xs = ts.map((t, i) => (t1 > t0 ? L + ((t - t0) / (t1 - t0)) * (W - L - R) : L + (i / (pts.length - 1)) * (W - L - R)));
        let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
        if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
        const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
        const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
        const fmt = (v) => (Math.round(v * 10) / 10).toString();
        const path = pts.map((p, i) => `${i ? "L" : "M"}${xs[i].toFixed(1)},${y(p.v).toFixed(1)}`).join("");
        const dots = pts.map((p, i) => `<circle class="pt" cx="${xs[i].toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${i === pts.length - 1 ? 5 : 4}"></circle>`).join("");
        const d0 = parseYmd(first.d), d1 = parseYmd(last.d);
        svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} 변화: ${esc(pts.map((p) => `${fmtDate(p.d)} ${p.v}${unit}`).join(", "))}" data-xs="${esc(JSON.stringify(xs))}">
          <line class="grid" x1="${L}" x2="${W - R}" y1="${y(hi - pad).toFixed(1)}" y2="${y(hi - pad).toFixed(1)}"></line>
          <line class="grid" x1="${L}" x2="${W - R}" y1="${y(lo + pad).toFixed(1)}" y2="${y(lo + pad).toFixed(1)}"></line>
          <text class="axis" x="${L - 6}" y="${(y(hi - pad) + 3).toFixed(1)}" text-anchor="end">${fmt(hi - pad)}</text>
          <text class="axis" x="${L - 6}" y="${(y(lo + pad) + 3).toFixed(1)}" text-anchor="end">${fmt(lo + pad)}</text>
          <text class="axis" x="${L}" y="${H - 4}" text-anchor="start">${d0.getMonth() + 1}.${d0.getDate()}</text>
          <text class="axis" x="${W - R}" y="${H - 4}" text-anchor="end">${d1.getMonth() + 1}.${d1.getDate()}</text>
          <line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"></line>
          <path class="line" d="${path}"></path>${dots}
        </svg>`;
      }
      return `<figure class="trend" data-unit="${esc(unit)}" data-pts="${esc(JSON.stringify(pts))}">
        <figcaption><span>${label}</span><b>${last.v}${unit}</b><small>${esc(sub)}</small></figcaption>${svg}<div class="tip" hidden></div>
      </figure>`;
    }).join("");
    return charts ? `<div class="trends">${charts}</div>` : "";
  }
  function trendHover(ev) {
    const svg = ev.target.closest && ev.target.closest(".trend svg");
    document.querySelectorAll(".trend .tip:not([hidden])").forEach((t) => {
      if (svg && t.parentElement === svg.parentElement) return;
      t.hidden = true;
      const xh = t.parentElement.querySelector(".xh"); if (xh) xh.setAttribute("visibility", "hidden");
    });
    if (!svg) return;
    const fig = svg.parentElement, tip = fig.querySelector(".tip");
    const pts = JSON.parse(fig.dataset.pts), xs = JSON.parse(svg.dataset.xs);
    const rect = svg.getBoundingClientRect();
    const vx = ((ev.clientX - rect.left) / rect.width) * 300;
    let i = 0;
    xs.forEach((x, k) => { if (Math.abs(x - vx) < Math.abs(xs[i] - vx)) i = k; });
    tip.textContent = `${fmtDate(pts[i].d)} · ${pts[i].v}${fig.dataset.unit}`;
    tip.hidden = false;
    const fr = fig.getBoundingClientRect();
    // 풍선이 카드 밖으로 잘리지 않게 좌우 끝을 막음
    const half = tip.offsetWidth / 2 || 50;
    const left = Math.min(Math.max(rect.left - fr.left + (xs[i] / 300) * rect.width, half + 4), fr.width - half - 4);
    tip.style.left = `${left.toFixed(0)}px`;
    tip.style.top = `${(rect.top - fr.top - 6).toFixed(0)}px`;
    tip.hidden = false;
    const xh = svg.querySelector(".xh");
    xh.setAttribute("x1", xs[i]); xh.setAttribute("x2", xs[i]); xh.setAttribute("visibility", "visible");
  }
  document.addEventListener("pointermove", trendHover);
  document.addEventListener("pointerdown", trendHover);

  // 내 기록에 붙는 공개 상태 표시
  function pubBadge(r) {
    const keys = IB_FIELDS.filter(([k]) => r[k] != null).map(([k]) => k).concat(validFileId(r.photo) ? ["photo"] : []);
    const on = keys.filter((k) => (r.pub || []).includes(k));
    if (!on.length) return "나만 보기";
    if (on.length === keys.length) return "모두 공개";
    return "일부 공개: " + on.map((k) => (k === "photo" ? "사진" : IB_FIELDS.find((f) => f[0] === k)[1])).join(", ");
  }
  function inbodyItem(r, mine) {
    const vals = IB_FIELDS.filter(([k]) => r[k] != null).map(([k, l, u]) => `<span>${l} <b class="num">${r[k]}</b>${u}</span>`).join("");
    const acts = [
      validFileId(r.photo) ? `<button type="button" class="act" data-ib="zoom" data-id="${esc(r.photo)}">결과지 보기</button>` : "",
      mine ? `<button type="button" class="act" data-ib="edit" data-id="${esc(r.id)}">수정</button><button type="button" class="act danger" data-ib="del" data-id="${esc(r.id)}">삭제</button>` : "",
    ].join("");
    return `<div class="ibitem">
      <div class="ibtop"><b class="num">${fmtDate(r.date)}</b>${mine ? `<span class="badge">${esc(pubBadge(r))}</span>` : ""}</div>
      <div class="ibvals">${vals}</div>${acts ? `<div class="actions">${acts}</div>` : ""}
    </div>`;
  }

  // --- 내 몸 기록 ---
  function openBody() {
    const b = myBody();
    ["height", "weight", "birthYear"].forEach((k) => ($("#b-" + k).value = b[k] || ""));
    $("#b-sex").value = b.sex || "";
    $("#b-birthYear").max = new Date().getFullYear() - 5;
    const pub = b.pub || [];
    $("#bodyForm").querySelectorAll("[data-pub]").forEach((c) => (c.checked = pub.includes(c.dataset.pub)));
    $("#bodyErr").hidden = true;
    renderBodySheet();
    openSheet("bodySheet");
  }
  function renderBodySheet() {
    const b = myBody();
    const est = estimateBmr(b);
    const mine = inbodyOf(S.me && S.me.id);
    const measured = [...mine].reverse().find((r) => r.bmr);
    const parts = [];
    if (est) parts.push(`예상 기초대사량 <b>${est.toLocaleString("ko-KR")}</b>kcal/일`);
    if (measured) parts.push(`인바디 측정 <b>${measured.bmr.toLocaleString("ko-KR")}</b>kcal`);
    if (!b.weight && !latestWeight(S.me && S.me.id)) parts.push("몸무게를 입력하면 운동 칼로리가 계산돼요.");
    else if (!est) parts.push("키·출생 연도·성별까지 입력하면 기초대사량도 알려드려요.");
    $("#bmrLine").innerHTML = parts.join(" · ");
    $("#myTrend").innerHTML = trendHtml(mine);
    $("#myInbody").innerHTML = mine.length
      ? [...mine].reverse().map((r) => inbodyItem(r, true)).join("")
      : `<p class="veil-note">아직 인바디 기록이 없어요. 측정할 때마다 추가하면 변화 그래프가 그려져요.</p>`;
  }
  $("#bodyForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = { sex: $("#b-sex").value, pub: [] };
    ["height", "weight", "birthYear"].forEach((k) => (body[k] = $("#b-" + k).value === "" ? "" : Number($("#b-" + k).value)));
    $("#bodyForm").querySelectorAll("[data-pub]").forEach((c) => { if (c.checked) body.pub.push(c.dataset.pub); });
    const pub = [], priv = [];
    Object.keys(BODY_LABELS).forEach((k) => {
      if (body[k] === "" || body[k] == null) return;
      const line = `${BODY_LABELS[k]}: ${bodyText(k, body[k])}`;
      (body.pub.includes(k) ? pub : priv).push(line);
    });
    const ok = await confirmVisibility({
      title: pub.length || priv.length ? "기본 정보 공개 범위 확인" : "기본 정보를 모두 지울까요?",
      pub, priv, notes: privacyNotes(body.weight !== ""),
    });
    if (!ok) return;
    try {
      apply(await api("saveBody", { body }));
      renderBodySheet();
      toast("기본 정보를 저장했어요");
    } catch (e) { $("#bodyErr").textContent = errText(e); $("#bodyErr").hidden = false; }
  });

  // --- 인바디 작성/수정 ---
  const IB = { id: null, file: null, url: null, removed: false, from: "body" };
  const backFromInbody = () => { if (IB.from === "me") closeSheets(); else { renderBodySheet(); openSheet("bodySheet"); } };
  function setIbPreview(src) {
    if (IB.url && src !== IB.url) { URL.revokeObjectURL(IB.url); IB.url = null; }
    const img = $("#i-preview");
    if (src) { img.src = src; img.hidden = false; } else { img.removeAttribute("src"); img.hidden = true; }
    $("#i-removePhoto").hidden = !src;
    $("#i-pick").textContent = src ? "다른 사진" : "사진 선택";
  }
  function openInbody(id) {
    const r = id ? S.inbody.find((x) => x.id === id) : null;
    IB.id = r ? r.id : null; IB.file = null; IB.removed = false;
    $("#ibTitle").textContent = r ? "인바디 기록 수정" : "인바디 기록 추가";
    $("#i-date").value = r ? r.date : ymd(new Date());
    $("#i-date").max = ymd(new Date());
    IB_FIELDS.forEach(([k]) => ($("#i-" + k).value = r && r[k] != null ? r[k] : ""));
    $("#i-photo").value = "";
    setIbPreview(r && validFileId(r.photo) ? photoSrc(r.photo, 800) : null);
    const pub = (r && r.pub) || [];
    $("#inbodyForm").querySelectorAll("[data-ipub]").forEach((c) => (c.checked = pub.includes(c.dataset.ipub)));
    $("#ibErr").hidden = true;
    openSheet("inbodySheet");
  }
  // 키를 알면 체중으로 BMI 칸을 미리 채워줌
  $("#i-weight").addEventListener("input", () => {
    const h = myBody().height, w = Number($("#i-weight").value);
    if (h && w && !$("#i-bmi").dataset.touched) $("#i-bmi").value = (Math.round((w / ((h / 100) ** 2)) * 10) / 10).toString();
  });
  $("#i-bmi").addEventListener("input", () => ($("#i-bmi").dataset.touched = "1"));
  $("#inbodyForm").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-ipall]"); if (!b) return;
    $("#inbodyForm").querySelectorAll("[data-ipub]").forEach((c) => (c.checked = b.dataset.ipall === "1"));
  });
  $("#i-photo").addEventListener("change", () => {
    const f = $("#i-photo").files[0]; if (!f) return;
    IB.file = f; IB.removed = false;
    const url = URL.createObjectURL(f);
    setIbPreview(url); IB.url = url;
  });
  $("#i-removePhoto").addEventListener("click", () => { IB.file = null; IB.removed = true; $("#i-photo").value = ""; setIbPreview(null); });
  $("#ibCancel").addEventListener("click", () => { delete $("#i-bmi").dataset.touched; backFromInbody(); });
  $("#addInbody").addEventListener("click", () => { delete $("#i-bmi").dataset.touched; IB.from = "body"; openInbody(null); });

  $("#inbodyForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const err = $("#ibErr");
    const pubKeys = [...$("#inbodyForm").querySelectorAll("[data-ipub]:checked")].map((c) => c.dataset.ipub);
    const record = { id: IB.id || undefined, date: $("#i-date").value, pub: pubKeys, removePhoto: IB.removed };
    IB_FIELDS.forEach(([k]) => (record[k] = $("#i-" + k).value === "" ? "" : Number($("#i-" + k).value)));
    if (!validDate(record.date)) { err.textContent = "측정일을 골라주세요."; err.hidden = false; return; }
    const filled = IB_FIELDS.filter(([k]) => record[k] !== "");
    if (!filled.length) { err.textContent = "측정값을 하나 이상 입력해주세요."; err.hidden = false; return; }
    err.hidden = true;
    const hasPhoto = !!IB.file || (!IB.removed && IB.id && validFileId((S.inbody.find((x) => x.id === IB.id) || {}).photo));
    const pub = [], priv = [];
    filled.forEach(([k, l, u]) => (pubKeys.includes(k) ? pub : priv).push(`${l} ${record[k]}${u}`));
    if (hasPhoto) (pubKeys.includes("photo") ? pub : priv).push("결과지 사진");
    const ok = await confirmVisibility({
      title: `인바디 기록(${fmtDate(record.date)}) 공개 범위 확인`,
      pub, priv, notes: privacyNotes(record.weight !== ""),
    });
    if (!ok) return;
    const btn = $("#ibSave"); btn.disabled = true;
    try {
      if (IB.file) {
        btn.textContent = "사진 올리는 중…";
        const blob = await shrink(IB.file);
        record.photo = { mime: blob.type || "image/jpeg", data: await toBase64(blob) };
      }
      apply(await api("saveInbody", { record }));
      delete $("#i-bmi").dataset.touched;
      backFromInbody();
      toast("인바디 기록을 저장했어요");
    } catch (e) { err.textContent = errText(e); err.hidden = false; }
    finally { btn.disabled = false; btn.textContent = "저장"; }
  });

  async function inbodyAction(ev, from) {
    const b = ev.target.closest("[data-ib]"); if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.ib === "zoom") return openZoom(id);
    if (b.dataset.ib === "edit") { IB.from = from; $("#i-bmi").dataset.touched = "1"; return openInbody(id); }
    if (!b.classList.contains("armed")) {
      b.classList.add("armed"); b.textContent = "한 번 더 누르면 삭제";
      setTimeout(() => { if (b.isConnected) { b.classList.remove("armed"); b.textContent = "삭제"; } }, 3500);
      return;
    }
    b.disabled = true;
    try { apply(await api("deleteInbody", { id })); if (from === "body") renderBodySheet(); toast("삭제했어요"); }
    catch (e) { toast(errText(e)); b.disabled = false; }
  }
  $("#myInbody").addEventListener("click", (ev) => inbodyAction(ev, "body"));
  $("#mePage").addEventListener("click", (ev) => {
    if (ev.target.closest("#meAddInbody")) { delete $("#i-bmi").dataset.touched; IB.from = "me"; return openInbody(null); }
    if (ev.target.closest("#meEditBody")) return openBody();
    if (ev.target.closest("#meEditProfile")) return $("#rename").click();
    if (ev.target.closest("#meTheme")) return $("#openTheme").click();
    inbodyAction(ev, "me");
  });

  // --- 업적과 레벨: 운동 기록만으로 계산 (모든 멤버에게 같은 결과) ---
  const ICONS = {
    trophy: '<path d="M5 2.5h6v3a3 3 0 0 1-6 0zM5 3.5H3a2 2 0 0 0 2 3M11 3.5h2a2 2 0 0 1-2 3M8 8.5v3M5.5 13.5h5"/>',
    star: '<path d="M8 2l1.8 3.8 4 .5-3 2.8.8 4L8 11.2 4.4 13.1l.8-4-3-2.8 4-.5z"/>',
    bolt: '<path d="M9 1.8 3.8 9H8l-1 5.2L12.2 7H8z"/>',
    calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3M5.5 9.5l1.6 1.6L10.5 8"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.2 1.4"/>',
    route: '<circle cx="3.5" cy="12" r="1.5"/><circle cx="12.5" cy="4" r="1.5"/><path d="M5 12h4.5a2.2 2.2 0 0 0 0-4.4h-3a2.2 2.2 0 0 1 0-4.4H11"/>',
    flame: '<path d="M8 1.8c.4 2.3 3.6 3.6 3.6 7A3.6 3.6 0 0 1 4.4 8.8c0-1.6.8-2.7 1.7-3.4.1 1.2.7 1.9 1.4 2.1C7.2 5.6 7.4 3.6 8 1.8z"/>',
    grid: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
    sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"/>',
  };
  const TIER = ["", "브론즈", "실버", "골드"];
  const ACHIEVEMENTS = [
    { id: "goal", icon: "trophy", name: "목표 연속 달성", unit: "주", tiers: [1, 4, 12], v: (s) => s.bestGoalStreak, desc: (n, c) => `주 ${c.goal}일 목표를 ${n}주 연속 달성` },
    { id: "perfect", icon: "star", name: "매일 운동한 주", unit: "번", tiers: [1, 3, 10], v: (s) => s.perfectWeeks, desc: (n) => `월~일 7일을 모두 운동한 주 ${n}번` },
    { id: "streak", icon: "bolt", name: "연속 운동", unit: "일", tiers: [3, 7, 30], v: (s) => s.bestDayStreak, desc: (n) => `${n}일 연속 운동` },
    { id: "days", icon: "calendar", name: "누적 운동일", unit: "일", tiers: [10, 50, 150], v: (s) => s.days, desc: (n) => `운동한 날 ${n}일` },
    { id: "hours", icon: "clock", name: "누적 운동 시간", unit: "시간", tiers: [10, 50, 150], v: (s) => Math.floor(s.mins / 60), desc: (n) => `운동 시간 ${n}시간` },
    { id: "distance", icon: "route", name: "누적 거리", unit: "km", tiers: [50, 200, 500], v: (s) => Math.floor(s.km), desc: (n) => `기록한 거리 ${n}km` },
    { id: "kcal", icon: "flame", name: "누적 칼로리", unit: "kcal", tiers: [10000, 50000, 150000], v: (s) => s.kcal, desc: (n) => `소모 칼로리(추정) ${n.toLocaleString("ko-KR")}kcal` },
    { id: "variety", icon: "grid", name: "다양한 종목", unit: "종목", tiers: [3, 5, 8], v: (s) => s.kinds, desc: (n) => `서로 다른 종목 ${n}가지` },
    { id: "weekend", icon: "sun", name: "주말 전사", unit: "번", tiers: [2, 8, 20], v: (s) => s.weekends, desc: (n) => `토·일 이틀 모두 운동한 주말 ${n}번` },
  ];
  const XP_RULE = "운동한 날 10XP · 주간 목표 달성 30XP · 업적 단계마다 50XP";

  // 기록권은 주간 목표(내기)에만 인정하고, 운동량·연속 운동 같은 업적에는 넣지 않음
  function statsFor(all, goal) {
    const list = all.filter((e) => !e.pass);
    const dates = [...new Set(list.map((e) => e.date))].sort();
    const set = new Set(dates);
    const betDates = [...new Set(all.map((e) => e.date))].sort();
    const betSet = new Set(betDates);
    let bestDayStreak = 0, run = 0, prev = null;
    dates.forEach((d) => {
      const t = parseYmd(d);
      run = prev && Math.round((t - prev) / 864e5) === 1 ? run + 1 : 1;
      bestDayStreak = Math.max(bestDayStreak, run); prev = t;
    });
    let bestGoalStreak = 0, goalWeeks = 0, perfectWeeks = 0, weekends = 0;
    if (betDates.length) {
      const thisMon = mondayOf(new Date());
      let w = mondayOf(parseYmd(betDates[0])), streak = 0, guard = 0;
      while (w <= thisMon && guard++ < 1000) {
        let n = 0, bet = 0;
        for (let k = 0; k < 7; k++) { const d = ymd(addDays(w, k)); if (set.has(d)) n++; if (betSet.has(d)) bet++; }
        if (bet >= goal) { goalWeeks++; streak++; bestGoalStreak = Math.max(bestGoalStreak, streak); }
        else if (+w !== +thisMon) streak = 0; // 진행 중인 이번 주는 아직 끊긴 걸로 보지 않음
        if (n === 7) perfectWeeks++;
        if (set.has(ymd(addDays(w, 5))) && set.has(ymd(addDays(w, 6)))) weekends++;
        w = addDays(w, 7);
      }
    }
    return {
      days: dates.length, bestDayStreak, bestGoalStreak, goalWeeks, perfectWeeks, weekends,
      mins: list.reduce((s, e) => s + (Number(e.minutes) || 0), 0),
      km: list.reduce((s, e) => s + (Number(e.km) || 0), 0),
      kcal: list.reduce((s, e) => s + (Number(e.kcal) || 0), 0),
      kinds: new Set(list.map((e) => String(e.kind || "").trim()).filter(Boolean)).size,
    };
  }
  function progressFor(memberId) {
    const c = cfg();
    const st = statsFor(S.entries.filter((e) => e.memberId === memberId), c.goal);
    const items = ACHIEVEMENTS.map((a) => {
      const value = a.v(st);
      const tier = a.tiers.filter((t) => value >= t).length;
      return { a, value, tier, next: a.tiers[tier] };
    });
    const xp = st.days * 10 + st.goalWeeks * 30 + items.reduce((s, i) => s + i.tier * 50, 0);
    const level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * xp) / 50)) / 2));
    return { st, items, xp, level, from: 50 * level * (level - 1), to: 50 * level * (level + 1) };
  }
  const medal = (it, small) => `<span class="medal t${it.tier}${small ? " sm" : ""}" title="${esc(`${it.a.name}${it.tier ? ` ${TIER[it.tier]}` : ""}`)}"><svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[it.a.icon]}</svg></span>`;
  // 멤버 카드: 레벨 + 가장 높은 업적 3개
  function medalsHtml(memberId) {
    const p = progressFor(memberId);
    const won = p.items.filter((i) => i.tier).sort((x, y) => y.tier - x.tier || ACHIEVEMENTS.indexOf(x.a) - ACHIEVEMENTS.indexOf(y.a));
    const shown = won.slice(0, 2).map((i) => medal(i, true)).join("");
    const label = `레벨 ${p.level}${won.length ? `, 업적 ${won.length}개: ${won.map((i) => `${i.a.name} ${TIER[i.tier]}`).join(", ")}` : ""}`;
    return `<button type="button" class="medals" data-member="${esc(memberId)}" aria-label="${esc(label)}" title="${esc(label)}"><span class="lv">Lv.${p.level}</span>${shown}${won.length > 2 ? `<span class="more">+${won.length - 2}</span>` : ""}</button>`;
  }
  // 내 페이지·멤버 상세의 업적 목록
  function achievementsHtml(memberId, mine) {
    const p = progressFor(memberId), c = cfg();
    const pct = Math.min(100, ((p.xp - p.from) / (p.to - p.from)) * 100);
    const cards = p.items.map((it) => {
      const goalN = it.next || it.a.tiers[it.a.tiers.length - 1];
      const base = it.tier ? it.a.tiers[it.tier - 1] : 0;
      const prog = it.next ? Math.min(100, ((it.value - base) / (it.next - base)) * 100) : 100;
      const val = it.a.unit === "kcal" ? it.value.toLocaleString("ko-KR") : it.value;
      return `<div class="ach${it.tier ? "" : " locked"}">
        ${medal(it)}
        <div class="achtext">
          <b>${esc(it.a.name)}${it.tier ? ` <span class="tiername t${it.tier}">${TIER[it.tier]}</span>` : ""}</b>
          <span>${esc(it.next ? `다음: ${it.a.desc(goalN, c)}` : `최고 단계 달성: ${it.a.desc(goalN, c)}`)}</span>
          <span class="achbar"><span style="width:${prog.toFixed(0)}%"></span></span>
          <small class="num">${esc(String(val))}${it.a.unit}${it.next ? ` / ${it.a.unit === "kcal" ? goalN.toLocaleString("ko-KR") : goalN}${it.a.unit}` : ""}</small>
        </div>
      </div>`;
    }).join("");
    return `<div class="levelcard">
        <div class="lvbig">Lv.${p.level}</div>
        <div class="lvinfo">
          <span class="achbar"><span style="width:${pct.toFixed(0)}%"></span></span>
          <small class="num">${p.xp.toLocaleString("ko-KR")} XP · 다음 레벨까지 ${(p.to - p.xp).toLocaleString("ko-KR")} XP</small>
          ${mine ? `<small>${XP_RULE}</small>` : ""}
        </div>
      </div>
      <div class="achgrid">${cards}</div>`;
  }

  // --- 내 페이지: 내 운동 기록과 인바디 변화를 그래프로 ---
  const ALL_IB = IB_FIELDS.map(([k, l, u]) => [k, l, u]);
  const KNOTE = "칼로리는 대략적인 추정치(±20~30%)예요.";

  // 막대그래프 하나 (한 가지 값만, 범례 없이 제목이 이름 역할)
  function barChart({ title, sub, items, unit, goal, fmt }) {
    const W = 320, H = 150, L = 40, R = 8, T = 14, B = 22;
    const f = fmt || ((v) => v.toLocaleString("ko-KR"));
    const vmax = Math.max(goal || 0, ...items.map((i) => i.v), 0);
    const step = niceStep(vmax / 4);
    const top = Math.max(step, Math.ceil(vmax / step) * step);
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const band = (W - L - R) / items.length, bw = Math.min(22, band * 0.62);
    const last = items.length - 1;
    const bars = items.map((it, i) => {
      const x = L + band * i + (band - bw) / 2, y0 = y(0), yv = y(it.v), r = Math.min(4, (y0 - yv) / 2, bw / 2);
      const shape = it.v > 0
        ? `<path class="barfill" d="M${x.toFixed(1)},${y0.toFixed(1)}V${(yv + r).toFixed(1)}Q${x.toFixed(1)},${yv.toFixed(1)} ${(x + r).toFixed(1)},${yv.toFixed(1)}H${(x + bw - r).toFixed(1)}Q${(x + bw).toFixed(1)},${yv.toFixed(1)} ${(x + bw).toFixed(1)},${(yv + r).toFixed(1)}V${y0.toFixed(1)}Z"></path>`
        : "";
      const lbl = (i % 3 === last % 3) ? `<text class="axis" x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(it.label)}</text>` : "";
      return `<g class="bar" data-tip="${esc(`${it.full || it.label} · ${f(it.v)}${unit}`)}"><rect class="hit" x="${(L + band * i).toFixed(1)}" y="${T}" width="${band.toFixed(1)}" height="${H - T - B}"></rect>${shape}${lbl}</g>`;
    }).join("");
    // 목표선 (값은 제목 옆에 적혀 있어서 그래프 안에는 선만 그림)
    const goalLine = goal ? `<line class="goal" x1="${L}" x2="${W - R}" y1="${y(goal).toFixed(1)}" y2="${y(goal).toFixed(1)}"></line>` : "";
    const aria = `${title}: ` + items.map((i) => `${i.full || i.label} ${f(i.v)}${unit}`).join(", ");
    return `<figure class="chartcard"><figcaption><b>${esc(title)}</b>${sub ? `<span>${sub}</span>` : ""}</figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">
        <line class="grid" x1="${L}" x2="${W - R}" y1="${y(top).toFixed(1)}" y2="${y(top).toFixed(1)}"></line>
        <line class="grid" x1="${L}" x2="${W - R}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"></line>
        <text class="axis" x="${L - 5}" y="${(y(top) + 3).toFixed(1)}" text-anchor="end">${esc(f(top))}</text>
        <text class="axis" x="${L - 5}" y="${(y(0) + 3).toFixed(1)}" text-anchor="end">0</text>
        ${bars}${goalLine}
      </svg><div class="tip" hidden></div></figure>`;
  }
  // 눈금 간격을 1·2·5·10 단위로 맞춤 (정수 아래로는 안 내려감)
  function niceStep(v) {
    if (v <= 1) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }
  function barHover(ev) {
    const bar = ev.target.closest && ev.target.closest(".chartcard .bar");
    document.querySelectorAll(".chartcard .tip:not([hidden])").forEach((t) => {
      if (bar && t.parentElement === bar.closest(".chartcard")) return;
      t.hidden = true;
    });
    document.querySelectorAll(".chartcard .bar.on").forEach((g) => { if (g !== bar) g.classList.remove("on"); });
    if (!bar) return;
    const fig = bar.closest(".chartcard"), tip = fig.querySelector(".tip");
    const fr = fig.getBoundingClientRect(), hr = bar.querySelector(".hit").getBoundingClientRect();
    const fill = bar.querySelector(".barfill");
    const yTop = fill ? fill.getBoundingClientRect().top : hr.bottom;
    tip.textContent = bar.dataset.tip; tip.hidden = false;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(hr.left - fr.left + hr.width / 2, half + 4), fr.width - half - 4).toFixed(0)}px`;
    tip.style.top = `${(yTop - fr.top - 6).toFixed(0)}px`;
    bar.classList.add("on");
  }
  document.addEventListener("pointermove", barHover);
  document.addEventListener("pointerdown", barHover);

  // 내 페이지: 내 벌금만 (누계, 이번 주 진행 상황, 벌금이 생긴 주 목록)
  function myFinesHtml() {
    const c = cfg();
    const me = members().find((m) => S.me && m.id === S.me.id);
    if (!me) return "";
    const weeks = fineWeeks(me);
    const fs = mondayOf(parseYmd(c.start));
    const thisMon = mondayOf(new Date());
    const done = daysIn(me.list, thisMon).size;
    const left = 7 - ((new Date().getDay() + 6) % 7);
    const now = thisMon < fs
      ? `이번 주는 벌금 계산 전이에요.`
      : done >= c.goal ? `이번 주는 목표 달성! (${done}/${c.goal}일)`
      : c.goal - done > left ? `이번 주는 목표를 채우기 어려워요 (${done}/${c.goal}일). 일요일이 지나면 ${won(fineFor(thisMon))}이 더해져요.`
      : `이번 주 진행 중: ${done}/${c.goal}일, 오늘 포함 ${left}일 남았어요.`;
    return `<section>
        <h3>내 벌금</h3>
        <div class="tiles">
          <div class="tile"><span>누적 벌금</span><b class="${weeks.length ? "owe" : ""}">${esc(won(fineSum(weeks)))}</b></div>
          <div class="tile"><span>목표 못 채운 주</span><b>${weeks.length}<small>주</small></b></div>
        </div>
        <p class="finenow">${esc(now)}</p>
        ${weeks.length
          ? `<div class="finelist">${[...weeks].reverse().map((w) => `<div class="fl"><span class="num">${esc(weekRangeText(w))}</span><span>${w.days}/${c.goal}일</span><b class="num">${esc(won(w.fine))}</b></div>`).join("")}</div>`
          : `<p class="veil-note">아직 벌금이 없어요. ${fs.getMonth() + 1}월 ${fs.getDate()}일 주부터 계산해요.</p>`}
      </section>`;
  }

  function renderMePage() {
    if (!S.me) return;
    const c = cfg();
    const meM = S.members.find((m) => m.id === S.me.id) || { id: S.me.id, name: S.me.name };
    const list = S.entries.filter((e) => e.memberId === S.me.id);
    const b = myBody();
    const pub = b.pub || [];
    const facts = Object.keys(BODY_LABELS).filter((k) => b[k]).map((k) => `<span>${esc(bodyText(k, b[k]))}<small>${pub.includes(k) ? "공개" : "나만"}</small></span>`).join("");

    // 요약
    const real = list.filter((e) => !e.pass); // 기록권은 운동 통계에서 뺌
    const passUsed = list.length - real.length;
    const dates = new Set(real.map((e) => e.date));
    const mins = list.reduce((s, e) => s + (Number(e.minutes) || 0), 0);
    const km = Math.round(list.reduce((s, e) => s + (Number(e.km) || 0), 0) * 10) / 10;
    const steps = list.reduce((s, e) => s + (Number(e.steps) || 0), 0);
    const kcal = list.reduce((s, e) => s + (Number(e.kcal) || 0), 0);
    const thisMon = mondayOf(new Date());
    const weekDays = (mon) => daysIn(list, mon).size;
    // 연속 달성: 이번 주가 이미 달성이면 이번 주부터, 아니면 지난 주부터 거꾸로 셈
    let streak = 0, w = weekDays(thisMon) >= c.goal ? thisMon : addDays(thisMon, -7);
    while (streak < 520 && weekDays(w) >= c.goal) { streak++; w = addDays(w, -7); }
    const now = new Date();
    const monthA = ymd(new Date(now.getFullYear(), now.getMonth(), 1)), monthB = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    const monthDays = new Set(real.filter((e) => e.date >= monthA && e.date <= monthB).map((e) => e.date)).size;

    // 최근 12주
    const weeks = [];
    for (let i = 11; i >= 0; i--) {
      const mon = addDays(thisMon, -7 * i), sun = addDays(mon, 6);
      const a = ymd(mon), z = ymd(sun);
      const inW = list.filter((e) => e.date >= a && e.date <= z);
      weeks.push({
        label: `${mon.getMonth() + 1}.${mon.getDate()}`,
        full: `${mon.getMonth() + 1}.${mon.getDate()}–${sun.getMonth() + 1}.${sun.getDate()}${i === 0 ? " (이번 주)" : ""}`,
        days: new Set(inW.map((e) => e.date)).size,
        mins: inW.reduce((s, e) => s + (Number(e.minutes) || 0), 0),
        kcal: inW.reduce((s, e) => s + (Number(e.kcal) || 0), 0),
      });
    }
    // 종목별 누적 시간
    const byKind = {};
    list.forEach((e) => (byKind[e.kind || "운동"] = (byKind[e.kind || "운동"] || 0) + (Number(e.minutes) || 0)));
    const kinds = Object.entries(byKind).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).slice(0, 6);
    const kmax = kinds.length ? kinds[0][1] : 1;

    const ib = inbodyOf(S.me.id);
    const tiles = [
      ["이번 달 운동", monthDays, "일"],
      ["연속 목표 달성", streak, "주"],
      ["전체 운동일", dates.size, "일"],
      ...(passUsed ? [["사용한 기록권", passUsed, "회"]] : []),
      ["총 운동 시간", fmtMinutes(mins), ""],
    ].concat(myPasses() ? [["남은 기록권", myPasses(), "장"]] : []).concat(km ? [["총 거리", km, "km"]] : []).concat(steps ? [["총 걸음 수", steps.toLocaleString("ko-KR"), "걸음"]] : []).concat(kcal ? [["총 소모 칼로리(약)", kcal.toLocaleString("ko-KR"), "kcal"]] : []);

    $("#mePage").innerHTML = `
      <div class="mehead">${avatar(meM)}
        <div class="who"><b>${esc(meM.name || "나")}</b>${mottoHtml(meM)}${facts ? `<div class="facts">${facts}</div>` : `<span class="veil-note">‘내 몸 기록 수정’에서 키·몸무게 등을 넣을 수 있어요.</span>`}</div>
        <div class="row-btns"><button type="button" class="btn" id="meEditProfile">프로필 수정</button><button type="button" class="btn" id="meEditBody">내 몸 기록 수정</button><button type="button" class="btn" id="meTheme">테마</button></div>
      </div>
      <section>
        <h3>내 운동 요약</h3>
        <div class="tiles">${tiles.map(([l, v, u]) => `<div class="tile"><span>${l}</span><b>${esc(String(v))}${u ? `<small>${u}</small>` : ""}</b></div>`).join("")}</div>
        ${kcal ? `<p class="kcalnote">${KNOTE}</p>` : ""}
      </section>
      ${myFinesHtml()}
      <section>
        <h3>업적</h3>
        ${achievementsHtml(S.me.id, true)}
      </section>
      <section>
        <h3>최근 12주</h3>
        ${list.length ? `<div class="charts">
          ${barChart({ title: "주별 운동한 날", sub: `목표 주 ${c.goal}일${passUsed ? " · 기록권 포함" : ""}`, items: weeks.map((x) => ({ label: x.label, full: x.full, v: x.days })), unit: "일", goal: c.goal })}
          ${barChart({ title: "주별 운동 시간", items: weeks.map((x) => ({ label: x.label, full: x.full, v: x.mins })), unit: "분" })}
          ${weeks.some((x) => x.kcal) ? barChart({ title: "주별 소모 칼로리", sub: "추정치", items: weeks.map((x) => ({ label: x.label, full: x.full, v: x.kcal })), unit: "kcal" }) : ""}
          ${kinds.length ? `<figure class="chartcard"><figcaption><b>종목별 운동 시간</b><span>전체 기간</span></figcaption><div class="hbars">${kinds.map(([k, v]) => `<div class="hbar"><span class="lbl">${esc(k)}</span><span class="track"><span class="fill" style="display:block;width:${((v / kmax) * 100).toFixed(1)}%"></span></span><span class="val">${esc(fmtMinutes(v))}</span></div>`).join("")}</div></figure>` : ""}
        </div>${weeks.some((x) => x.kcal) ? `<p class="kcalnote">${KNOTE}</p>` : ""}` : `<p class="veil-note">아직 운동 기록이 없어요. ‘+ 기록하기’로 첫 기록을 남겨보세요.</p>`}
      </section>
      <section>
        <h3>인바디 변화 <button type="button" class="btn" id="meAddInbody">+ 인바디 추가</button></h3>
        ${ib.length ? trendHtml(ib, ALL_IB) + `<div class="iblist" style="margin-top:10px">${[...ib].reverse().map((r) => inbodyItem(r, true)).join("")}</div>`
          : `<p class="veil-note">아직 인바디 기록이 없어요. 측정할 때마다 추가하면 항목별 변화 그래프가 그려져요.</p>`}
      </section>`;
  }

  // --- 멤버 상세 (다른 사람이 공개한 정보만 보임) ---
  function openMember(id) {
    const m = S.members.find((x) => x.id === id); if (!m) return;
    const b = S.bodies[id] || {};
    const facts = Object.keys(BODY_LABELS).filter((k) => b[k]).map((k) => `<span>${esc(bodyText(k, b[k]))}</span>`).join("");
    const t = new Date();
    const a = ymd(new Date(t.getFullYear(), t.getMonth(), 1)), z = ymd(new Date(t.getFullYear(), t.getMonth() + 1, 0));
    const list = S.entries.filter((e) => e.memberId === id && e.date >= a && e.date <= z);
    const days = new Set(list.map((e) => e.date)).size;
    const mins = list.reduce((s, e) => s + (Number(e.minutes) || 0), 0);
    const kcal = kcalIn(list, a, z);
    const ib = inbodyOf(id);
    $("#mHead").innerHTML = `${avatar(m)}<div class="who"><b>${esc(m.name || "친구")}</b>${mottoHtml(m)}</div>`;
    $("#mBody").innerHTML = `
      <section><h4>이번 달</h4><p class="bmr">${list.length ? `운동 <b>${days}</b>일 · 총 <b>${esc(fmtMinutes(mins))}</b>${kcal ? ` · 약 <b>${kcal.toLocaleString("ko-KR")}</b>kcal` : ""}` : "이번 달 기록이 아직 없어요."}</p>${kcal ? `<p class="kcalnote">칼로리는 대략적인 추정치(±20~30%)예요.</p>` : ""}</section>
      <section><h4>업적</h4>${achievementsHtml(id, false)}</section>
      <section><h4>공개한 정보</h4>${facts ? `<div class="facts">${facts}</div>` : `<p class="veil-note">공개한 몸 정보가 없어요.</p>`}</section>
      <section><h4>인바디</h4>${ib.length ? trendHtml(ib) + `<div class="iblist">${[...ib].reverse().map((r) => inbodyItem(r, false)).join("")}</div>` : `<p class="veil-note">공개한 인바디 기록이 없어요.</p>`}</section>`;
    openSheet("memberSheet");
  }
  $("#mBody").addEventListener("click", (ev) => { const b = ev.target.closest('[data-ib="zoom"]'); if (b) openZoom(b.dataset.id); });

  // 한 마디 고치기: 연필을 누르면 그 자리에서 입력, Enter·바깥 클릭으로 저장, Esc로 취소
  const editingMotto = () => !!document.querySelector(".mottoinput");
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-motto-edit]"); if (!b) return;
    const box = b.closest(".motto"); if (box.querySelector(".mottoinput")) return;
    const cur = (S.members.find((m) => S.me && m.id === S.me.id) || {}).motto || "";
    box.innerHTML = `<input class="mottoinput" type="text" maxlength="40" placeholder="운동하자!" aria-label="나만의 한 마디">`;
    const input = box.querySelector("input");
    input.value = cur; input.focus(); input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const v = input.value.replace(/\s+/g, " ").trim();
      if (!save || v === cur) { render(); return; }
      try { apply(await api("setMotto", { motto: v })); toast(v ? "한 마디를 바꿨어요" : "기본 문구로 돌아갔어요"); }
      catch (e) { toast(errText(e)); render(); }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  });

  // ---------- 기록권 ----------
  const myPasses = () => ((S.members.find((m) => S.me && m.id === S.me.id) || {}).passes) || 0;
  function openPass() {
    const n = myPasses();
    if (!n) { toast("남은 기록권이 없어요. 관리자에게 받을 수 있어요"); return; }
    const mineDates = new Set(S.entries.filter((e) => S.me && e.memberId === S.me.id).map((e) => e.date));
    // 오늘부터 거꾸로, 기록이 없는 가장 가까운 날을 기본값으로
    let d = new Date(), guard = 0;
    while (mineDates.has(ymd(d)) && guard++ < 30) d = addDays(d, -1);
    $("#p-date").value = ymd(d); $("#p-date").max = ymd(new Date());
    $("#p-memo").value = ""; $("#passErr").hidden = true;
    $("#passInfo").textContent = `남은 기록권 ${n}장. 운동을 못 한 날 하루를 채울 수 있어요.`;
    openSheet("passSheet");
  }
  $("#passForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const date = $("#p-date").value, err = $("#passErr");
    if (!validDate(date)) { err.textContent = "날짜를 골라주세요."; err.hidden = false; return; }
    if (date > ymd(new Date())) { err.textContent = "미래 날짜에는 쓸 수 없어요."; err.hidden = false; return; }
    if (S.entries.some((e) => S.me && e.memberId === S.me.id && e.date === date)) { err.textContent = "이미 기록이 있는 날이에요. 기록이 없는 날에만 쓸 수 있어요."; err.hidden = false; return; }
    const btn = $("#passSave"); btn.disabled = true;
    try {
      apply(await api("usePass", { date, memo: $("#p-memo").value.trim() }));
      closeSheets(); toast("기록권으로 하루를 채웠어요");
      S.weekOffset = Math.round((mondayOf(parseYmd(date)) - mondayOf(new Date())) / (7 * 864e5)); render();
    } catch (e) { err.textContent = errText(e); err.hidden = false; }
    finally { btn.disabled = false; }
  });
  document.addEventListener("click", (ev) => { if (ev.target.closest("[data-usepass]")) openPass(); });

  // ---------- 이모지 반응 ----------
  const REACT_EMOJIS = ["👍", "🔥", "💪", "👏", "😂", "❤️"];
  const SMILE = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M5.6 9.6a3 3 0 0 0 4.8 0"/><circle cx="6" cy="6.6" r=".6" fill="currentColor" stroke="none"/><circle cx="10" cy="6.6" r=".6" fill="currentColor" stroke="none"/></svg>`;
  const memberName = (id) => (S.members.find((m) => m.id === id) || {}).name || "친구";
  function reactionBar(e) {
    const list = S.reactions.filter((r) => r.entryId === e.id);
    const chips = REACT_EMOJIS.map((em) => {
      const who = list.filter((r) => r.emoji === em);
      if (!who.length) return "";
      const mine = who.some((r) => S.me && r.memberId === S.me.id);
      const names = who.map((r) => memberName(r.memberId)).join(", ");
      return `<button type="button" class="react${mine ? " mine" : ""}" data-react="${em}" data-entry="${esc(e.id)}" aria-pressed="${mine}" title="${esc(names)}" aria-label="${em} ${who.length}명: ${esc(names)}">${em}<span class="num">${who.length}</span></button>`;
    }).join("");
    const picker = REACT_EMOJIS.map((em) => `<button type="button" data-react="${em}" data-entry="${esc(e.id)}" aria-label="${em} 남기기">${em}</button>`).join("");
    return `<div class="reacts">${chips}<span class="reactadd"><button type="button" class="reactbtn" data-react-open aria-label="이모지 남기기" aria-expanded="false">${SMILE}<span aria-hidden="true">+</span></button><span class="picker" hidden>${picker}</span></span></div>`;
  }
  const closePickers = (except) => document.querySelectorAll(".picker:not([hidden])").forEach((p) => {
    if (p === except) return;
    p.hidden = true; p.previousElementSibling.setAttribute("aria-expanded", "false");
  });
  // 누르자마자 화면에 반영하고, 서버 응답으로 맞춤 (실패하면 되돌림)
  async function toggleReact(entryId, emoji) {
    if (!S.me) return;
    const before = S.reactions;
    const has = before.some((r) => r.entryId === entryId && r.memberId === S.me.id && r.emoji === emoji);
    S.reactions = has
      ? before.filter((r) => !(r.entryId === entryId && r.memberId === S.me.id && r.emoji === emoji))
      : before.concat([{ entryId, memberId: S.me.id, emoji, at: Date.now() }]);
    render();
    try { apply(await api("react", { entryId, emoji })); }
    catch (e) { S.reactions = before; render(); toast(errText(e)); }
  }
  $("#feed").addEventListener("click", (ev) => {
    const open = ev.target.closest("[data-react-open]");
    if (open) {
      const p = open.nextElementSibling;
      closePickers(p);
      p.hidden = !p.hidden; open.setAttribute("aria-expanded", String(!p.hidden));
      if (!p.hidden) {
        // 화면 오른쪽으로 넘치면 오른쪽 끝에 맞춤
        p.style.left = ""; p.style.right = "";
        if (p.getBoundingClientRect().right > window.innerWidth - 8) { p.style.left = "auto"; p.style.right = "0"; }
        p.querySelector("button").focus();
      }
      return;
    }
    const r = ev.target.closest("[data-react]");
    if (r) { closePickers(); toggleReact(r.dataset.entry, r.dataset.react); }
  });
  document.addEventListener("click", (ev) => { if (!ev.target.closest(".reactadd")) closePickers(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closePickers(); });

  // ---------- 알림함 (앱 안): 친구의 새 기록 + 내 기록에 남긴 이모지 + 이번 주 목표 안내 ----------
  const seenKey = () => "healthy.notiSeen." + (S.me ? S.me.id : "");
  function notiSeen() {
    try {
      const v = Number(localStorage.getItem(seenKey()));
      if (v) return v;
      // 처음 쓰는 기기에서는 지난 소식이 한꺼번에 '새 알림'으로 뜨지 않게 지금부터 셈
      localStorage.setItem(seenKey(), String(Date.now()));
    } catch (_) {}
    return Date.now();
  }
  const ago = (t) => {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return "방금";
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
    const d = new Date(t); return `${d.getMonth() + 1}.${d.getDate()}`;
  };
  function notiItems() {
    if (!S.me) return [];
    const myId = S.me.id;
    const byEntry = Object.fromEntries(S.entries.map((e) => [e.id, e]));
    const items = [];
    S.reactions.forEach((r) => {
      const e = byEntry[r.entryId];
      if (e && e.memberId === myId && r.memberId !== myId && r.at) items.push({ at: r.at, who: r.memberId, text: `내 ${e.kind || "운동"} 기록에 ${r.emoji} 반응을 남겼어요`, entry: e });
    });
    S.entries.forEach((e) => {
      if (e.memberId !== myId && e.createdAt) items.push({ at: e.createdAt, who: e.memberId, text: e.pass ? "기록권으로 하루를 채웠어요" : `${e.kind || "운동"}${Number(e.minutes) > 0 ? ` ${e.minutes}분` : ""} 운동을 기록했어요`, entry: e });
    });
    return items.sort((a, b) => b.at - a.at).slice(0, 40);
  }
  function weekTip() {
    if (!S.me) return "";
    const c = cfg(), mon = mondayOf(new Date());
    const done = daysIn(S.entries.filter((e) => e.memberId === S.me.id), mon).size;
    const left = 7 - ((new Date().getDay() + 6) % 7);
    if (done >= c.goal) return "";
    const need = c.goal - done;
    return need > left
      ? `이번 주는 목표(주 ${c.goal}일)를 채우기 어려워요. 다음 주에 다시 도전해요!`
      : `이번 주 목표까지 ${need}일 남았어요. 이번 주는 오늘 포함 ${left}일 남았어요.`;
  }
  function updateNotiBadge() {
    if (!S.me) return;
    const seen = notiSeen();
    const n = notiItems().filter((i) => i.at > seen).length;
    $("#notiCount").hidden = !n;
    $("#notiCount").textContent = n > 99 ? "99+" : String(n);
    $("#openNoti").setAttribute("aria-label", n ? `알림 ${n}개` : "알림");
    document.title = (n ? `(${n}) ` : "") + document.title.replace(/^\(\d+\+?\) /, "");
  }
  $("#openNoti").addEventListener("click", () => {
    const seen = notiSeen();
    const items = notiItems();
    const tip = weekTip();
    $("#notiList").innerHTML =
      (tip ? `<div class="noti tip"><span class="nicon" aria-hidden="true">!</span><span class="ntext">${esc(tip)}</span></div>` : "") +
      (items.length
        ? items.map((i, k) => {
            const m = S.members.find((x) => x.id === i.who) || { id: i.who, name: "친구" };
            return `<button type="button" class="noti${i.at > seen ? " unread" : ""}" data-noti="${k}">${avatar(m)}<span class="ntext"><b>${esc(m.name || "친구")}</b>님이 ${esc(i.text)}<small>${esc(ago(i.at))}</small></span></button>`;
          }).join("")
        : `<p class="veil-note">아직 알림이 없어요.</p>`);
    $("#notiList").dataset.items = JSON.stringify(items.map((i) => i.entry.id));
    renderPushCard();
    if (PUSH_APP_ID && S.push && S.push.ready) loadOneSignal().then(() => { linkDevice(); renderPushCard(); });
    try { localStorage.setItem(seenKey(), String(Date.now())); } catch (_) {}
    openSheet("notiSheet");
    updateNotiBadge();
  });
  // 알림을 누르면 그 기록이 있는 주로 가서 보여줌
  $("#notiList").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-noti]"); if (!b) return;
    const id = JSON.parse($("#notiList").dataset.items || "[]")[Number(b.dataset.noti)];
    const e = S.entries.find((x) => x.id === id); if (!e) return;
    closeSheets();
    S.view = "week"; S.mineOnly = false;
    $("#tabAll").setAttribute("aria-pressed", "true"); $("#tabMine").setAttribute("aria-pressed", "false");
    S.weekOffset = Math.round((mondayOf(parseYmd(e.date)) - mondayOf(new Date())) / (7 * 864e5));
    render();
    const card = document.getElementById("entry-" + id);
    if (card) { card.scrollIntoView({ behavior: "smooth", block: "center" }); card.classList.remove("flash"); void card.offsetWidth; card.classList.add("flash"); }
  });

  // ---------- 휴대폰 푸시 알림 (OneSignal) ----------
  const PUSH_APP_ID = (window.HEALTHY_CONFIG && window.HEALTHY_CONFIG.oneSignalAppId) || "";
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  const pushSupported = () => "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
  const NOTIFY_LABELS = [
    ["react", "내 기록에 친구가 이모지를 남기면"],
    ["entry", "친구가 새 운동 기록을 올리면"],
    ["daily", "매일 저녁 8시, 오늘 기록이 아직 없으면"],
    ["goal", "금·토·일 저녁, 이번 주 목표가 남았으면"],
  ];
  let OS = null, osPromise = null, osLoggedIn = "";
  function loadOneSignal() {
    if (!PUSH_APP_ID || !pushSupported()) return Promise.resolve(null);
    if (osPromise) return osPromise;
    osPromise = new Promise((resolve) => {
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(async (OneSignal) => {
        try {
          await OneSignal.init({ appId: PUSH_APP_ID, serviceWorkerPath: "OneSignalSDKWorker.js", notifyButton: { enable: false } });
          OS = OneSignal;
          OneSignal.User.PushSubscription.addEventListener("change", () => renderPushCard());
          OneSignal.Notifications.addEventListener("permissionChange", () => renderPushCard());
          resolve(OneSignal);
        } catch (e) { console.warn("OneSignal init failed", e); resolve(null); }
      });
      const s = document.createElement("script");
      s.src = "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";
      s.defer = true;
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
      setTimeout(() => resolve(OS), 15000);
    });
    return osPromise;
  }
  // 이 기기를 내 알림 받는 곳으로 연결 (개인 키로 만든 비밀 값 사용)
  async function linkDevice() {
    if (!OS || !S.me || !S.me.alias || osLoggedIn === S.me.alias) return;
    try { await OS.login(S.me.alias); osLoggedIn = S.me.alias; } catch (e) { console.warn(e); }
  }
  // 이미 알림을 허용한 기기는 열 때마다 연결을 확인
  function bootPush() {
    if (PUSH_APP_ID && pushSupported() && Notification.permission === "granted") loadOneSignal().then(linkDevice);
  }
  const myLink = () => location.origin + location.pathname + "#k=" + KEY;
  function renderPushCard() {
    const box = $("#pushCard");
    if (!S.me) { box.innerHTML = ""; return; }
    const prefs = S.me.notify || ["react", "daily", "goal"];
    const prefsHtml = `<div class="pushprefs">${NOTIFY_LABELS.map(([k, l]) => `<label><input type="checkbox" data-pref="${k}"${prefs.includes(k) ? " checked" : ""}>${l}</label>`).join("")}</div>`;
    const head = (state, on) => `<div class="phead"><b>휴대폰 알림</b><span class="pstate${on ? " on" : ""}">${state}</span></div>`;
    if (!PUSH_APP_ID || !(S.push && S.push.ready)) {
      box.innerHTML = head("준비 중") + `<p>관리자가 휴대폰 알림을 설정하면 여기서 켤 수 있어요.</p>`;
      return;
    }
    if (isIOS && !isStandalone()) {
      box.innerHTML = head("홈 화면 앱 필요") + `<ol>
          <li>아래 <b>내 링크 복사</b>를 눌러요.</li>
          <li>사파리 아래쪽 <b>공유 버튼 → 홈 화면에 추가</b>를 눌러요.</li>
          <li>홈 화면에 생긴 <b>JJJ Healthy</b> 아이콘으로 열고, 복사한 링크를 붙여넣어요.</li>
          <li>그 앱의 알림함에서 <b>휴대폰 알림 받기</b>를 눌러 허용해요.</li>
        </ol><div class="row-btns"><button type="button" class="btn primary" id="copyMyLink">내 링크 복사</button></div>`;
      return;
    }
    if (!pushSupported()) {
      box.innerHTML = head("지원 안 됨") + `<p>이 브라우저에서는 휴대폰 알림을 받을 수 없어요. 아이폰은 사파리, 안드로이드는 크롬에서 열어주세요.</p>`;
      return;
    }
    if (Notification.permission === "denied") {
      box.innerHTML = head("차단됨") + `<p>이 기기에서 알림이 차단돼 있어요. 휴대폰 설정에서 이 사이트(앱)의 알림을 허용한 뒤 다시 열어주세요.</p>` + prefsHtml;
      return;
    }
    const on = !!(OS && Notification.permission === "granted" && OS.User.PushSubscription.optedIn);
    box.innerHTML = head(on ? "이 기기에서 받는 중" : "꺼짐", on) +
      (on
        ? `<div class="row-btns"><button type="button" class="btn" id="pushTest">테스트 알림 보내기</button><button type="button" class="btn" id="pushOff">이 기기 알림 끄기</button></div>`
        : `<p>잠금 화면으로 알림을 받을 수 있어요. 받을 알림은 아래에서 골라요.</p><div class="row-btns"><button type="button" class="btn primary" id="pushOn">휴대폰 알림 받기</button></div>`) +
      prefsHtml;
  }
  $("#pushCard").addEventListener("click", async (ev) => {
    const id = ev.target.closest("button") && ev.target.closest("button").id;
    if (id === "copyMyLink") {
      try { await navigator.clipboard.writeText(myLink()); toast("내 링크를 복사했어요. 홈 화면 앱에서 붙여넣어 주세요"); }
      catch (_) {
        // 복사가 막힌 브라우저: 링크를 보여주고 직접 길게 눌러 복사하게 함
        const box = ev.target.closest(".row-btns");
        if (!box.querySelector("input")) box.insertAdjacentHTML("beforeend", `<input type="text" readonly class="linkbox" style="flex-basis:100%" aria-label="내 링크">`);
        const inp = box.querySelector("input"); inp.value = myLink(); inp.focus(); inp.select();
        toast("링크를 길게 눌러 복사해 주세요");
      }
      return;
    }
    if (id === "pushOn") {
      if (!OS) { toast("알림 준비 중이에요. 잠시 뒤 다시 눌러주세요"); loadOneSignal().then(() => renderPushCard()); return; }
      const btn = ev.target.closest("button"); btn.disabled = true;
      try {
        // 아이폰은 버튼을 누른 그 순간에 권한을 물어야 해서 가장 먼저 호출
        await OS.Notifications.requestPermission();
        if (Notification.permission === "granted") {
          await linkDevice();
          await OS.User.PushSubscription.optIn();
          toast("이 기기에서 휴대폰 알림을 받아요");
        } else toast("알림이 허용되지 않았어요");
      } catch (e) { console.warn(e); toast("알림을 켜지 못했어요. 다시 시도해주세요"); }
      renderPushCard();
      return;
    }
    if (id === "pushOff") {
      try { await OS.User.PushSubscription.optOut(); toast("이 기기 알림을 껐어요"); } catch (_) {}
      renderPushCard();
      return;
    }
    if (id === "pushTest") {
      const btn = ev.target.closest("button"); btn.disabled = true; btn.textContent = "보내는 중…";
      try { await api("pushTest"); toast("테스트 알림을 보냈어요. 몇 초 안에 와요"); }
      catch (e) { toast(errText(e)); }
      finally { btn.disabled = false; btn.textContent = "테스트 알림 보내기"; }
    }
  });
  $("#pushCard").addEventListener("change", async (ev) => {
    const c = ev.target.closest("[data-pref]"); if (!c) return;
    const prefs = [...$("#pushCard").querySelectorAll("[data-pref]:checked")].map((x) => x.dataset.pref);
    const before = S.me.notify;
    S.me.notify = prefs;
    try { apply(await api("setNotify", { prefs })); toast("알림 설정을 저장했어요"); }
    catch (e) { S.me.notify = before; renderPushCard(); toast(errText(e)); }
  });

  // 홈 화면 앱처럼 저장 공간이 따로인 곳에서는 링크를 붙여넣어 들어옴
  $("#pasteForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = $("#pasteLink").value.trim();
    const m = v.match(/k=([A-Za-z0-9]{16,})/) || v.match(/^([A-Za-z0-9]{16,})$/);
    if (!m) { $("#pasteErr").textContent = "링크를 다시 확인해주세요. 받은 개인 링크 전체를 붙여넣으면 돼요."; $("#pasteErr").hidden = false; return; }
    try { localStorage.setItem(KEY_STORE, m[1]); } catch (_) {}
    location.replace(location.pathname);
  });

  // 사용 가이드: 현재 규칙 숫자를 채워서 보여주고, 처음 한 번은 버튼에 점 표시
  const GUIDE_SEEN = "healthy.guideSeen";
  try { $("#guideDot").hidden = !!localStorage.getItem(GUIDE_SEEN); } catch (_) { $("#guideDot").hidden = true; }
  $("#openGuide").addEventListener("click", () => {
    const c = cfg();
    document.querySelectorAll('#guideSheet [data-g="goal"]').forEach((el) => (el.textContent = c.goal));
    document.querySelectorAll('#guideSheet [data-g="fine"]').forEach((el) => (el.textContent = won(c.fine)));
    document.querySelectorAll('#guideSheet [data-g="home"]').forEach((el) => (el.textContent = (location.host + location.pathname).replace(/\/$/, "")));
    document.querySelectorAll("#guideSheet .adminonly").forEach((el) => (el.hidden = !(S.me && S.me.role === "admin")));
    $("#guideDot").hidden = true;
    try { localStorage.setItem(GUIDE_SEEN, "1"); } catch (_) {}
    openSheet("guideSheet");
  });

  // 테마: 기기마다 저장, 색은 style.css의 [data-skin] 토큰
  const SKINS = [
    ["", "블루", "#EBEFF3", "#2147D6"], ["cherry", "체리 핑크", "#FBEFF3", "#D6336C"], ["mint", "민트", "#E9F5F0", "#0E8565"],
    ["lavender", "라벤더", "#F1EFFA", "#6D4ED8"], ["lemon", "레몬", "#FAF7E6", "#946200"], ["night", "다크 나이트", "#0F141B", "#8AA2FF"],
  ];
  function renderSkins() {
    const cur = document.documentElement.dataset.skin || "";
    $("#skins").innerHTML = SKINS.map(([id, name, bg, ac]) => `<button type="button" class="skin" data-skin="${id}" aria-pressed="${id === cur}"><span class="sw" style="background:${bg}"><i style="background:${ac}"></i></span>${name}</button>`).join("");
  }
  $("#openTheme").addEventListener("click", () => { renderSkins(); openSheet("themeSheet"); });
  $("#skins").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-skin]"); if (!b) return;
    const id = b.dataset.skin;
    if (id) document.documentElement.dataset.skin = id; else delete document.documentElement.dataset.skin;
    try { if (id) localStorage.setItem("healthy.skin", id); else localStorage.removeItem("healthy.skin"); } catch (_) {}
    renderSkins();
  });

  // ---------- page events ----------
  $("#prev").addEventListener("click", () => { if (S.view === "week") S.weekOffset--; else S.monthOffset--; render(); });
  $("#next").addEventListener("click", () => {
    if (S.view === "week" && S.weekOffset < 0) S.weekOffset++;
    else if (S.view === "month" && S.monthOffset < 0) S.monthOffset++;
    render();
  });
  function setView(v) {
    S.view = v;
    try { localStorage.setItem("healthy.view", v); } catch (_) {}
    render();
  }
  $("#viewWeek").addEventListener("click", () => setView("week"));
  $("#viewMonth").addEventListener("click", () => setView("month"));
  $("#viewMe").addEventListener("click", () => setView("me"));
  $("#tabAll").addEventListener("click", () => { S.mineOnly = false; $("#tabAll").setAttribute("aria-pressed", "true"); $("#tabMine").setAttribute("aria-pressed", "false"); render(); });
  $("#tabMine").addEventListener("click", () => { S.mineOnly = true; $("#tabMine").setAttribute("aria-pressed", "true"); $("#tabAll").setAttribute("aria-pressed", "false"); render(); });
  $("#fab").addEventListener("click", () => openEntry(null));
  $("#rules").addEventListener("click", (ev) => { if (ev.target.closest("#editRules")) openRules(); });
  $("#manage").addEventListener("click", openManage);
  $("#openBody").addEventListener("click", openBody);
  $("#board").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-member]"); if (!b) return;
    const mine = S.me && b.dataset.member === S.me.id;
    if (mine && b.classList.contains("medals")) { setView("me"); window.scrollTo(0, 0); }
    else if (mine) openBody(); else openMember(b.dataset.member);
  });
  $("#signout").addEventListener("click", () => {
    try { localStorage.removeItem(KEY_STORE); } catch (_) {}
    dropCache();
    KEY = ""; S.loaded = false;
    showGate("이 기기에서 나갔어요", "다시 들어오려면 받은 링크를 눌러주세요.");
  });
  $("#lightbox").addEventListener("click", () => ($("#lightbox").hidden = true));
  $("#lightImg").addEventListener("error", () => {
    const img = $("#lightImg");
    if (img.dataset.alt) { img.src = img.dataset.alt; img.dataset.alt = ""; }
  });

  $("#feed").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act, id = b.dataset.id;
    if (act === "zoom") {
      const img = $("#lightImg");
      img.dataset.alt = photoAlt(id, 2400); img.src = photoSrc(id, 2400);
      $("#lightbox").hidden = false;
      return;
    }
    const e = S.entries.find((x) => x.id === id); if (!e) return;
    if (act === "edit") return openEntry(id);
    if (act === "hide") {
      b.disabled = true;
      try { apply(await api("toggleHidden", { id })); toast(e.hidden ? "공개했어요" : "숨겼어요"); }
      catch (err) { toast(errText(err)); b.disabled = false; }
      return;
    }
    if (act === "del") {
      if (!b.classList.contains("armed")) {
        const orig = b.textContent;
        b.classList.add("armed"); b.textContent = "한 번 더 누르면 삭제";
        setTimeout(() => { if (b.isConnected) { b.classList.remove("armed"); b.textContent = orig; } }, 3500);
        return;
      }
      b.disabled = true;
      try { apply(await api("deleteEntry", { id })); toast("삭제했어요"); }
      catch (err) { toast(errText(err)); b.disabled = false; }
    }
  });

  // ---------- boot ----------
  if (!API) {
    showGate("아직 설정이 끝나지 않았어요", "config.js에 Apps Script 웹 앱 주소를 넣어주세요. 자세한 방법은 README.md에 있어요.");
    return;
  }
  if (!KEY) { showGate(); return; }
  $("#app").hidden = false;
  const cached = readCache();
  if (cached) apply(cached, true);
  load().then(bootPush);
  // 친구들의 새 기록을 가져오려고 1분마다, 그리고 다시 화면에 돌아왔을 때 새로고침
  setInterval(() => { if (KEY && document.visibilityState === "visible" && !anySheetOpen() && !editingMotto()) load(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (KEY && document.visibilityState === "visible" && S.loaded && !anySheetOpen() && !editingMotto()) load(); });
})();
