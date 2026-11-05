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
  members: ['id', 'name', 'key', 'role', 'joinedAt', 'avatar', 'height', 'weight', 'birthYear', 'sex', 'bodyPub', 'motto', 'notify'],
  entries: ['id', 'memberId', 'date', 'kind', 'minutes', 'km', 'memo', 'photoId', 'hidden', 'createdAt', 'updatedAt', 'intensity', 'speed', 'steps'],
  settings: ['key', 'value'],
  reactions: ['id', 'entryId', 'memberId', 'emoji', 'createdAt'],
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
const REACTION_EMOJIS = ['👍', '🔥', '💪', '👏', '😂', '❤️'];
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
    let oldPhoto = '', isNew = false;
    try {
      withLock_(() => {
        const t = table_('entries');
        const now = String(Date.now());
        const existing = src.id ? t.rows.find((r) => r.id === src.id) : null;
        if (src.id && !existing) throw fail_('not_found', '기록을 찾을 수 없어요.');
        if (existing && existing.memberId !== me.id) throw fail_('forbidden', '본인 기록만 수정할 수 있어요.');
        isNew = !existing;
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
    if (isNew) notifyOthers_(me, 'entry', me.name + '님이 운동을 기록했어요', clean.kind + (clean.minutes ? ' ' + clean.minutes + '분' : '') + ' · 이모지로 응원해 주세요!');
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

  // 기록에 이모지 반응: 같은 이모지를 다시 누르면 취소
  react: (me, req) => {
    const emoji = String(req.emoji || '');
    if (REACTION_EMOJIS.indexOf(emoji) < 0) throw fail_('invalid', '고를 수 없는 이모지예요.');
    let added = null;
    withLock_(() => {
      if (!table_('entries').rows.some((r) => r.id === req.entryId)) throw fail_('not_found', '기록을 찾을 수 없어요.');
      const t = table_('reactions');
      const mine = t.rows.find((r) => r.entryId === req.entryId && r.memberId === me.id && r.emoji === emoji);
      if (mine) t.sh.deleteRow(mine._row);
      else {
        writeRow_(t.sh, null, [ 'r' + uid_(12), req.entryId, me.id, emoji, String(Date.now()) ]);
        added = table_('entries').rows.find((r) => r.id === req.entryId);
      }
    });
    if (added && added.memberId !== me.id) notifyMember_(added.memberId, 'react', me.name + '님이 ' + emoji + ' 반응을 남겼어요', '내 ' + added.kind + ' 기록 (' + added.date.slice(5).replace('-', '.') + ')');
    return stateFor_(me);
  },

  // --- 휴대폰 알림 ---
  setNotify: (me, req) => {
    const prefs = (Array.isArray(req.prefs) ? req.prefs : []).filter((k) => NOTIFY_KINDS.indexOf(k) >= 0);
    withLock_(() => {
      const t = table_('members');
      const r = t.rows.find((m) => m.id === me.id);
      const row = SHEETS.members.map((c) => r[c]);
      row[SHEETS.members.indexOf('notify')] = prefs.length ? prefs.join(',') : 'none';
      writeRow_(t.sh, r._row, row);
    });
    return stateFor_(me);
  },

  pushTest: (me) => {
    if (!pushConfig_()) throw fail_('push_off', '관리자가 아직 휴대폰 알림을 설정하지 않았어요.');
    const res = sendPush_([me.alias], '테스트 알림이에요 🔔', '이 알림이 보이면 휴대폰 알림이 잘 설정된 거예요.');
    if (!res.ok) throw fail_('push_failed', '알림을 보내지 못했어요. ' + (res.message || ''));
    if (!res.recipients) throw fail_('push_no_device', '알림을 받을 기기를 찾지 못했어요. 이 기기에서 ‘알림 받기’를 다시 눌러주세요.');
    return { sent: res.recipients };
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
  // --- 관리자: 백업 ---
  backupStatus: (me) => {
    requireAdmin_(me);
    return { backup: backupStatus_() };
  },

  backupNow: (me) => {
    requireAdmin_(me);
    try {
      return { backup: backup() };
    } catch (err) {
      if (/permission|권한|authoriz/i.test(String(err.message))) throw fail_('needs_setup', 'Apps Script 편집기에서 setupBackup을 한 번 실행해서 백업 권한을 허용해주세요.');
      throw err;
    }
  },

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
  const entryIds = {};
  entries.forEach((e) => (entryIds[e.id] = true));
  return {
    me: { id: me.id, name: me.name, role: me.role, alias: me.alias, notify: notifyPrefs_((memberRows.find((m) => m.id === me.id) || {}).notify) },
    push: { ready: !!pushConfig_() },
    members,
    entries,
    bodies,
    inbody,
    reactions: table_('reactions').rows
      .filter((r) => ids[r.memberId] && entryIds[r.entryId])
      .map((r) => ({ entryId: r.entryId, memberId: r.memberId, emoji: r.emoji, at: Number(r.createdAt) || 0 })),
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
  return m ? { id: m.id, name: m.name, role: m.role === 'admin' ? 'admin' : 'member', alias: pushAlias_(m.key) } : null;
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
    if (name !== 'inbody' && name !== 'reactions') throw fail_('not_setup', '시트가 없어요. Apps Script에서 setup을 먼저 실행해주세요.');
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

// ---------------------------------------------------------------------------
// 자동 백업: 드라이브 healthy-backup 폴더에 멤버별 폴더(기록 시트 + 사진)와 전체 기록을 만듦
//   healthy-backup/멤버별/<이름>/<이름> 기록   (운동 기록 · 인바디 · 몸 정보 탭, 매번 최신으로 덮어씀)
//   healthy-backup/멤버별/<이름>/사진/          (새로 생긴 사진만 복사, 원본을 지워도 남아 있음)
//   healthy-backup/전체 기록/JJJ Healthy Girl 백업 <날짜>  (요약 + 멤버별 탭, 최근 BACKUP_KEEP개 보관)
// 처음 한 번 Apps Script 편집기에서 setupBackup을 실행하면 권한을 받고 매주 월요일 새벽에 자동으로 돌아요.
// ---------------------------------------------------------------------------
const BACKUP_ROOT_NAME = 'healthy-backup';
const BACKUP_KEEP = 8;
const BACKUP_TIME_LIMIT_MS = 4.5 * 60 * 1000; // Apps Script 실행 제한(6분) 전에 멈추고 다음 번에 이어서 함

function setupBackup() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'backup')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('backup').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(4).create();
  const st = backup();
  Logger.log('자동 백업을 켰어요 (매주 월요일 새벽 4~5시). ' + st.note);
  Logger.log('백업 폴더: ' + st.folderUrl);
}

function backup() {
  const started = Date.now();
  clearCache_();
  const tz = Session.getScriptTimeZone();
  const stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
  const root = backupRoot_();
  const byMember = childFolder_(root, '멤버별', 'healthy:members');
  const fullDir = childFolder_(root, '전체 기록', 'healthy:full');

  const members = table_('members').rows;
  const entries = table_('entries').rows.filter((r) => isDate_(r.date)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const inbody = table_('inbody').rows.filter((r) => isDate_(r.date)).sort((a, b) => (a.date < b.date ? -1 : 1));

  let copied = 0, pending = 0;
  const summary = [['멤버', '운동한 날', '기록 수', '총 운동 시간(분)', '인바디 기록', '백업한 사진']];
  const perMember = [];

  members.forEach((m) => {
    const name = String(m.name || '이름 없음');
    const dir = childFolder_(byMember, safeFileName_(name), 'healthy:member:' + m.id);
    const photoDir = childFolder_(dir, '사진', 'healthy:photos:' + m.id);
    const myEntries = entries.filter((e) => e.memberId === m.id);
    const myInbody = inbody.filter((r) => r.memberId === m.id);

    // 사진: 이미 복사한 것(설명에 원본 id를 적어 둠)은 건너뜀
    const copies = {};
    const it = photoDir.getFiles();
    while (it.hasNext()) { const f = it.next(); const d = f.getDescription(); if (d) copies[d] = f.getId(); }
    const wanted = [];
    myEntries.forEach((e) => { if (e.photoId) wanted.push([e.photoId, e.date + '_' + e.kind]); });
    myInbody.forEach((r) => { if (r.photoId) wanted.push([r.photoId, r.date + '_인바디 결과지']); });
    if (m.avatar) wanted.push([m.avatar, '프로필 사진']);
    wanted.forEach(([id, label]) => {
      if (copies[id]) return;
      if (Date.now() - started > BACKUP_TIME_LIMIT_MS) { pending++; return; }
      try {
        const src = DriveApp.getFileById(id);
        const ext = (src.getMimeType().split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        const copy = src.makeCopy(safeFileName_(label) + '_' + id.slice(-6) + '.' + ext, photoDir);
        copy.setDescription(id);
        copies[id] = copy.getId();
        copied++;
      } catch (_) { /* 원본이 이미 완전히 지워졌으면 건너뜀 */ }
    });

    const tabs = memberTabs_(m, myEntries, myInbody, copies);
    // 멤버별 기록 시트 (같은 파일을 계속 갱신)
    const ss = memberSheet_(dir, name, m.id);
    writeTab_(ss, '운동 기록', tabs.entries);
    writeTab_(ss, '인바디', tabs.inbody);
    writeTab_(ss, '몸 정보', tabs.body);
    dropDefaultTab_(ss);

    const days = {};
    myEntries.forEach((e) => (days[e.date] = true));
    summary.push([name, Object.keys(days).length, myEntries.length, myEntries.reduce((s, e) => s + (Number(e.minutes) || 0), 0), myInbody.length, Object.keys(copies).length]);
    perMember.push({ name, tabs });
  });

  // 전체 기록 스냅샷 (요약 + 멤버별 탭)
  const full = SpreadsheetApp.create('JJJ Healthy Girl 백업 ' + stamp);
  DriveApp.getFileById(full.getId()).moveTo(fullDir);
  const settings = readSettings_();
  writeTab_(full, '요약', [['백업 시각', stamp], ['내기 이름', settings.title], ['주당 목표', settings.goal + '일'], ['미달 벌금', settings.fine + '원'], ['시작일', settings.start], []].concat(summary));
  const used = {};
  perMember.forEach((p) => {
    let tab = safeTabName_(p.name), n = 2;
    while (used[tab]) tab = safeTabName_(p.name) + ' ' + n++;
    used[tab] = true;
    writeTab_(full, tab, p.tabs.entries.concat([[], ['인바디']], p.tabs.inbody, [[], ['몸 정보']], p.tabs.body));
  });
  dropDefaultTab_(full);
  pruneSnapshots_(fullDir);

  const note = `멤버 ${members.length}명 · 기록 ${entries.length}개 · 사진 ${copied}장 새로 복사` + (pending ? ` · 남은 사진 ${pending}장은 다음 백업 때 이어서 복사` : '');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('BACKUP_LAST', String(Date.now()));
  props.setProperty('BACKUP_NOTE', note);
  return backupStatus_();
}

function backupStatus_() {
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty('BACKUP_LAST')) || 0;
  let auto = null;
  try { auto = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'backup'); } catch (_) {}
  const id = props.getProperty('BACKUP_FOLDER_ID');
  return {
    last,
    lastText: last ? Utilities.formatDate(new Date(last), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : '',
    note: props.getProperty('BACKUP_NOTE') || '',
    auto,
    folderUrl: id ? 'https://drive.google.com/drive/folders/' + id : '',
  };
}

function memberTabs_(m, list, inbodyRows, copies) {
  const link = (id) => (id ? 'https://drive.google.com/file/d/' + (copies[id] || id) + '/view' : '');
  const INT = { light: '가볍게', normal: '보통', hard: '힘들게' };
  const entries = [['날짜', '종목', '운동 시간(분)', '거리(km)', '속도(km/h)', '걸음 수', '강도', '메모', '숨김', '사진']].concat(
    list.map((e) => [e.date, e.kind, Number(e.minutes) || '', Number(e.km) || '', Number(e.speed) || '', Number(e.steps) || '', INT[e.intensity] || '보통', e.memo, e.hidden === 'Y' ? '숨김' : '', link(e.photoId)])
  );
  const inbody = [['측정일', '체중(kg)', '골격근량(kg)', '체지방량(kg)', '체지방률(%)', 'BMI', '기초대사량(kcal)', '인바디 점수', '친구에게 공개한 항목', '결과지 사진']].concat(
    inbodyRows.map((r) => {
      const pub = r.pubFields ? r.pubFields.split(',') : r.public === 'Y' ? INBODY_PUB_KEYS : [];
      const labels = pub.map((k) => (k === 'photo' ? '사진' : (INBODY_FIELDS[k] || {}).label)).filter(Boolean);
      const num = (v) => (v === '' || v == null ? '' : Number(v));
      return [r.date, num(r.weight), num(r.muscle), num(r.fatMass), num(r.fatPct), num(r.bmi), num(r.bmr), num(r.score), labels.join(', ') || '없음 (나만 보기)', link(r.photoId)];
    })
  );
  const pub = String(m.bodyPub || '').split(',');
  const sex = { F: '여성', M: '남성' };
  const body = [['항목', '값', '친구에게 공개'],
    ['이름', m.name, '공개'],
    ['한 마디', m.motto || '', '공개'],
    ['키(cm)', m.height ? Number(m.height) : '', pub.indexOf('height') >= 0 ? '공개' : '나만 보기'],
    ['몸무게(kg)', m.weight ? Number(m.weight) : '', pub.indexOf('weight') >= 0 ? '공개' : '나만 보기'],
    ['출생 연도', m.birthYear ? Number(m.birthYear) : '', pub.indexOf('birthYear') >= 0 ? '공개' : '나만 보기'],
    ['성별', sex[m.sex] || '', pub.indexOf('sex') >= 0 ? '공개' : '나만 보기'],
    ['참가일', m.joinedAt ? Utilities.formatDate(new Date(Number(m.joinedAt)), Session.getScriptTimeZone(), 'yyyy-MM-dd') : '', ''],
    ['프로필 사진', link(m.avatar), ''],
  ];
  return { entries, inbody, body };
}

function backupRoot_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('BACKUP_FOLDER_ID');
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (_) {}
  }
  const folder = DriveApp.createFolder(BACKUP_ROOT_NAME);
  props.setProperty('BACKUP_FOLDER_ID', folder.getId());
  return folder;
}

// 설명(description)에 적어 둔 키로 폴더를 찾음. 이름이 바뀌면 폴더 이름도 따라 바꿈
function childFolder_(parent, name, key) {
  const it = parent.getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getDescription() === key) { if (f.getName() !== name) f.setName(name); return f; }
  }
  const f = parent.createFolder(name);
  f.setDescription(key);
  return f;
}

