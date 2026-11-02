/**
 * JJJ Healthy Girl — Google Apps Script 백엔드
 *
 * 구글 시트에서 [확장 프로그램 → Apps Script]를 열고 이 파일 내용을 붙여넣어 사용합니다.
 * 설치 순서는 저장소의 README.md를 보세요.
 *
 * 모든 요청은 참가자 키(k)가 있어야 처리됩니다. 키는 members 시트에만 저장되며
 * 관리자 외에는 응답에 포함되지 않습니다.
 */

const SHEETS = {
  members: ['id', 'name', 'key', 'role', 'joinedAt', 'avatar', 'height', 'weight', 'birthYear', 'sex', 'bodyPub', 'motto'],
  entries: ['id', 'memberId', 'date', 'kind', 'minutes', 'km', 'memo', 'photoId', 'hidden', 'createdAt', 'updatedAt', 'intensity', 'speed', 'steps'],
  settings: ['key', 'value'],
  inbody: ['id', 'memberId', 'date', 'weight', 'muscle', 'fatMass', 'fatPct', 'bmi', 'bmr', 'score', 'photoId', 'public', 'createdAt', 'updatedAt', 'pubFields'],
};
// 몸 정보(members 시트)와 인바디 측정값의 허용 범위
const BODY_FIELDS = {
  height: { label: '키', min: 100, max: 250 },
  weight: { label: '몸무게', min: 20, max: 300 },
  birthYear: { label: '출생 연도', min: 1920, max: new Date().getFullYear() - 5 },
};
const INBODY_FIELDS = {
  weight: { label: '체중', min: 20, max: 300 },
  muscle: { label: '골격근량', min: 5, max: 100 },
  fatMass: { label: '체지방량', min: 0, max: 150 },
  fatPct: { label: '체지방률', min: 1, max: 70 },
  bmi: { label: 'BMI', min: 10, max: 60 },
  bmr: { label: '기초대사량', min: 500, max: 4000 },
  score: { label: '인바디 점수', min: 0, max: 120 },
};
const DEFAULT_SETTINGS = { title: '주 3회 운동 내기', goal: '3', fine: '10000', start: '', note: '', rules: '[]' };
const MAX_RULES = 20;
const PHOTO_FOLDER_NAME = 'healthy-photos';
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 최초 1회 실행: 시트 만들기, 관리자 키 발급, 사진 폴더 만들기
// ---------------------------------------------------------------------------
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach((name) => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  const settings = readSettings_();
  if (!settings.start) writeSettings_(Object.assign({}, DEFAULT_SETTINGS, settings, { start: mondayOf_(today_()) }));
  let admin = table_('members').rows.find((m) => m.role === 'admin');
  if (!admin) admin = addMember_('나', 'admin');
  photoFolder_();
  clearCache_();
  Logger.log('관리자 키: ' + admin.key);
  Logger.log('관리자 링크: <GitHub Pages 주소>#k=' + admin.key);
}

// ---------------------------------------------------------------------------
// 웹 앱 진입점
// ---------------------------------------------------------------------------
function doGet() {
  return json_({ ok: true, app: 'healthy', message: 'API가 동작 중이에요.' });
}

function doPost(e) {
  REQ_CACHE = {};
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (_) {
    return json_({ ok: false, error: 'bad_request' });
  }
  try {
    const me = auth_(req.k);
    if (!me) return json_({ ok: false, error: 'invalid_key' });
    const fn = ACTIONS[req.action];
    if (!fn) return json_({ ok: false, error: 'unknown_action' });
    return json_(Object.assign({ ok: true }, fn(me, req)));
  } catch (err) {
    return json_({ ok: false, error: err.code || 'server_error', message: String(err.message || err) });
  }
}

