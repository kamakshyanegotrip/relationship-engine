/* Relationship Engine web app — talks to the n8n PRE-05 Web App API. No build step. */
(function () {
  'use strict';

  // ---------- settings & storage ----------
  const DEFAULT_API = 'https://n8n.assignover.in/webhook/pre-api';
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pre_' + k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pre_' + k, v); } catch (e) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem('pre_' + k); } catch (e) { /* ignore */ } }
  };

  const S = {
    apiUrl: store.get('api', DEFAULT_API),
    key: store.get('key', ''),
    data: null,
    mode: 'demo',
    loading: false,
    lastSync: null,
    error: '',
    view: 'today',
    drawer: null,
    filters: { q: '', status: '', campaign: '' },
    sort: { col: 'priority_score', dir: -1 },
    bulkRows: [],
    findCamp: store.get('lastcamp', ''),
    find: Object.assign({ loc: '', ent: '', dept: '', topic: '' }, (() => { try { return JSON.parse(store.get('find', '{}')) || {}; } catch (e) { return {}; } })()),
    capture: null,
    captureDone: ''
  };
  (function readCapture() {
    const m = (location.hash || '').match(/^#capture=(.+)$/);
    if (!m) return;
    try {
      const d = JSON.parse(decodeURIComponent(m[1]));
      if (d && d.u) { S.capture = d; S.view = 'add'; }
    } catch (e) { /* ignore a malformed capture link */ }
    try { history.replaceState(null, '', '#add'); } catch (e) { /* ignore */ }
  })();
  const APP_URL = location.origin + location.pathname;
  const BOOKMARKLET_CODE = "(()=>{const u=location.href.split('?')[0].split('#')[0];if(!/linkedin\\.com\\/in\\//.test(u)){alert('Open a LinkedIn profile page (linkedin.com/in/...) first, then click this button.');return;}const q=s=>{const e=document.querySelector(s);return e?e.innerText.trim():'';};const m=document.querySelector('main')||document.body;const d={u:u,n:q('h1'),h:q('.text-body-medium'),l:q('.text-body-small.inline'),t:m.innerText.replace(/\\n{2,}/g,'\\n').slice(0,3500)};window.open('" + APP_URL + "#capture='+encodeURIComponent(JSON.stringify(d)),'re_capture');})();";
  const BOOKMARKLET = 'javascript:' + encodeURIComponent(BOOKMARKLET_CODE);

  const theme = store.get('theme', 'system');
  if (theme !== 'system') document.documentElement.setAttribute('data-theme', theme);

  // ---------- helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const todayISO = () => { const t = new Date(); t.setMinutes(t.getMinutes() - t.getTimezoneOffset()); return t.toISOString().slice(0, 10); };
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    if (isNaN(d)) return esc(iso);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };
  const relDays = (iso) => {
    if (!iso) return '';
    const a = new Date(todayISO() + 'T00:00:00'), b = new Date(iso.slice(0, 10) + 'T00:00:00');
    const n = Math.round((b - a) / 86400000);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    return n > 0 ? 'in ' + n + ' days' : Math.abs(n) + ' days ago';
  };
  const isDnc = (c) => c.do_not_contact === true || c.do_not_contact === 'true' || c.unsubscribed === true || c.status === 'UNSUBSCRIBED';
  const num = (v) => Number(v || 0);

  const STAGES = [
    { key: 'IDENTIFIED', label: 'Found', group: 'new' },
    { key: 'RESEARCHED', label: 'Researched', group: 'new' },
    { key: 'QUALIFIED', label: 'Qualified (no LinkedIn yet)', group: 'ready' },
    { key: 'READY_FOR_CONNECTION', label: 'Ready to connect', group: 'ready' },
    { key: 'FOLLOWING', label: 'Following', group: 'wait' },
    { key: 'CONNECTION_SENT', label: 'Request sent', group: 'wait' },
    { key: 'CONNECTED', label: 'Connected', group: 'conn' },
    { key: 'FIRST_CONVERSATION', label: 'First conversation', group: 'conn' },
    { key: 'ENGAGED', label: 'Engaged', group: 'hot' },
    { key: 'OPPORTUNITY', label: 'Opportunity', group: 'hot' },
    { key: 'COLLABORATION', label: 'Collaboration', group: 'hot' },
    { key: 'NURTURE', label: 'Nurture', group: 'conn' },
    { key: 'IGNORED', label: 'Not accepted', group: 'dead' },
    { key: 'DECLINED', label: 'Declined', group: 'dead' },
    { key: 'NOT_RELEVANT', label: 'Not relevant', group: 'dead' },
    { key: 'UNSUBSCRIBED', label: 'Unsubscribed', group: 'dead' },
    { key: 'DO_NOT_CONTACT', label: 'Do not contact', group: 'dead' }
  ];
  const stageOf = (k) => STAGES.find((s) => s.key === k) || { key: k, label: String(k || 'Unknown').replace(/_/g, ' ').toLowerCase(), group: 'ready' };
  const PILL = { new: 's-new', ready: 's-ready', wait: 's-wait', conn: 's-conn', hot: 's-hot', dead: 's-dead' };
  const statusPill = (k) => { const s = stageOf(k); return '<span class="pill ' + PILL[s.group] + '">' + esc(s.label) + '</span>'; };
  const ACTIVE_FOLLOW = ['CONNECTED', 'FIRST_CONVERSATION', 'ENGAGED', 'OPPORTUNITY', 'COLLABORATION', 'NURTURE'];

  const campaigns = () => (S.data ? S.data.campaigns : []);
  const campaignName = (code) => { const c = campaigns().find((x) => x.campaign_code === code); return c ? c.campaign_name : (code || '—'); };
  const cleanPhone = (v) => String(v || '').replace(/[^\d+]/g, '').slice(0, 20);
  const waLink = (ph, text) => { let d = String(ph || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return 'https://wa.me/' + d + (text ? '?text=' + encodeURIComponent(text) : ''); };
  const hasPlaceholder = (t) => /\[[^\]]{2,80}\]/.test(t || '');
  const calLink = (c) => { const t = new Date(); t.setDate(t.getDate() + 3); t.setHours(11, 0, 0, 0); const e = new Date(t.getTime() + 30 * 60000); const f = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent('Call: ' + (c.full_name || '') + (c.organization ? ' (' + c.organization + ')' : '')) + '&dates=' + f(t) + '/' + f(e) + '&details=' + encodeURIComponent((c.recommended_action || '') + '\n' + (c.linkedin_url || '')) + (c.email ? '&add=' + encodeURIComponent(c.email) : ''); };
  const CARD_API = 'https://n8n.assignover.in/webhook/pre-card';
  const CAT_ORDER = ['Travel trade', 'Medical & wellness', 'Academic & research', 'Corporate', 'Government & public sector', 'Media & community'];
  function campOptionsHtml(selected, allLabel) {
    const groups = {};
    campaigns().forEach((c) => { const g = c.category || 'Other'; (groups[g] = groups[g] || []).push(c); });
    const names = Object.keys(groups).sort((a, b) => ((CAT_ORDER.indexOf(a) + 1) || 99) - ((CAT_ORDER.indexOf(b) + 1) || 99));
    return (allLabel ? '<option value="">' + esc(allLabel) + '</option>' : '') + names.map((g) => '<optgroup label="' + esc(g) + '">' +
      groups[g].sort((a, b) => String(a.campaign_name).localeCompare(String(b.campaign_name))).map((c) => '<option value="' + esc(c.campaign_code) + '"' + (c.campaign_code === selected ? ' selected' : '') + '>' + esc(c.campaign_name) + '</option>').join('') + '</optgroup>').join('');
  }
  const contactByKey = (k) => (S.data ? S.data.contacts.find((c) => c.person_key === k) : null);
  const canEmail = (c) => !!(c && c.email && ['verified', 'likely', 'found_unverified', 'provided_unverified'].includes(c.email_status) && !isDnc(c) && c.unsubscribed !== true);
  const JOBS = [
    ['discover', 'Discover new people', 'Searches OpenAlex, Google Places, listed websites (and Google, once Serper is added) for campaigns with auto-discovery on. Also runs every Monday 6:00.'],
    ['enrich', 'Research profiles', 'Reads publications and organisation websites for up to 10 new people, writes a profile and sends them for qualification. Also runs daily 6:40.'],
    ['email', 'Find email addresses', 'Checks official websites, contact pages and public sources for missing emails. Also runs daily 7:15.'],
    ['monitor', 'Monitor & spot opportunities', 'Looks for new publications and good timing, flags research, B2B, referral and network opportunities. Also runs Wed and Sat 7:10.'],
    ['report', 'Email me the weekly report', 'Funnel, campaign targets, opportunities and relationships going cold. Also every Monday 8:25.'],
    ['sheet', 'Sync Google Sheet', 'Refreshes the mirror sheet and imports rows from its Import tab. Also every 6 hours.']
  ];
  const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1-y4kiIRBqUSsJHf04w52wttwXHATYGRbJZ7mJ6SoDjI/edit';
  async function runJob(job, extra, btn) {
    if (S.mode === 'demo') { toast('Demo mode: connect your key to run jobs.'); return; }
    if (btn) btn.disabled = true;
    try { const j = await api('run', Object.assign({ job: job }, extra || {})); toast(j.message || 'Started.'); }
    catch (e) { toast(e.message, true); } finally { if (btn) setTimeout(() => { btn.disabled = false; }, 4000); }
  }

  // ---------- API ----------
  async function api(op, payload) {
    const body = 'data=' + encodeURIComponent(JSON.stringify({ key: S.key, op: op, payload: payload || {} }));
    let res;
    try {
      res = await fetch(S.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: body });
    } catch (e) {
      throw new Error('Could not reach n8n. Check the API address in Settings and that PRE-05 is published.');
    }
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (res.status === 401) throw new Error('The access key was rejected. Re-enter it in Settings.');
    if (!res.ok || !j) throw new Error((j && j.message) || 'n8n answered with status ' + res.status + '.');
    if (j.ok === false) throw new Error(j.message || 'The request did not go through.');
    return j;
  }

  async function load(quiet) {
    if (!S.key) {
      S.mode = 'demo';
      S.data = JSON.parse(JSON.stringify(window.DEMO_DATA)); S.data.content = S.data.content || []; S.data.suppressed = 0;
      S.lastSync = null;
      render();
      return;
    }
    S.loading = true; if (!quiet) renderChrome();
    try {
      const j = await api('bootstrap');
      S.data = { contacts: j.contacts || [], campaigns: j.campaigns || [], interactions: j.interactions || [], content: j.content || [], suppressed: j.suppressed || 0 };
      S.mode = 'live'; S.error = ''; S.lastSync = new Date();
    } catch (e) {
      S.error = e.message;
      if (!S.data) { S.data = JSON.parse(JSON.stringify(window.DEMO_DATA)); S.data.content = S.data.content || []; S.mode = 'demo'; }
      toast(e.message, true);
    } finally {
      S.loading = false;
      render();
    }
  }

  // ---------- demo-mode simulation ----------
  function simulate(c, action) {
    const t = todayISO();
    const plus = (n) => { const d = new Date(t + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const map = {
      sent: () => Object.assign(c, { status: 'CONNECTION_SENT', next_followup_date: plus(10), last_contact_date: t, last_contact_summary: 'Connection request sent' }),
      followed: () => Object.assign(c, { status: 'FOLLOWING', next_followup_date: plus(14) }),
      later: () => Object.assign(c, { next_followup_date: plus(3) }),
      notrelevant: () => Object.assign(c, { status: 'NOT_RELEVANT', next_followup_date: '' }),
      accepted: () => Object.assign(c, { status: 'CONNECTED', connection_date: t, next_followup_date: plus(3) }),
      resend: () => Object.assign(c, { status: 'READY_FOR_CONNECTION', next_followup_date: '' }),
      noresponse: () => Object.assign(c, { status: 'IGNORED', next_followup_date: '' }),
      fu_linkedin: () => Object.assign(c, { pending_message: '', followup_count: num(c.followup_count) + 1, next_followup_date: plus(7), last_contact_date: t }),
      fu_email: () => Object.assign(c, { pending_message: '', followup_count: num(c.followup_count) + 1, next_followup_date: plus(7), last_contact_date: t }),
      replied: () => Object.assign(c, { pending_message: '', last_contact_date: t }),
      snooze: () => Object.assign(c, { next_followup_date: plus(7) }),
      dnc: () => Object.assign(c, { status: 'DO_NOT_CONTACT', do_not_contact: true, next_followup_date: '', pending_message: '' }),
      collab: () => Object.assign(c, { status: 'COLLABORATION', next_followup_date: plus(30) }),
      unsub: () => Object.assign(c, { status: 'UNSUBSCRIBED', unsubscribed: true, next_followup_date: '', pending_message: '' }),
      reopen: () => Object.assign(c, { status: 'NURTURE', do_not_contact: false, next_followup_date: plus(7) })
    };
    (map[action] || (() => {}))();
  }

  const ACTION_LABEL = {
    sent: 'Marked as request sent', followed: 'Marked as following', later: 'Hidden for 3 days', notrelevant: 'Marked not relevant',
    accepted: 'Marked as connected', resend: 'Back in the connection queue', noresponse: 'Marked as not accepted',
    fu_linkedin: 'Follow-up logged', fu_email: 'Gmail draft created', replied: 'Reply logged', snooze: 'Snoozed for 7 days', dnc: 'Marked do not contact',
    collab: 'Marked as collaboration', unsub: 'Unsubscribed from email', reopen: 'Reopened'
  };

  async function doAction(key, action, v, btn) {
    const c = contactByKey(key);
    if (!c) return;
    if (S.mode === 'demo') {
      simulate(c, action);
      toast(ACTION_LABEL[action] + ' (demo only, nothing saved)');
      render();
      return;
    }
    if (btn) btn.disabled = true;
    try {
      const j = await api('action', { person_key: key, action: action, v: v || '' });
      toast(j.message || ACTION_LABEL[action]);
      await load(true);
    } catch (e) {
      toast(e.message, true);
      if (btn) btn.disabled = false;
    }
  }

  // ---------- toast & copy ----------
  function toast(msg, err) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), err ? 7000 : 4200);
  }
  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) { const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = o; }, 1400); }
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch (e2) { toast('Select the text and copy it manually.', true); }
      ta.remove();
    }
  }

  // ---------- derived lists ----------
  function queueList() {
    const t = todayISO();
    const camps = {}; campaigns().forEach((c) => { camps[c.campaign_code] = c; });
    const ready = S.data.contacts
      .filter((c) => c.status === 'READY_FOR_CONNECTION' && !isDnc(c) && (!c.next_followup_date || c.next_followup_date <= t)
        && !(camps[c.campaign_code] && (camps[c.campaign_code].active === false || camps[c.campaign_code].active === 'false')))
      .sort((a, b) => num(b.priority_score) - num(a.priority_score));
    const per = {}; const out = [];
    ready.forEach((c) => {
      const lim = num((camps[c.campaign_code] || {}).daily_limit) || 10;
      per[c.campaign_code] = per[c.campaign_code] || 0;
      if (per[c.campaign_code] < lim && out.length < 25) { out.push(c); per[c.campaign_code]++; }
    });
    return { queue: out, backlog: ready.length - out.length };
  }
  const checksList = () => { const t = todayISO(); return S.data.contacts.filter((c) => ['CONNECTION_SENT', 'FOLLOWING'].includes(c.status) && !isDnc(c) && c.next_followup_date && c.next_followup_date <= t); };
  const draftsList = () => S.data.contacts.filter((c) => c.pending_message && !isDnc(c) && ACTIVE_FOLLOW.includes(c.status))
    .sort((a, b) => ACTIVE_FOLLOW.indexOf(b.status) - ACTIVE_FOLLOW.indexOf(a.status));
  const dueNoDraft = () => { const t = todayISO(); return S.data.contacts.filter((c) => ACTIVE_FOLLOW.includes(c.status) && !isDnc(c) && !c.pending_message && c.next_followup_date && c.next_followup_date <= t); };

  // ---------- chrome (nav, banner) ----------
  const VIEWS = [
    { id: 'today', label: 'Today' },
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'contacts', label: 'Contacts' },
    { id: 'campaigns', label: 'Campaigns' },
    { id: 'library', label: 'Library' },
    { id: 'add', label: 'Add people' },
    { id: 'guide', label: 'How it works' },
    { id: 'settings', label: 'Settings' }
  ];
  try {
    document.head.insertAdjacentHTML('beforeend', '<style>' +
      '.onboard{background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-radius:var(--radius);padding:18px;display:flex;flex-direction:column;gap:12px}' +
      '.steps{margin:0;padding-left:22px;display:flex;flex-direction:column;gap:8px}.steps li{padding-left:4px}' +
      '.guide{display:flex;flex-direction:column;gap:16px;max-width:820px}.guide p{margin:0;max-width:68ch}.guide .panel{display:flex;flex-direction:column;gap:10px}' +
      '.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{display:inline-flex;align-items:center;padding:6px 10px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--ink);text-decoration:none;font-size:12.5px;font-weight:600}.chip:hover{border-color:#0a66c2;color:#0a66c2}button.chip{cursor:pointer;font-family:inherit}.chip.on,.chip.on:hover{background:var(--accent);border-color:var(--accent);color:#fff}' +
      '.hint-line{font-size:12.5px;color:var(--ink-3);margin:-4px 0 0}' +
      '@media (max-width:760px){.mobile-nav{grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:minmax(62px,1fr);overflow-x:auto;scrollbar-width:none}}' +
      '.pill.s-new{background:var(--surface-2);color:var(--ink-2)}.progress{height:6px;border-radius:99px;background:var(--surface-2);overflow:hidden;min-width:70px}.progress>i{display:block;height:100%;background:var(--accent)}' +
      '.info{display:flex;flex-direction:column;gap:6px;font-size:13.5px}.info b{font-weight:600}.opp{border-left:3px solid var(--saffron);background:var(--saffron-soft);padding:8px 10px;border-radius:6px;font-size:13.5px}' +
      '.runs{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}.runs .panel{gap:8px;display:flex;flex-direction:column}' +
      '</style>');
  } catch (e) { /* styles are optional */ }
  const FIND_LOC = ['Bhubaneswar', 'Odisha', 'Cuttack', 'Puri', 'Rourkela', 'Kolkata', 'Delhi', 'Mumbai', 'Bengaluru', 'Chennai', 'Hyderabad', 'Pune', 'Ahmedabad', 'India', 'Bangladesh', 'Nepal', 'Sri Lanka', 'Dubai', 'UAE', 'Saudi Arabia', 'Oman', 'Singapore', 'Malaysia', 'Thailand', 'United Kingdom', 'USA', 'Australia', 'Africa', 'Nigeria', 'Kenya'];
  const FIND_ENT = ['hospital', 'multispecialty hospital', 'super speciality hospital', 'medical college', 'diagnostic centre', 'wellness centre', 'Ayurveda', 'yoga retreat', 'health insurance', 'TPA', 'pharmaceutical', 'medical tourism facilitator', 'university', 'business school', 'research institute', 'IIT', 'IIM', 'travel agency', 'tour operator', 'DMC', 'inbound tour operator', 'outbound travel', 'pilgrimage tours', 'hotel', 'resort', 'homestay', 'airline', 'cruise', 'MICE', 'event management', 'wedding planner', 'IT company', 'manufacturing', 'bank', 'PSU', 'government', 'tourism department', 'state government', 'ministry', 'embassy', 'consulate', 'NGO', 'CSR foundation', 'media', 'travel magazine'];
  const FIND_DEPT = ['marketing', 'business development', 'sales', 'international patient services', 'international marketing', 'patient relations', 'medical director', 'hospital administration', 'purchase', 'procurement', 'HR', 'admin', 'travel desk', 'corporate travel', 'CSR', 'operations', 'partnerships', 'alliances', 'corporate communications', 'public relations', 'product', 'contracting', 'reservations', 'professor', 'associate professor', 'researcher', 'PhD scholar', 'dean', 'director', 'general manager', 'CEO', 'founder', 'secretary', 'joint secretary', 'director of tourism'];
  const findQuery = () => [S.find.dept, S.find.ent, S.find.topic, S.find.loc].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
  const findPreview = () => findQuery() ? 'Searches LinkedIn people for: <b>' + esc(findQuery()) + '</b>' : 'Fill a box or tap a topic to build your search.';
  const liSearch = (q) => 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(q);
  function onboardCard() {
    return '<div class="onboard"><h2>Your list is empty. Here is how to start</h2>' +
      '<p class="muted" style="margin:0">This app does not search LinkedIn for you. It keeps track of the people you choose to add, scores them with AI, drafts your notes and reminds you when to follow up.</p>' +
      '<ol class="steps"><li><b>Install the Chrome extension</b> from the Add people page (one-time setup, two minutes).</li>' +
      '<li><b>Search LinkedIn yourself</b> and press <b>+ Save</b> next to anyone worth contacting, or Save on their profile page.</li>' +
      '<li><b>Wait about a minute.</b> The AI scores them and writes three connection notes. Press Refresh; they appear under Today and Contacts.</li>' +
      '<li><b>Send the request on LinkedIn yourself</b>, then tap "Sent with note 1/2/3" so the app can remind you later.</li></ol>' +
      '<div class="actions"><button class="btn primary" type="button" data-nav="add">Add people</button><button class="btn" type="button" data-nav="guide">Read how it works</button></div></div>';
  }
  function renderChrome() {
    const todayCount = S.data ? queueList().queue.length + checksList().length + draftsList().length : 0;
    const navHtml = VIEWS.map((v) => '<button type="button" data-nav="' + v.id + '"' + (S.view === v.id ? ' aria-current="page"' : '') + '><span>' + v.label + '</span>' +
      (v.id === 'today' && todayCount ? '<span class="count num">' + todayCount + '</span>' : '') + '</button>').join('');
    $('#nav').innerHTML = navHtml;
    $('#mobile-nav').innerHTML = VIEWS.map((v) => '<button type="button" data-nav="' + v.id + '"' + (S.view === v.id ? ' aria-current="page"' : '') + '>' +
      (v.id === 'add' ? 'Add' : (v.id === 'guide' ? 'Help' : (v.id === 'campaigns' ? 'Camps' : v.label))) + (v.id === 'today' && todayCount ? ' · ' + todayCount : '') + '</button>').join('');

    const dot = $('#conn-dot'); const txt = $('#conn-text');
    dot.className = 'dot ' + (S.mode === 'live' ? 'live' : 'demo');
    txt.textContent = S.loading ? 'Syncing…' : (S.mode === 'live' ? 'Connected to n8n' : 'Demo data');
    $('#sync-text').textContent = S.lastSync ? 'Synced ' + S.lastSync.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';

    $('#banner').innerHTML = S.mode === 'demo'
      ? '<div class="banner"><span><b>Demo mode.</b> You are looking at sample people, and buttons change nothing. Add your access key to load your real contacts.</span><button class="btn sm primary" data-nav="settings" type="button">Connect</button></div>'
      : (S.error ? '<div class="banner"><span>' + esc(S.error) + '</span><button class="btn sm" data-refresh type="button">Try again</button></div>' : '');
  }

  function topbar(title, sub, extra) {
    return '<div class="topbar"><div><h1>' + title + '</h1>' + (sub ? '<p>' + sub + '</p>' : '') + '</div><div class="top-actions">' + (extra || '') +
      '<button class="btn" type="button" data-refresh' + (S.loading ? ' disabled' : '') + '>' + (S.loading ? 'Syncing…' : 'Refresh') + '</button></div></div>';
  }

  // ---------- TODAY ----------
  function renderToday() {
    const { queue, backlog } = queueList();
    const checks = checksList(); const drafts = draftsList(); const due = dueNoDraft();
    const dateStr = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
    let h = topbar('Today', dateStr + ' · ' + queue.length + ' to connect · ' + checks.length + ' to check · ' + drafts.length + ' follow-ups ready');
    if (!S.data.contacts.length) return h + onboardCard();

    h += '<section class="section"><div class="section-head"><h2>Connect on LinkedIn</h2><span class="hint">Open the profile, send the request yourself, then log which note you used.' +
      (backlog > 0 ? ' ' + backlog + ' more wait behind today\'s campaign limits.' : '') + '</span></div>';
    h += queue.length ? '<div class="cards">' + queue.map(queueCard).join('') + '</div>' : '<div class="empty">Nobody is waiting to be contacted. Add people from the Add people tab.</div>';
    h += '</section>';

    const found = S.data.contacts.filter((c) => c.status === 'QUALIFIED' && !c.linkedin_url && !isDnc(c)).sort((a, b) => num(b.priority_score) - num(a.priority_score)).slice(0, 12);
    if (found.length) {
      h += '<section class="section"><div class="section-head"><h2>Found by discovery</h2><span class="hint">Qualified people the engine found on websites and research databases. Find their LinkedIn profile, paste the link under Edit details, and they move into the connect queue.</span></div>';
      h += '<div class="panel table-wrap"><table><tbody>' + found.map((c) => '<tr><td>' + whoBlock(c) + '<div class="faint" style="margin-top:3px">' + esc(c.source || '') + '</div></td><td><span class="pill ' + esc(c.priority || 'C') + '">' + esc(c.priority_score) + '</span></td><td><div class="actions">' + liBtn(c) +
        (c.email && !['invalid', 'none'].includes(c.email_status) ? '<span class="pill s-conn">email ' + esc(String(c.email_status).replace(/_/g, ' ')) + '</span>' : '') + '<button type="button" class="btn sm" data-open="' + esc(c.person_key) + '">Details</button>' + act(c, 'notrelevant', 'Not relevant', 'ghost bad') + '</div></td></tr>').join('') + '</tbody></table></div></section>';
    }

    h += '<section class="section"><div class="section-head"><h2>Did they accept?</h2><span class="hint">Requests and follows that are due for a check.</span></div>';
    h += checks.length ? '<div class="panel table-wrap"><table><tbody>' + checks.map(checkRow).join('') + '</tbody></table></div>' : '<div class="empty">No pending requests need a check today.</div>';
    h += '</section>';

    h += '<section class="section"><div class="section-head"><h2>Follow-ups ready</h2><span class="hint">Drafted each morning at 9:00. Edit before sending; nothing goes out automatically.</span></div>';
    h += drafts.length ? '<div class="cards">' + drafts.map(draftCard).join('') + '</div>' : '<div class="empty">No drafts waiting.' + (due.length ? ' ' + due.length + ' relationships are due; their drafts arrive at the next 9:00 run.' : '') + '</div>';
    h += '</section>';
    return h;
  }

  function scoreLine(c) {
    return '<div class="scores"><span>Score <b>' + esc(c.priority_score) + '</b></span><span>Relevance <b>' + esc(c.relevance_score) + '</b></span><span>Potential <b>' + esc(c.relationship_potential) +
      '</b></span><span>Contact data <b>' + esc(c.contact_confidence) + '</b></span><span>Timing <b>' + esc(c.timing_score) + '</b></span></div>';
  }
  function whoBlock(c) {
    return '<div class="who"><span class="name" role="button" tabindex="0" data-open="' + esc(c.person_key) + '">' + esc(c.full_name) + '</span>' +
      '<span class="role">' + esc([c.job_title, c.organization].filter(Boolean).join(' · ')) + '</span></div>';
  }
  function liBtn(c, label) { return c.linkedin_url ? '<a class="btn sm li" href="' + esc(c.linkedin_url) + '" target="_blank" rel="noopener">' + (label || 'Open LinkedIn') + '</a>' : '<a class="btn sm li" href="' + esc(liSearch([c.full_name, c.organization].filter(Boolean).join(' '))) + '" target="_blank" rel="noopener" title="Find their profile, then add the link under Edit details">Find on LinkedIn</a>'; }
  function act(c, action, label, cls, v) { return '<button type="button" class="btn sm ' + (cls || '') + '" data-act="' + action + '" data-key="' + esc(c.person_key) + '"' + (v ? ' data-v="' + v + '"' : '') + '>' + label + '</button>'; }

  function queueCard(c) {
    const notes = [1, 2, 3].map((v) => {
      const m = c['msg_variant_' + v]; if (!m) return '';
      return '<div class="note"><div class="note-top"><span>Note ' + v + '</span><span class="num ' + (m.length > 200 ? 'over' : '') + '">' + m.length + ' / 200</span></div><p>' + esc(m) + '</p>' +
        '<div class="note-actions"><button type="button" class="btn sm" data-copy="' + esc(m) + '">Copy</button>' + act(c, 'sent', 'Sent with note ' + v, 'good', String(v)) + '</div></div>';
    }).join('');
    return '<article class="card pri-' + esc(c.priority || 'C') + '"><div class="card-head">' + whoBlock(c) +
      '<div class="actions"><span class="pill ' + esc(c.priority || 'C') + '">Priority ' + esc(c.priority || 'C') + '</span><span class="pill">' + esc(campaignName(c.campaign_code)) + '</span></div></div>' +
      scoreLine(c) + (c.why_this_person ? '<div class="why"><b>Why this person:</b> ' + esc(c.why_this_person) + '</div>' : '') +
      (c.recommended_action === 'follow' ? '<div class="faint">The AI suggests following first and engaging with a post before you connect.</div>' : '') +
      (notes ? '<div class="notes">' + notes + '</div>' : '') +
      '<div class="actions">' + liBtn(c) + act(c, 'sent', 'Sent without a note') + act(c, 'followed', 'Followed only') + act(c, 'later', 'Later (3 days)', 'ghost') + act(c, 'notrelevant', 'Not relevant', 'ghost bad') + '</div></article>';
  }

  function checkRow(c) {
    const acts = c.status === 'CONNECTION_SENT'
      ? act(c, 'accepted', 'Accepted', 'good') + act(c, 'snooze', 'Not yet') + act(c, 'noresponse', 'Drop', 'ghost bad')
      : act(c, 'accepted', 'Already connected', 'good') + act(c, 'resend', 'Queue a request') + act(c, 'snooze', 'Snooze') + act(c, 'notrelevant', 'Drop', 'ghost bad');
    return '<tr><td>' + whoBlock(c) + '</td><td>' + statusPill(c.status) + '<div class="faint" style="margin-top:4px">since ' + fmtDate(c.last_contact_date) + '</div></td><td><div class="actions">' + liBtn(c, 'Check profile') + acts + '</div></td></tr>';
  }

  function draftCard(c) {
    const isReply = /^They replied/.test(c.last_contact_summary || '');
    const hasEmail = c.email && c.email_status !== 'invalid';
    return '<article class="card"><div class="card-head">' + whoBlock(c) + '<div class="actions">' + statusPill(c.status) +
      '<span class="pill">' + (isReply ? 'Reply to their message' : 'Follow-up #' + (num(c.followup_count) + 1)) + '</span><span class="pill">' + esc(c.pending_channel || 'linkedin') + '</span></div></div>' +
      (c.last_contact_summary ? '<div class="faint">Last: ' + esc(c.last_contact_summary) + ' (' + fmtDate(c.last_contact_date) + ')</div>' : '') +
      (c.pending_subject ? '<div><b>Subject:</b> ' + esc(c.pending_subject) + '</div>' : '') +
      '<div class="draft">' + esc(c.pending_message) + '</div>' +
      '<div class="actions"><button type="button" class="btn sm" data-copy="' + esc(c.pending_message) + '">Copy</button>' + liBtn(c) +
      act(c, isReply ? 'replied' : 'fu_linkedin', isReply ? 'I sent this reply' : 'Sent on LinkedIn', 'good') +
      (hasEmail && !isReply ? act(c, 'fu_email', 'Create Gmail draft') : '') +
      (canEmail(c) && !hasPlaceholder(c.pending_message) ? '<button type="button" class="btn sm primary" data-sendmail="' + esc(c.person_key) + '">Send email now</button>' : '') +
      (c.phone ? '<a class="btn sm" style="background:#128c7e;color:#fff;border-color:#128c7e" target="_blank" rel="noopener" href="' + esc(waLink(c.phone, c.pending_message)) + '">Send on WhatsApp</a>' : '') +
      '<button type="button" class="btn sm" data-open="' + esc(c.person_key) + '">They replied</button>' + act(c, 'snooze', 'Snooze 7 days', 'ghost') + act(c, 'dnc', 'Do not contact', 'ghost bad') + '</div></article>';
  }

  // ---------- PIPELINE ----------
  function renderPipeline() {
    const cs = S.data.contacts; const ints = S.data.interactions;
    const count = (pred) => cs.filter(pred).length;
    const inGroup = (g) => (c) => stageOf(c.status).group === g;
    const ready = count(inGroup('ready')); const wait = count(inGroup('wait'));
    const conn = count(inGroup('conn')) + count(inGroup('hot'));
    const opp = count((c) => ['OPPORTUNITY', 'COLLABORATION'].includes(c.status));
    const ignored = count((c) => c.status === 'IGNORED');
    const accRate = conn + ignored ? Math.round((conn / (conn + ignored)) * 100) + '% acceptance' : 'acceptance rate appears after first results';
    const weekAgo = (() => { const d = new Date(todayISO() + 'T00:00:00'); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })();

    let h = topbar('Pipeline', 'Where every relationship stands, across all campaigns.');
    h += '<div class="kpis">' +
      kpi('Contacts', cs.length, count((c) => (c.added_on || '') >= weekAgo) + ' added this week') +
      kpi('Ready to connect', ready, queueList().queue.length + ' in today\'s queue') +
      kpi('Awaiting reply', wait, checksList().length + ' due for a check') +
      kpi('Connected', conn, accRate) +
      kpi('Opportunities', opp, count((c) => c.status === 'ENGAGED') + ' engaged') + '</div>';

    const max = Math.max(1, ...STAGES.map((s) => count((c) => c.status === s.key)));
    const funnel = STAGES.map((s) => {
      const n = count((c) => c.status === s.key); if (!n && s.group === 'dead') return '';
      const cls = s.group === 'hot' ? 'alt' : (s.group === 'dead' ? 'dead' : '');
      return '<div class="frow"><span>' + esc(s.label) + '</span><div class="track"><div class="bar ' + cls + '" style="width:' + (n ? Math.max(2, (n / max) * 100) : 0) + '%"></div></div><span class="n">' + n + '</span></div>';
    }).join('');

    h += '<div class="grid-2"><div class="panel"><div class="panel-head"><h2>Stages</h2><span class="faint">contacts per stage</span></div><div class="funnel">' + funnel + '</div></div>' +
      '<div class="panel"><div class="panel-head"><h2>Activity</h2><span class="faint">last 21 days · outbound and replies</span></div>' + activityChart(ints) + '</div></div>';

    const usedCamps = campaigns().filter((cp) => cs.some((c) => c.campaign_code === cp.campaign_code));
    const rows = usedCamps.map((cp) => {
      const inC = cs.filter((c) => c.campaign_code === cp.campaign_code);
      const g = (grp) => inC.filter((c) => stageOf(c.status).group === grp).length;
      const reached = g('wait') + g('conn') + g('hot') + inC.filter((c) => c.status === 'IGNORED').length;
      const connected = g('conn') + g('hot');
      return '<tr><td><b>' + esc(cp.campaign_name) + '</b><div class="faint">' + esc(cp.relationship_type || '') + ' · limit ' + esc(cp.daily_limit) + '/day</div></td>' +
        '<td class="r">' + inC.length + '</td><td class="r">' + g('ready') + '</td><td class="r">' + reached + '</td><td class="r">' + connected + '</td><td class="r">' + g('hot') +
        '</td><td class="r">' + (reached ? Math.round((connected / reached) * 100) + '%' : '—') + '</td></tr>';
    }).join('');
    h += '<div class="panel"><div class="panel-head"><h2>Campaigns</h2><span class="faint">only campaigns with people in them</span></div><div class="table-wrap"><table><thead><tr><th>Campaign</th><th class="r">People</th><th class="r">Ready</th><th class="r">Reached</th><th class="r">Connected</th><th class="r">Engaged+</th><th class="r">Connect rate</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7"><div class="empty" style="border:0">No people added yet. Campaigns appear here once someone is added to them (' + campaigns().length + ' campaigns available).</div></td></tr>') + '</tbody></table></div></div>';

    const feed = ints.slice(0, 14).map((i) => '<div class="feed-item"><span class="d">' + fmtDate(i.interaction_date) + '</span><span><b role="button" tabindex="0" data-open="' + esc(i.person_key) + '" style="cursor:pointer">' + esc(i.full_name) + '</b> · ' +
      esc(String(i.interaction_type || '').replace(/_/g, ' ')) + (i.intent ? ' <span class="pill s-hot">' + esc(i.intent.replace(/_/g, ' ').toLowerCase()) + '</span>' : '') + '</span></div>').join('');
    h += '<div class="panel"><div class="panel-head"><h2>Recent activity</h2></div>' + (feed ? '<div class="feed">' + feed + '</div>' : '<div class="empty">No activity logged yet.</div>') + '</div>';
    return h;
  }
  function kpi(label, value, sub) { return '<div class="kpi"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="sub">' + esc(sub) + '</div></div>'; }

  function activityChart(ints) {
    const days = []; const base = new Date(todayISO() + 'T00:00:00');
    for (let i = 20; i >= 0; i--) { const d = new Date(base); d.setDate(d.getDate() - i); days.push(d.toISOString().slice(0, 10)); }
    const out = {}, inn = {};
    ints.forEach((i) => {
      if (i.direction === 'outbound') out[i.interaction_date] = (out[i.interaction_date] || 0) + 1;
      else if (i.direction === 'inbound') inn[i.interaction_date] = (inn[i.interaction_date] || 0) + 1;
    });
    const max = Math.max(1, ...days.map((d) => (out[d] || 0) + (inn[d] || 0)));
    const W = 420, H = 120, padL = 22, padB = 18, bw = (W - padL) / days.length;
    const y = (v) => (H - padB) - (v / max) * (H - padB - 8);
    let s = '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Interactions per day, last 21 days">';
    [0, max].forEach((v) => { s += '<line x1="' + padL + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--line)" stroke-width="1"/><text x="0" y="' + (y(v) + 3) + '">' + v + '</text>'; });
    days.forEach((d, i) => {
      const o = out[d] || 0, n = inn[d] || 0, x = padL + i * bw + 2, w = Math.max(2, bw - 4);
      if (o) s += '<rect x="' + x + '" y="' + y(o) + '" width="' + w + '" height="' + ((H - padB) - y(o)) + '" rx="2" fill="var(--accent)"><title>' + d + ': ' + o + ' outbound</title></rect>';
      if (n) s += '<rect x="' + x + '" y="' + y(o + n) + '" width="' + w + '" height="' + (y(o) - y(o + n)) + '" rx="2" fill="var(--saffron)"><title>' + d + ': ' + n + ' inbound</title></rect>';
      if (i % 7 === 0 || i === days.length - 1) s += '<text x="' + (x + w / 2) + '" y="' + (H - 4) + '" text-anchor="middle">' + fmtDate(d) + '</text>';
    });
    s += '</svg><div class="actions faint" style="font-size:12px"><span><span class="dot" style="display:inline-block;background:var(--accent)"></span> Outbound</span><span><span class="dot" style="display:inline-block;background:var(--saffron)"></span> Inbound</span></div>';
    return s;
  }

  // ---------- CONTACTS ----------
  function renderContacts() {
    const f = S.filters;
    let list = S.data.contacts.filter((c) => {
      if (f.status && c.status !== f.status) return false;
      if (f.campaign && c.campaign_code !== f.campaign) return false;
      if (f.q) {
        const hay = [c.full_name, c.organization, c.job_title, c.email, c.city, c.interests].join(' ').toLowerCase();
        if (!hay.includes(f.q.toLowerCase())) return false;
      }
      return true;
    });
    const { col, dir } = S.sort;
    list = list.slice().sort((a, b) => {
      const x = a[col], y = b[col];
      if (typeof x === 'number' || typeof y === 'number') return (num(x) - num(y)) * dir;
      return String(x || '').localeCompare(String(y || '')) * dir;
    });
    const statusOpts = '<option value="">All stages</option>' + STAGES.map((s) => '<option value="' + s.key + '"' + (f.status === s.key ? ' selected' : '') + '>' + s.label + '</option>').join('');
    const campOpts = campOptionsHtml(f.campaign, 'All campaigns');
    const th = (key, label, r) => '<th class="sortable' + (r ? ' r' : '') + '" data-sort="' + key + '">' + label + (col === key ? (dir > 0 ? ' ↑' : ' ↓') : '') + '</th>';

    let h = topbar('Contacts', list.length + ' of ' + S.data.contacts.length + ' people in your list', '<button class="btn primary" type="button" data-nav="add">Add people</button>');
    if (!S.data.contacts.length) return h + onboardCard();
    h += '<div class="filters"><input id="f-q" type="search" placeholder="Search people in your list: name, organisation, email, city" value="' + esc(f.q) + '" aria-label="Search contacts">' +
      '<select id="f-status" aria-label="Filter by stage">' + statusOpts + '</select><select id="f-campaign" aria-label="Filter by campaign">' + campOpts + '</select></div>' +
      '<p class="hint-line">This search looks only at people you have already added. To find someone new, search LinkedIn, then add them.</p>';
    h += '<div class="panel table-wrap" style="padding:0"><table><thead><tr>' + th('full_name', 'Person') + th('campaign_code', 'Campaign') + th('status', 'Stage') +
      th('priority_score', 'Score', true) + th('next_followup_date', 'Next touch') + th('last_contact_date', 'Last contact') + '</tr></thead><tbody>';
    h += list.map((c) => '<tr class="click" data-open="' + esc(c.person_key) + '" tabindex="0"><td><b>' + esc(c.full_name) + '</b><div class="faint">' + esc([c.job_title, c.organization].filter(Boolean).join(' · ')) + '</div></td>' +
      '<td>' + esc(campaignName(c.campaign_code)) + '</td><td>' + statusPill(c.status) + (isDnc(c) ? '' : '') + '</td><td class="r"><span class="pill ' + esc(c.priority || 'C') + '">' + esc(c.priority_score) + '</span></td>' +
      '<td class="num">' + (c.next_followup_date ? fmtDate(c.next_followup_date) + ' <span class="faint">' + relDays(c.next_followup_date) + '</span>' : '<span class="faint">—</span>') + '</td>' +
      '<td class="num">' + (c.last_contact_date ? fmtDate(c.last_contact_date) : '<span class="faint">—</span>') + '</td></tr>').join('');
    if (!list.length) h += '<tr><td colspan="6"><div class="empty" style="border:0">Nobody in your list matches these filters.' +
      (f.q ? '<div class="actions" style="justify-content:center;margin-top:10px"><a class="btn sm li" target="_blank" rel="noopener" href="' + esc(liSearch(f.q)) + '">Search LinkedIn for "' + esc(f.q) + '"</a><button class="btn sm" type="button" data-nav="add">Add a person</button></div>' : '') +
      '</div></td></tr>';
    h += '</tbody></table></div>';
    return h;
  }

  // ---------- DRAWER ----------
  function renderDrawer() {
    const root = $('#drawer-root');
    const c = S.drawer ? contactByKey(S.drawer) : null;
    if (!c) { root.innerHTML = ''; return; }
    const hist = S.data.interactions.filter((i) => i.person_key === c.person_key);
    const campOpts = campOptionsHtml(c.campaign_code);
    const quick = {
      READY_FOR_CONNECTION: act(c, 'sent', 'Request sent', 'good') + act(c, 'followed', 'Followed') + act(c, 'notrelevant', 'Not relevant', 'ghost bad'),
      FOLLOWING: act(c, 'accepted', 'Connected', 'good') + act(c, 'resend', 'Queue a request'),
      CONNECTION_SENT: act(c, 'accepted', 'Accepted', 'good') + act(c, 'noresponse', 'Not accepted'),
      IGNORED: act(c, 'resend', 'Try again later'),
      NOT_RELEVANT: act(c, 'resend', 'Move back to queue')
    }[c.status] || act(c, 'snooze', 'Snooze 7 days');
    const notes = [1, 2, 3].map((v) => c['msg_variant_' + v] ? '<div class="note"><div class="note-top"><span>Note ' + v + '</span><span class="num">' + c['msg_variant_' + v].length + '</span></div><p>' + esc(c['msg_variant_' + v]) + '</p><div class="note-actions"><button type="button" class="btn sm" data-copy="' + esc(c['msg_variant_' + v]) + '">Copy</button></div></div>' : '').join('');

    root.innerHTML = '<div class="scrim" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="' + esc(c.full_name) + '">' +
      '<div class="card-head"><div class="who"><h2>' + esc(c.full_name) + '</h2><span class="role">' + esc([c.job_title, c.organization].filter(Boolean).join(' · ')) + '</span></div>' +
      '<button type="button" class="btn ghost" data-close aria-label="Close">Close</button></div>' +
      '<div class="actions">' + statusPill(c.status) + '<span class="pill ' + esc(c.priority || 'C') + '">Priority ' + esc(c.priority || 'C') + ' · ' + esc(c.priority_score) + '</span><span class="pill">' + esc(campaignName(c.campaign_code)) + '</span></div>' +
      '<div class="actions">' + liBtn(c) + (isDnc(c) ? '' : quick) + '<a class="btn sm ghost" target="_blank" rel="noopener" href="' + esc(calLink(c)) + '">Schedule a call</a>' + '</div>' +
      (c.why_this_person ? '<div class="why"><b>Why this person:</b> ' + esc(c.why_this_person) + '</div>' : '') +
      (c.opportunity_type ? '<div class="opp"><b>Opportunity · ' + esc(String(c.opportunity_type).replace(/_/g, ' ')) + ':</b> ' + esc(c.opportunity_note) + '</div>' : '') +
      (c.recommended_action && c.recommended_action.length > 12 ? '<div class="faint"><b>Suggested next step:</b> ' + esc(c.recommended_action) + '</div>' : '') +
      ((c.professional_summary || c.research_interest || c.potential_need || c.collaboration_opportunities || c.publications) ? '<div class="panel info"><h3 style="margin:0">Research profile</h3>' +
        (c.professional_summary ? '<div>' + esc(c.professional_summary) + '</div>' : '') +
        (c.research_interest || c.professional_interest ? '<div><b>Interests:</b> ' + esc([c.research_interest, c.professional_interest].filter(Boolean).join(' · ')) + '</div>' : '') +
        (c.potential_need ? '<div><b>Possible need:</b> ' + esc(c.potential_need) + '</div>' : '') +
        (c.collaboration_opportunities ? '<div><b>Collaboration ideas:</b> ' + esc(c.collaboration_opportunities) + '</div>' : '') +
        (c.publications ? '<details><summary class="faint" style="cursor:pointer">Publications</summary><div class="faint" style="margin-top:4px">' + esc(c.publications).split(' | ').join('<br>') + '</div></details>' : '') +
        '<div class="faint">' + [c.segment ? 'Segment: ' + esc(c.segment) : '', c.enriched_on ? 'researched ' + fmtDate(c.enriched_on) : '', c.last_monitored ? 'monitored ' + fmtDate(c.last_monitored) : '', c.source_url ? '<a href="' + esc(c.source_url) + '" target="_blank" rel="noopener">source</a>' : ''].filter(Boolean).join(' · ') + '</div></div>' : '') +
      '<div class="panel"><dl class="dl">' +
      '<dt>Next touchpoint</dt><dd>' + (c.next_followup_date ? fmtDate(c.next_followup_date) + ' (' + relDays(c.next_followup_date) + ')' : '—') + '</dd>' +
      '<dt>Last contact</dt><dd>' + (c.last_contact_date ? fmtDate(c.last_contact_date) + ' · ' + esc(c.last_contact_summary) : '—') + '</dd>' +
      '<dt>Connected on</dt><dd>' + fmtDate(c.connection_date) + '</dd>' +
      '<dt>Follow-ups sent</dt><dd class="num">' + num(c.followup_count) + (c.nurture_stage && c.nurture_stage !== 'none' ? ' · stage ' + esc(c.nurture_stage) : '') + '</dd>' +
      '<dt>Last intent</dt><dd>' + esc((c.last_intent || '—').replace(/_/g, ' ').toLowerCase()) + '</dd>' +
      '<dt>Email</dt><dd>' + (c.email ? '<a class="mono" href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a> <span class="faint">(' + esc(String(c.email_status || '').replace(/_/g, ' ')) + (c.email_source ? ', ' + esc(c.email_source) : '') + ')</span>' : '<span class="faint">Not added yet. LinkedIn shows email only under Contact info, usually after you connect.</span> <a href="#" onclick="var e=document.getElementById(\'e-email\');e.scrollIntoView({block:\'center\'});e.focus();return false">Add email</a>') + '</dd>' +
      '<dt>Mobile</dt><dd>' + (c.phone ? '<a class="mono" href="tel:' + esc(c.phone) + '">' + esc(c.phone) + '</a> · <a href="' + esc(waLink(c.phone)) + '" target="_blank" rel="noopener">WhatsApp</a>' : '<span class="faint">Not added yet.</span> <a href="#" onclick="var e=document.getElementById(\'e-phone\');e.scrollIntoView({block:\'center\'});e.focus();return false">Add mobile</a>') + '</dd>' +
      '<dt>Location</dt><dd>' + esc([c.city, c.country].filter(Boolean).join(', ') || '—') + '</dd>' +
      '<dt>Interests</dt><dd>' + esc(c.interests || '—') + '</dd>' +
      '<dt>Scores</dt><dd>' + scoreLine(c) + '</dd>' +
      '<dt>Added</dt><dd>' + fmtDate(c.added_on) + ' · ' + esc(c.source || '') + '</dd></dl></div>' +
      (c.pending_message ? '<div class="section"><h3>Draft waiting</h3>' + (c.pending_subject ? '<div><b>Subject:</b> ' + esc(c.pending_subject) + '</div>' : '') + '<div class="draft">' + esc(c.pending_message) + '</div><div class="actions"><button type="button" class="btn sm" data-copy="' + esc(c.pending_message) + '">Copy</button>' +
        act(c, /^They replied/.test(c.last_contact_summary || '') ? 'replied' : 'fu_linkedin', 'Mark as sent', 'good') +
        (canEmail(c) ? '<button type="button" class="btn sm primary" data-sendmail="' + esc(c.person_key) + '">Send as email now</button>' : '') +
        (c.phone ? '<a class="btn sm" style="background:#128c7e;color:#fff;border-color:#128c7e" target="_blank" rel="noopener" href="' + esc(waLink(c.phone, c.pending_message)) + '">Send on WhatsApp</a>' : '') + '</div></div>' : '') +
      (notes && c.status === 'READY_FOR_CONNECTION' ? '<div class="section"><h3>Connection notes</h3><div class="notes">' + notes + '</div></div>' : '') +
      '<div class="section"><h3>History</h3>' + (hist.length ? '<div class="timeline">' + hist.map((i) => '<div class="tl ' + (i.direction === 'inbound' ? 'in' : (i.direction === 'outbound' ? 'out' : '')) + '"><div class="meta">' + fmtDate(i.interaction_date) + ' · ' + esc(i.channel) + ' · ' + esc(String(i.interaction_type || '').replace(/_/g, ' ')) + (i.intent ? ' · ' + esc(i.intent.replace(/_/g, ' ').toLowerCase()) : '') + '</div>' + (i.message ? '<div class="msg">' + esc(i.message) + '</div>' : '') + '</div>').join('') + '</div>' : '<div class="faint">Nothing logged yet.</div>') + '</div>' +
      (isDnc(c) ? '' : '<form class="panel section" id="reply-form"><h3>Log their reply</h3><p class="faint" style="margin:0">Paste what they said. The AI classifies it, moves the stage and drafts your answer.</p>' +
        '<label class="field" for="r-channel">Channel<select id="r-channel"><option>linkedin</option><option>email</option><option>whatsapp</option><option>phone</option><option>meeting</option></select></label>' +
        '<label class="field" for="r-msg">What they said<textarea id="r-msg" required></textarea></label>' +
        '<label class="field" for="r-notes">Your notes (optional)<input id="r-notes" type="text"></label>' +
        '<div><button class="btn primary" type="submit">Log reply</button></div></form>') +
      '<form class="panel section" id="edit-form"><h3>Edit details</h3><div class="form-grid">' +
      '<label class="field" for="e-title">Job title<input id="e-title" value="' + esc(c.job_title) + '"></label>' +
      '<label class="field" for="e-org">Organisation<input id="e-org" value="' + esc(c.organization) + '"></label>' +
      '<label class="field" for="e-email">Email<input id="e-email" type="email" value="' + esc(c.email) + '"></label>' +
      '<label class="field" for="e-phone">Mobile number<input id="e-phone" type="tel" inputmode="tel" placeholder="+91 98xxxxxxxx" value="' + esc(c.phone || '') + '"></label>' +
      '<label class="field" for="e-camp">Campaign<select id="e-camp">' + campOpts + '</select></label>' +
      '<label class="field span" for="e-li">LinkedIn profile URL<input id="e-li" placeholder="https://www.linkedin.com/in/…" value="' + esc(c.linkedin_url || '') + '"></label>' +
      '<label class="field span" for="e-notes">Profile notes (headline, about, recent activity, your angle)<textarea id="e-notes">' + esc(c.profile_notes) + '</textarea></label>' +
      '<label class="field span" for="e-pnotes">Private notes (only for you; the AI does not use these in messages)<textarea id="e-pnotes" style="min-height:70px">' + esc(c.notes || '') + '</textarea></label></div>' +
      '<div class="actions"><button class="btn primary" type="submit">Save changes</button></div></form>' +
      '<div class="panel section"><h3>Relationship status</h3><div class="actions">' +
        (isDnc(c) || ['DECLINED', 'NOT_RELEVANT', 'IGNORED'].includes(c.status) ? act(c, 'reopen', 'Reopen relationship') : act(c, 'collab', 'Mark as collaboration', 'good') + act(c, 'dnc', 'Do not contact', 'ghost bad')) +
        (c.email && c.unsubscribed !== true ? act(c, 'unsub', 'Unsubscribe from email', 'ghost') : '') +
        '<button type="button" class="btn sm ghost bad" data-delete="' + esc(c.person_key) + '">Delete permanently</button></div></div>' +
      '</aside>';

    const rf = $('#reply-form');
    if (rf) rf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#r-msg').value.trim(); if (!msg) return;
      if (S.mode === 'demo') { toast('Demo mode: connect your key to classify real replies.'); return; }
      const b = rf.querySelector('button[type=submit]'); b.disabled = true;
      try {
        const j = await api('reply', { person_key: c.person_key, channel: $('#r-channel').value, their_message: msg, my_notes: $('#r-notes').value });
        toast(j.message); rf.reset();
        setTimeout(() => load(true), 35000);
      } catch (err) { toast(err.message, true); } finally { b.disabled = false; }
    });
    $('#edit-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = { person_key: c.person_key, job_title: $('#e-title').value.trim(), organization: $('#e-org').value.trim(), email: $('#e-email').value.trim(), phone: cleanPhone($('#e-phone').value), campaign_code: $('#e-camp').value, profile_notes: $('#e-notes').value };
      const li = ($('#e-li').value || '').trim().split('?')[0];
      if (li && !/linkedin\.com\/(in|pub)\//i.test(li)) { toast('The LinkedIn link should look like https://www.linkedin.com/in/name', true); return; }
      payload.notes = $('#e-pnotes').value;
      if (li !== (c.linkedin_url || '')) { payload.linkedin_url = li; if (li && c.status === 'QUALIFIED') payload.status = 'READY_FOR_CONNECTION'; }
      if (payload.email.toLowerCase() === String(c.email || '').toLowerCase() && c.email_status) payload.email_status_keep = c.email_status;
      if (S.mode === 'demo') { Object.assign(c, payload); toast('Saved (demo only)'); render(); return; }
      const b = e.target.querySelector('button[type=submit]'); b.disabled = true;
      try { const j = await api('update', payload); toast(j.message); await load(true); } catch (err) { toast(err.message, true); b.disabled = false; }
    });
  }

  // ---------- ADD ----------
  const CSV_COLS = ['full_name', 'linkedin_url', 'job_title', 'organization', 'email', 'campaign_code', 'city', 'profile_notes', 'phone'];
  function renderAdd() {
    const campOpts = campOptionsHtml(S.findCamp || ((campaigns()[0] || {}).campaign_code));
    let h = topbar('Add people', 'Search LinkedIn as usual and press + Save (Chrome extension) next to anyone worth contacting. The AI fills in the details, scores them and drafts three connection notes.');
    h += captureBlocks();
    const fc = campaigns().find((c) => c.campaign_code === S.findCamp) || campaigns()[0] || {};
    const terms = String(fc.keywords || fc.campaign_name || '').split(',').concat(String(fc.target_profile || '').split(','))
      .map((t) => t.trim()).filter((t) => t && t.length < 60);
    const uniq = terms.filter((t, i) => terms.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i).slice(0, 12);
    const F = S.find;
    const dl = (id, arr) => '<datalist id="' + id + '">' + arr.map((v) => '<option value="' + esc(v) + '">').join('') + '</datalist>';
    h += '<div class="panel section"><div class="panel-head" style="margin:0"><h2>Find people on LinkedIn</h2><span class="faint">opens LinkedIn search in a new tab</span></div>' +
      '<p class="muted" style="margin:0">Fill any of the boxes (type your own or pick a suggestion), optionally tap a topic, then press Search LinkedIn. On the results page, press <b>+ Save</b> (Chrome extension) next to anyone worth contacting.</p>' +
      '<div class="form-grid"><label class="field" for="find-camp">Campaign<select id="find-camp">' +
      campOptionsHtml(fc.campaign_code) + '</select></label>' +
      '<label class="field" for="find-loc">Location<input id="find-loc" list="dl-loc" value="' + esc(F.loc) + '" placeholder="e.g. Bhubaneswar, Odisha, Dubai" autocomplete="off"></label>' +
      '<label class="field" for="find-ent">Entity type / industry<input id="find-ent" list="dl-ent" value="' + esc(F.ent) + '" placeholder="e.g. hospital, university, tour operator" autocomplete="off"></label>' +
      '<label class="field" for="find-dept">Department / role<input id="find-dept" list="dl-dept" value="' + esc(F.dept) + '" placeholder="e.g. marketing, international patient services" autocomplete="off"></label></div>' +
      dl('dl-loc', FIND_LOC) + dl('dl-ent', FIND_ENT) + dl('dl-dept', FIND_DEPT) +
      '<div><div class="faint" style="font-size:12px;margin-bottom:6px">Topic from this campaign (optional, tap to add or remove)</div><div class="chips">' +
      uniq.map((t) => '<button type="button" class="chip' + (F.topic === t ? ' on' : '') + '" data-topic="' + esc(t) + '" aria-pressed="' + (F.topic === t) + '">' + esc(t) + '</button>').join('') + '</div></div>' +
      '<div class="actions" style="align-items:center"><a class="btn li" id="find-go" target="_blank" rel="noopener" href="' + esc(liSearch(findQuery())) + '">Search LinkedIn</a>' +
      '<span class="faint" id="find-preview">' + findPreview() + '</span>' +
      '<button type="button" class="btn sm ghost" id="find-clear">Clear</button></div></div>';
    h += '<div class="grid-2"><form class="panel section" id="add-form"><h2>Add one person</h2><div class="form-grid">' +
      '<label class="field" for="a-name">Full name<input id="a-name" required placeholder="Dr. Priya Sharma"></label>' +
      '<label class="field" for="a-li">LinkedIn profile URL<input id="a-li" required placeholder="https://www.linkedin.com/in/…"></label>' +
      '<label class="field" for="a-title">Job title<input id="a-title" placeholder="Associate Professor"></label>' +
      '<label class="field" for="a-org">Organisation<input id="a-org" placeholder="XYZ University"></label>' +
      '<label class="field" for="a-email">Public or official email<input id="a-email" type="email"></label>' +
      '<label class="field" for="a-phone">Mobile number<input id="a-phone" type="tel" inputmode="tel" placeholder="+91 98xxxxxxxx"></label>' +
      '<label class="field" for="a-city">City<input id="a-city"></label>' +
      '<label class="field" for="a-camp">Campaign<select id="a-camp">' + campOpts + '</select></label>' +
      '<label class="field" for="a-source">Source<select id="a-source"><option>LinkedIn (manual research)</option><option>Google search</option><option>Company / university website</option><option>Event / conference</option><option>Journal / publication</option><option>Existing contact</option><option>Other</option></select></label>' +
      '<label class="field span" for="a-notes">Profile notes<textarea id="a-notes" style="min-height:120px" placeholder="Example:\nHeadline: Director, International Patient Services at XYZ Hospital\nAbout: 12 years in medical value travel; works with patients from Bangladesh and Africa\nRecent post: announced a new robotic surgery centre (Sept 2026)\nMet at: FICCI Heal 2026\nMy angle: they need a Bhubaneswar-side travel partner for patient families"></textarea></label>' + notesHelp() + '</div>' +
      '<div><button class="btn primary" type="submit">Add and qualify</button></div></form>';

    h += '<div class="panel section"><h2>Many at once</h2><p class="muted" style="margin:0">Paste CSV with a header row, or tab-separated rows copied from Excel or Google Sheets. Up to 200 per batch. Known columns:</p>' +
      '<div class="code-sample">' + CSV_COLS.join(',') + '</div>' +
      '<label class="field" for="bulk-text">Rows<textarea id="bulk-text" style="min-height:140px" placeholder="full_name,linkedin_url,job_title,organization,email,campaign_code\nAmit Das,https://www.linkedin.com/in/amit-das,Founder,ABC Tours,,C003"></textarea></label>' +
      '<div class="actions"><button type="button" class="btn" id="bulk-parse">Preview</button><button type="button" class="btn primary" id="bulk-send"' + (S.bulkRows.length ? '' : ' disabled') + '>Send ' + (S.bulkRows.length || '') + ' for qualification</button></div>' +
      (S.bulkRows.length ? '<div class="bulk-preview table-wrap"><table><thead><tr><th>Name</th><th>Title · Org</th><th>Campaign</th><th>LinkedIn</th></tr></thead><tbody>' +
        S.bulkRows.slice(0, 200).map((r) => '<tr><td>' + esc(r.full_name) + '</td><td>' + esc([r.job_title, r.organization].filter(Boolean).join(' · ')) + '</td><td>' + esc(r.campaign_code || 'C001') + '</td><td class="mono">' + esc((r.linkedin_url || '').replace(/^https?:\/\/(www\.)?/, '')) + '</td></tr>').join('') +
        '</tbody></table></div>' : '') + '</div></div>';
    h += '<p class="faint">Duplicates are skipped automatically: anyone whose LinkedIn URL is already in your contacts is ignored.</p>';
    return h;
  }

  function notesHelp() {
    return '<details class="span"><summary class="faint" style="cursor:pointer">What to write in Profile notes</summary><div class="muted" style="font-size:13px;margin-top:6px">' +
      'These notes are what the AI reads to score the person and write your three connection notes. Specific facts give specific, personal notes; an empty box gives generic ones. Copy or jot down:' +
      '<ul style="margin:6px 0 0;padding-left:18px"><li><b>Headline</b>: their title line under the name.</li>' +
      '<li><b>About</b>: two or three lines about what they do, who they serve, markets or specialities.</li>' +
      '<li><b>Something recent</b>: a post, new job, publication, award, event they spoke at or attended.</li>' +
      '<li><b>Common ground</b>: shared connection, same event, same university, a place in Odisha they mention.</li>' +
      '<li><b>Your angle</b>: one line on why you want to connect (e.g. they sell pilgrimage tours but have no Odisha partner; they research patient trust).</li></ul>' +
      'Do not include private details like phone numbers or personal matters. Easiest option: open their profile, press Ctrl+A and Ctrl+C, and paste the whole page here.</div></details>';
  }
  function campSelect(id, selected) {
    const sel = selected || S.findCamp || ((campaigns()[0] || {}).campaign_code);
    return '<select id="' + id + '">' + campOptionsHtml(sel) + '</select>';
  }
  function captureBlocks() {
    let h = '';
    if (S.captureDone) {
      h += '<div class="onboard"><h2>Added: ' + esc(S.captureDone) + '</h2><p class="muted" style="margin:0">The AI is scoring them and writing three connection notes. They appear in Today and Contacts in about a minute. You can close this tab and go back to LinkedIn; the next person you save opens here again.</p>' +
        '<div class="actions"><button class="btn" type="button" id="cap-clear">OK</button></div></div>';
    }
    if (S.capture) {
      const c = S.capture;
      h += '<form class="panel section" id="cap-form" style="border:2px solid var(--accent)"><div class="panel-head" style="margin:0"><h2>Save this person?</h2><span class="faint">captured from the LinkedIn profile you had open</span></div>' +
        '<div><div style="font-family:var(--font-display);font-size:20px;font-weight:700">' + esc(c.n || 'Name will be read from the profile') + '</div>' +
        '<div class="muted">' + esc(c.h || '') + (c.l ? ' · ' + esc(c.l) : '') + '</div><div class="mono faint" style="margin-top:4px;word-break:break-all">' + esc(c.u) + '</div></div>' +
        '<div class="form-grid"><label class="field" for="cap-camp">Campaign' + campSelect('cap-camp') + '</label>' +
        '<label class="field" for="cap-email">Email (optional)<input id="cap-email" type="email" placeholder="if shown under Contact info"></label>' +
        '<label class="field" for="cap-phone">Mobile (optional)<input id="cap-phone" type="tel" inputmode="tel" placeholder="if you have it"></label></div>' +
        '<details><summary class="faint" style="cursor:pointer">Profile text that will be sent to the AI (' + String(c.t || '').length + ' characters)</summary><textarea id="cap-text" style="min-height:160px;margin-top:8px">' + esc(c.t || '') + '</textarea></details>' +
        (S.mode === 'demo' ? '<div class="banner"><span>Connect your access key in Settings first; then click the bookmark again on the profile.</span></div>' : '') +
        '<div class="actions"><button class="btn primary" type="submit"' + (S.mode === 'demo' ? ' disabled' : '') + '>Add and qualify</button><button class="btn ghost" type="button" id="cap-cancel">Discard</button></div></form>';
    }
    h += '<form class="panel section" id="card-form"><div class="panel-head" style="margin:0"><h2>Scan business cards</h2><span class="faint">works on phone · photo of one or several visiting cards</span></div>' +
      '<p class="muted" style="margin:0">Take a clear photo (or pick photos) of visiting cards from an event. The AI reads name, title, organisation, email, mobile and website, then scores each person like any other contact.</p>' +
      '<div class="form-grid"><label class="field" for="card-file">Photos<input id="card-file" type="file" accept="image/*" capture="environment" multiple required></label>' +
      '<label class="field" for="card-camp">Campaign' + campSelect('card-camp') + '</label>' +
      '<label class="field span" for="card-note">Where you met (optional, added to their notes)<input id="card-note" placeholder="e.g. Met at FICCI Heal 2026, Delhi"></label></div>' +
      '<div class="actions"><button class="btn primary" type="submit">Read cards and add</button><span class="faint" id="card-status"></span></div></form>';
    h += '<div class="panel section"><div class="panel-head" style="margin:0"><h2>Save from LinkedIn with the Chrome extension</h2><span class="faint">recommended · set up once on your computer</span></div>' +
      '<p class="muted" style="margin:0">The extension adds a <b>+ Save</b> button next to every person in a LinkedIn people search, and a Save panel on every profile page. One click adds the person to the campaign you picked; the AI scores them and writes the notes.</p>' +
      '<ol class="steps"><li><a class="btn sm primary" href="relationship-engine-extension.zip" download>Download the extension (.zip)</a> and unzip it. You get a folder called <b>extension</b>.</li>' +
      '<li>In Chrome or Edge open <span class="mono">chrome://extensions</span> (Edge: <span class="mono">edge://extensions</span>) and switch on <b>Developer mode</b> (top right).</li>' +
      '<li>Click <b>Load unpacked</b> and choose the unzipped <b>extension</b> folder.</li>' +
      '<li>Click the puzzle-piece icon in the toolbar, pin <b>Relationship Engine for LinkedIn</b>, click it, paste your access key (the same one as in Settings) and press <b>Save and connect</b>.</li>' +
      '<li>On LinkedIn, search people as usual. Choose the campaign in the small panel at the bottom-right, then press <b>+ Save</b> next to anyone worth contacting. For richer AI notes, open the profile and press <b>Save to Relationship Engine</b> there.</li></ol>' +
      '<p class="hint-line" style="margin:0">It reads only what is on your screen, only when you press Save. It does not scroll, browse, click or message anything on LinkedIn. People already saved show <b>Saved ✓</b>.</p>' +
      '<details><summary class="faint" style="cursor:pointer">No extension? Use the bookmark button instead</summary><ol class="steps"><li>Show your bookmarks bar (Ctrl+Shift+B).</li>' +
      '<li>Drag this button onto the bar: <a class="btn sm li" href="' + esc(BOOKMARKLET) + '" onclick="return false" title="Drag me to your bookmarks bar">Save to Relationship Engine</a>. If dragging does not work, right-click the bookmarks bar, choose Add page, name it Save to RE and paste the address from the box below as the URL.</li>' +
      '<li>Open a LinkedIn profile and click the bookmark.</li></ol><textarea readonly class="mono" style="min-height:70px;font-size:11px" onclick="this.select()">' + esc(BOOKMARKLET) + '</textarea></details></div>';
    h += '<form class="panel section" id="paste-form"><div class="panel-head" style="margin:0"><h2>Or paste a profile</h2><span class="faint">works on phone too</span></div>' +
      '<p class="muted" style="margin:0">Open the profile, select all the text (Ctrl+A), copy it (Ctrl+C) and paste it below with the profile link. The AI works out the name, title and organisation.</p>' +
      '<div class="form-grid"><label class="field" for="p-url">LinkedIn profile URL<input id="p-url" required placeholder="https://www.linkedin.com/in/…"></label>' +
      '<label class="field" for="p-camp">Campaign' + campSelect('p-camp') + '</label>' +
      '<label class="field span" for="p-text">Profile text<textarea id="p-text" required style="min-height:120px" placeholder="On their LinkedIn profile press Ctrl+A, then Ctrl+C, and paste here (Ctrl+V). Menus and buttons in the copied text are fine; the AI ignores them. Add a line at the end for anything you know that is not on the profile, e.g. Met at OTM Mumbai."></textarea></label></div>' +
      '<div><button class="btn primary" type="submit">Add and qualify</button></div></form>';
    return h;
  }

  function parseDelimited(text) {
    const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
    if (!lines.length) return [];
    const sep = lines[0].includes('\t') ? '\t' : ',';
    const split = (line) => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
        else if (ch === '"') q = true; else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch;
      }
      out.push(cur); return out.map((s) => s.trim());
    };
    const head = split(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z_]/g, '_'));
    const hasHeader = head.some((h) => CSV_COLS.includes(h));
    const cols = hasHeader ? head : CSV_COLS;
    return (hasHeader ? lines.slice(1) : lines).map((l) => {
      const v = split(l); const o = {};
      cols.forEach((c, i) => { if (CSV_COLS.includes(c) && v[i]) o[c] = v[i]; });
      return o;
    }).filter((o) => o.full_name || o.linkedin_url);
  }

  async function sendProspects(list, btn) {
    if (S.mode === 'demo') { toast('Demo mode: connect your key to add real people.'); return false; }
    if (btn) btn.disabled = true;
    try {
      const j = await api('add', { prospects: list });
      toast((j.queued || list.length) + ' sent. ' + (j.message || ''));
      setTimeout(() => load(true), 60000);
      return true;
    } catch (e) { toast(e.message, true); return false; } finally { if (btn) btn.disabled = false; }
  }

  // ---------- CAMPAIGNS ----------
  const CAMP_FIELDS = [
    ['campaign_name', 'Name', 'text'], ['category', 'Category', 'cat'], ['relationship_type', 'Relationship type', 'text'], ['sender_identity', 'Write as', 'identity'],
    ['target_count', 'Target number of people', 'number'], ['daily_limit', 'LinkedIn requests per day', 'number'], ['min_score', 'Minimum AI score (0-100)', 'number'], ['countries', 'Countries (comma separated)', 'text'],
    ['purpose', 'Purpose: why you want these relationships', 'area'], ['target_profile', 'Ideal person (roles, organisations)', 'area'], ['keywords', 'Keywords (comma separated)', 'area'],
    ['my_context', 'About you for this campaign (the AI uses this when writing)', 'area'], ['search_queries', 'Search phrases for discovery (one per line, e.g. "multispecialty hospital Bhubaneswar")', 'area'],
    ['source_urls', 'Web pages to read for people (one per line: team, faculty or member pages)', 'area']
  ];
  function nextCampCode() { const n = campaigns().map((c) => Number(String(c.campaign_code).replace(/\D/g, '')) || 0); return 'C' + String(Math.max(46, ...n) + 1).padStart(3, '0'); }
  function renderCampaigns() {
    const cs = S.data.contacts;
    const edit = S.campEdit;
    let h = topbar('Campaigns', campaigns().length + ' campaigns · who you are building relationships with, and why', '<button class="btn primary" type="button" data-campedit="__new">New campaign</button>');
    if (edit) {
      const c = edit === '__new' ? { campaign_code: nextCampCode(), active: true, daily_limit: 10, min_score: 60, target_count: 100, sender_identity: 'business' } : (campaigns().find((x) => x.campaign_code === edit) || {});
      const cats = CAT_ORDER.concat(['Other']);
      const field = ([k, label, type]) => {
        const v = c[k] === undefined || c[k] === null ? '' : c[k];
        if (type === 'area') return '<label class="field span" for="cf-' + k + '">' + label + '<textarea id="cf-' + k + '" style="min-height:70px">' + esc(v) + '</textarea></label>';
        if (type === 'cat') return '<label class="field" for="cf-' + k + '">' + label + '<select id="cf-' + k + '">' + cats.map((x) => '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select></label>';
        if (type === 'identity') return '<label class="field" for="cf-' + k + '">' + label + '<select id="cf-' + k + '"><option value="business"' + (v !== 'academic' ? ' selected' : '') + '>Founder of NegoTrip</option><option value="academic"' + (v === 'academic' ? ' selected' : '') + '>Researcher (no selling)</option></select></label>';
        return '<label class="field" for="cf-' + k + '">' + label + '<input id="cf-' + k + '" type="' + type + '" value="' + esc(v) + '"></label>';
      };
      h += '<form class="panel section" id="camp-form" data-code="' + esc(c.campaign_code) + '"><div class="panel-head" style="margin:0"><h2>' + (edit === '__new' ? 'New campaign ' : 'Edit ') + esc(c.campaign_code) + '</h2><button type="button" class="btn ghost" data-campedit="">Close</button></div><div class="form-grid">' +
        CAMP_FIELDS.map(field).join('') +
        '<label class="field"><span><input type="checkbox" id="cf-active"' + (c.active === false || c.active === 'false' ? '' : ' checked') + '> Active</span></label>' +
        '<label class="field"><span><input type="checkbox" id="cf-auto"' + (c.auto_discovery === true || c.auto_discovery === 'true' ? ' checked' : '') + '> Auto-discovery (weekly search for new people until the target is reached)</span></label></div>' +
        '<div class="actions"><button class="btn primary" type="submit">Save campaign</button></div></form>';
    }
    const rows = campaigns().slice().sort((a, b) => cs.filter((x) => x.campaign_code === b.campaign_code).length - cs.filter((x) => x.campaign_code === a.campaign_code).length || String(a.campaign_code).localeCompare(b.campaign_code)).map((cp) => {
      const inC = cs.filter((c) => c.campaign_code === cp.campaign_code);
      const tg = num(cp.target_count); const pct = tg ? Math.min(100, Math.round((inC.length / tg) * 100)) : 0;
      const conn = inC.filter((c) => ['conn', 'hot'].includes(stageOf(c.status).group)).length;
      const off = cp.active === false || cp.active === 'false';
      return '<tr' + (off ? ' style="opacity:.55"' : '') + '><td><b>' + esc(cp.campaign_name) + '</b><div class="faint">' + esc(cp.campaign_code) + ' · ' + esc(cp.category || '') + (off ? ' · paused' : '') + (cp.auto_discovery === true || cp.auto_discovery === 'true' ? ' · auto-discovery' : '') + '</div></td>' +
        '<td class="r num">' + inC.length + (tg ? ' / ' + tg : '') + (tg ? '<div class="progress" title="' + pct + '%"><i style="width:' + pct + '%"></i></div>' : '') + '</td><td class="r num">' + conn + '</td>' +
        '<td><div class="actions" style="justify-content:flex-end"><button type="button" class="btn sm" data-run="discover" data-camp="' + esc(cp.campaign_code) + '">Discover now</button><button type="button" class="btn sm ghost" data-campedit="' + esc(cp.campaign_code) + '">Edit</button><button type="button" class="btn sm ghost" data-campfilter="' + esc(cp.campaign_code) + '">People</button></div></td></tr>';
    }).join('');
    h += '<p class="hint-line">"Discover now" searches research databases and organisation websites for new people who fit the campaign (never LinkedIn). New people appear as Found, get researched, then qualified.</p>';
    h += '<div class="panel table-wrap" style="padding:0"><table><thead><tr><th>Campaign</th><th class="r">People / target</th><th class="r">Connected</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    return h;
  }

  // ---------- LIBRARY ----------
  function renderLibrary() {
    const items = (S.data.content || []).slice().sort((a, b) => String(b.added_on || '').localeCompare(String(a.added_on || '')));
    const e = S.libEdit ? (items.find((x) => x.content_id === S.libEdit) || {}) : null;
    let h = topbar('Content library', 'Papers, articles, itineraries, offers and events the AI may share in follow-ups. It only ever shares items from this list.', '<button class="btn primary" type="button" data-libedit="__new">Add item</button>');
    if (e) {
      h += '<form class="panel section" id="lib-form" data-id="' + esc(e.content_id || '') + '"><div class="panel-head" style="margin:0"><h2>' + (e.content_id ? 'Edit item' : 'Add item') + '</h2><button type="button" class="btn ghost" data-libedit="">Close</button></div><div class="form-grid">' +
        '<label class="field span" for="lf-title">Title<input id="lf-title" required value="' + esc(e.title || '') + '" placeholder="e.g. Our 2026 paper on patient trust in medical tourism"></label>' +
        '<label class="field span" for="lf-url">Link<input id="lf-url" value="' + esc(e.url || '') + '" placeholder="https://…"></label>' +
        '<label class="field" for="lf-kind">Type<select id="lf-kind">' + ['paper', 'article', 'itinerary', 'offer', 'event', 'meeting', 'case study', 'video', 'note'].map((k) => '<option' + (k === (e.kind || 'paper') ? ' selected' : '') + '>' + k + '</option>').join('') + '</select></label>' +
        '<label class="field" for="lf-aud">Who it suits<input id="lf-aud" value="' + esc(e.audience || '') + '" placeholder="academic, healthcare, travel_trade, corporate, government, all"></label>' +
        '<label class="field span" for="lf-sum">Short summary (what the AI tells people about it)<textarea id="lf-sum" style="min-height:80px">' + esc(e.summary || '') + '</textarea></label>' +
        '<label class="field"><span><input type="checkbox" id="lf-active"' + (e.active === false ? '' : ' checked') + '> Active</span></label></div>' +
        '<div class="actions"><button class="btn primary" type="submit">Save</button>' + (e.content_id ? '<button type="button" class="btn ghost bad" data-libdel="' + esc(e.content_id) + '">Delete</button>' : '') + '</div></form>';
    }
    h += items.length ? '<div class="panel table-wrap" style="padding:0"><table><thead><tr><th>Item</th><th>Type</th><th>Suits</th><th></th></tr></thead><tbody>' + items.map((x) => '<tr' + (x.active === false ? ' style="opacity:.55"' : '') + '><td><b>' + esc(x.title) + '</b>' + (x.url ? ' <a href="' + esc(x.url) + '" target="_blank" rel="noopener">link</a>' : '') + '<div class="faint">' + esc(String(x.summary || '').slice(0, 140)) + '</div></td><td>' + esc(x.kind) + '</td><td>' + esc(x.audience) + '</td><td><button type="button" class="btn sm ghost" data-libedit="' + esc(x.content_id) + '">Edit</button></td></tr>').join('') + '</tbody></table></div>'
      : '<div class="empty">Nothing here yet. Add your papers, blog posts, sample itineraries or upcoming events. Follow-up drafts will then offer them to the right people instead of leaving [placeholders].</div>';
    h += '<p class="hint-line" style="margin-top:10px">Tip: add one item of type <b>meeting</b> with your booking link (for example a Google Calendar appointment page). When a follow-up proposes a call, the AI includes that link so people can pick a time.</p>';
    return h;
  }

  // ---------- GUIDE ----------
  function renderGuide() {
    const stageRows = [
      ['Found', 'Discovered automatically on a website or research database. Waiting to be researched.'],
      ['Researched', 'Publications and organisation website read; a profile summary is written. Qualification follows within minutes.'],
      ['Qualified (no LinkedIn yet)', 'A good fit, but no LinkedIn link yet. Use Find on LinkedIn, then paste the link under Edit details.'],
      ['Ready to connect', 'Added and scored well by the AI. Waiting for you to send a LinkedIn request.'],
      ['Following', 'You followed them first instead of connecting. You get a reminder after 14 days.'],
      ['Request sent', 'You sent a connection request. After 10 days the app asks whether they accepted.'],
      ['Connected', 'They accepted. A thank-you follow-up draft is written 3 days later.'],
      ['First conversation', 'They replied with a polite, low-intent message.'],
      ['Engaged', 'They are interested or asked for details.'],
      ['Opportunity', 'They have a clear need or want a call. Flagged [OPPORTUNITY] in your inbox.'],
      ['Nurture', 'Connected, three follow-ups done. A light check-in every 30 to 60 days.'],
      ['Not accepted / Declined / Not relevant', 'Parked. They drop out of every queue.'],
      ['Collaboration', 'You are actively working together. Light touchpoints every 30 days.'],
      ['Unsubscribed', 'They used the unsubscribe link or asked to stop email. No email is ever sent again.'],
      ['Do not contact', 'They asked not to be contacted, or you chose this. Never shown again.']
    ].map((r) => '<tr><td style="white-space:nowrap"><b>' + r[0] + '</b></td><td>' + r[1] + '</td></tr>').join('');
    let h = topbar('How it works', 'A relationship tracker for LinkedIn. You do the talking; the app remembers, scores, drafts and reminds.');
    h += '<div class="guide">' +
      '<div class="panel"><h2>What this app does, and what it does not do</h2>' +
      '<p><b>It does not search, scrape or message on LinkedIn.</b> LinkedIn forbids automation and can restrict accounts that use it. So finding people and clicking Connect or Send stays with you.</p>' +
      '<p><b>It does everything around that:</b> keeps your list of people, scores each person for fit, writes three connection notes, tells you each morning who to contact, reminds you to check whether they accepted, drafts follow-ups at the right time, and reads their replies to suggest your answer.</p></div>' +
      '<div class="panel"><h2>Your routine, in order</h2><ol class="steps">' +
      '<li><b>Install the Chrome extension once.</b> On <a href="#add" data-nav="add">Add people</a>, download it and load it in Chrome (steps are there), then paste your access key into it.</li>' +
      '<li><b>Find and save people.</b> Search LinkedIn as usual (the campaign search links on Add people help). Pick the campaign in the extension panel (bottom-right on LinkedIn) and press + Save next to a person in the results, or Save to Relationship Engine on their profile (richer notes). On a phone, copy the profile text and paste it in "Or paste a profile" instead. To add many at once, paste rows from Excel or Google Sheets.</li>' +
      '<li><b>Let the AI qualify them.</b> Within about a minute each person gets four scores (relevance, relationship potential, contact data, timing), a "why this person" line and three connection notes under 200 characters. Press Refresh to see them. Low scorers are marked Not relevant automatically.</li>' +
      '<li><b>Connect each morning.</b> Open <a href="#today" data-nav="today">Today</a> (or the 8:30 email). For each person: Open LinkedIn, copy a note, send the request on LinkedIn, then tap "Sent with note 1/2/3".</li>' +
      '<li><b>Check acceptances.</b> Ten days later the person appears under "Did they accept?". Tap Accepted, Not yet, or Drop.</li>' +
      '<li><b>Follow up.</b> Once connected, a follow-up draft appears under "Follow-ups ready" (and in the 9:00 email). Edit it, send it on LinkedIn, then tap "Sent on LinkedIn". For email, "Create Gmail draft" puts it in your Gmail drafts to review and send.</li>' +
      '<li><b>Log replies.</b> When someone answers, open them in <a href="#contacts" data-nav="contacts">Contacts</a> and paste their message into "Log their reply". The AI classifies it, moves them to the right stage and emails you a suggested reply.</li></ol></div>' +
      '<div class="panel"><h2>Stages</h2><div class="table-wrap"><table><tbody>' + stageRows + '</tbody></table></div></div>' +
      '<div class="panel"><h2>What runs automatically</h2><ul class="muted" style="margin:0;padding-left:18px">' +
      '<li><b>When you add someone:</b> AI scoring and connection notes (about a minute).</li>' +
      '<li><b>Discovery, research, email finding, monitoring, reports and the Google Sheet</b> run on their own schedules; see Settings, Run now.</li>' +
      '<li><b>Your replies and sent emails in Gmail</b> are picked up every few minutes and logged against the right person.</li>' +
      '<li><b>8:30 IST daily:</b> email with today\'s connection queue and acceptance checks.</li>' +
      '<li><b>9:00 IST daily:</b> follow-up drafts written and emailed. Unused drafts come back after 2 days.</li>' +
      '<li><b>Follow-up rhythm after connecting:</b> day 3, then 7, 16 and 30 days later, then every 60 days.</li>' +
      '<li><b>Daily limits:</b> each campaign shows a limited number of new people per day (8 to 12) to keep your LinkedIn activity at a natural pace.</li></ul></div>' +
      '<div class="panel"><h2>Tips</h2><ul class="muted" style="margin:0;padding-left:18px">' +
      '<li>Search in Contacts only looks through people already in your list.</li>' +
      '<li>If someone was added twice, the second copy is skipped automatically (matched by LinkedIn URL).</li>' +
      '<li>Always read a draft before sending. Where the AI needs a detail it does not know, it leaves a [bracketed placeholder] for you to fill in.</li>' +
      '<li>Campaigns (who you are targeting and why) are edited on the Campaigns tab. Turn on auto-discovery and add search phrases to have the engine find people for you.</li>' +
      '<li>Add your papers, articles and offers to the Library so follow-ups can share them.</li></ul></div>' +
      '</div>';
    return h;
  }

  // ---------- SETTINGS ----------
  function renderSettings() {
    const th = store.get('theme', 'system');
    let h = topbar('Settings', 'Connect this app to your n8n Relationship Engine.');
    h += '<form class="panel section" id="settings-form" style="max-width:640px"><h2>Connection</h2>' +
      '<label class="field" for="s-url">API address<input id="s-url" value="' + esc(S.apiUrl) + '" required></label>' +
      '<label class="field" for="s-key">Access key<input id="s-key" type="password" value="' + esc(S.key) + '" autocomplete="off" placeholder="Paste the key from the PRE-05 workflow"></label>' +
      '<p class="faint" style="margin:0">The key is kept only in this browser. The app code is public on GitHub; your contacts are not, because every request needs this key.</p>' +
      '<div class="actions"><button class="btn primary" type="submit">Save and connect</button>' + (S.key ? '<button class="btn bad" type="button" id="s-forget">Forget key on this device</button>' : '') + '</div></form>';
    h += '<div class="section"><div class="section-head"><h2>Run now</h2><span class="hint">Every job also runs on its own schedule. Results appear in a few minutes.</span></div><div class="runs">' +
      JOBS.map((j) => '<div class="panel"><b>' + esc(j[1]) + '</b><span class="faint" style="font-size:12.5px">' + esc(j[2]) + '</span><div><button type="button" class="btn sm primary" data-run="' + j[0] + '">Run</button></div></div>').join('') + '</div>' +
      '<p class="hint-line" style="margin-top:8px">Google Sheet mirror: <a href="' + SHEET_URL + '" target="_blank" rel="noopener">open the sheet</a>. Paste people into its Import tab (keep the header row) and they are added at the next sync.' + (S.data && S.data.suppressed ? ' · ' + S.data.suppressed + ' addresses on the email suppression list.' : '') + '</p></div>';
    h += '<div class="panel section" style="max-width:640px"><h2>Appearance</h2><label class="field" for="s-theme">Theme<select id="s-theme">' +
      ['system', 'light', 'dark'].map((t) => '<option value="' + t + '"' + (t === th ? ' selected' : '') + '>' + t[0].toUpperCase() + t.slice(1) + '</option>').join('') + '</select></label></div>';
    h += '<div class="panel section" style="max-width:640px"><h2>How it runs</h2><ul class="muted" style="margin:0;padding-left:18px">' +
      '<li>8:30 IST: the LinkedIn queue email. 9:00 IST: follow-up drafts. The Today tab shows the same lists.</li>' +
      '<li>LinkedIn is never automated. You send every request and message yourself; this app records what you did.</li>' +
      '<li>"Create Gmail draft" puts a draft in your Gmail. It never sends on its own.</li>' +
      '<li>Email is sent automatically only to verified or found addresses, never to anyone unsubscribed or marked do not contact, at most 30 a day, and always with an unsubscribe link.</li>' +
      '<li>Add or edit campaigns on the Campaigns tab.</li></ul></div>';
    return h;
  }

  // ---------- render & events ----------
  function render() {
    renderChrome();
    const v = $('#view');
    if (!S.data) { v.innerHTML = '<div class="empty">Loading…</div>'; return; }
    const views = { today: renderToday, pipeline: renderPipeline, contacts: renderContacts, campaigns: renderCampaigns, library: renderLibrary, add: renderAdd, guide: renderGuide, settings: renderSettings };
    v.innerHTML = (views[S.view] || renderToday)();
    renderDrawer();
    bindViewInputs();
  }

  function bindViewInputs() {
    const q = $('#f-q');
    if (q) {
      q.addEventListener('input', () => { S.filters.q = q.value; const pos = q.selectionStart; render(); const nq = $('#f-q'); nq.focus(); nq.setSelectionRange(pos, pos); });
      $('#f-status').addEventListener('change', (e) => { S.filters.status = e.target.value; render(); });
      $('#f-campaign').addEventListener('change', (e) => { S.filters.campaign = e.target.value; render(); });
    }
    const remember = (code) => { S.findCamp = code; store.set('lastcamp', code); };
    const cf = $('#cap-form');
    if (cf) {
      cf.addEventListener('submit', async (e) => {
        e.preventDefault();
        const c = S.capture; const camp = $('#cap-camp').value; remember(camp);
        const txt = $('#cap-text') ? $('#cap-text').value : (c.t || '');
        const p = { full_name: c.n || '', linkedin_url: c.u, email: $('#cap-email').value.trim(), phone: cleanPhone($('#cap-phone').value), campaign_code: camp, source: 'LinkedIn (one-click capture)',
          profile_notes: [c.h ? 'Headline: ' + c.h : '', c.l ? 'Location: ' + c.l : '', txt].filter(Boolean).join('\n') };
        if (await sendProspects([p], cf.querySelector('button[type=submit]'))) { S.captureDone = c.n || 'profile saved'; S.capture = null; render(); }
      });
      $('#cap-cancel').addEventListener('click', () => { S.capture = null; render(); });
    }
    const cc = $('#cap-clear');
    if (cc) cc.addEventListener('click', () => { S.captureDone = ''; render(); });
    const pf = $('#paste-form');
    if (pf) pf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = $('#p-url').value.trim(); const camp = $('#p-camp').value; remember(camp);
      if (!/linkedin\.com\/(in|pub)\//i.test(url)) { toast('Enter the profile link, like https://www.linkedin.com/in/name', true); return; }
      const p = { full_name: '', linkedin_url: url, campaign_code: camp, source: 'LinkedIn (pasted profile)', profile_notes: $('#p-text').value.trim().slice(0, 4000) };
      if (await sendProspects([p], pf.querySelector('button[type=submit]'))) { pf.reset(); S.captureDone = 'profile from ' + url.replace(/^https?:\/\/(www\.)?/, ''); render(); window.scrollTo(0, 0); }
    });
    const fcs = $('#find-camp');
    if (fcs) {
      fcs.addEventListener('change', (e) => { S.findCamp = e.target.value; S.find.topic = ''; store.set('find', JSON.stringify(S.find)); render(); const ac = $('#a-camp'); if (ac) ac.value = S.findCamp; });
      const upd = () => { store.set('find', JSON.stringify(S.find)); $('#find-go').href = liSearch(findQuery()); $('#find-preview').innerHTML = findPreview(); };
      [['find-loc', 'loc'], ['find-ent', 'ent'], ['find-dept', 'dept']].forEach(([id, k]) => $('#' + id).addEventListener('input', (e) => { S.find[k] = e.target.value; upd(); }));
      document.querySelectorAll('[data-topic]').forEach((b) => b.addEventListener('click', () => {
        S.find.topic = S.find.topic === b.dataset.topic ? '' : b.dataset.topic;
        document.querySelectorAll('[data-topic]').forEach((x) => { const on = x.dataset.topic === S.find.topic; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
        upd();
      }));
      $('#find-clear').addEventListener('click', () => { S.find = { loc: '', ent: '', dept: '', topic: '' }; store.set('find', JSON.stringify(S.find)); render(); });
      $('#find-go').addEventListener('click', (e) => { if (!findQuery()) { e.preventDefault(); toast('Fill at least one box or pick a topic first.', true); } });
      const ac = $('#a-camp'); if (ac && S.findCamp) ac.value = S.findCamp;
    }
    const af = $('#add-form');
    if (af) af.addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = { full_name: $('#a-name').value.trim(), linkedin_url: $('#a-li').value.trim(), job_title: $('#a-title').value.trim(), organization: $('#a-org').value.trim(),
        email: $('#a-email').value.trim(), phone: cleanPhone($('#a-phone').value), city: $('#a-city').value.trim(), campaign_code: $('#a-camp').value, source: $('#a-source').value, profile_notes: $('#a-notes').value.trim() };
      if (!/linkedin\.com\/(in|pub)\//i.test(p.linkedin_url)) { toast('Enter a LinkedIn profile URL like https://www.linkedin.com/in/name', true); return; }
      if (await sendProspects([p], af.querySelector('button[type=submit]'))) af.reset();
    });
    const bp = $('#bulk-parse');
    if (bp) {
      bp.addEventListener('click', () => {
        const txt = $('#bulk-text').value; S.bulkRows = parseDelimited(txt);
        if (!S.bulkRows.length) toast('No rows with a name or LinkedIn URL found.', true);
        render(); $('#bulk-text').value = txt;
      });
      $('#bulk-send').addEventListener('click', async (e) => {
        if (await sendProspects(S.bulkRows.slice(0, 200), e.target)) { S.bulkRows = []; render(); }
      });
    }
    const cardf = $('#card-form');
    if (cardf) cardf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const files = [...($('#card-file').files || [])].slice(0, 10); if (!files.length) return;
      if (S.mode === 'demo') { toast('Demo mode: connect your key to scan real cards.'); return; }
      const camp = $('#card-camp').value; const note = $('#card-note').value.trim(); remember(camp);
      const b = cardf.querySelector('button[type=submit]'); const st = $('#card-status'); b.disabled = true;
      const shrink = (file) => new Promise((res, rej) => { const img = new Image(); const url = URL.createObjectURL(file);
        img.onload = () => { const m = 1600, s = Math.min(1, m / Math.max(img.width, img.height)); const cv = document.createElement('canvas'); cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url); res(cv.toDataURL('image/jpeg', 0.85).split(',')[1]); };
        img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not open ' + file.name)); }; img.src = url; });
      const done = [];
      for (let i = 0; i < files.length; i++) {
        st.textContent = 'Reading photo ' + (i + 1) + ' of ' + files.length + '…';
        try {
          const image = await shrink(files[i]);
          const r = await fetch(CARD_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(JSON.stringify({ key: S.key, op: 'card', payload: { image: image, mime: 'image/jpeg', campaign_code: camp, note: note } })) });
          let j = null; try { j = await r.json(); } catch (er) { j = null; }
          if (!r.ok || !j) throw new Error((j && j.message) || 'The scanner answered with status ' + r.status);
          done.push(j.message); toast(j.message, j.ok === false);
        } catch (er) { toast(er.message, true); }
      }
      st.textContent = done.length ? 'Done. New people appear in about a minute.' : ''; b.disabled = false; cardf.reset();
      setTimeout(() => load(true), 60000);
    });
    const cfm = $('#camp-form');
    if (cfm) cfm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = { campaign_code: cfm.getAttribute('data-code') };
      CAMP_FIELDS.forEach(([k, , type]) => { const el = $('#cf-' + k); if (el) p[k] = type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value; });
      p.active = $('#cf-active').checked; p.auto_discovery = $('#cf-auto').checked;
      if (!String(p.campaign_name || '').trim()) { toast('Give the campaign a name.', true); return; }
      if (S.mode === 'demo') { const ex = campaigns().find((x) => x.campaign_code === p.campaign_code); if (ex) Object.assign(ex, p); else S.data.campaigns.push(p); S.campEdit = null; toast('Saved (demo only)'); render(); return; }
      const b = cfm.querySelector('button[type=submit]'); b.disabled = true;
      try { const j = await api('campaign_save', p); toast(j.message || 'Campaign saved.'); S.campEdit = null; await load(true); } catch (err) { toast(err.message, true); b.disabled = false; }
    });
    const lfm = $('#lib-form');
    if (lfm) lfm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = { content_id: lfm.getAttribute('data-id') || '', title: $('#lf-title').value.trim(), url: $('#lf-url').value.trim(), kind: $('#lf-kind').value, audience: $('#lf-aud').value.trim() || 'all', summary: $('#lf-sum').value.trim(), active: $('#lf-active').checked };
      if (S.mode === 'demo') { p.content_id = p.content_id || 'K' + Date.now().toString(36); S.data.content = (S.data.content || []).filter((x) => x.content_id !== p.content_id).concat([p]); S.libEdit = null; render(); return; }
      const b = lfm.querySelector('button[type=submit]'); b.disabled = true;
      try { const j = await api('content_save', p); toast(j.message || 'Saved.'); S.libEdit = null; await load(true); } catch (err) { toast(err.message, true); b.disabled = false; }
    });
    const sf = $('#settings-form');
    if (sf) {
      sf.addEventListener('submit', async (e) => {
        e.preventDefault();
        S.apiUrl = $('#s-url').value.trim() || DEFAULT_API; S.key = $('#s-key').value.trim();
        store.set('api', S.apiUrl); if (S.key) store.set('key', S.key); else store.del('key');
        S.data = null; await load();
        if (S.mode === 'live') { toast('Connected. Your contacts are loaded.'); go('today'); }
      });
      const fg = $('#s-forget');
      if (fg) fg.addEventListener('click', () => { store.del('key'); S.key = ''; S.error = ''; load(); toast('Key removed from this device.'); });
      $('#s-theme').addEventListener('change', (e) => {
        const t = e.target.value; store.set('theme', t);
        if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
      });
    }
  }

  function go(view) {
    S.view = view; S.drawer = null;
    try { history.replaceState(null, '', '#' + view); } catch (e) { location.hash = view; }
    render();
    const m = $('#main'); if (m) m.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-nav],[data-act],[data-copy],[data-open],[data-close],[data-refresh],[data-sort],[data-run],[data-campedit],[data-campfilter],[data-libedit],[data-libdel],[data-sendmail],[data-delete]');
    if (!t) return;
    if (t.hasAttribute('data-run')) { runJob(t.getAttribute('data-run'), t.getAttribute('data-camp') ? { campaign_code: t.getAttribute('data-camp'), limit: 12 } : {}, t); return; }
    if (t.hasAttribute('data-campedit')) { S.campEdit = t.getAttribute('data-campedit') || null; render(); window.scrollTo(0, 0); return; }
    if (t.hasAttribute('data-campfilter')) { S.filters = { q: '', status: '', campaign: t.getAttribute('data-campfilter') }; go('contacts'); return; }
    if (t.hasAttribute('data-libedit')) { S.libEdit = t.getAttribute('data-libedit') || null; if (S.libEdit === '__new') S.libEdit = '__new'; render(); window.scrollTo(0, 0); return; }
    if (t.hasAttribute('data-libdel')) {
      const id = t.getAttribute('data-libdel'); if (!confirm('Delete this library item?')) return;
      if (S.mode === 'demo') { S.data.content = S.data.content.filter((x) => x.content_id !== id); S.libEdit = null; render(); return; }
      api('content_delete', { content_id: id }).then((j) => { toast(j.message || 'Deleted.'); S.libEdit = null; return load(true); }).catch((er) => toast(er.message, true));
      return;
    }
    if (t.hasAttribute('data-sendmail')) {
      const c = contactByKey(t.getAttribute('data-sendmail')); if (!c) return;
      if (/\[[^\]]{2,80}\]/.test(c.pending_message || '')) { toast('The draft still has a [placeholder]. Edit it in your email app or fill it first; it will not be sent with placeholders.', true); return; }
      if (!confirm('Send this email now to ' + c.email + ' from your Gmail? An unsubscribe line is added at the bottom.')) return;
      if (S.mode === 'demo') { toast('Demo mode: nothing was sent.'); return; }
      t.disabled = true;
      api('send_email', { person_key: c.person_key, subject: c.pending_subject || '', body: c.pending_message || '' }).then((j) => { toast(j.message || 'Sent.'); return load(true); }).catch((er) => { toast(er.message, true); t.disabled = false; });
      return;
    }
    if (t.hasAttribute('data-delete')) {
      const c = contactByKey(t.getAttribute('data-delete')); if (!c) return;
      if (!confirm('Delete ' + c.full_name + ' and all their details permanently? This cannot be undone.')) return;
      if (S.mode === 'demo') { S.data.contacts = S.data.contacts.filter((x) => x !== c); S.drawer = null; render(); return; }
      api('delete', { person_key: c.person_key }).then((j) => { toast(j.message || 'Deleted.'); S.drawer = null; return load(true); }).catch((er) => toast(er.message, true));
      return;
    }
    if (t.hasAttribute('data-nav')) { go(t.getAttribute('data-nav')); return; }
    if (t.hasAttribute('data-act')) { doAction(t.getAttribute('data-key'), t.getAttribute('data-act'), t.getAttribute('data-v'), t); return; }
    if (t.hasAttribute('data-copy')) { copyText(t.getAttribute('data-copy'), t); return; }
    if (t.hasAttribute('data-open')) { S.drawer = t.getAttribute('data-open'); renderDrawer(); return; }
    if (t.hasAttribute('data-close')) { S.drawer = null; renderDrawer(); return; }
    if (t.hasAttribute('data-refresh')) { load(); return; }
    if (t.hasAttribute('data-sort')) {
      const col = t.getAttribute('data-sort');
      S.sort = S.sort.col === col ? { col, dir: -S.sort.dir } : { col, dir: col === 'full_name' || col === 'next_followup_date' ? 1 : -1 };
      render();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.drawer) { S.drawer = null; renderDrawer(); }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open]')) { e.preventDefault(); S.drawer = e.target.getAttribute('data-open'); renderDrawer(); }
  });

  const initial = (location.hash || '').replace('#', '');
  if (VIEWS.some((v) => v.id === initial)) S.view = initial;
  load();
  setInterval(() => { if (S.mode === 'live' && document.visibilityState === 'visible' && !S.drawer) load(true); }, 5 * 60 * 1000);
})();