function memberSheet_(dir, name, memberId) {
  const key = 'healthy:sheet:' + memberId;
  const it = dir.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getDescription() === key) {
      if (f.getName() !== name + ' 기록') f.setName(name + ' 기록');
      return SpreadsheetApp.openById(f.getId());
    }
  }
  const ss = SpreadsheetApp.create(name + ' 기록');
  const file = DriveApp.getFileById(ss.getId());
  file.moveTo(dir);
  file.setDescription(key);
  return ss;
}

function writeTab_(ss, name, rows) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  if (!rows.length) return;
  const width = Math.max.apply(null, rows.map((r) => r.length || 1));
  const data = rows.map((r) => { const out = r.map((v) => (typeof v === 'string' ? safe_(v) : v)); while (out.length < width) out.push(''); return out; });
  sh.getRange(1, 1, data.length, width).setValues(data);
  sh.getRange(1, 1, 1, width).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function dropDefaultTab_(ss) {
  ss.getSheets().forEach((sh) => {
    if (ss.getSheets().length > 1 && /^(Sheet1|시트1)$/.test(sh.getName())) ss.deleteSheet(sh);
  });
}

function pruneSnapshots_(dir) {
  const files = [];
  const it = dir.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  files.slice(BACKUP_KEEP).forEach((f) => f.setTrashed(true));
}