const ACTIONS = {
  state: (me) => stateFor_(me),

  saveEntry: (me, req) => {
    const src = req.entry || {};
    const clean = cleanEntry_(src);
    // 사진 업로드는 느리니까 잠금 밖에서 처리
    const newPhoto = src.photo && src.photo.data ? savePhoto_(me, src.photo) : '';
    let oldPhoto = '';
    try {
      withLock_(() => {
        const t = table_('entries');
        const now = String(Date.now());
        const existing = src.id ? t.rows.find((r) => r.id === src.id) : null;
        if (src.id && !existing) throw fail_('not_found', '기록을 찾을 수 없어요.');
        if (existing && existing.memberId !== me.id) throw fail_('forbidden', '본인 기록만 수정할 수 있어요.');
        let photoId = existing ? existing.photoId : '';
        if (newPhoto || src.removePhoto) {
          oldPhoto = photoId;
          photoId = newPhoto;
        }
        const row = {
          id: existing ? existing.id : 'e' + uid_(12),
          memberId: me.id,
          date: clean.date,
          kind: clean.kind,
          minutes: String(clean.minutes),
          km: String(clean.km),
          speed: clean.speed ? String(clean.speed) : '',
          steps: clean.steps ? String(clean.steps) : '',
          memo: clean.memo,
          photoId,
          hidden: clean.hidden ? 'Y' : '',
          createdAt: existing ? existing.createdAt : now,
          updatedAt: now,
          intensity: clean.intensity,
        };
        writeRow_(t.sh, existing ? existing._row : null, SHEETS.entries.map((c) => row[c]));
      });
    } catch (err) {
      if (newPhoto) trashPhoto_(newPhoto);
      throw err;
    }
    if (oldPhoto) trashPhoto_(oldPhoto);
    return stateFor_(me);
  },

  toggleHidden: (me, req) => {
    withLock_(() => {
      const t = table_('entries');
      const r = ownEntry_(t, me, req.id, false);
      t.sh.getRange(r._row, SHEETS.entries.indexOf('hidden') + 1).setNumberFormat('@').setValue(r.hidden === 'Y' ? '' : 'Y');
    });
    return stateFor_(me);
  },

  deleteEntry: (me, req) => {
    let photo = '';
    withLock_(() => {
      const t = table_('entries');
      const r = ownEntry_(t, me, req.id, true);
      photo = r.photoId;
      t.sh.deleteRow(r._row);
    });
    if (photo) trashPhoto_(photo);
    return stateFor_(me);
  },

  // 이름과 프로필 사진을 함께 바꿈. 사진을 안 바꿀 때는 rename을 써도 됨
  updateProfile: (me, req) => {
    const name = cleanName_(req.name);
    const newPhoto = req.photo && req.photo.data ? savePhoto_(me, req.photo) : '';
    let oldPhoto = '';
    try {
      withLock_(() => {
        const t = table_('members');
        // 예전 시트에는 avatar 열 제목이 없으니 제목 줄을 최신으로 맞춤
        t.sh.getRange(1, 1, 1, SHEETS.members.length).setValues([SHEETS.members]).setFontWeight('bold');
        const r = t.rows.find((m) => m.id === me.id);
        t.sh.getRange(r._row, SHEETS.members.indexOf('name') + 1).setNumberFormat('@').setValue(safe_(name));
        if (newPhoto || req.removePhoto) {
          oldPhoto = r.avatar;
          t.sh.getRange(r._row, SHEETS.members.indexOf('avatar') + 1).setNumberFormat('@').setValue(newPhoto);
        }
        me.name = name;
      });
    } catch (err) {
      if (newPhoto) trashPhoto_(newPhoto);
      throw err;
    }
    if (oldPhoto) trashPhoto_(oldPhoto);
    return stateFor_(me);
  },

  rename: (me, req) => {
    const name = cleanName_(req.name);
    withLock_(() => {
      const t = table_('members');
      const r = t.rows.find((m) => m.id === me.id);
      t.sh.getRange(r._row, SHEETS.members.indexOf('name') + 1).setNumberFormat('@').setValue(safe_(name));
      me.name = name;
    });
    return stateFor_(me);
  },

  saveSettings: (me, req) => {
    requireAdmin_(me);
    const s = req.settings || {};
    const goal = Math.round(Number(s.goal));
    if (!(goal >= 1 && goal <= 7)) throw fail_('invalid', '목표 운동일은 1에서 7 사이로 정해주세요.');
    const fine = Math.round(Number(s.fine) || 0);
    if (fine < 0 || fine > 10000000) throw fail_('invalid', '벌금 금액을 확인해주세요.');
    if (!isDate_(s.start)) throw fail_('invalid', '시작일을 골라주세요.');
    withLock_(() => writeSettings_({
      title: String(s.title || '').trim().slice(0, 40) || DEFAULT_SETTINGS.title,
      goal: String(goal),
      fine: String(fine),
      start: s.start,
      note: String(s.note || '').trim().slice(0, 60),
      rules: JSON.stringify((Array.isArray(s.rules) ? s.rules : [])
        .map((r) => String(r).trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, MAX_RULES)),
    }));
    return stateFor_(me);
  },

  // --- 몸 정보와 인바디 (항목·기록마다 공개 여부를 정함, 기본은 나만 보기) ---
  // 멤버 카드에 보이는 나만의 한 마디 (빈칸이면 기본 문구가 보임)
  setMotto: (me, req) => {
    const motto = String(req.motto || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    withLock_(() => {
      const t = table_('members');
      const r = t.rows.find((m) => m.id === me.id);
      const row = SHEETS.members.map((c) => r[c]);
      row[SHEETS.members.indexOf('motto')] = motto;
      writeRow_(t.sh, r._row, row);
    });
    return stateFor_(me);
  },

  saveBody: (me, req) => {
    const src = req.body || {};
    const vals = {};
    Object.keys(BODY_FIELDS).forEach((k) => (vals[k] = cleanNum_(src[k], BODY_FIELDS[k], k === 'birthYear' ? 0 : 1)));
    vals.sex = src.sex === 'F' || src.sex === 'M' ? src.sex : '';
    const pub = (Array.isArray(src.pub) ? src.pub : []).filter((k) => k in vals);
    withLock_(() => {
      const t = table_('members');
      const r = t.rows.find((m) => m.id === me.id);
      const row = SHEETS.members.map((c) => r[c]);
      Object.keys(vals).forEach((k) => (row[SHEETS.members.indexOf(k)] = vals[k] === null ? '' : String(vals[k])));
      row[SHEETS.members.indexOf('bodyPub')] = pub.join(',');
      writeRow_(t.sh, r._row, row);
    });
    return stateFor_(me);
  },

  saveInbody: (me, req) => {
    const src = req.record || {};
    const date = String(src.date || '');
    if (!isDate_(date) || date > addDaysStr_(today_(), 1)) throw fail_('invalid', '측정일을 확인해주세요.');
    const vals = {};
    Object.keys(INBODY_FIELDS).forEach((k) => (vals[k] = cleanNum_(src[k], INBODY_FIELDS[k], k === 'bmr' || k === 'score' ? 0 : 1)));
    if (Object.keys(vals).every((k) => vals[k] === null)) throw fail_('invalid', '측정값을 하나 이상 입력해주세요.');
    const newPhoto = src.photo && src.photo.data ? savePhoto_(me, src.photo) : '';
    let oldPhoto = '';
    try {
      withLock_(() => {
        const t = table_('inbody');
        const now = String(Date.now());
        const existing = src.id ? t.rows.find((r) => r.id === src.id) : null;
        if (src.id && !existing) throw fail_('not_found', '인바디 기록을 찾을 수 없어요.');
        if (existing && existing.memberId !== me.id) throw fail_('forbidden', '본인 기록만 수정할 수 있어요.');
        let photoId = existing ? existing.photoId : '';
        if (newPhoto || src.removePhoto) {
          oldPhoto = photoId;
          photoId = newPhoto;
        }
        const row = Object.assign({
          id: existing ? existing.id : 'b' + uid_(12),
          memberId: me.id,
          date,
          photoId,
          // 항목별 공개 (예전 방식: public = 기록 전체 공개)
          public: '',
          pubFields: inbodyPub_(src).join(','),
          createdAt: existing ? existing.createdAt : now,
          updatedAt: now,
        }, vals);
        writeRow_(t.sh, existing ? existing._row : null, SHEETS.inbody.map((c) => (row[c] === null ? '' : row[c])));
      });
    } catch (err) {
      if (newPhoto) trashPhoto_(newPhoto);
      throw err;
    }
    if (oldPhoto) trashPhoto_(oldPhoto);
    return stateFor_(me);
  },

  deleteInbody: (me, req) => {
    let photo = '';
    withLock_(() => {
      const t = table_('inbody');
      const r = ownEntry_(t, me, req.id, false);
      photo = r.photoId;
      t.sh.deleteRow(r._row);
    });
    if (photo) trashPhoto_(photo);
    return stateFor_(me);
  },

  // --- 관리자: 참가자 관리 ---
  members: (me) => {
    requireAdmin_(me);
    return { roster: roster_() };
  },

  addMember: (me, req) => {
    requireAdmin_(me);
    withLock_(() => addMember_(cleanName_(req.name), 'member'));
    return Object.assign(stateFor_(me), { roster: roster_() });
  },

  resetKey: (me, req) => {
    requireAdmin_(me);
    withLock_(() => {
      const t = table_('members');
      const r = t.rows.find((m) => m.id === req.id);
      if (!r) throw fail_('not_found', '참가자를 찾을 수 없어요.');
      if (r.id === me.id) throw fail_('invalid', '내 링크는 여기서 재발급할 수 없어요. members 시트에서 직접 바꿔주세요.');
      t.sh.getRange(r._row, SHEETS.members.indexOf('key') + 1).setNumberFormat('@').setValue(uid_(32));
    });
    return { roster: roster_() };
  },

  removeMember: (me, req) => {
    requireAdmin_(me);
    withLock_(() => {
      const t = table_('members');
      const r = t.rows.find((m) => m.id === req.id);
      if (!r) throw fail_('not_found', '참가자를 찾을 수 없어요.');
      if (r.id === me.id) throw fail_('invalid', '나 자신은 내보낼 수 없어요.');
      t.sh.deleteRow(r._row);
    });
    return Object.assign(stateFor_(me), { roster: roster_() });
  },
};

// ---------------------------------------------------------------------------
// 상태 조립: 숨긴 기록의 메모와 사진은 작성자에게만 내려보냄
// ---------------------------------------------------------------------------
function stateFor_(me) {
  const memberRows = table_('members').rows;
  const members = memberRows.map((m) => ({ id: m.id, name: m.name, joinedAt: Number(m.joinedAt) || 0, avatar: m.avatar || '', admin: m.role === 'admin', motto: m.motto || '' }));
  const ids = {};
  members.forEach((m) => (ids[m.id] = true));
  const inbodyRows = table_('inbody').rows.filter((r) => ids[r.memberId] && isDate_(r.date));
  const weightAt = weightLookup_(memberRows, inbodyRows);

  // 몸 정보: 내 것은 전부, 다른 사람 것은 공개한 항목만
  const bodies = {};
  memberRows.forEach((m) => {
    const pub = String(m.bodyPub || '').split(',').filter(Boolean);
    const mine = m.id === me.id;
    const b = {};
    ['height', 'weight', 'birthYear', 'sex'].forEach((k) => {
      if (!m[k] || (!mine && pub.indexOf(k) < 0)) return;
      b[k] = k === 'sex' ? m[k] : Number(m[k]);
    });
    if (mine) b.pub = pub;
    bodies[m.id] = b;
  });

  // 인바디: 내 기록은 전부, 다른 사람 기록은 공개한 것만
  const inbody = inbodyRows
    .map((r) => {
      const mine = r.memberId === me.id;
      const pub = r.pubFields ? r.pubFields.split(',') : r.public === 'Y' ? INBODY_PUB_KEYS : [];
      const o = { id: r.id, memberId: r.memberId, date: r.date };
      let shown = 0;
      Object.keys(INBODY_FIELDS).forEach((k) => {
        if (r[k] === '' || (!mine && pub.indexOf(k) < 0)) return;
        o[k] = Number(r[k]);
        shown++;
      });
      if (r.photoId && (mine || pub.indexOf('photo') >= 0)) { o.photo = r.photoId; shown++; }
      if (mine) o.pub = pub;
      return shown ? o : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const entries = table_('entries').rows
    .filter((r) => ids[r.memberId] && isDate_(r.date))
    .map((r) => {
      const hidden = r.hidden === 'Y';
      const e = {
        id: r.id,
        memberId: r.memberId,
        date: r.date,
        kind: r.kind,
        minutes: Number(r.minutes) || 0,
        km: Number(r.km) || 0,
        speed: Number(r.speed) || 0,
        steps: Number(r.steps) || 0,
        hidden,
        createdAt: Number(r.createdAt) || 0,
        intensity: INTENSITY[r.intensity] ? r.intensity : 'normal',
      };
      // 칼로리는 모두에게 보여줌 (몸무게 자체는 보내지 않음)
      e.kcal = kcalFor_(e, weightAt(r.memberId, r.date));
      if (!hidden || r.memberId === me.id) {
        e.memo = r.memo;
        e.photo = r.photoId || '';
      }
      return e;
    });
  return {
    me: { id: me.id, name: me.name, role: me.role },
    members,
    entries,
    bodies,
    inbody,
    settings: settingsOut_(),
  };
}

// ---------------------------------------------------------------------------
// 칼로리 추정: 소모 kcal ≈ MET × 체중(kg) × 시간(h)
// 러닝·걷기·자전거는 거리와 시간으로 속도를 구해 MET을 고름 (Compendium of Physical Activities 기준)
// ---------------------------------------------------------------------------
const SPEED_MET = {
  run: [[6.4, 6.0], [8.0, 8.3], [9.7, 9.8], [10.8, 10.5], [12.1, 11.8], [13.8, 12.8], [16.1, 16.0]],
  walk: [[3.2, 2.8], [4.0, 3.0], [4.8, 3.5], [5.6, 4.3], [6.4, 5.0], [7.2, 7.0]],
  bike: [[12, 4.0], [17.5, 6.8], [20.5, 8.0], [23.5, 10.0], [27.5, 12.0], [32, 15.8]],
};
const KIND_MET = [
  [/러닝|런닝|달리기|조깅|마라톤|트레드밀|러닝머신/, 9.0, 'run'],
  [/걷기|산책|워킹/, 3.5, 'walk'],
  [/자전거|사이클|라이딩|스피닝/, 7.5, 'bike'],
  [/줄넘기/, 11.0],
  [/계단|스텝밀|천국의 ?계단/, 8.8],
  [/크로스핏/, 8.0],
  [/클라이밍|암벽|볼더링/, 8.0],
  [/복싱|킥복싱|주짓수|태권도|유도|무술/, 7.8],
  [/수영/, 7.0],
  [/테니스|스쿼시/, 7.3],
  [/축구|풋살|구기/, 7.0],
  [/농구/, 6.5],
  [/등산|하이킹|트레킹/, 6.0],
  [/댄스|줌바|에어로빅/, 6.0],
  [/스키|스노보드/, 6.0],
  [/배드민턴/, 5.5],
  [/헬스|웨이트|근력|PT/, 5.0],
  [/골프/, 4.8],
  [/배구|탁구/, 4.0],
  [/필라테스/, 3.0],
  [/요가/, 2.5],
  [/스트레칭/, 2.3],
];
const DEFAULT_MET = 5.0;
const INTENSITY = { light: 0.8, normal: 1, hard: 1.25 };

// 러닝·걷기·자전거는 속도로 MET을 고름: 적은 속도 → 거리÷시간 → 걸음 수(보폭으로 거리 추정)÷시간 순
const STRIDE_M = { run: 1.0, walk: 0.7 };
function metFor_(e) {
  const rule = KIND_MET.find((r) => r[0].test(e.kind));
  if (rule && rule[2]) {
    const h = e.minutes / 60;
    let speed = e.speed > 0 ? e.speed : 0;
    if (!speed && e.km > 0 && h > 0) speed = e.km / h;
    if (!speed && e.steps > 0 && h > 0 && STRIDE_M[rule[2]]) speed = (e.steps * STRIDE_M[rule[2]]) / 1000 / h;
    if (speed > 0) return interp_(SPEED_MET[rule[2]], speed);
  }
  return (rule ? rule[1] : DEFAULT_MET) * (INTENSITY[e.intensity] || 1);
}

function interp_(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const a = table[i - 1], b = table[i];
      return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
    }
  }
  return table[table.length - 1][1];
}

function kcalFor_(e, kg) {
  if (!kg || !e.minutes) return null;
  return Math.round((metFor_(e) * kg * e.minutes) / 60);
}

// 그날 기준 가장 최근 인바디 체중 → 프로필 몸무게 → 가장 오래된 인바디 체중 순으로 씀
function weightLookup_(memberRows, inbodyRows) {
  const byMember = {};
  inbodyRows.forEach((r) => {
    const w = Number(r.weight);
    if (w > 0) (byMember[r.memberId] = byMember[r.memberId] || []).push({ date: r.date, w });
  });
  Object.keys(byMember).forEach((k) => byMember[k].sort((a, b) => (a.date < b.date ? -1 : 1)));
  const profile = {};
  memberRows.forEach((m) => (profile[m.id] = Number(m.weight) || 0));
  return (memberId, date) => {
    const list = byMember[memberId] || [];
    let found = 0;
    list.forEach((x) => { if (x.date <= date) found = x.w; });
    return found || profile[memberId] || (list[0] ? list[0].w : 0);
  };
}

function roster_() {
  return table_('members').rows.map((m) => ({ id: m.id, name: m.name, role: m.role, key: m.key, avatar: m.avatar || '' }));
}

// ---------------------------------------------------------------------------
// 인증과 검증
// ---------------------------------------------------------------------------
function auth_(key) {
  if (typeof key !== 'string' || key.length < 16) return null;
  const m = table_('members').rows.find((r) => r.key === key);
  return m ? { id: m.id, name: m.name, role: m.role === 'admin' ? 'admin' : 'member' } : null;
}

function requireAdmin_(me) {
  if (me.role !== 'admin') throw fail_('forbidden', '관리자만 할 수 있어요.');
}

function ownEntry_(t, me, id, allowAdmin) {
  const r = t.rows.find((x) => x.id === id);
  if (!r) throw fail_('not_found', '기록을 찾을 수 없어요.');
  if (r.memberId !== me.id && !(allowAdmin && me.role === 'admin')) throw fail_('forbidden', '본인 기록만 바꿀 수 있어요.');
  return r;
}

function cleanEntry_(src) {
  const date = String(src.date || '');
  if (!isDate_(date)) throw fail_('invalid', '날짜가 올바르지 않아요.');
  // 시간대 차이를 감안해 하루 여유를 둠
  if (date > addDaysStr_(today_(), 1)) throw fail_('invalid', '미래 날짜에는 기록할 수 없어요.');
  const kind = String(src.kind || '').trim().slice(0, 30);
  if (!kind) throw fail_('invalid', '종목을 입력해주세요.');
  return {
    date,
    kind,
    minutes: Math.max(0, Math.min(1440, Math.round(Number(src.minutes) || 0))),
    km: Math.max(0, Math.min(1000, Math.round((Number(src.km) || 0) * 10) / 10)),
    speed: Math.max(0, Math.min(100, Math.round((Number(src.speed) || 0) * 10) / 10)),
    steps: Math.max(0, Math.min(200000, Math.round(Number(src.steps) || 0))),
    memo: String(src.memo || '').trim().slice(0, 1000),
    hidden: !!src.hidden,
    intensity: INTENSITY[src.intensity] ? src.intensity : 'normal',
  };
}

const INBODY_PUB_KEYS = Object.keys(INBODY_FIELDS).concat(['photo']);
// 공개할 항목 목록. pub 배열이 없으면 예전 방식(public: true면 전부 공개)
function inbodyPub_(src) {
  if (Array.isArray(src.pub)) return src.pub.filter((k) => INBODY_PUB_KEYS.indexOf(k) >= 0);
  return src.public ? INBODY_PUB_KEYS.slice() : [];
}

// 빈칸은 null, 범위를 벗어나면 오류
function cleanNum_(v, spec, digits) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < spec.min || n > spec.max) throw fail_('invalid', spec.label + ' 값을 확인해주세요. (' + spec.min + '~' + spec.max + ')');
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function cleanName_(name) {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) throw fail_('invalid', '이름을 입력해주세요.');
  return n;
}