function safeFileName_(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 80) || '이름 없음';
}

function safeTabName_(s) {
  return String(s).replace(/[\[\]*?\/\\:']/g, ' ').trim().slice(0, 90) || '멤버';
}

// ---------------------------------------------------------------------------
// 휴대폰 푸시 알림 (OneSignal)
//   스크립트 속성 ONESIGNAL_APP_ID, ONESIGNAL_API_KEY 를 넣고, 편집기에서 setupNotifications 를 한 번 실행하세요.
//   알림 받는 사람은 멤버 id가 아니라 개인 키로 만든 비밀 값(alias)으로 정해요. 멤버 id는 모두에게 보여서,
//   그걸로 정하면 다른 사람이 남의 알림을 받아 갈 수 있기 때문이에요.
// ---------------------------------------------------------------------------
const NOTIFY_KINDS = ['react', 'entry', 'daily', 'goal'];
const NOTIFY_DEFAULT = ['react', 'daily', 'goal'];
const SITE_URL = 'https://jjj-healthy.github.io/';

function notifyPrefs_(v) {
  if (!v) return NOTIFY_DEFAULT.slice();
  if (v === 'none') return [];
  return String(v).split(',').filter((k) => NOTIFY_KINDS.indexOf(k) >= 0);
}

function pushAlias_(key) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'push:' + key, Utilities.Charset.UTF_8);
  return bytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').slice(0, 32);
}