// ---------------------------------------------------------------------------
// 사진 (구글 드라이브)
// ---------------------------------------------------------------------------
function photoFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (_) {}
  }
  const folder = DriveApp.createFolder(PHOTO_FOLDER_NAME);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

function savePhoto_(me, photo) {
  const mime = /^image\/(jpeg|png|webp|gif)$/.test(photo.mime) ? photo.mime : 'image/jpeg';
  const bytes = Utilities.base64Decode(String(photo.data));
  if (!bytes.length) throw fail_('invalid', '사진 파일이 비어 있어요.');
  if (bytes.length > MAX_PHOTO_BYTES) throw fail_('too_large', '사진은 8MB 이하만 올릴 수 있어요.');
  const blob = Utilities.newBlob(bytes, mime, me.id + '-' + Date.now() + '.' + mime.split('/')[1]);
  const file = photoFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getId();
}

function trashPhoto_(id) {
  try {
    DriveApp.getFileById(id).setTrashed(true);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// 시트 헬퍼
// ---------------------------------------------------------------------------
function sheet_(name) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    if (name !== 'inbody') throw fail_('not_setup', '시트가 없어요. Apps Script에서 setup을 먼저 실행해주세요.');
    // 기능 추가로 새로 생긴 시트는 처음 쓸 때 만듦
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ---------------------------------------------------------------------------
// 읽기 캐시: 시트 읽기가 가장 느려서, 표 내용을 잠깐(5분) 저장해 두고 씀.
// 앱이 저장할 때(withLock_)와 시트를 직접 고칠 때(onEdit)는 바로 지움.
// ---------------------------------------------------------------------------
const CACHE_TTL = 300;
let REQ_CACHE = {};

function scriptCache_() {
  try { return CacheService.getScriptCache(); } catch (_) { return null; }
}

function clearCache_() {
  REQ_CACHE = {};
  const c = scriptCache_();
  if (c) try { c.removeAll(Object.keys(SHEETS).map((n) => 't:' + n)); } catch (_) {}
}

// 시트를 손으로 고치면 캐시를 비움 (행 삭제·추가는 최대 5분 뒤 반영)
function onEdit() {
  clearCache_();
}

function table_(name) {
  if (REQ_CACHE[name]) return REQ_CACHE[name];
  const c = scriptCache_();
  let rows = null;
  if (c) {
    try { const hit = c.get('t:' + name); if (hit) rows = JSON.parse(hit); } catch (_) {}
  }
  if (!rows) {
    rows = readRows_(sheet_(name), name);
    if (c) {
      const s = JSON.stringify(rows);
      if (s.length < 95000) try { c.put('t:' + name, s, CACHE_TTL); } catch (_) {}
    }
  }
  let sh = null;
  const t = { rows, get sh() { return sh || (sh = sheet_(name)); } };
  REQ_CACHE[name] = t;
  return t;
}

function readRows_(sh, name) {
  const cols = SHEETS[name];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, cols.length).getDisplayValues();
  const rows = [];
  vals.forEach((v, i) => {
    if (!v[0]) return;
    const o = { _row: i + 2 };
    cols.forEach((c, j) => (o[c] = String(v[j]).trim()));
    rows.push(o);
  });
  return rows;
}

// 모든 칸을 일반 텍스트로 써서 날짜·숫자 자동 변환을 막음
function writeRow_(sh, row, values) {
  // 열이 추가된 예전 시트는 제목 줄을 최신으로 맞춤
  const cols = SHEETS[sh.getName()];
  if (cols && sh.getRange(1, cols.length).getDisplayValue() !== cols[cols.length - 1]) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
  }
  if (!row) {
    row = sh.getLastRow() + 1;
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
  }
  sh.getRange(row, 1, 1, values.length).setNumberFormat('@').setValues([values.map((v) => safe_(String(v == null ? '' : v)))]);
}

// =, +, -, @ 로 시작하는 글이 수식으로 실행되지 않게 함
function safe_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function addMember_(name, role) {
  const sh = sheet_('members');
  const m = { id: 'm' + uid_(10), name, key: uid_(32), role, joinedAt: String(Date.now()), avatar: '' };
  writeRow_(sh, null, SHEETS.members.map((c) => m[c]));
  return m;
}

// 추가 규칙(rules)은 시트에 JSON 문자열로 저장하고 응답에서는 배열로 보냄
function settingsOut_() {
  const s = readSettings_();
  let rules = [];
  try { rules = JSON.parse(s.rules || '[]'); } catch (_) {}
  s.rules = Array.isArray(rules) ? rules.map(String) : [];
  return s;
}

function readSettings_() {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  table_('settings').rows.forEach((r) => {
    if (r.key in out) out[r.key] = r.value;
  });
  return out;
}

function writeSettings_(s) {
  const t = table_('settings');
  Object.keys(DEFAULT_SETTINGS).forEach((k) => {
    const existing = t.rows.find((r) => r.key === k);
    writeRow_(t.sh, existing ? existing._row : null, [k, s[k] == null ? '' : s[k]]);
    if (!existing) t.rows.push({ key: k, _row: t.sh.getLastRow() });
  });
}

// ---------------------------------------------------------------------------
// 기타
// ---------------------------------------------------------------------------
// 저장은 항상 최신 시트를 읽고 하고, 끝나면 캐시를 비움
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw fail_('busy', '다른 저장이 진행 중이에요. 잠시 뒤 다시 시도해주세요.');
  try {
    clearCache_();
    return fn();
  } finally {
    clearCache_();
    lock.releaseLock();
  }
}

function fail_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function uid_(n) {
  let s = '';
  while (s.length < n) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, n);
}

function isDate_(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function addDaysStr_(s, n) {
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function mondayOf_(s) {
  const p = s.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}