function pushConfig_() {
  const p = PropertiesService.getScriptProperties();
  const appId = p.getProperty('ONESIGNAL_APP_ID'), key = p.getProperty('ONESIGNAL_API_KEY');
  return appId && key ? { appId, key } : null;
}

// OneSignal로 보냄. 실패해도 저장 같은 원래 동작은 막지 않음
function sendPush_(aliases, heading, message, url) {
  const cfg = pushConfig_();
  if (!cfg || !aliases.length) return { ok: false, message: '알림 설정이 없어요.' };
  try {
    const res = UrlFetchApp.fetch('https://api.onesignal.com/notifications?c=push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Key ' + cfg.key },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        app_id: cfg.appId,
        target_channel: 'push',
        include_aliases: { external_id: aliases },
        headings: { en: heading, ko: heading },
        contents: { en: message, ko: message },
        url: url || SITE_URL,
      }),
    });
    const code = res.getResponseCode();
    let body = {};
    try { body = JSON.parse(res.getContentText()); } catch (_) {}
    const noSubs = body.errors && JSON.stringify(body.errors).indexOf('not subscribed') >= 0;
    if (code >= 300 && !noSubs) return { ok: false, message: (body.errors && JSON.stringify(body.errors)) || 'HTTP ' + code };
    return { ok: true, recipients: noSubs ? 0 : body.id ? (body.recipients == null ? 1 : body.recipients) : 0 };
  } catch (err) {
    return { ok: false, message: String(err.message || err) };
  }
}

function notifyMember_(memberId, kind, heading, message) {
  const m = table_('members').rows.find((r) => r.id === memberId);
  if (m && notifyPrefs_(m.notify).indexOf(kind) >= 0) sendPush_([pushAlias_(m.key)], heading, message);
}

function notifyOthers_(me, kind, heading, message) {
  const aliases = table_('members').rows
    .filter((m) => m.id !== me.id && notifyPrefs_(m.notify).indexOf(kind) >= 0)
    .map((m) => pushAlias_(m.key));
  if (aliases.length) sendPush_(aliases, heading, message);
}

// 매일 저녁 8시쯤: 주 후반(금·토·일)에 목표가 남았으면 목표 알림, 아니면 오늘 기록이 없을 때 운동 알림
function dailyPush() {
  if (!pushConfig_()) return;
  clearCache_();
  const today = today_();
  const mon = mondayOf_(today);
  const left = 7 - Math.round((Date.parse(today) - Date.parse(mon)) / 864e5); // 오늘 포함 남은 날
  const goal = Math.max(1, Number(readSettings_().goal) || 3);
  const entries = table_('entries').rows;
  table_('members').rows.forEach((m) => {
    const prefs = notifyPrefs_(m.notify);
    const mine = entries.filter((e) => e.memberId === m.id);
    const days = {};
    mine.forEach((e) => { if (e.date >= mon && e.date <= today) days[e.date] = true; });
    const done = Object.keys(days).length;
    const need = goal - done;
    const alias = pushAlias_(m.key);
    if (prefs.indexOf('goal') >= 0 && need > 0 && need <= left && left <= 3) {
      sendPush_([alias], '이번 주 목표까지 ' + need + '일 남았어요 🔥', '이번 주는 오늘 포함 ' + left + '일 남았어요. 지금 ' + done + '/' + goal + '일!');
    } else if (prefs.indexOf('daily') >= 0 && !days[today]) {
      sendPush_([alias], '오늘 운동했나요? 💪', '운동했다면 잊지 말고 기록을 남겨주세요. 이번 주 ' + done + '/' + goal + '일');
    }
  });
}

function setupNotifications() {
  if (!pushConfig_()) throw new Error('프로젝트 설정 → 스크립트 속성에 ONESIGNAL_APP_ID 와 ONESIGNAL_API_KEY 를 먼저 넣어주세요.');
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'dailyPush')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyPush').timeBased().everyDays(1).atHour(20).create();
  // 외부 연결 권한 확인용으로 한 번 호출 (받을 사람이 없어도 괜찮음)
  const res = sendPush_(['setup-check'], '알림 설정 확인', '이 알림은 아무에게도 가지 않아요.');
  Logger.log(res.ok ? '휴대폰 알림을 켰어요. 매일 저녁 8~9시에 알림을 확인해요.' : 'OneSignal 연결 확인 실패: ' + res.message);
}
