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
    sid: store.get('sid', ''),
    me: null,
    data: null,
    inbox: [],
    threads: {},
    sigs: [],
    reconnect: { list: [], total: 0, scan: [], loaded: false },
    rcAll: false,
    sigEdit: null,
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
  const cred = () => (S.sid ? { sid: S.sid } : { key: S.key });
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
  // phone status from the daily phone check (PRE-20): WhatsApp only for numbers that can be mobiles
  const waOk = (c) => !!(c && c.phone) && !['landline', 'invalid'].includes(String(c.phone_status || ''));
  const PHONE_BADGE = { mobile_verified: ['Mobile, confirmed', '#1a7f37'], mobile_likely: ['Mobile, likely', '#2f81f7'], landline: ['Landline / office', '#9a6700'], invalid: ['Invalid number', '#cf222e'], unchecked: ['Not checked yet', '#6e7781'] };
  const phoneBadge = (c) => { const b = PHONE_BADGE[c.phone_status || 'unchecked'] || PHONE_BADGE.unchecked; return '<span class="pill" style="border-color:' + b[1] + ';color:' + b[1] + '" title="' + esc(c.phone_sources || '') + '">' + b[0] + '</span>'; };
  const waBtn = (c, text) => waOk(c) ? '<a class="btn sm" style="background:#128c7e;color:#fff;border-color:#128c7e" target="_blank" rel="noopener" href="' + esc(waLink(c.phone, text)) + '">Send on WhatsApp' + (c.phone_status && c.phone_status !== 'unchecked' ? '' : ' (number not checked)') + '</a>' : (c && c.phone && c.phone_status === 'landline' ? '<a class="btn sm" href="tel:' + esc(c.phone) + '">Call ' + esc(c.phone) + '</a>' : '');
  const PHONE_API = 'https://n8n.assignover.in/webhook/pre-phone-check';
  const waLink = (ph, text) => { let d = String(ph || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return 'https://wa.me/' + d + (text ? '?text=' + encodeURIComponent(text) : ''); };
  const hasPlaceholder = (t) => /\[[^\]]{2,80}\]/.test(t || '');
  const calLink = (c) => { const t = new Date(); t.setDate(t.getDate() + 3); t.setHours(11, 0, 0, 0); const e = new Date(t.getTime() + 30 * 60000); const f = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent('Call: ' + (c.full_name || '') + (c.organization ? ' (' + c.organization + ')' : '')) + '&dates=' + f(t) + '/' + f(e) + '&details=' + encodeURIComponent((c.recommended_action || '') + '\n' + (c.linkedin_url || '')) + (c.email ? '&add=' + encodeURIComponent(c.email) : ''); };
  const CARD_API = 'https://n8n.assignover.in/webhook/pre-card';
  const INBOX_API = 'https://n8n.assignover.in/webhook/pre-inbox-api';
  const RECONNECT_API = 'https://n8n.assignover.in/webhook/pre-reconnect-api';
  const MAILBOXES = [['b2b0', 'info@b2btourdeals.com', 'B2B'], ['b2b1', 'ops1@b2btourdeals.com', 'B2B'], ['b2b2', 'ops2@b2btourdeals.com', 'B2B'], ['b2b3', 'ops3@b2btourdeals.com', 'B2B'], ['b2b4', 'ops4@b2btourdeals.com', 'B2B'], ['b2b5', 'ops5@b2btourdeals.com', 'B2B'], ['b2b6', 'ops6@b2btourdeals.com', 'B2B'], ['b2b7', 'ops7@b2btourdeals.com', 'B2B'],
    ['info', 'info@negotrip.com', 'B2C'], ['kn', 'kn0733@gmail.com', 'Individual / Research'], ['icssr', 'icssrmedicaltourism@gmail.com', 'Research'], ['assign', 'assignover@gmail.com', 'Research'], ['hpcu', 'ra1.tourism@hpcu.ac.in', 'Research']];
  // other addresses that live in the same Gmail account (a reply can go from either)
  const MB_ALT = { b2b0: ['b2btourdeals@gmail.com'], b2b1: ['ops1b2btourdeals@gmail.com'], b2b2: ['ops2b2btourdeals@gmail.com'], b2b3: ['ops3b2btourdeals@gmail.com'], b2b4: ['ops4b2btourdeals@gmail.com'], b2b5: ['ops5b2btourdeals@gmail.com'], b2b6: ['ops6b2btourdeals@gmail.com'], b2b7: ['ops7b2btourdeals@gmail.com'], info: ['sales@negotrip.in'] };
  const ALL_ADDR = [];
  MAILBOXES.forEach((m) => { ALL_ADDR.push(m[1]); (MB_ALT[m[0]] || []).forEach((a) => ALL_ADDR.push(a)); });
  const mbAddr = (k) => { if (String(k || '').includes('@')) return k; const m = MAILBOXES.find((x) => x[0] === k); return m ? m[1] : ''; };
  function fromOptionsHtml(selected, autoLabel) {
    const groups = {}; MAILBOXES.forEach((m) => { (groups[m[2]] = groups[m[2]] || []).push(m); });
    return '<option value="">' + esc(autoLabel || 'Automatic (best address)') + '</option>' + Object.keys(groups).map((g) => '<optgroup label="' + esc(g) + '">' + groups[g].map((m) => [m[1]].concat(MB_ALT[m[0]] || []).map((a) => '<option value="' + esc(a) + '"' + (a === selected ? ' selected' : '') + '>' + esc(a) + '</option>').join('')).join('') + '</optgroup>').join('');
  }
  const sigCovers = (g, addr) => { const a = String(g.addresses || '').toLowerCase(); return !a || a === 'all' || !addr || a.split(',').includes(String(addr).toLowerCase()); };
  function sigOptionsHtml(addr, selected) {
    const list = (S.sigs || []).filter((g) => g.active !== false && sigCovers(g, addr));
    const def = addr ? list.filter((g) => g.is_default).sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0] : null;
    const o = (v, l) => '<option value="' + esc(v) + '"' + (v === (selected || '') ? ' selected' : '') + '>' + esc(l) + '</option>';
    return o('', addr ? ('Default for this address: ' + (def ? def.label : 'Gmail signature')) : 'Default signature of the sending address') +
      list.map((g) => o(g.sig_id, g.label + (g.sender_name ? ' (as ' + g.sender_name + ')' : ''))).join('') +
      o('gmail', 'Gmail signature of this address') + o('none', 'No signature');
  }
  async function loadSigs() {
    if (S.mode !== 'live') return;
    try { const j = await inboxApi('sig_list'); S.sigs = j.signatures || []; if (S.view === 'settings' || S.view === 'today') render(); if (S.drawer) renderDrawer(); } catch (e) { S.sigs = S.sigs || []; }
  }
  const cleanSigHtml = (h) => String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<(meta|link|script|style)[^>]*>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/javascript:/gi, '').trim();
  const CAT_ORDER = ['Travel trade', 'Medical & wellness', 'Academic & research', 'Corporate', 'Government & public sector', 'Media & community'];
  function campOptionsHtml(selected, allLabel) {
    const groups = {};
    campaigns().forEach((c) => { const g = c.category || 'Other'; (groups[g] = groups[g] || []).push(c); });
    const names = Object.keys(groups).sort((a, b) => ((CAT_ORDER.indexOf(a) + 1) || 99) - ((CAT_ORDER.indexOf(b) + 1) || 99));
    return (allLabel ? '<option value="">' + esc(allLabel) + '</option>' : '') + names.map((g) => '<optgroup label="' + esc(g) + '">' +
      groups[g].sort((a, b) => String(a.campaign_name).localeCompare(String(b.campaign_name))).map((c) => '<option value="' + esc(c.campaign_code) + '"' + (c.campaign_code === selected ? ' selected' : '') + '>' + esc(c.campaign_name) + '</option>').join('') + '</optgroup>').join('');
  }
  const contactByKey = (k) => (S.data ? S.data.contacts.find((c) => c.person_key === k) : null);
  const canEmail = (c) => !!(c && c.email && ['verified', 'likely', 'found_unverified', 'provided_unverified', 'known'].includes(c.email_status) && !isDnc(c) && c.unsubscribed !== true);
  const igLine = (c) => {
    if (c.ig_status !== 'ok') return '<span class="faint">' + (c.ig_status === 'personal or not found' ? 'Personal or private account, stats not available' : 'Could not check yet') + (c.ig_checked_on ? ' (checked ' + esc(fmtDate(c.ig_checked_on)) + ')' : '') + '</span>';
    const days = c.ig_last_post ? Math.round((Date.now() - new Date(c.ig_last_post).getTime()) / 86400000) : null;
    const pill = (t, col) => ' <span class="pill" style="border-color:' + col + ';color:' + col + '">' + t + '</span>';
    const act = days === null ? '' : days <= 14 ? pill('Active', '#1a7f37') : days <= 90 ? pill('Posts monthly', '#2f81f7') : pill('Quiet', '#9a6700');
    return '<b>' + esc(num(c.ig_followers).toLocaleString('en-IN')) + '</b> followers · ' + esc(num(c.ig_posts).toLocaleString('en-IN')) + ' posts' + (c.ig_last_post ? ' · last post ' + esc(fmtDate(c.ig_last_post)) : '') + act + '<div class="faint" style="font-size:12px">Checked ' + esc(fmtDate(c.ig_checked_on)) + ' via the official Instagram API.</div>';
  };
  const JOBS = [
    ['discover', 'Discover new people', 'Searches OpenAlex, Google Places, listed websites (and Google, once Serper is added) for campaigns with auto-discovery on. Also runs every Monday 6:00.'],
    ['enrich', 'Research profiles', 'Reads publications and organisation websites for up to 10 new people, writes a profile and sends them for qualification. Also runs daily 6:40.'],
    ['email', 'Find email addresses', 'Checks official websites, contact pages and public sources for missing emails. Also runs daily 7:15.'],
    ['monitor', 'Monitor & spot opportunities', 'Looks for new publications and good timing, flags research, B2B, referral and network opportunities. Also runs Wed and Sat 7:10.'],
    ['report', 'Email me the weekly report', 'Funnel, campaign targets, opportunities and relationships going cold. Also every Monday 8:25.'],
    ['social', 'Find social pages', 'Reads each organisation website (and Google, when needed) for Facebook, Instagram, WhatsApp and a general company email such as info@. Also runs daily 8:00.'],
    ['igstats', 'Instagram stats', 'Looks up followers, posts and last post date for Instagram business accounts found on organisation pages (official Meta API). Also runs daily 8:30.'],
    ['phones', 'Check phone numbers', 'Cleans every number to +91 format and marks it mobile, landline or invalid. WhatsApp buttons hide for landlines. Also runs daily 7:30.'],
    ['sheet', 'Sync Google Sheet', 'Refreshes the mirror sheet and imports rows from its Import tab. Also every 6 hours.']
  ];
  const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1-y4kiIRBqUSsJHf04w52wttwXHATYGRbJZ7mJ6SoDjI/edit';
  async function runJob(job, extra, btn) {
    if (S.mode === 'demo') { toast('Demo mode: connect your key to run jobs.'); return; }
    if (job === 'social') {
      if (btn) btn.disabled = true;
      try {
        const r = await fetch('https://n8n.assignover.in/webhook/pre-social', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(JSON.stringify({ ...cred(), op: 'run', payload: { limit: 30 } })) });
        const j = await r.json(); toast((j && j.message) || 'Started.'); setTimeout(() => load(true), 240000);
      } catch (e) { toast('Could not start the social check.', true); } finally { if (btn) setTimeout(() => { btn.disabled = false; }, 4000); }
      return;
    }
    if (job === 'igstats') {
      if (btn) btn.disabled = true;
      try {
        const r = await fetch('https://n8n.assignover.in/webhook/pre-ig-stats', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(JSON.stringify({ ...cred(), op: 'run', payload: { limit: 40 } })) });
        const j = await r.json(); toast((j && j.message) || 'Started.'); setTimeout(() => load(true), 90000);
      } catch (e) { toast('Could not start the Instagram check.', true); } finally { if (btn) setTimeout(() => { btn.disabled = false; }, 4000); }
      return;
    }
    if (job === 'phones') {
      if (btn) btn.disabled = true;
      try {
        const r = await fetch(PHONE_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(JSON.stringify({ ...cred(), op: 'run', payload: { all: true } })) });
        const j = await r.json(); if (!j || j.ok === false) throw new Error((j && j.message) || 'The phone check did not answer.');
        toast(j.message || 'Phones checked.'); load(true);
      } catch (e) { toast(e.message, true); } finally { if (btn) setTimeout(() => { btn.disabled = false; }, 3000); }
      return;
    }
    if (btn) btn.disabled = true;
    try { const j = await api('run', Object.assign({ job: job }, extra || {})); toast(job === 'discover' ? 'Searching now. New people appear on Today under "Just discovered" in 2 to 5 minutes, then get researched and scored.' : (j.message || 'Started.')); if (job === 'discover') { setTimeout(() => load(true), 180000); setTimeout(() => load(true), 480000); } }
    catch (e) { toast(e.message, true); } finally { if (btn) setTimeout(() => { btn.disabled = false; }, 4000); }
  }

  // ---------- API ----------
  async function api(op, payload) {
    const body = 'data=' + encodeURIComponent(JSON.stringify({ ...cred(), op: op, payload: payload || {} }));
    let res;
    try {
      res = await fetch(S.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: body });
    } catch (e) {
      throw new Error('Could not reach n8n. Check the API address in Settings and that PRE-05 is published.');
    }
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (res.status === 401 || (j && j.code === 'signin')) { if (S.sid) { authLost(); throw new Error('Please sign in again.'); } throw new Error('The access key was rejected. Re-enter it in Settings or sign in with Google.'); }
    if (!res.ok || !j) throw new Error((j && j.message) || 'n8n answered with status ' + res.status + '.');
    if (j.ok === false) throw new Error(j.message || 'The request did not go through.');
    return j;
  }

  async function inboxApi(op, payload) {
    const r = await fetch(INBOX_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(JSON.stringify({ ...cred(), op: op, payload: payload || {} })) });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (j && j.code === 'signin') { authLost(); throw new Error('Please sign in again.'); }
    if (!r.ok || !j) throw new Error((j && j.message) || 'The inbox answered with status ' + r.status + '.');
    if (j.ok === false) throw new Error(j.message || 'The inbox request did not go through.');
    return j;
  }
  async function rcApi(op, payload) {
    const r = await fetch(RECONNECT_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(JSON.stringify({ ...cred(), op: op, payload: payload || {} })) });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (j && j.code === 'signin') { authLost(); throw new Error('Please sign in again.'); }
    if (!r.ok || !j) throw new Error((j && j.message) || 'The reconnect service answered with status ' + r.status + '.');
    if (j.ok === false) throw new Error(j.message || 'The request did not go through.');
    return j;
  }
  async function loadReconnect() {
    if (S.mode !== 'live') return;
    try { const j = await rcApi('list'); S.reconnect = { list: j.list || [], total: j.total || 0, scan: j.scan || [], loaded: true }; if (S.view === 'today' || S.view === 'settings') render(); } catch (e) { /* keep the old list */ }
  }
  async function loadInbox() {
    if (S.mode !== 'live') return;
    try { const j = await inboxApi('list'); S.inbox = j.inbox || []; if (S.view === 'today') render(); } catch (e) { S.inbox = S.inbox || []; }
  }
  async function loadThread(key) {
    if (S.mode !== 'live' || !key) return;
    try { const j = await inboxApi('thread', { person_key: key }); S.threads[key] = j.thread || []; } catch (e) { S.threads[key] = []; }
    if (S.drawer === key) renderDrawer();
  }

  async function load(quiet) {
    if (!S.key && !S.sid) {
      S.me = null;
      S.mode = 'demo';
      S.data = JSON.parse(JSON.stringify(window.DEMO_DATA)); S.data.content = S.data.content || []; S.data.suppressed = 0;
      S.lastSync = null;
      render();
      return;
    }
    S.loading = true; if (!quiet) renderChrome();
    try {
      if (!S.me) await loadMe();
      const j = await api('bootstrap');
      S.data = { contacts: j.contacts || [], campaigns: j.campaigns || [], interactions: j.interactions || [], content: j.content || [], suppressed: j.suppressed || 0 };
      S.mode = 'live'; S.error = ''; S.lastSync = new Date(); S.threads = {};
      setTimeout(loadInbox, 50); setTimeout(loadSigs, 400); setTimeout(loadReconnect, 700);
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
    { id: 'bulk', label: 'Bulk email' },
    { id: 'library', label: 'Library' },
    { id: 'add', label: 'Add people' },
    { id: 'guide', label: 'How it works' },
    { id: 'team', label: 'Team' },
    { id: 'settings', label: 'Settings' }
  ];
  const viewAllowed = (id) => { if (!S.me) return id !== 'team'; if (id === 'team') return can('members') || can('approve'); if (id === 'bulk') return can('bulk_draft') || can('approve'); if (id === 'add') return can('import') || can('edit_contacts'); return true; };
  const navViews = () => VIEWS.filter((v) => viewAllowed(v.id));
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
      '@media (max-width:900px){#bk-edit-form{grid-template-columns:1fr!important}#bk-edit-form>.panel{position:static!important}}.chip input{accent-color:var(--accent)}' +
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
    const navHtml = navViews().map((v) => '<button type="button" data-nav="' + v.id + '"' + (S.view === v.id ? ' aria-current="page"' : '') + '><span>' + v.label + '</span>' +
      (v.id === 'today' && todayCount ? '<span class="count num">' + todayCount + '</span>' : '') + '</button>').join('');
    $('#nav').innerHTML = navHtml;
    $('#mobile-nav').innerHTML = navViews().map((v) => '<button type="button" data-nav="' + v.id + '"' + (S.view === v.id ? ' aria-current="page"' : '') + '>' +
      (v.id === 'add' ? 'Add' : (v.id === 'guide' ? 'Help' : (v.id === 'campaigns' ? 'Camps' : (v.id === 'bulk' ? 'Bulk' : v.label)))) + (v.id === 'today' && todayCount ? ' · ' + todayCount : '') + '</button>').join('');

    const dot = $('#conn-dot'); const txt = $('#conn-text');
    dot.className = 'dot ' + (S.mode === 'live' ? 'live' : 'demo');
    txt.textContent = S.loading ? 'Syncing…' : (S.mode === 'live' ? (S.me ? S.me.name + ' · ' + (ROLE_LABEL[S.me.role] || S.me.role) : 'Connected to n8n') : 'Demo data');
    $('#sync-text').textContent = S.lastSync ? 'Synced ' + S.lastSync.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';

    $('#banner').innerHTML = S.mode === 'demo'
      ? '<div class="banner"><span><b>Demo mode.</b> You are looking at sample people, and buttons change nothing. Sign in with Google to load your real contacts.</span><button class="btn sm primary" data-nav="settings" type="button">Sign in</button></div>'
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
    const inbox = (S.inbox || []);
    if (inbox.length) {
      h += '<section class="section"><div class="section-head"><h2>Inbox · ' + inbox.length + ' new ' + (inbox.length === 1 ? 'reply' : 'replies') + '</h2><span class="hint">Replies from your contacts to any of your connected addresses, checked every 10 minutes. Your answer goes back in the same email thread, from the address they wrote to.</span></div><div class="cards">' + inbox.map(inboxCard).join('') + '</div></section>';
    }

    h += '<section class="section"><div class="section-head"><h2>Connect on LinkedIn</h2><span class="hint">Open the profile, send the request yourself, then log which note you used.' +
      (backlog > 0 ? ' ' + backlog + ' more wait behind today\'s campaign limits.' : '') + '</span></div>';
    h += queue.length ? '<div class="cards">' + queue.map(queueCard).join('') + '</div>' : '<div class="empty">Nobody is waiting to be contacted. Add people from the Add people tab.</div>';
    h += '</section>';

    const found = S.data.contacts.filter((c) => c.status === 'QUALIFIED' && !c.linkedin_url && !isDnc(c)).sort((a, b) => num(b.priority_score) - num(a.priority_score)).slice(0, 12);
    const pending = S.data.contacts.filter((c) => ['IDENTIFIED', 'RESEARCHED'].includes(c.status) && !isDnc(c)).sort((a, b) => String(b.added_on || '').localeCompare(String(a.added_on || '')));
    if (pending.length) {
      h += '<section class="section"><div class="section-head"><h2>Just discovered · ' + pending.length + ' being researched</h2><span class="hint">New people from Discover now, mailboxes and imports. The engine researches and scores them (usually within 10 minutes); good matches then move to Found by discovery below.</span></div>';
      h += '<div class="panel table-wrap"><table><tbody>' + pending.slice(0, 15).map((c) => '<tr><td>' + whoBlock(c) + '<div class="faint" style="margin-top:3px">' + esc(c.source || '') + ' · ' + esc(campaignName(c.campaign_code)) + '</div></td><td><span class="pill">' + (c.status === 'IDENTIFIED' ? 'found' : 'researched') + '</span></td><td><div class="actions"><button type="button" class="btn sm" data-open="' + esc(c.person_key) + '">Details</button>' + act(c, 'notrelevant', 'Not relevant', 'ghost bad') + '</div></td></tr>').join('') + '</tbody></table>' + (pending.length > 15 ? '<div class="faint" style="padding:8px">+ ' + (pending.length - 15) + ' more in Contacts</div>' : '') + '</div></section>';
    }
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
    h += reconnectSection();
    return h;
  }

  const MB_NAME = { b2b0: 'info@b2btourdeals.com', b2b1: 'ops1', b2b2: 'ops2', b2b3: 'ops3', b2b4: 'ops4', b2b5: 'ops5', b2b6: 'ops6', b2b7: 'ops7', kn: 'kn0733', info: 'info@negotrip.com', icssr: 'icssrmedicaltourism', assign: 'assignover', hpcu: 'ra1.tourism@hpcu' };
  function scanLine() {
    const sc = (S.reconnect.scan || []).filter((x) => x.back_to);
    if (!sc.length) return '';
    const oldest = sc.map((x) => x.back_to).sort()[0]; const newest = sc.map((x) => x.back_to).sort().pop();
    const done = sc.filter((x) => x.done).length;
    return done === sc.length ? 'All ' + sc.length + ' mailboxes are read back two years.' : 'So far the mailboxes are read back to dates between ' + fmtDate(oldest) + ' and ' + fmtDate(newest) + ' (' + done + ' of ' + sc.length + ' finished). Older contacts appear here as the scan goes further back.';
  }
  function reconnectSection() {
    const R = S.reconnect; if (S.mode !== 'live' || !R.loaded) return '';
    let h = '<section class="section"><div class="section-head"><h2>Reconnect' + (R.total ? ' · ' + R.total : '') + '</h2><span class="hint">People you exchanged email with both ways who have been quiet for 6 months or more, strongest first. Draft a note, review it, then send it from their details.</span></div>';
    if (!R.list.length) return h + '<div class="empty">Nobody to reconnect with yet. ' + esc(scanLine()) + '</div></section>';
    const list = S.rcAll ? R.list : R.list.slice(0, 6);
    h += '<div class="cards">' + list.map(reconnectCard).join('') + '</div>';
    if (R.list.length > 6) h += '<div class="actions" style="margin-top:8px"><button type="button" class="btn sm ghost" data-rcmore="1">' + (S.rcAll ? 'Show fewer' : 'Show all ' + R.list.length) + '</button></div>';
    return h + '<p class="hint-line">' + esc(scanLine()) + '</p></section>';
  }
  function reconnectCard(r) {
    const e = esc(r.email);
    const who = '<span class="name"' + (r.in_contacts ? ' role="button" tabindex="0" data-open="' + esc(r.person_key) + '"' : '') + '>' + esc(r.name) + '</span><span class="role">' + esc([r.job_title, r.organization].filter(Boolean).join(', ')) + '</span>';
    let btns = '';
    if (r.in_contacts) btns += r.has_draft ? '<button type="button" class="btn sm primary" data-open="' + esc(r.person_key) + '">Open draft</button>' : '<button type="button" class="btn sm primary" data-rcdraft="' + e + '">Draft a note</button>';
    else btns += '<button type="button" class="btn sm primary" data-rcadd="' + e + '">Add to contacts</button>';
    btns += '<button type="button" class="btn sm" data-rcsnooze="' + e + '">Snooze 3 months</button><button type="button" class="btn sm ghost" data-rcnever="' + e + '">Not a work contact</button>';
    return '<article class="card"><div class="card-head"><div class="who">' + who + '</div><div class="actions"><span class="pill">' + esc(r.months_quiet) + ' months quiet</span></div></div>' +
      '<div class="faint" style="font-size:12.5px">' + e + (r.in_contacts ? ' · ' + esc(String(r.status || '').replace(/_/g, ' ').toLowerCase()) : ' · not in contacts yet') + '</div>' +
      '<div style="margin:6px 0">' + esc(r.reason) + '</div><div class="actions">' + btns + '</div></article>';
  }

  function inboxCard(m) {
    const id = esc(m.gmail_id); const to = m.to_address || mbAddr(m.mailbox);
    return '<article class="card"><div class="card-head"><div class="who"><span class="name" role="button" tabindex="0" data-open="' + esc(m.person_key) + '">' + esc(m.full_name || m.from_email) + '</span><span class="role">' + esc(m.from_email) + ' → ' + esc(to) + '</span></div>' +
      '<div class="actions"><span class="pill">' + fmtDate(String(m.received_at || '').slice(0, 10)) + '</span></div></div>' +
      '<div><b>' + esc(m.subject || '(no subject)') + '</b></div><div class="draft" style="max-height:220px;overflow:auto">' + esc(m.body) + '</div>' +
      '<label class="field" for="ib-' + id + '">Your reply<textarea id="ib-' + id + '" placeholder="Write your answer. It goes from ' + esc(to) + ' in the same thread."></textarea></label>' +
      '<label class="field" for="ibs-' + id + '" style="max-width:420px">Signature<select id="ibs-' + id + '">' + sigOptionsHtml(to, '') + '</select></label>' +
      '<div class="actions"><button type="button" class="btn sm primary" data-inboxreply="' + id + '">Send reply</button><button type="button" class="btn sm" data-open="' + esc(m.person_key) + '">Details</button><button type="button" class="btn sm ghost" data-inboxdone="' + id + '">Mark handled</button></div></article>';
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
      waBtn(c, c.pending_message) +
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
  function threadHtml(c) {
    const t = S.threads[c.person_key];
    if (t === undefined && S.mode === 'live') { S.threads[c.person_key] = null; setTimeout(() => loadThread(c.person_key), 0); }
    if (!t) return '<div class="faint">' + (S.mode === 'live' ? 'Loading…' : 'Connect your key to see emails.') + '</div>';
    if (!t.length) return '<div class="faint">No emails through the engine yet' + (c.send_mailbox ? '. Home address: ' + esc(mbAddr(c.send_mailbox)) : '') + '.</div>';
    return '<div class="timeline">' + t.map((m) => '<div class="tl ' + (m.dir === 'in' ? 'in' : 'out') + '"><div class="meta">' + fmtDate(String(m.at || '').slice(0, 10)) + ' · ' + (m.dir === 'in' ? 'they wrote to ' : 'you wrote from ') + esc(m.address || mbAddr(m.mailbox)) + '</div><div><b>' + esc(m.subject || '') + '</b></div>' + (m.body ? '<div class="msg">' + esc(m.body) + '</div>' : '') + '</div>').join('') + '</div>';
  }

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
      '<dt>Phone</dt><dd>' + (c.phone ? '<a class="mono" href="tel:' + esc(c.phone) + '">' + esc(c.phone) + '</a> ' + phoneBadge(c) + (waOk(c) ? ' · <a href="' + esc(waLink(c.phone)) + '" target="_blank" rel="noopener">WhatsApp</a>' : '') + (c.phone_sources ? '<div class="faint" style="font-size:12px">Seen on: ' + esc(c.phone_sources) + '</div>' : '') : '<span class="faint">Not added yet.</span> <a href="#" onclick="var e=document.getElementById(\'e-phone\');e.scrollIntoView({block:\'center\'});e.focus();return false">Add mobile</a>') + '</dd>' +
      '<dt>Location</dt><dd>' + esc([c.city, c.country].filter(Boolean).join(', ') || '—') + '</dd>' +
      (c.facebook_url || c.instagram_handle || c.org_whatsapp || c.org_email ? '<dt>Organisation</dt><dd>' + [
        c.facebook_url ? '<a href="' + esc(c.facebook_url) + '" target="_blank" rel="noopener">Facebook</a>' : '',
        c.instagram_handle ? '<a href="https://www.instagram.com/' + esc(encodeURIComponent(c.instagram_handle)) + '/" target="_blank" rel="noopener">Instagram @' + esc(c.instagram_handle) + '</a>' : '',
        c.org_whatsapp ? '<a href="' + esc(waLink(c.org_whatsapp)) + '" target="_blank" rel="noopener">Company WhatsApp</a>' : '',
        c.org_email ? '<a class="mono" href="mailto:' + esc(c.org_email) + '">' + esc(c.org_email) + '</a> <span class="faint">(company)</span>' : ''].filter(Boolean).join(' · ') + (c.social_source ? '<div class="faint" style="font-size:12px">Found via ' + esc(c.social_source) + '. Open and message from your own accounts.</div>' : '') + '</dd>' : '') +
      (c.ig_status ? '<dt>Instagram</dt><dd>' + igLine(c) + '</dd>' : '') +
      (c.maps_url || c.rating ? '<dt>Google Maps</dt><dd>' + (c.rating ? '<b>' + esc(Number(c.rating).toFixed(1)) + '★</b> <span class="faint">(' + esc(num(c.review_count || 0)) + ' reviews)</span> ' : '') + (c.maps_url ? '<a href="' + esc(c.maps_url) + '" target="_blank" rel="noopener">Open in Maps</a>' : '') + '</dd>' : '') +
      '<dt>Interests</dt><dd>' + esc(c.interests || '—') + '</dd>' +
      '<dt>Scores</dt><dd>' + scoreLine(c) + '</dd>' +
      '<dt>Added</dt><dd>' + fmtDate(c.added_on) + ' · ' + esc(c.source || '') + '</dd></dl></div>' +
      (c.pending_message ? '<div class="section"><h3>Draft waiting</h3>' + (c.pending_subject ? '<div><b>Subject:</b> ' + esc(c.pending_subject) + '</div>' : '') + '<div class="draft">' + esc(c.pending_message) + '</div><div class="actions"><button type="button" class="btn sm" data-copy="' + esc(c.pending_message) + '">Copy</button>' +
        act(c, /^They replied/.test(c.last_contact_summary || '') ? 'replied' : 'fu_linkedin', 'Mark as sent', 'good') +
        (canEmail(c) ? '<label class="field" for="d-from" style="min-width:220px">Send from<select id="d-from">' + fromOptionsHtml('', c.send_mailbox ? 'Home address: ' + mbAddr(c.send_mailbox) : 'Automatic (campaign address)') + '</select></label><label class="field" for="d-sig" style="min-width:220px">Signature<select id="d-sig">' + sigOptionsHtml(c.send_mailbox ? mbAddr(c.send_mailbox) : '', '') + '</select></label><button type="button" class="btn sm primary" data-sendmail="' + esc(c.person_key) + '">Send as email now</button>' : '') +
        waBtn(c, c.pending_message) + '</div></div>' : '') +
      '<div class="section"><h3>Email conversation</h3>' + threadHtml(c) + '</div>' +
      (notes && c.status === 'READY_FOR_CONNECTION' ? '<div class="section"><h3>Connection notes</h3><div class="notes">' + notes + '</div></div>' : '') +
      '<div class="section"><h3>History</h3>' + (hist.length ? '<div class="timeline">' + hist.map((i) => '<div class="tl ' + (i.direction === 'inbound' ? 'in' : (i.direction === 'outbound' ? 'out' : '')) + '"><div class="meta">' + fmtDate(i.interaction_date) + ' · ' + esc(i.channel) + ' · ' + esc(String(i.interaction_type || '').replace(/_/g, ' ')) + (i.intent ? ' · ' + esc(i.intent.replace(/_/g, ' ').toLowerCase()) : '') + '</div>' + (i.message ? '<div class="msg">' + esc(i.message) + '</div>' : '') + '</div>').join('') + '</div>' : '<div class="faint">Nothing logged yet.</div>') + '</div>' +
      (isDnc(c) ? '' : '<form class="panel section" id="reply-form"><h3>Log their reply</h3><p class="faint" style="margin:0">Paste what they said. The AI classifies it, moves the stage and drafts your answer.</p>' +
        '<label class="field" for="r-channel">Channel<select id="r-channel"><option>linkedin</option><option>email</option><option>whatsapp</option><option>phone</option><option>meeting</option></select></label>' +
        '<label class="field" for="r-msg">What they said<textarea id="r-msg" required></textarea></label>' +
        '<label class="field" for="r-notes">Your notes (optional)<input id="r-notes" type="text"></label>' +
        '<div><button class="btn primary" type="submit">Log reply</button></div></form>') +
      assignPanel(c) +
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
        (can('delete') ? '<button type="button" class="btn sm ghost bad" data-delete="' + esc(c.person_key) + '">Delete permanently</button>' : '') + '</div></div>' +
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
    const asf = $('#assign-form');
    if (asf) asf.addEventListener('submit', async (e) => {
      e.preventDefault(); const b = asf.querySelector('button[type=submit]'); b.disabled = true;
      try { const j = await api('assign', { person_key: c.person_key, assigned_to: $('#as-who').value, send_mailbox: $('#as-mb').value }); toast(j.message || 'Saved.'); await load(true); } catch (err) { toast(err.message, true); b.disabled = false; }
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
    ['campaign_name', 'Name', 'text'], ['category', 'Category', 'cat'], ['relationship_type', 'Relationship type', 'text'], ['sender_identity', 'Write as', 'identity'], ['sender', 'Send emails from', 'sender'],
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
        if (type === 'sender') return '<label class="field" for="cf-' + k + '">' + label + '<select id="cf-' + k + '">' + [['', 'Automatic (researcher: kn0733, else info@negotrip.com)'], ['B2B', 'B2B: rotate the 8 b2btourdeals addresses'], ['B2C', 'B2C: info@negotrip.com'], ['Research', 'Research: kn0733@gmail.com'], ['Individual', 'Individual: kn0733@gmail.com']].map((o) => '<option value="' + o[0] + '"' + (o[0] === v ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '<optgroup label="One fixed address">' + MAILBOXES.map((m) => '<option value="' + m[1] + '"' + (m[1] === v ? ' selected' : '') + '>' + esc(m[1]) + '</option>').join('') + '</optgroup></select></label>';
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

  // ---------- BULK EMAIL (lists, campaigns, warm-up) ----------
  const BULK_LISTS_API = 'https://n8n.assignover.in/webhook/pre-bulk-api';
  const BULK_CAMP_API = 'https://n8n.assignover.in/webhook/pre-bulk-camp';
  const BULK_RUN_API = 'https://n8n.assignover.in/webhook/pre-bulk-run';
  const BULK_TEST_API = 'https://n8n.assignover.in/webhook/pre-bulk-test';
  const BK = { tab: store.get('bktab', 'campaigns'), loaded: false, loading: false, buckets: [], campaigns: [], warmup: [], plan: null,
    rows: { bucket: '', filter: 'all', q: '', offset: 0, total: 0, list: [] }, bucketEdit: null, importFor: '', imp: null, fromFor: '',
    edit: null, detail: '', sends: { filter: 'all', list: [], total: 0 }, sample: [], sampleBucket: '', sampleIdx: 0 };
  const bkPost = async (url, op, payload) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(JSON.stringify({ ...cred(), op: op, payload: payload || {} })) });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (j && j.code === 'signin') { authLost(); throw new Error('Please sign in again.'); }
    if (!r.ok || !j) throw new Error((j && j.message) || 'The bulk service answered with status ' + r.status + '.');
    if (j.ok === false) throw new Error(j.message || 'The request did not go through.');
    return j;
  };
  const MB_KEYS = MAILBOXES.map((m) => m[0]);
  const mbLabel = (k) => { const m = MAILBOXES.find((x) => x[0] === k); return m ? m[1] : k; };
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
  const bkBucket = (id) => BK.buckets.find((b) => b.bucket_id === id) || {};
  const bkCamp = (id) => BK.campaigns.find((c) => c.campaign_id === id) || null;
  const BK_STATUS = { draft: ['Draft', '#6e7781'], running: ['Sending', '#1a7f37'], paused: ['Paused', '#9a6700'], done: ['Finished', '#2f81f7'] };
  const bkPill = (s) => { const x = BK_STATUS[s] || [s || '—', '#6e7781']; return '<span class="pill" style="border-color:' + x[1] + ';color:' + x[1] + '">' + esc(x[0]) + '</span>'; };
  const VSTAT = { valid: ['Valid', '#1a7f37'], pending: ['Checking', '#2f81f7'], risky: ['Risky', '#9a6700'], invalid: ['Invalid', '#cf222e'] };
  const vPill = (v, why) => { const x = VSTAT[v] || [v || '—', '#6e7781']; return '<span class="pill" title="' + esc(why || '') + '" style="border-color:' + x[1] + ';color:' + x[1] + '">' + esc(x[0]) + '</span>'; };
  // merge fields: {first_name}, {organisation}, {city}, {full_name}, {email}, any CSV column, {field|fallback}
  const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const fieldsOf = (r) => { const f = { first_name: r.first_name, full_name: r.full_name, name: r.full_name, organisation: r.organisation, organization: r.organisation, company: r.organisation, city: r.city, email: r.email }; let x = {}; try { x = JSON.parse(r.extra || '{}'); } catch (e) { x = {}; } Object.keys(x).forEach((k) => { const nk = normKey(k); if (nk && !String(f[nk] || '').trim()) f[nk] = x[k]; }); return f; };
  const mergeT = (t, f) => { const miss = []; const text = String(t || '').replace(/\{\s*([a-zA-Z0-9_ .-]{1,40}?)\s*(?:\|([^{}]{0,60}))?\}/g, (m, k, fb) => { const v = String(f[normKey(k)] == null ? '' : f[normKey(k)]).trim(); if (v) return v; if (fb !== undefined) return fb.trim(); miss.push(k.trim()); return ''; }); return { text, miss }; };
  const parseCsv = (text) => {
    const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const first = src.split('\n')[0] || '';
    const sep = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (q) { if (ch === '"' && src[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === sep) { row.push(cur.trim()); cur = ''; } else if (ch === '\n') { row.push(cur.trim()); rows.push(row); row = []; cur = ''; } else cur += ch;
    }
    if (cur || row.length) { row.push(cur.trim()); rows.push(row); }
    const clean = rows.filter((r) => r.some((c) => c));
    if (!clean.length) return { headers: [], rows: [] };
    let headers = clean[0].map((h, i) => h || 'column_' + (i + 1));
    let body = clean.slice(1);
    if (headers.some((h) => /@/.test(h))) { headers = headers.map((h, i) => (/@/.test(h) ? 'email' : 'column_' + (i + 1))); body = clean; }
    return { headers, rows: body.map((r) => { const o = {}; headers.forEach((h, i) => { if (r[i] !== undefined && r[i] !== '') o[h] = r[i]; }); return o; }) };
  };
  const emailCol = (headers) => headers.find((h) => /^(e-?mail|email ?address|e-?mail ?id|mail)$/i.test(h.trim())) || headers.find((h) => /mail/i.test(h));

  async function loadBulk(force) {
    if (S.mode !== 'live') return;
    if (BK.loading || (BK.loaded && !force)) return;
    BK.loading = true;
    try {
      const [l, c] = await Promise.all([bkPost(BULK_LISTS_API, 'buckets'), bkPost(BULK_CAMP_API, 'list')]);
      BK.buckets = l.buckets || []; BK.campaigns = c.campaigns || []; BK.warmup = c.warmup || [];
      BK.loaded = true;
    } catch (e) { toast(e.message, true); } finally { BK.loading = false; if (S.view === 'bulk') render(); }
  }
  async function loadBkRows() {
    if (!BK.rows.bucket) return;
    try { const j = await bkPost(BULK_LISTS_API, 'rows', { bucket_id: BK.rows.bucket, filter: BK.rows.filter, q: BK.rows.q, offset: BK.rows.offset, limit: 50 }); BK.rows.list = j.rows || []; BK.rows.total = j.total || 0; }
    catch (e) { toast(e.message, true); }
    if (S.view === 'bulk') render();
  }
  async function loadSample(bucketId) {
    if (!bucketId || S.mode !== 'live') { BK.sample = []; return; }
    if (BK.sampleBucket === bucketId && BK.sample.length) return;
    try { const j = await bkPost(BULK_LISTS_API, 'rows', { bucket_id: bucketId, filter: 'valid', limit: 200 }); BK.sample = (j.rows || []).filter((r) => r.status === 'active'); BK.sampleBucket = bucketId; BK.sampleIdx = 0; }
    catch (e) { BK.sample = []; }
    if (S.view === 'bulk' && BK.edit) bkPreview();
  }
  async function loadSends() {
    if (!BK.detail) return;
    try { const j = await bkPost(BULK_CAMP_API, 'sends', { campaign_id: BK.detail, filter: BK.sends.filter }); BK.sends.list = j.sends || []; BK.sends.total = j.total || 0; }
    catch (e) { toast(e.message, true); }
    if (S.view === 'bulk') render();
  }
  async function loadPlan(btn) {
    if (btn) btn.disabled = true;
    try { BK.plan = await bkPost(BULK_RUN_API, 'plan'); } catch (e) { toast(e.message, true); }
    if (btn) btn.disabled = false;
    if (S.view === 'bulk') render();
  }

  function renderBulk() {
    const tabs = [['campaigns', 'Campaigns'], ['lists', 'Lists & buckets'], ['mailboxes', 'Mailboxes & sending']];
    let h = topbar('Bulk email', 'Your own GMass: lists in buckets, checked addresses, warm-up limits per mailbox, open tracking and automatic follow-ups.',
      '<button class="btn primary" type="button" data-bk="newcamp">New campaign</button>');
    if (S.mode !== 'live') return h + '<div class="empty">Connect your access key in Settings to use bulk email. Nothing is sent from demo mode.</div>';
    h += '<div class="chips" role="tablist" style="margin-bottom:14px">' + tabs.map((t) => '<button type="button" class="chip' + (BK.tab === t[0] ? ' on' : '') + '" data-bk="tab" data-id="' + t[0] + '" aria-pressed="' + (BK.tab === t[0]) + '">' + t[1] + '</button>').join('') + '</div>';
    if (!BK.loaded) return h + '<div class="empty">' + (BK.loading ? 'Loading lists and campaigns…' : 'Loading…') + '</div>';
    if (BK.edit) return h + bkEditor();
    if (BK.tab === 'lists') return h + bkLists();
    if (BK.tab === 'mailboxes') return h + bkMailboxes();
    return h + (BK.detail ? bkDetail() : bkCampaigns());
  }

  function bkCampaigns() {
    const cs = BK.campaigns;
    if (!cs.length) return '<div class="empty">No bulk campaigns yet. Import a list into a bucket (Lists & buckets), then press <b>New campaign</b>.</div>';
    const rows = cs.map((c) => {
      const s = c.stats || {}; const b = bkBucket(c.bucket_id);
      let steps = 1; try { steps += JSON.parse(c.followups || '[]').length; } catch (e) { /* none */ }
      const act = c.status === 'running' ? '<button class="btn sm" type="button" data-bk="pause" data-id="' + esc(c.campaign_id) + '">Pause</button>'
        : (c.status === 'done' ? '' : '<button class="btn sm primary" type="button" data-bk="start" data-id="' + esc(c.campaign_id) + '">' + (c.status === 'paused' ? 'Resume' : 'Start') + '</button>');
      return '<tr><td><b>' + esc(c.name) + '</b><div class="faint">' + esc(b.name || c.bucket_id) + ' · ' + steps + ' email' + (steps > 1 ? 's' : '') + ' · ' + esc(c.sendable || 0) + ' sendable' + (c.notes ? '<br><span style="color:#9a6700">' + esc(c.notes) + '</span>' : '') + '</div></td>' +
        '<td>' + bkPill(c.status) + (c.approval_status === 'pending' ? '<div><span class="pill" style="border-color:#9a6700;color:#9a6700">Waiting for approval</span></div>' : (c.approval_status === 'rejected' ? '<div><span class="pill" style="border-color:#cf222e;color:#cf222e">Sent back</span></div>' : '')) + '</td><td class="r num">' + esc(s.people || 0) + (s.today ? '<div class="faint">' + s.today + ' today</div>' : '') + '</td><td class="r num">' + pct(s.opened, s.people) + '</td><td class="r num">' + pct(s.replied, s.people) + '</td><td class="r num">' + esc((s.bounced || 0) + ' / ' + (s.unsubscribed || 0)) + '</td>' +
        '<td><div class="actions" style="justify-content:flex-end">' + act + '<button class="btn sm ghost" type="button" data-bk="detail" data-id="' + esc(c.campaign_id) + '">Results</button><button class="btn sm ghost" type="button" data-bk="edit" data-id="' + esc(c.campaign_id) + '">Edit</button></div></td></tr>';
    }).join('');
    return '<div class="panel table-wrap" style="padding:0"><table><thead><tr><th>Campaign</th><th>Status</th><th class="r">People sent</th><th class="r">Opened</th><th class="r">Replied</th><th class="r">Bounced / unsub</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="hint-line" style="margin-top:10px">Opens are counted when the recipient\'s mail app loads images, so treat them as a rough signal. Replies, bounces and unsubscribes are exact; each one stops that person\'s follow-ups.</p>';
  }

  function bkDetail() {
    const c = bkCamp(BK.detail); if (!c) { BK.detail = ''; return bkCampaigns(); }
    const s = c.stats || {}; const by = s.by_step || {};
    const card = (n, l, sub) => '<div class="panel" style="gap:2px;display:flex;flex-direction:column;min-width:120px"><div class="num" style="font-size:22px;font-weight:700">' + n + '</div><div class="faint">' + l + (sub ? ' · ' + sub : '') + '</div></div>';
    let F = []; try { F = JSON.parse(c.followups || '[]'); } catch (e) { F = []; }
    let h = '<div class="actions" style="margin-bottom:10px"><button class="btn ghost" type="button" data-bk="back">← All campaigns</button>' + (c.status === 'running' ? '<button class="btn" type="button" data-bk="pause" data-id="' + esc(c.campaign_id) + '">Pause</button>' : (c.status !== 'done' ? '<button class="btn primary" type="button" data-bk="start" data-id="' + esc(c.campaign_id) + '">' + (c.status === 'paused' ? 'Resume' : 'Start') + '</button>' : '')) + '<button class="btn ghost" type="button" data-bk="edit" data-id="' + esc(c.campaign_id) + '">Edit</button></div>';
    h += '<h2 style="margin:0 0 4px">' + esc(c.name) + ' ' + bkPill(c.status) + '</h2><p class="muted" style="margin:0 0 12px">' + esc(bkBucket(c.bucket_id).name || c.bucket_id) + ' · from ' + esc((c.mailboxes || bkBucket(c.bucket_id).mailboxes || '').split(',').filter(Boolean).map(mbLabel).join(', ')) + ' · ' + esc(c.send_window || '09:30-18:30|1-6') + (s.last_sent ? ' · last sent ' + esc(fmtDate(s.last_sent.slice(0, 10))) : '') + '</p>';
    if (c.notes) h += '<div class="opp" style="margin-bottom:12px">' + esc(c.notes) + '</div>';
    h += '<div class="runs" style="margin-bottom:12px">' + card(esc(s.people || 0), 'people emailed', (s.sent || 0) + ' emails') + card(pct(s.opened, s.people), 'opened', (s.opened || 0)) + card(pct(s.clicked, s.people), 'clicked', (s.clicked || 0)) + card(pct(s.replied, s.people), 'replied', (s.replied || 0)) + card(esc(s.bounced || 0), 'bounced') + card(esc(s.unsubscribed || 0), 'unsubscribed') + (s.failed ? card(esc(s.failed), 'failed to send') : '') + '</div>';
    h += '<div class="panel table-wrap" style="padding:0;margin-bottom:12px"><table><thead><tr><th>Email</th><th>Waits</th><th class="r">Sent</th><th class="r">Opened</th><th class="r">Clicked</th></tr></thead><tbody>' +
      [{ days: 0, body: c.body }].concat(F).map((f, i) => { const t = by[i] || {}; return '<tr><td>' + (i ? 'Follow-up ' + i : 'First email') + '<div class="faint">' + esc(String(f.body || '').slice(0, 90)) + '</div></td><td>' + (i ? esc(f.days) + ' days' : '—') + '</td><td class="r num">' + esc(t.sent || 0) + '</td><td class="r num">' + pct(t.opened, t.sent) + '</td><td class="r num">' + pct(t.clicked, t.sent) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    const fl = [['all', 'All'], ['replied', 'Replied'], ['opened', 'Opened'], ['clicked', 'Clicked'], ['bounced', 'Bounced'], ['unsubscribed', 'Unsubscribed'], ['failed', 'Failed']];
    h += '<div class="chips" style="margin-bottom:8px">' + fl.map((f) => '<button type="button" class="chip' + (BK.sends.filter === f[0] ? ' on' : '') + '" data-bk="sendsf" data-id="' + f[0] + '">' + f[1] + '</button>').join('') + '</div>';
    const gm = (x) => x.thread_id ? '<a href="https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(x.from || '') + '#all/' + encodeURIComponent(x.thread_id) + '" target="_blank" rel="noopener">open in Gmail</a>' : '';
    h += BK.sends.list.length ? '<div class="panel table-wrap" style="padding:0"><table><thead><tr><th>To</th><th>Email</th><th>Sent</th><th>Result</th><th></th></tr></thead><tbody>' + BK.sends.list.map((x) => '<tr><td>' + esc(x.email) + '<div class="faint">from ' + esc(x.from || mbLabel(x.mailbox)) + '</div></td><td>' + (Number(x.step) ? 'Follow-up ' + esc(x.step) : 'First') + '</td><td>' + esc(fmtDate(String(x.sent_at || '').slice(0, 10))) + '</td><td>' +
      [x.replied_at ? '<b style="color:#1a7f37">Replied</b>' : '', x.bounced === true ? '<b style="color:#cf222e">Bounced</b>' : '', x.unsubscribed === true ? 'Unsubscribed' : '', x.clicked_at ? 'Clicked' : '', x.opened_at ? 'Opened' + (Number(x.opens) > 1 ? ' ×' + esc(x.opens) : '') : '', x.status === 'failed' ? '<b style="color:#cf222e">Not sent</b>' : ''].filter(Boolean).join(' · ') + '</td><td>' + gm(x) + '</td></tr>').join('') + '</tbody></table></div>' + (BK.sends.total > BK.sends.list.length ? '<p class="hint-line">Showing the latest ' + BK.sends.list.length + ' of ' + BK.sends.total + '.</p>' : '')
      : '<div class="empty">' + (BK.sends.total === 0 ? 'Nothing in this view yet.' : 'Loading…') + '</div>';
    return h;
  }

  function bkLists() {
    let h = '<div class="actions" style="margin-bottom:10px"><button class="btn" type="button" data-bk="newbucket">New bucket</button><button class="btn ghost" type="button" data-bk="verify">Check pending addresses now</button></div>';
    if (BK.bucketEdit) {
      const b = BK.bucketEdit; const sel = String(b.mailboxes || '').split(',');
      h += '<form class="panel section" id="bk-bucket-form"><div class="panel-head" style="margin:0"><h2>' + (b.bucket_id ? 'Edit bucket' : 'New bucket') + '</h2><button type="button" class="btn ghost" data-bk="closebucket">Close</button></div><div class="form-grid">' +
        '<label class="field" for="bb-name">Name<input id="bb-name" required value="' + esc(b.name || '') + '" placeholder="e.g. Travel agents – Odisha"></label>' +
        '<label class="field" for="bb-cat">Category<input id="bb-cat" value="' + esc(b.category || '') + '" placeholder="e.g. Travel agents, Hotels, Corporates, Academics"></label>' +
        '<label class="field span" for="bb-purpose">Purpose<input id="bb-purpose" value="' + esc(b.purpose || '') + '" placeholder="e.g. B2B deals, contracting, partnership, research collaboration"></label>' +
        '<div class="field span">Sends from (spread across these mailboxes)<div class="chips" style="margin-top:6px">' + MAILBOXES.map((m) => '<label class="chip"><input type="checkbox" class="bb-mb" value="' + m[0] + '"' + (sel.includes(m[0]) ? ' checked' : '') + ' style="margin-right:6px">' + esc(m[1]) + '</label>').join('') + '</div></div>' +
        '<label class="field span" for="bb-notes">Notes<input id="bb-notes" value="' + esc(b.notes || '') + '"></label>' +
        '<label class="field"><span><input type="checkbox" id="bb-active"' + (b.active === false ? '' : ' checked') + '> Active</span></label></div>' +
        '<div class="actions"><button class="btn primary" type="submit">Save bucket</button></div></form>';
    }
    if (BK.importFor) h += bkImportPanel();
    if (BK.fromFor) h += bkFromContactsPanel();
    const rows = BK.buckets.map((b) => { const s = b.stats || {};
      return '<tr' + (b.active === false ? ' style="opacity:.55"' : '') + '><td><b>' + esc(b.name) + '</b><div class="faint">' + esc([b.category, b.purpose].filter(Boolean).join(' · ')) + '</div><div class="faint">' + esc(String(b.mailboxes || '').split(',').filter(Boolean).map(mbLabel).join(', ') || 'no mailbox set') + '</div></td>' +
        '<td class="r num">' + esc(s.total || 0) + '</td><td class="r num"><b>' + esc(s.sendable || 0) + '</b></td><td class="r num">' + esc(s.pending || 0) + '</td><td class="r num">' + esc((s.invalid || 0) + (s.risky ? ' + ' + s.risky + ' risky' : '')) + '</td><td class="r num">' + esc((s.suppressed || 0) + (s.unsubscribed || 0) + (s.bounced || 0)) + '</td>' +
        '<td><div class="actions" style="justify-content:flex-end"><button class="btn sm" type="button" data-bk="import" data-id="' + esc(b.bucket_id) + '">Import</button><button class="btn sm ghost" type="button" data-bk="fromcontacts" data-id="' + esc(b.bucket_id) + '">From contacts</button><button class="btn sm ghost" type="button" data-bk="rows" data-id="' + esc(b.bucket_id) + '">View list</button><button class="btn sm ghost" type="button" data-bk="editbucket" data-id="' + esc(b.bucket_id) + '">Edit</button></div></td></tr>'; }).join('');
    h += '<div class="panel table-wrap" style="padding:0"><table><thead><tr><th>Bucket</th><th class="r">Total</th><th class="r">Ready to send</th><th class="r">Checking</th><th class="r">Invalid</th><th class="r">Do not email</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    h += '<p class="hint-line" style="margin-top:10px">Every address is checked when it comes in: format, common typos (gmial.com), throwaway and no-reply addresses, then a mail-server lookup for company domains (every 15 minutes). Only <b>valid</b> addresses are ever emailed. Anyone who unsubscribed, bounced or is marked do-not-contact anywhere in the engine is blocked.</p>';
    if (BK.rows.bucket) h += bkRowsPanel();
    return h;
  }

  function bkImportPanel() {
    const b = bkBucket(BK.importFor); const imp = BK.imp;
    let h = '<div class="panel section" id="bk-import"><div class="panel-head" style="margin:0"><h2>Import into ' + esc(b.name || '') + '</h2><button type="button" class="btn ghost" data-bk="closeimport">Close</button></div>' +
      '<p class="muted" style="margin:0">Choose a CSV file, or copy cells from Google Sheets / Excel (with the header row) and paste them below. Needed: an <b>Email</b> column. Recognised: Name, First name, Company / Organisation, City. Any other column (for example Package or Website) is kept and can be used as {package} in the email.</p>' +
      '<div class="form-grid"><label class="field" for="bk-file">CSV file<input id="bk-file" type="file" accept=".csv,.tsv,.txt,text/csv"></label>' +
      '<label class="field" for="bk-src">Source label<input id="bk-src" value="' + esc((imp && imp.source) || '') + '" placeholder="e.g. TAAI directory 2026, GMass export"></label>' +
      '<label class="field span" for="bk-paste">Or paste rows<textarea id="bk-paste" style="min-height:110px" placeholder="Email	Name	Company	City&#10;anil@example.com	Anil Das	Anil Travels	Puri"></textarea></label></div>' +
      '<div class="actions"><button class="btn" type="button" data-bk="parse">Read rows</button></div>';
    if (imp && imp.rows) {
      const ec = emailCol(imp.headers || []);
      h += '<div class="info"><div><b>' + imp.rows.length + '</b> rows found. Columns: ' + esc(imp.headers.join(', ')) + '</div>' + (ec ? '<div>Email column: <b>' + esc(ec) + '</b></div>' : '<div style="color:#cf222e">No email column found. Rename the column to Email and read again.</div>') + '</div>';
      if (imp.rows.length) h += '<div class="panel table-wrap" style="padding:0;margin:8px 0"><table><thead><tr>' + imp.headers.slice(0, 6).map((x) => '<th>' + esc(x) + '</th>').join('') + '</tr></thead><tbody>' + imp.rows.slice(0, 5).map((r) => '<tr>' + imp.headers.slice(0, 6).map((x) => '<td>' + esc(r[x] || '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
      if (ec && imp.rows.length) h += '<div class="actions"><button class="btn primary" type="button" data-bk="doimport"' + (imp.busy ? ' disabled' : '') + '>' + (imp.busy ? 'Adding… ' + esc(imp.progress || '') : 'Add ' + imp.rows.length + ' rows to ' + esc(b.name || '')) + '</button></div>';
      if (imp.result) h += '<div class="opp" style="margin-top:8px">' + esc(imp.result) + '</div>';
    }
    return h + '</div>';
  }

  function bkFromContactsPanel() {
    const b = bkBucket(BK.fromFor);
    return '<form class="panel section" id="bk-from-form"><div class="panel-head" style="margin:0"><h2>Add engine contacts to ' + esc(b.name || '') + '</h2><button type="button" class="btn ghost" data-bk="closefrom">Close</button></div>' +
      '<p class="muted" style="margin:0">Adds people already in the Relationship Engine who have a verified, likely, found, provided or known email. Leave boxes empty to match everyone.</p><div class="form-grid">' +
      '<label class="field" for="bf-camp">Campaign<select id="bf-camp">' + campOptionsHtml('', 'Any campaign') + '</select></label>' +
      '<label class="field" for="bf-city">City contains<input id="bf-city" placeholder="e.g. Bhubaneswar"></label>' +
      '<label class="field" for="bf-stage">Stage<select id="bf-stage"><option value="">Any stage</option>' + STAGES.filter((s) => s.group !== 'dead').map((s) => '<option value="' + s.key + '">' + esc(s.label) + '</option>').join('') + '</select></label>' +
      '<label class="field" for="bf-text">Organisation / title / industry contains<input id="bf-text" placeholder="e.g. hospital, travel, professor"></label></div>' +
      '<div class="actions"><button class="btn primary" type="submit">Add matching contacts</button></div></form>';
  }

  function bkRowsPanel() {
    const b = bkBucket(BK.rows.bucket); const R = BK.rows;
    const fl = [['all', 'All'], ['valid', 'Valid'], ['pending', 'Checking'], ['risky', 'Risky'], ['invalid', 'Invalid'], ['suppressed', 'Do not email'], ['replied', 'Replied'], ['unsubscribed', 'Unsubscribed'], ['bounced', 'Bounced'], ['removed', 'Removed']];
    let h = '<div class="panel section" id="bk-rows"><div class="panel-head" style="margin:0"><h2>' + esc(b.name || '') + ' · ' + esc(R.total) + ' rows</h2><button type="button" class="btn ghost" data-bk="closerows">Close</button></div>' +
      '<div class="chips">' + fl.map((f) => '<button type="button" class="chip' + (R.filter === f[0] ? ' on' : '') + '" data-bk="rowsf" data-id="' + f[0] + '">' + f[1] + '</button>').join('') + '</div>' +
      '<label class="field" for="bk-rq" style="max-width:360px">Search<input id="bk-rq" value="' + esc(R.q) + '" placeholder="email, name, company or city"></label>';
    h += R.list.length ? '<div class="table-wrap"><table><thead><tr><th>Email</th><th>Name / company</th><th>Check</th><th>Status</th><th class="r">Sent</th><th></th></tr></thead><tbody>' + R.list.map((r) => '<tr' + (r.status !== 'active' ? ' style="opacity:.6"' : '') + '><td>' + esc(r.email) + '<div class="faint">' + esc(r.source || '') + ' · ' + esc(fmtDate(r.added_on)) + '</div></td><td>' + esc(r.full_name || r.first_name || '') + '<div class="faint">' + esc([r.organisation, r.city].filter(Boolean).join(', ')) + '</div></td><td>' + vPill(r.verify_status, r.verify_reason) + '<div class="faint" style="font-size:11.5px">' + esc(r.verify_reason || '') + '</div></td><td>' + esc(r.status) + '</td><td class="r num">' + esc(r.sends || 0) + '</td><td>' +
      (r.status === 'active' ? '<button class="btn sm ghost" type="button" data-bk="rowremove" data-id="' + esc(r.row_key) + '">Remove</button>' : (['removed', 'replied'].includes(r.status) ? '<button class="btn sm ghost" type="button" data-bk="rowrestore" data-id="' + esc(r.row_key) + '">Restore</button>' : '')) + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">No rows in this view.</div>';
    const pages = Math.ceil(R.total / 50);
    if (pages > 1) h += '<div class="actions"><button class="btn sm" type="button" data-bk="rowspage" data-id="-1"' + (R.offset ? '' : ' disabled') + '>Previous</button><span class="faint">Page ' + (Math.floor(R.offset / 50) + 1) + ' of ' + pages + '</span><button class="btn sm" type="button" data-bk="rowspage" data-id="1"' + (R.offset + 50 < R.total ? '' : ' disabled') + '>Next</button></div>';
    return h + '</div>';
  }

  function bkMailboxes() {
    const P = BK.plan;
    const info = {}; ((P && P.mailboxes) || []).forEach((m) => { info[m.mailbox] = m; });
    const warm = {}; BK.warmup.forEach((w) => { warm[w.mailbox] = w; });
    const RAMP = [50, 100, 200, 350, 480];
    const today = todayISO();
    const rows = MAILBOXES.map((m) => {
      const w = warm[m[0]]; const i = info[m[0]];
      if (!w) return '<tr style="opacity:.6"><td><b>' + esc(m[1]) + '</b><div class="faint">' + esc(m[2]) + '</div></td><td colspan="4" class="faint">Not used for bulk yet. Warm-up starts the day a campaign first sends from it.</td><td></td></tr>';
      const days = Math.max(0, Math.round((new Date(today + 'T00:00:00') - new Date(String(w.warm_start).slice(0, 10) + 'T00:00:00')) / 86400000));
      const cap = Math.min(num(w.max_cap) || 480, RAMP[Math.min(4, Math.floor(days / 7))]);
      return '<tr><td><b>' + esc(m[1]) + '</b><div class="faint">' + esc(m[2]) + '</div></td><td>Day ' + (days + 1) + '<div class="faint">since ' + esc(fmtDate(String(w.warm_start).slice(0, 10))) + '</div></td><td class="r num"><b>' + cap + '</b>/day<div class="faint">max ' + esc(w.max_cap || 480) + '</div></td><td class="r num">' + (i ? esc(i.sent_today) + ' sent · ' + esc(i.left_today) + ' left' : '—') + '</td><td>' + (w.paused === true ? '<span style="color:#cf222e"><b>Paused</b></span><div class="faint">' + esc(w.pause_reason || '') + '</div>' : '<span style="color:#1a7f37">Sending</span>') + (i && i.sent_7d ? '<div class="faint">' + esc(i.bounces_7d) + ' bounces of ' + esc(i.sent_7d) + ' in 7 days</div>' : '') + '</td>' +
        '<td><div class="actions" style="justify-content:flex-end">' + (w.paused === true ? '<button class="btn sm primary" type="button" data-bk="mbresume" data-id="' + m[0] + '">Resume</button>' : '<button class="btn sm" type="button" data-bk="mbpause" data-id="' + m[0] + '">Pause</button>') + '<select class="bk-cap" data-id="' + m[0] + '" aria-label="Daily maximum for ' + esc(m[1]) + '">' + [50, 100, 200, 300, 400, 480].map((n) => '<option value="' + n + '"' + (num(w.max_cap || 480) === n ? ' selected' : '') + '>max ' + n + '/day</option>').join('') + '</select></div></td></tr>';
    }).join('');
    let h = '<div class="panel table-wrap" style="padding:0;margin-bottom:12px"><table><thead><tr><th>Mailbox</th><th>Warm-up</th><th class="r">Today\'s limit</th><th class="r">Today</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    h += '<p class="hint-line">Warm-up per mailbox: 50 a day in week 1, 100 in week 2, 200 in week 3, 350 in week 4, then up to 480. Emails are spread across the sending hours (at most 12 per mailbox every 10 minutes). A mailbox pauses itself if more than 3% of its emails bounce in 7 days; a campaign pauses itself above 5%.</p>';
    h += '<div class="panel section"><div class="panel-head" style="margin:0"><h2>Next run</h2><button class="btn sm" type="button" data-bk="plan">Check what sends next</button></div>';
    if (!P) h += '<p class="muted" style="margin:0">Shows what the next 10-minute run would send, without sending anything.</p>';
    else {
      h += '<p class="muted" style="margin:0">As of ' + esc(P.now_ist) + ' IST: ' + esc(P.running) + ' campaign' + (P.running === 1 ? '' : 's') + ' sending, <b>' + esc(P.planned_this_run) + '</b> emails in the next run.</p>';
      h += (P.campaigns || []).map((c) => '<div class="info" style="border-top:1px solid var(--line);padding-top:8px"><div><b>' + esc(c.name) + '</b> ' + (c.in_window ? '' : '<span class="faint">(outside sending hours)</span>') + (c.finished ? ' <span class="faint">(finished)</span>' : '') + (c.auto_paused ? ' <span style="color:#cf222e">(paused for bounces)</span>' : '') + '</div><div class="faint">' + esc(c.due_new) + ' new and ' + esc(c.due_followups) + ' follow-ups due · ' + esc(c.waiting) + ' waiting · ' + esc(c.planned) + ' in this run' + (Object.keys(c.skipped || {}).length ? ' · skipped: ' + esc(Object.entries(c.skipped).map(([k, v]) => v + ' ' + k).join(', ')) : '') + '</div></div>').join('');
      if ((P.sample || []).length) h += '<details style="margin-top:8px"><summary>Preview the first ' + P.sample.length + '</summary>' + P.sample.map((x) => '<div class="panel" style="margin-top:8px;white-space:pre-wrap;font-size:13px"><b>To:</b> ' + esc(x.to) + ' · <b>From:</b> ' + esc(x.from) + (x.step ? ' · follow-up ' + esc(x.step) : '') + '\n<b>Subject:</b> ' + esc(x.subject) + '\n\n' + esc(x.body) + '</div>').join('') + '</details>';
    }
    return h + '</div>';
  }

  function bkBlank() { return { campaign_id: '', name: '', bucket_id: (BK.buckets[0] || {}).bucket_id || '', mailboxes: '', subject: '', body: '', followups: [{ days: 3, body: '' }, { days: 7, body: '' }], send_from: '09:30', send_to: '18:30', days_from: '1', days_to: '6', start_date: '', track_opens: true, track_clicks: false, signature_id: '', sender_name: '' }; }
  function bkEditFrom(c) {
    let F = []; try { F = JSON.parse(c.followups || '[]'); } catch (e) { F = []; }
    const m = String(c.send_window || '09:30-18:30|1-6').match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})(?:\s*\|\s*([1-7])\s*-\s*([1-7]))?/) || [];
    return { campaign_id: c.campaign_id, name: c.name || '', bucket_id: c.bucket_id || '', mailboxes: c.mailboxes || '', subject: c.subject || '', body: c.body || '', followups: F, send_from: m[1] || '09:30', send_to: m[2] || '18:30', days_from: m[3] || '1', days_to: m[4] || '6', start_date: c.start_date || '', track_opens: c.track_opens !== false, track_clicks: c.track_clicks === true, signature_id: c.signature_id || '', sender_name: c.sender_name || '', status: c.status };
  }
  const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']];
  function bkEditor() {
    const e = BK.edit; const b = bkBucket(e.bucket_id);
    const sel = String(e.mailboxes || '').split(',').filter(Boolean);
    const bSel = String(b.mailboxes || '').split(',').filter(Boolean);
    const chip = (f) => '<button type="button" class="chip" data-bk="ins" data-id="' + esc(f) + '">' + esc(f) + '</button>';
    const fu = (e.followups || []).map((f, i) => '<div class="panel" style="display:flex;flex-direction:column;gap:6px"><div class="actions" style="justify-content:space-between"><b>Follow-up ' + (i + 1) + '</b><span><label>wait <input type="number" min="1" max="60" class="bk-fu-days" data-i="' + i + '" value="' + esc(f.days) + '" style="width:64px"> days after the previous email</label> <button type="button" class="btn sm ghost bad" data-bk="fudel" data-id="' + i + '">Remove</button></span></div><textarea class="bk-fu-body" data-i="' + i + '" style="min-height:90px" placeholder="Short and friendly. Sent in the same email thread, only if they have not replied.">' + esc(f.body) + '</textarea></div>').join('');
    let h = '<form class="section" id="bk-edit-form" style="display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:16px;align-items:start">';
    h += '<div class="panel" style="display:flex;flex-direction:column;gap:12px"><div class="panel-head" style="margin:0"><h2>' + (e.campaign_id ? 'Edit campaign' : 'New campaign') + (e.status ? ' ' + bkPill(e.status) : '') + '</h2><button type="button" class="btn ghost" data-bk="closeedit">Close</button></div><div class="form-grid">' +
      '<label class="field span" for="be-name">Campaign name<input id="be-name" class="bk-in" data-k="name" value="' + esc(e.name) + '" placeholder="e.g. October B2B deals – Odisha agents"></label>' +
      '<label class="field span" for="be-bucket">Send to bucket<select id="be-bucket" class="bk-in" data-k="bucket_id">' + BK.buckets.map((x) => '<option value="' + esc(x.bucket_id) + '"' + (x.bucket_id === e.bucket_id ? ' selected' : '') + '>' + esc(x.name) + ' (' + esc((x.stats || {}).sendable || 0) + ' ready)</option>').join('') + '</select></label>' +
      '<div class="field span">Send from <span class="faint">(empty = the bucket\'s mailboxes: ' + esc(bSel.map(mbLabel).join(', ') || 'none set') + ')</span><div class="chips" style="margin-top:6px">' + MAILBOXES.map((m) => '<label class="chip"><input type="checkbox" class="be-mb" value="' + m[0] + '"' + (sel.includes(m[0]) ? ' checked' : '') + ' style="margin-right:6px">' + esc(m[1]) + '</label>').join('') + '</div></div>' +
      '<label class="field span" for="be-subject">Subject<input id="be-subject" class="bk-in" data-k="subject" value="' + esc(e.subject) + '" placeholder="e.g. Puri & Konark packages for {organisation|your agency}"></label>' +
      '<div class="field span">Insert a field <span class="faint">(click where you want it, then a field; use {field|fallback} when a value may be empty)</span><div class="chips" style="margin-top:6px">' + ['{first_name|there}', '{organisation}', '{city}', '{full_name}', '{email}'].map(chip).join('') + '</div></div>' +
      '<label class="field span" for="be-body">First email<textarea id="be-body" class="bk-in" data-k="body" style="min-height:200px" placeholder="Hi {first_name|there},&#10;&#10;…">' + esc(e.body) + '</textarea></label></div>' +
      fu + ((e.followups || []).length < 5 ? '<div class="actions"><button type="button" class="btn sm" data-bk="fuadd">Add a follow-up</button></div>' : '') +
      '<div class="form-grid">' +
      '<label class="field" for="be-from">Send between<input id="be-from" type="time" class="bk-in" data-k="send_from" value="' + esc(e.send_from) + '"></label>' +
      '<label class="field" for="be-to">and (IST)<input id="be-to" type="time" class="bk-in" data-k="send_to" value="' + esc(e.send_to) + '"></label>' +
      '<label class="field" for="be-d1">From day<select id="be-d1" class="bk-in" data-k="days_from">' + DAYS.map((d) => '<option value="' + d[0] + '"' + (d[0] === String(e.days_from) ? ' selected' : '') + '>' + d[1] + '</option>').join('') + '</select></label>' +
      '<label class="field" for="be-d2">to day<select id="be-d2" class="bk-in" data-k="days_to">' + DAYS.map((d) => '<option value="' + d[0] + '"' + (d[0] === String(e.days_to) ? ' selected' : '') + '>' + d[1] + '</option>').join('') + '</select></label>' +
      '<label class="field" for="be-start">Start date (optional)<input id="be-start" type="date" class="bk-in" data-k="start_date" value="' + esc(e.start_date) + '"></label>' +
      '<label class="field" for="be-sig">Signature<select id="be-sig" class="bk-in" data-k="signature_id">' + sigOptionsHtml('', e.signature_id) + '</select></label>' +
      '<label class="field" for="be-sender">Sender name (optional)<input id="be-sender" class="bk-in" data-k="sender_name" value="' + esc(e.sender_name) + '" placeholder="Kamakshya Prasad Nayak"></label>' +
      '<div class="field">Tracking<label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="be-opens" style="width:auto"' + (e.track_opens ? ' checked' : '') + '> Track opens</label><label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="be-clicks" style="width:auto"' + (e.track_clicks ? ' checked' : '') + '> Track link clicks</label></div></div>' +
      '<div class="actions"><button class="btn primary" type="submit">Save campaign</button>' + (e.campaign_id && e.status !== 'running' ? '<button class="btn" type="button" data-bk="start" data-id="' + esc(e.campaign_id) + '">Save and start</button>' : '') + '</div>' +
      '<p class="hint-line">Every email gets an unsubscribe link and the one-click unsubscribe header Gmail and Yahoo require. Emails go out one by one as plain, personal-looking messages from each mailbox with its signature.</p></div>';
    h += '<div class="panel" style="display:flex;flex-direction:column;gap:10px;position:sticky;top:12px"><div class="panel-head" style="margin:0"><h2>Preview</h2><span class="actions"><button type="button" class="btn sm ghost" data-bk="sprev">‹</button><button type="button" class="btn sm ghost" data-bk="snext">›</button></span></div><div id="bk-preview"></div>' +
      '<div class="field">Send a test to yourself<div class="actions" style="margin-top:6px"><select id="be-test-to">' + (isOwnerMe() ? ALL_ADDR : [S.me.email]).map((a) => '<option' + (a === 'kn0733@gmail.com' ? ' selected' : '') + '>' + esc(a) + '</option>').join('') + '</select><select id="be-test-step"><option value="0">First email</option>' + (e.followups || []).map((f, i) => '<option value="' + (i + 1) + '">Follow-up ' + (i + 1) + '</option>').join('') + '</select><button type="button" class="btn" data-bk="test">Send test</button></div></div></div>';
    return h + '</form>';
  }
  function bkCollect() {
    const e = BK.edit; if (!e) return;
    document.querySelectorAll('.bk-in').forEach((el) => { e[el.getAttribute('data-k')] = el.value; });
    const mbs = [...document.querySelectorAll('.be-mb')].filter((x) => x.checked).map((x) => x.value); e.mailboxes = mbs.join(',');
    document.querySelectorAll('.bk-fu-days').forEach((el) => { const i = +el.getAttribute('data-i'); if (e.followups[i]) e.followups[i].days = el.value; });
    document.querySelectorAll('.bk-fu-body').forEach((el) => { const i = +el.getAttribute('data-i'); if (e.followups[i]) e.followups[i].body = el.value; });
    const o = $('#be-opens'); if (o) e.track_opens = o.checked; const c = $('#be-clicks'); if (c) e.track_clicks = c.checked;
  }
  function bkPayload() {
    const e = BK.edit;
    return { campaign_id: e.campaign_id || '', name: e.name, bucket_id: e.bucket_id, mailboxes: e.mailboxes, subject: e.subject, body: e.body,
      followups: (e.followups || []).filter((f) => String(f.body || '').trim()).map((f) => ({ days: Number(f.days) || 3, body: f.body })),
      send_window: (e.send_from || '09:30') + '-' + (e.send_to || '18:30') + '|' + (e.days_from || '1') + '-' + (e.days_to || '6'), start_date: e.start_date || '',
      track_opens: !!e.track_opens, track_clicks: !!e.track_clicks, signature_id: e.signature_id || '', sender_name: e.sender_name || '' };
  }
  function bkPreview() {
    const box = $('#bk-preview'); const e = BK.edit; if (!box || !e) return;
    const row = BK.sample[BK.sampleIdx] || { email: 'sample@example.com', first_name: '', full_name: '', organisation: '', city: '', extra: '{}' };
    const f = fieldsOf(row); const s = mergeT(e.subject, f); const b = mergeT(e.body, f);
    const miss = [...new Set(s.miss.concat(b.miss))];
    let missCount = 0; const allTpl = [e.subject, e.body].concat((e.followups || []).map((x) => x.body)).join('\n');
    BK.sample.forEach((r) => { if (mergeT(allTpl, fieldsOf(r)).miss.length) missCount++; });
    const ph = hasPlaceholder(allTpl);
    box.innerHTML = '<div class="faint">' + (BK.sample.length ? 'Contact ' + (BK.sampleIdx + 1) + ' of ' + BK.sample.length + ' ready to send: ' + esc(row.email) : 'No ready-to-send contacts in this bucket yet; showing empty fields.') + '</div>' +
      '<div style="border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--surface)"><div><b>' + esc(s.text || '(no subject)') + '</b></div><div class="faint" style="margin-bottom:8px">from ' + esc(String(e.mailboxes || bkBucket(e.bucket_id).mailboxes || '').split(',').filter(Boolean).map(mbLabel)[0] || '—') + '</div><div style="white-space:pre-wrap;font-size:14px">' + esc(b.text || '') + '</div><div class="faint" style="margin-top:10px;font-size:12px">— signature —<br>Not interested? Unsubscribe or just reply with the word unsubscribe.</div></div>' +
      (miss.length ? '<div class="opp">This contact has no ' + esc(miss.join(', ')) + '. Contacts with a missing field are skipped, not sent a blank. Add a fallback like {' + esc(miss[0]) + '|there}.</div>' : '') +
      (missCount ? '<div class="faint">' + missCount + ' of the ' + BK.sample.length + ' loaded contacts would be skipped for a missing field.</div>' : '') +
      (ph ? '<div class="opp" style="border-color:#cf222e">Remove the [placeholder] text; the campaign cannot be saved with it.</div>' : '');
  }

  async function bkSave(thenStart, btn) {
    bkCollect(); const p = bkPayload();
    if (btn) btn.disabled = true;
    try {
      const j = await bkPost(BULK_CAMP_API, 'save', p); BK.edit.campaign_id = j.campaign_id;
      if (thenStart) { await bkStart(j.campaign_id, true); } else toast(j.message || 'Saved.');
      BK.edit = null; await loadBulk(true);
    } catch (er) { toast(er.message, true); } finally { if (btn) btn.disabled = false; }
  }
  async function bkStart(id, fresh) {
    if (fresh) await loadBulk(true);
    const c = bkCamp(id); if (!c) return;
    const b = bkBucket(c.bucket_id); const mbs = String(c.mailboxes || b.mailboxes || '').split(',').filter(Boolean);
    if (!confirm('Start sending "' + c.name + '"?\n\nTo: ' + (c.sendable || 0) + ' ready contacts in ' + (b.name || c.bucket_id) + '\nFrom: ' + mbs.map(mbLabel).join(', ') + '\nHours: ' + (c.send_window || '09:30-18:30|1-6') + ' IST\n\nEmails go out gradually within each mailbox\'s warm-up limit. You can pause at any time.')) return;
    try { const j = await bkPost(BULK_CAMP_API, 'status', { campaign_id: id, status: 'running' }); toast(j.message || 'Started.'); await loadBulk(true); } catch (er) { toast(er.message, true); }
  }

  function bindBulk() {
    if (S.view !== 'bulk') return;
    if (BK.edit) {
      bkPreview();
      if (BK.sampleBucket !== BK.edit.bucket_id) loadSample(BK.edit.bucket_id);
      const f = $('#bk-edit-form');
      f.addEventListener('input', () => { bkCollect(); bkPreview(); });
      f.addEventListener('change', (ev) => { const bucketChanged = ev.target.id === 'be-bucket'; bkCollect(); if (bucketChanged) { BK.sample = []; BK.sampleBucket = ''; render(); } else bkPreview(); });
      f.addEventListener('submit', (ev) => { ev.preventDefault(); bkSave(false, f.querySelector('button[type=submit]')); });
      f.addEventListener('focusin', (ev) => { if (ev.target.matches('#be-subject,#be-body,.bk-fu-body')) BK.lastField = ev.target; });
    }
    const bf = $('#bk-bucket-form');
    if (bf) bf.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const p = Object.assign({}, BK.bucketEdit, { name: $('#bb-name').value.trim(), category: $('#bb-cat').value.trim(), purpose: $('#bb-purpose').value.trim(), notes: $('#bb-notes').value.trim(), active: $('#bb-active').checked, mailboxes: [...document.querySelectorAll('.bb-mb')].filter((x) => x.checked).map((x) => x.value).join(',') });
      delete p.stats;
      const btn = bf.querySelector('button[type=submit]'); btn.disabled = true;
      try { const j = await bkPost(BULK_LISTS_API, 'bucket_save', p); toast(j.message || 'Bucket saved.'); BK.bucketEdit = null; await loadBulk(true); } catch (er) { toast(er.message, true); btn.disabled = false; }
    });
    const ff = $('#bk-from-form');
    if (ff) ff.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = ff.querySelector('button[type=submit]'); btn.disabled = true;
      try { const j = await bkPost(BULK_LISTS_API, 'from_contacts', { bucket_id: BK.fromFor, filter: { campaign_code: $('#bf-camp').value, city: $('#bf-city').value.trim(), stage: $('#bf-stage').value, text: $('#bf-text').value.trim() } }); toast(j.message || 'Added.'); BK.fromFor = ''; await loadBulk(true); } catch (er) { toast(er.message, true); btn.disabled = false; }
    });
    const fileIn = $('#bk-file');
    if (fileIn) fileIn.addEventListener('change', () => { const fl = fileIn.files && fileIn.files[0]; if (!fl) return; const rd = new FileReader(); rd.onload = () => { const r = parseCsv(rd.result); BK.imp = { headers: r.headers, rows: r.rows, source: ($('#bk-src').value || fl.name).trim() }; render(); }; rd.readAsText(fl); });
    const rq = $('#bk-rq');
    if (rq) rq.addEventListener('change', () => { BK.rows.q = rq.value.trim(); BK.rows.offset = 0; loadBkRows(); });
    document.querySelectorAll('.bk-cap').forEach((s) => s.addEventListener('change', async () => { try { const j = await bkPost(BULK_CAMP_API, 'warmup_save', { mailbox: s.getAttribute('data-id'), max_cap: Number(s.value) }); toast(j.message); await loadBulk(true); } catch (er) { toast(er.message, true); } }));
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-bk]'); if (!t) return;
    const a = t.getAttribute('data-bk'); const id = t.getAttribute('data-id') || '';
    if (a === 'tab') { BK.tab = id; store.set('bktab', id); BK.detail = ''; BK.edit = null; render(); if (id === 'mailboxes' && !BK.plan) loadPlan(); return; }
    if (a === 'newcamp') { if (S.mode !== 'live') { toast('Connect your key first.', true); return; } BK.edit = bkBlank(); BK.tab = 'campaigns'; render(); window.scrollTo(0, 0); return; }
    if (a === 'edit') { const c = bkCamp(id); if (!c) return; BK.edit = bkEditFrom(c); BK.detail = ''; render(); window.scrollTo(0, 0); return; }
    if (a === 'closeedit') { BK.edit = null; render(); return; }
    if (a === 'detail') { BK.detail = id; BK.sends = { filter: 'all', list: [], total: -1 }; render(); window.scrollTo(0, 0); loadSends(); return; }
    if (a === 'back') { BK.detail = ''; render(); return; }
    if (a === 'sendsf') { BK.sends.filter = id; BK.sends.list = []; BK.sends.total = -1; render(); loadSends(); return; }
    if (a === 'start') { if (BK.edit && BK.edit.campaign_id === id) { await bkSave(true, t); return; } await bkStart(id); return; }
    if (a === 'pause') { if (!confirm('Pause this campaign? Nothing more is sent until you resume.')) return; t.disabled = true; try { const j = await bkPost(BULK_CAMP_API, 'status', { campaign_id: id, status: 'paused' }); toast(j.message); await loadBulk(true); } catch (er) { toast(er.message, true); t.disabled = false; } return; }
    if (a === 'ins') { const el = BK.lastField || $('#be-body'); if (!el) return; const s = el.selectionStart || el.value.length; el.value = el.value.slice(0, s) + id + el.value.slice(el.selectionEnd || s); el.focus(); el.setSelectionRange(s + id.length, s + id.length); bkCollect(); bkPreview(); return; }
    if (a === 'fuadd') { bkCollect(); BK.edit.followups.push({ days: 4, body: '' }); render(); return; }
    if (a === 'fudel') { bkCollect(); BK.edit.followups.splice(Number(id), 1); render(); return; }
    if (a === 'sprev' || a === 'snext') { if (!BK.sample.length) return; BK.sampleIdx = (BK.sampleIdx + (a === 'snext' ? 1 : -1) + BK.sample.length) % BK.sample.length; bkPreview(); return; }
    if (a === 'test') {
      bkCollect(); const to = $('#be-test-to').value; const step = Number($('#be-test-step').value) || 0;
      const p = bkPayload();
      if (!confirm('Send a TEST of ' + (step ? 'follow-up ' + step : 'the first email') + ' to ' + to + '?\nIt uses a sample contact\'s details and is not counted in the campaign.')) return;
      t.disabled = true;
      try { const j = await bkPost(BULK_TEST_API, 'test', { to: to, step: step, row_key: (BK.sample[BK.sampleIdx] || {}).row_key || '', campaign: Object.assign({}, p, { mailboxes: p.mailboxes || bkBucket(p.bucket_id).mailboxes || '', followups: JSON.stringify(p.followups) }) }); toast(j.message || 'Test sent.'); } catch (er) { toast(er.message, true); } finally { t.disabled = false; }
      return;
    }
    if (a === 'newbucket') { BK.bucketEdit = { name: '', category: '', purpose: '', mailboxes: '', notes: '', active: true }; render(); return; }
    if (a === 'editbucket') { BK.bucketEdit = Object.assign({}, bkBucket(id)); render(); window.scrollTo(0, 0); return; }
    if (a === 'closebucket') { BK.bucketEdit = null; render(); return; }
    if (a === 'import') { BK.importFor = id; BK.imp = null; BK.fromFor = ''; render(); const p = $('#bk-import'); if (p) p.scrollIntoView({ block: 'start' }); return; }
    if (a === 'closeimport') { BK.importFor = ''; BK.imp = null; render(); return; }
    if (a === 'fromcontacts') { BK.fromFor = id; BK.importFor = ''; render(); const p = $('#bk-from-form'); if (p) p.scrollIntoView({ block: 'start' }); return; }
    if (a === 'closefrom') { BK.fromFor = ''; render(); return; }
    if (a === 'parse') { const txt = $('#bk-paste').value; if (!txt.trim()) { toast('Paste rows or choose a file first.', true); return; } const r = parseCsv(txt); BK.imp = { headers: r.headers, rows: r.rows, source: ($('#bk-src').value || 'pasted rows').trim() }; render(); return; }
    if (a === 'doimport') {
      const imp = BK.imp; if (!imp || !imp.rows.length) return;
      imp.source = ($('#bk-src') && $('#bk-src').value.trim()) || imp.source || 'import';
      imp.busy = true; imp.result = ''; const tot = { added: 0, duplicates: 0, invalid: 0, suppressed: 0, pending: 0 };
      try {
        for (let i = 0; i < imp.rows.length; i += 1000) {
          imp.progress = Math.min(i + 1000, imp.rows.length) + ' of ' + imp.rows.length; render();
          const j = await bkPost(BULK_LISTS_API, 'import', { bucket_id: BK.importFor, source: imp.source, rows: imp.rows.slice(i, i + 1000) });
          Object.keys(tot).forEach((k) => { tot[k] += Number(j[k] || 0); });
        }
        imp.result = 'Added ' + tot.added + (tot.duplicates ? ', skipped ' + tot.duplicates + ' already in the bucket' : '') + (tot.invalid ? ', ' + tot.invalid + ' invalid' : '') + (tot.suppressed ? ', ' + tot.suppressed + ' on the do-not-email list' : '') + '.' + (tot.pending ? ' ' + tot.pending + ' company addresses are being checked now.' : '');
        toast(imp.result);
        if (tot.pending) bkPost(BULK_LISTS_API, 'verify').catch(() => {});
      } catch (er) { toast(er.message, true); imp.result = 'Stopped: ' + er.message; }
      imp.busy = false; await loadBulk(true); return;
    }
    if (a === 'verify') { t.disabled = true; try { await bkPost(BULK_LISTS_API, 'verify'); toast('Checking now. Refresh in a minute to see the results.'); setTimeout(() => loadBulk(true), 60000); } catch (er) { toast(er.message, true); } setTimeout(() => { t.disabled = false; }, 5000); return; }
    if (a === 'rows') { BK.rows = { bucket: id, filter: 'all', q: '', offset: 0, total: 0, list: [] }; render(); loadBkRows(); setTimeout(() => { const p = $('#bk-rows'); if (p) p.scrollIntoView({ block: 'start' }); }, 50); return; }
    if (a === 'closerows') { BK.rows.bucket = ''; render(); return; }
    if (a === 'rowsf') { BK.rows.filter = id; BK.rows.offset = 0; loadBkRows(); return; }
    if (a === 'rowspage') { BK.rows.offset = Math.max(0, BK.rows.offset + Number(id) * 50); loadBkRows(); return; }
    if (a === 'rowremove' || a === 'rowrestore') { t.disabled = true; try { const j = await bkPost(BULK_CAMP_API, 'row_status', { row_key: id, status: a === 'rowremove' ? 'removed' : 'active' }); toast(j.message); loadBkRows(); } catch (er) { toast(er.message, true); t.disabled = false; } return; }
    if (a === 'mbpause' || a === 'mbresume') { t.disabled = true; try { const j = await bkPost(BULK_CAMP_API, 'warmup_save', { mailbox: id, paused: a === 'mbpause' }); toast(j.message); await loadBulk(true); loadPlan(); } catch (er) { toast(er.message, true); t.disabled = false; } return; }
    if (a === 'plan') { loadPlan(t); return; }
  });

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
  function sigPanelHtml() {
    const e = S.sigEdit;
    let h = '<div class="panel section" style="max-width:760px" id="sig-panel"><h2>Email signatures</h2>' +
      '<p class="faint" style="margin:0 0 8px">Gmail keeps several named signatures in its own screen but only lets other apps read one per address, so save the ones you use here (for example Kamakshya and Manish). You pick one each time you send or reply. "Default" is used when you do not pick.</p>';
    if (S.mode !== 'live') return h + '<div class="empty">Connect your key to manage signatures.</div></div>';
    const list = S.sigs || [];
    h += list.length ? '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Used for</th><th>Shown as</th><th></th></tr></thead><tbody>' + list.map((g) => '<tr><td><b>' + esc(g.label) + '</b>' + (g.is_default ? ' <span class="pill">Default</span>' : '') + '</td><td style="font-size:12.5px">' + esc(g.addresses === 'all' || !g.addresses ? 'All addresses' : g.addresses.split(',').join(', ')) + '</td><td>' + esc(g.sender_name || 'Kamakshya Prasad Nayak') + '</td><td style="white-space:nowrap"><button type="button" class="btn sm" data-sigedit="' + esc(g.sig_id) + '">Edit</button> <button type="button" class="btn sm ghost" data-sigdel="' + esc(g.sig_id) + '">Delete</button></td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">No saved signatures yet. Until you add one, each email uses the Gmail signature of the address it is sent from.</div>';
    if (!e) return h + '<div class="actions" style="margin-top:10px"><button type="button" class="btn primary" data-signew="1">Add a signature</button></div></div>';
    const chosen = String(e.addresses || 'all').split(',');
    const all = !e.addresses || e.addresses === 'all';
    h += '<form id="sig-form" class="section" style="border-top:1px solid var(--line,#ddd);padding-top:12px"><h3 style="margin-top:0">' + (e.sig_id ? 'Edit signature' : 'New signature') + '</h3>' +
      '<label class="field" for="sg-label">Name of this signature<input id="sg-label" maxlength="80" required value="' + esc(e.label || '') + '" placeholder="e.g. Manish - B2B"></label>' +
      '<label class="field" for="sg-name">Sender name shown in the From line (optional)<input id="sg-name" maxlength="80" value="' + esc(e.sender_name || '') + '" placeholder="Kamakshya Prasad Nayak"></label>' +
      '<div class="field"><span>Signature</span><div id="sg-html" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Signature" style="min-height:120px;border:1px solid var(--line,#ccc);border-radius:8px;padding:10px;background:var(--panel,#fff);overflow:auto">' + cleanSigHtml(e.html || '') + '</div>' +
      '<span class="faint" style="font-size:12.5px">Tip: in Gmail open Settings → See all settings → Signature, select the whole signature, copy it (Ctrl + C) and paste it here (Ctrl + V). Formatting, links and logos come along.</span></div>' +
      '<fieldset class="field" style="border:0;padding:0;margin:0"><legend>Use it for</legend><label style="display:block"><input type="checkbox" id="sg-all"' + (all ? ' checked' : '') + '> All addresses</label>' +
      '<div id="sg-addrs" style="columns:2;font-size:13px' + (all ? ';opacity:.5' : '') + '">' + ALL_ADDR.map((a) => '<label style="display:block"><input type="checkbox" class="sg-addr" value="' + esc(a) + '"' + (!all && chosen.includes(a) ? ' checked' : '') + (all ? ' disabled' : '') + '> ' + esc(a) + '</label>').join('') + '</div></fieldset>' +
      '<label style="display:block;margin:8px 0"><input type="checkbox" id="sg-def"' + (e.is_default ? ' checked' : '') + '> Make this the default for these addresses</label>' +
      '<div class="actions"><button type="submit" class="btn primary">Save signature</button><button type="button" class="btn" data-sigcancel="1">Cancel</button></div></form>';
    return h + '</div>';
  }
  function wireSigForm() {
    const f = $('#sig-form'); if (!f) return;
    const allBox = $('#sg-all');
    allBox.addEventListener('change', () => { document.querySelectorAll('.sg-addr').forEach((x) => { x.disabled = allBox.checked; }); $('#sg-addrs').style.opacity = allBox.checked ? '.5' : '1'; });
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const addrs = allBox.checked ? 'all' : Array.from(document.querySelectorAll('.sg-addr:checked')).map((x) => x.value).join(',');
      if (!addrs) { toast('Tick at least one address, or All addresses.', true); return; }
      const html = cleanSigHtml($('#sg-html').innerHTML);
      if (!html.replace(/<[^>]+>|&nbsp;|\s/g, '')) { toast('Paste or type the signature first.', true); return; }
      const rec = { sig_id: S.sigEdit.sig_id || '', label: $('#sg-label').value.trim(), sender_name: $('#sg-name').value.trim(), html: html, addresses: addrs, is_default: $('#sg-def').checked, active: true };
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const j = await inboxApi('sig_save', rec);
        if (rec.is_default) {
          const mine = addrs === 'all' ? null : addrs.split(',');
          for (const g of (S.sigs || [])) {
            if (g.sig_id === j.sig_id || !g.is_default) continue;
            const ga = g.addresses === 'all' || !g.addresses ? null : g.addresses.split(',');
            const overlap = !mine || !ga || ga.some((a) => mine.includes(a));
            if (overlap) await inboxApi('sig_save', Object.assign({}, g, { is_default: false }));
          }
        }
        toast('Signature saved.'); S.sigEdit = null; await loadSigs(); render();
      } catch (er) { toast(er.message, true); btn.disabled = false; }
    });
  }

  function renderSettings() {
    const th = store.get('theme', 'system');
    let h = topbar('Settings', 'Sign in, signatures, jobs and appearance.');
    h += S.me ? whoLine() : '';
    if (!S.sid) h += signInPanel();
    if (!S.me || S.me.role === 'owner') h += '<details class="section" style="max-width:640px"><summary class="faint" style="cursor:pointer">Owner access key (old way to connect, being retired)</summary>';
    if (!S.me || S.me.role === 'owner') h += '<form class="panel section" id="settings-form" style="max-width:640px"><h2>Connection</h2>' +
      '<label class="field" for="s-url">API address<input id="s-url" value="' + esc(S.apiUrl) + '" required></label>' +
      '<label class="field" for="s-key">Access key<input id="s-key" type="password" value="' + esc(S.key) + '" autocomplete="off" placeholder="Paste the key from the PRE-05 workflow"></label>' +
      '<p class="faint" style="margin:0">The key is kept only in this browser. The app code is public on GitHub; your contacts are not, because every request needs this key.</p>' +
      '<div class="actions"><button class="btn primary" type="submit">Save and connect</button>' + (S.key ? '<button class="btn bad" type="button" id="s-forget">Forget key on this device</button>' : '') + '</div></form></details>';
    if (can('run_jobs')) h += '<div class="section"><div class="section-head"><h2>Run now</h2><span class="hint">Every job also runs on its own schedule. Results appear in a few minutes.</span></div><div class="runs">' +
      JOBS.map((j) => '<div class="panel"><b>' + esc(j[1]) + '</b><span class="faint" style="font-size:12.5px">' + esc(j[2]) + '</span><div><button type="button" class="btn sm primary" data-run="' + j[0] + '">Run</button></div></div>').join('') + '</div>' +
      '<p class="hint-line" style="margin-top:8px">Google Sheet mirror: <a href="' + SHEET_URL + '" target="_blank" rel="noopener">open the sheet</a>. Paste people into its Import tab (keep the header row) and they are added at the next sync.' + (S.data && S.data.suppressed ? ' · ' + S.data.suppressed + ' addresses on the email suppression list.' : '') + '</p></div>';
    if (can('settings')) h += sigPanelHtml();
    if (S.mode === 'live' && (S.reconnect.scan || []).length) {
      h += '<div class="panel section" style="max-width:640px"><h2>Mailbox scan</h2><p class="faint" style="margin:0 0 8px">Every 20 minutes the engine reads a little further back in each mailbox (headers only, no email text), up to two years. New mail is picked up as it arrives.</p><div class="table-wrap"><table><thead><tr><th>Mailbox</th><th>Read back to</th><th>Messages</th></tr></thead><tbody>' +
        S.reconnect.scan.slice().sort((a, b) => String(a.mailbox).localeCompare(String(b.mailbox))).map((x) => '<tr><td>' + esc(MB_NAME[x.mailbox] || x.mailbox) + '</td><td>' + (x.done ? 'Done (2 years)' : esc(fmtDate(x.back_to))) + '</td><td>' + esc(x.seen) + '</td></tr>').join('') + '</tbody></table></div></div>';
    }
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

  // ---------- SIGN-IN & TEAM ----------
  const AUTH_API = 'https://n8n.assignover.in/webhook/pre-auth';
  const GOOGLE_CLIENT_ID = '437012493188-lvm5ac1r75tj6uqemitlm3q90d8uua2a.apps.googleusercontent.com';
  const RIGHT_LABEL = { view: 'See contacts', send: 'Send email', reply: 'Reply in inbox', edit_contacts: 'Edit contacts', delete: 'Delete contacts', import: 'Import / add people', bulk_draft: 'Write bulk campaigns', bulk_edit: 'Edit running bulk campaigns', bulk_start: 'Start bulk campaigns without approval', bulk_pause: 'Pause bulk campaigns', approve: 'Approve bulk campaigns', run_jobs: 'Run background jobs', assign: 'Assign contacts to people', export: 'Export', settings: 'Settings, signatures, campaigns', members: 'Manage team' };
  const ROLE_LABEL = { owner: 'Owner', manager: 'Manager', staff: 'Staff', viewer: 'Viewer' };
  const can = (r) => !S.me || (S.me.rights || []).includes(r);
  const isOwnerMe = () => !S.me || S.me.role === 'owner';
  const TM = { loaded: false, loading: false, members: [], roleRights: {}, audit: [], auditFor: '', pend: [], camps: [], buckets: [], edit: null, team: null };
  async function authPost(op, payload, extra) {
    const r = await fetch(AUTH_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(JSON.stringify(Object.assign(cred(), { op: op, payload: payload || {} }, extra || {}))) });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (!j) throw new Error('The sign-in service answered with status ' + r.status + '.');
    if (j.ok === false) { if (j.code === 'signin') authLost(); throw new Error(j.message || 'The request did not go through.'); }
    return j;
  }
  function authLost() {
    if (!S.sid) return;
    S.sid = ''; S.me = null; store.del('sid');
    S.data = null; TM.loaded = false; BK.loaded = false;
    toast('Your sign-in has ended. Please sign in again.', true);
    load();
  }
  async function loadMe() {
    if (!S.sid && !S.key) { S.me = null; return; }
    try { const j = await authPost('me'); S.me = j.member || null; } catch (e) { /* keep going; the data calls report the problem */ }
  }
  let gsiLoading = null;
  function loadGsi() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
    if (gsiLoading) return gsiLoading;
    gsiLoading = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = () => res(); s.onerror = () => { gsiLoading = null; rej(new Error('Google sign-in could not load. Check the connection.')); }; document.head.appendChild(s); });
    return gsiLoading;
  }
  async function mountGoogleButton() {
    const box = document.getElementById('g-signin'); if (!box) return;
    try {
      await loadGsi();
      window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogleCredential, auto_select: false, cancel_on_tap_outside: true });
      window.google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', width: 280 });
    } catch (e) { box.innerHTML = '<span class="faint">' + esc(e.message) + '</span>'; }
  }
  async function onGoogleCredential(resp) {
    try {
      const r = await fetch(AUTH_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(JSON.stringify({ op: 'login', payload: { credential: resp.credential } })) });
      const j = await r.json();
      if (!j || !j.ok || !j.sid) throw new Error((j && j.message) || 'Sign-in did not work. Try again.');
      S.sid = j.sid; store.set('sid', j.sid); S.me = j.member || null;
      if (S.me && S.me.role !== 'owner') { S.key = ''; store.del('key'); }
      S.data = null; S.error = ''; BK.loaded = false; TM.loaded = false;
      toast('Signed in as ' + ((S.me && S.me.name) || 'you') + '.');
      await load(); go('today');
    } catch (e) { toast(e.message, true); }
  }
  async function signOut() {
    try { if (S.sid) await authPost('logout'); } catch (e) { /* ignore */ }
    try { if (window.google && window.google.accounts && window.google.accounts.id) window.google.accounts.id.disableAutoSelect(); } catch (e) { /* ignore */ }
    S.sid = ''; S.me = null; store.del('sid'); S.data = null; TM.loaded = false; BK.loaded = false;
    toast('Signed out.'); load(); go('today');
  }
  function signInPanel() {
    return '<div class="panel section" style="max-width:640px;display:flex;flex-direction:column;gap:10px"><h2 style="margin:0">Sign in</h2>' +
      '<p class="muted" style="margin:0">Use the Google account Kamakshya added for you. You see only your own contacts, mailboxes and lists.</p>' +
      '<div id="g-signin" style="min-height:44px"></div></div>';
  }
  function whoLine() {
    if (!S.me) return '';
    return '<div class="panel section" style="max-width:640px;display:flex;flex-direction:column;gap:8px"><h2 style="margin:0">Signed in</h2>' +
      '<div><b>' + esc(S.me.name) + '</b> · ' + esc(S.me.email) + ' · <span class="pill">' + esc(ROLE_LABEL[S.me.role] || S.me.role) + '</span></div>' +
      (S.me.role !== 'owner' ? '<div class="faint">Mailboxes: ' + esc((S.me.mailboxes || []).map(mbLabel).join(', ') || 'none') + '</div>' : '') +
      '<div class="actions">' + (S.sid ? '<button type="button" class="btn" data-signout>Sign out</button>' : '<span class="faint">Connected with the Owner access key. Sign in with Google below to stop using the key.</span>') + '</div></div>';
  }
  const memberName = (id) => { if (!id) return ''; if (S.me && S.me.member_id === id) return 'you'; const all = (TM.members || []).concat(TM.team || []); const m = all.find((x) => x.member_id === id); return m ? m.name : (id === 'owner' ? 'Owner' : id); };
  async function loadTeamList() {
    if (TM.team || !can('assign') || S.mode !== 'live') return;
    try { const j = await authPost('team'); TM.team = j.team || []; if (S.drawer) renderDrawer(); } catch (e) { TM.team = []; }
  }
  async function loadTeam(quiet) {
    if (S.mode !== 'live' || TM.loading) return;
    TM.loading = true; if (!quiet && S.view === 'team') render();
    try {
      const jobs = [can('members') ? authPost('members') : Promise.resolve(null), can('members') ? authPost('audit', { member_id: TM.auditFor }) : Promise.resolve(null),
        bkPost(BULK_CAMP_API, 'list').catch(() => null), bkPost(BULK_LISTS_API, 'buckets').catch(() => null)];
      const [m, a, c, b] = await Promise.all(jobs);
      if (m) { TM.members = m.members || []; TM.roleRights = m.role_rights || {}; }
      if (a) TM.audit = a.entries || [];
      if (c) { TM.camps = c.campaigns || []; TM.pend = TM.camps.filter((x) => x.approval_status === 'pending'); }
      if (b) TM.buckets = b.buckets || [];
      TM.loaded = true;
    } catch (e) { toast(e.message, true); } finally { TM.loading = false; if (S.view === 'team') render(); }
  }
  function renderTeam() {
    let h = topbar('Team', 'Who can sign in, what each person can see and do, campaigns waiting for approval, and a log of actions.', can('members') ? '<button class="btn primary" type="button" data-tm="new">Add a person</button>' : '');
    if (S.mode !== 'live') return h + '<div class="empty">Sign in first.</div>';
    if (!TM.loaded) return h + '<div class="empty">' + (TM.loading ? 'Loading…' : 'Loading the team…') + '</div>';
    if (can('approve')) {
      h += '<section class="section"><div class="section-head"><h2>Waiting for your approval · ' + TM.pend.length + '</h2><span class="hint">Bulk campaigns written by Staff. Approving starts sending at the next 10-minute run inside the sending hours.</span></div>';
      h += TM.pend.length ? '<div class="panel table-wrap"><table><tbody>' + TM.pend.map((c) => { const b = TM.buckets.find((x) => x.bucket_id === c.bucket_id) || {};
        return '<tr><td><b>' + esc(c.name) + '</b><div class="faint">by ' + esc(memberName(c.created_by) || 'unknown') + ' · list ' + esc(b.name || c.bucket_id) + ' · ' + esc(c.sendable || 0) + ' ready to send · from ' + esc(String(c.mailboxes || b.mailboxes || '').split(',').filter(Boolean).map(mbLabel).join(', ')) + '</div>' +
          '<details><summary class="faint" style="cursor:pointer">Read the email</summary><div><b>Subject:</b> ' + esc(c.subject) + '</div><div class="draft">' + esc(c.body) + '</div></details></td>' +
          '<td><div class="actions" style="justify-content:flex-end"><button class="btn sm primary" type="button" data-tm="approve" data-id="' + esc(c.campaign_id) + '">Approve and start</button><button class="btn sm ghost bad" type="button" data-tm="reject" data-id="' + esc(c.campaign_id) + '">Send back</button></div></td></tr>'; }).join('') + '</tbody></table></div>'
        : '<div class="empty">Nothing is waiting.</div>';
      h += '</section>';
    }
    if (can('members')) {
      if (TM.edit) h += memberForm();
      h += '<section class="section"><div class="section-head"><h2>People · ' + TM.members.length + '</h2><span class="hint">Everyone signs in with their own Google account. Nobody needs the Gmail passwords; mail goes out through the app.</span></div>';
      h += '<div class="panel table-wrap" style="padding:0"><table><thead><tr><th>Name</th><th>Role</th><th>Mailboxes</th><th>Lists / campaigns</th><th>Last sign-in</th><th></th></tr></thead><tbody>' + TM.members.map((m) =>
        '<tr' + (m.active ? '' : ' style="opacity:.55"') + '><td><b>' + esc(m.name) + '</b><div class="faint mono">' + esc(m.email) + '</div>' + (m.active ? '' : '<span class="pill">Switched off</span>') + '</td><td>' + esc(ROLE_LABEL[m.role] || m.role) + '</td>' +
        '<td class="faint">' + (m.role === 'owner' ? 'all' : esc((m.mailboxes || []).map(mbLabel).join(', ') || 'none')) + '</td>' +
        '<td class="faint">' + (m.role === 'owner' ? 'all' : esc((m.buckets === 'all' ? 'all lists' : ((m.buckets || []).length + ' lists')) + ' · ' + (m.campaign_codes === 'all' ? 'all campaigns' : ((m.campaign_codes || []).length + ' campaigns')))) + '</td>' +
        '<td class="faint">' + esc(m.last_login ? fmtDate(String(m.last_login).slice(0, 10)) : 'never') + '</td>' +
        '<td><div class="actions" style="justify-content:flex-end">' + (m.role === 'owner' ? '' : '<button class="btn sm" type="button" data-tm="edit" data-id="' + esc(m.member_id) + '">Edit</button>') + '<button class="btn sm ghost" type="button" data-tm="log" data-id="' + esc(m.member_id) + '">Activity</button></div></td></tr>').join('') + '</tbody></table></div></section>';
      const fm = TM.members.find((m) => m.member_id === TM.auditFor);
      h += '<section class="section"><div class="section-head"><h2>Activity' + (fm ? ' · ' + esc(fm.name) : '') + '</h2><span class="hint">Every change, send and refusal, newest first (last 300).' + (fm ? ' <a href="#" data-tm="logall">Show everyone</a>' : '') + '</span></div>';
      h += TM.audit.length ? '<div class="panel table-wrap" style="padding:0"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>On</th><th>Result</th></tr></thead><tbody>' + TM.audit.map((e) =>
        '<tr><td class="faint num" style="white-space:nowrap">' + esc(e.at ? new Date(e.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '') + '</td><td>' + esc(memberName(e.member_id) || e.email || 'not signed in') + '</td><td>' + esc(String(e.action || '').replace(/[_:]/g, ' ')) + (e.detail && e.detail !== '{}' ? '<div class="faint" style="font-size:12px">' + esc(String(e.detail).replace(/[{}"]/g, '').replace(/,/g, ', ').slice(0, 160)) + '</div>' : '') + '</td><td class="faint mono" style="font-size:12px">' + esc(String(e.object || '').slice(0, 60)) + '</td>' +
        '<td>' + (/refused/.test(e.result || '') ? '<span class="pill" style="border-color:#cf222e;color:#cf222e">' + esc(e.result) + '</span>' : '<span class="faint">' + esc(e.result || '') + '</span>') + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty">No activity yet.</div>';
      h += '</section>';
    }
    return h;
  }
  function memberForm() {
    const m = TM.edit; const role = m.role || 'staff';
    const def = new Set(TM.roleRights[role] || []);
    const eff = new Set(m._rights || Array.from(def));
    const box = (name, val, on, label) => '<label class="chip" style="gap:6px;white-space:nowrap"><input type="checkbox" style="width:auto;min-width:0;flex:none;margin:0" name="' + name + '" value="' + esc(val) + '"' + (on ? ' checked' : '') + '>' + esc(label) + '</label>';
    const inList = (arr, v) => arr === 'all' || (Array.isArray(arr) && arr.includes(v));
    const camps = campaigns().slice().sort((a, b) => String(a.campaign_name).localeCompare(String(b.campaign_name)));
    return '<form class="panel section" id="tm-form" style="display:flex;flex-direction:column;gap:12px"><div class="panel-head" style="margin:0"><h2>' + (m.member_id ? 'Edit ' + esc(m.name) : 'Add a person') + '</h2><button type="button" class="btn ghost" data-tm="close">Close</button></div>' +
      '<div class="form-grid"><label class="field" for="tm-name">Name<input id="tm-name" required value="' + esc(m.name || '') + '"></label>' +
      '<label class="field" for="tm-email">Google sign-in address<input id="tm-email" type="email" required value="' + esc(m.email || '') + '" placeholder="name@gmail.com"></label>' +
      '<label class="field" for="tm-role">Role<select id="tm-role">' + ['manager', 'staff', 'viewer'].map((r) => '<option value="' + r + '"' + (r === role ? ' selected' : '') + '>' + ROLE_LABEL[r] + '</option>').join('') + '</select></label>' +
      '<label class="field" for="tm-active">Access<select id="tm-active"><option value="1"' + (m.active !== false ? ' selected' : '') + '>On</option><option value="0"' + (m.active === false ? ' selected' : '') + '>Switched off (signs them out)</option></select></label></div>' +
      '<div><b>Mailboxes they work from</b><p class="hint-line">They see replies to these addresses and send only from them. Two people can share a mailbox and see each other\'s replies.</p><div class="chips">' + MAILBOXES.map((x) => box('tm-mb', x[0], inList(m.mailboxes || [], x[0]), x[1])).join('') + '</div></div>' +
      '<div><b>Bulk lists</b><div class="chips">' + (TM.buckets.length ? TM.buckets.map((b) => box('tm-bk', b.bucket_id, inList(m.buckets || [], b.bucket_id), b.name)).join('') : '<span class="faint">No lists yet.</span>') + '</div></div>' +
      '<div><b>Relationship campaigns</b><p class="hint-line">They see contacts in these campaigns, plus contacts assigned to them and contacts whose home mailbox is theirs.</p><div class="chips">' + camps.map((c) => box('tm-cp', c.campaign_code, inList(m.campaign_codes || [], c.campaign_code), c.campaign_name)).join('') + '</div></div>' +
      '<div><b>What they can do</b><p class="hint-line">Ticked boxes follow the role; change them to give or take away a single right. Team and Export stay with the Owner.</p><div class="chips" id="tm-rights">' + Object.keys(RIGHT_LABEL).filter((r) => !['members', 'export'].includes(r)).map((r) => box('tm-rt', r, eff.has(r), RIGHT_LABEL[r] + (def.has(r) ? '' : ' (extra)'))).join('') + '</div></div>' +
      '<label class="field" for="tm-notes">Notes<input id="tm-notes" value="' + esc(m.notes || '') + '"></label>' +
      '<div class="actions"><button class="btn primary" type="submit">' + (m.member_id ? 'Save changes' : 'Add') + '</button></div></form>';
  }
  function bindTeam() {
    const f = $('#tm-form'); if (!f) return;
    $('#tm-role').addEventListener('change', (e) => { collectMember(); TM.edit.role = e.target.value; TM.edit._rights = null; render(); });
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); const m = collectMember();
      const def = new Set(TM.roleRights[m.role] || []); const eff = new Set(m._rights || []);
      const rights = []; Object.keys(RIGHT_LABEL).filter((r) => !['members', 'export'].includes(r)).forEach((r) => { if (eff.has(r) && !def.has(r)) rights.push(r); if (!eff.has(r) && def.has(r)) rights.push('-' + r); });
      const b = f.querySelector('button[type=submit]'); b.disabled = true;
      try { const j = await authPost('member_save', { member_id: m.member_id || '', name: m.name, email: m.email, role: m.role, mailboxes: m.mailboxes, buckets: m.buckets, campaign_codes: m.campaign_codes, rights: rights, active: m.active !== false, notes: m.notes }); toast(j.message || 'Saved.'); TM.edit = null; await loadTeam(true); }
      catch (er) { toast(er.message, true); b.disabled = false; }
    });
  }
  function collectMember() {
    const m = TM.edit; if (!m || !$('#tm-form')) return m;
    const vals = (n) => Array.from(document.querySelectorAll('input[name="' + n + '"]:checked')).map((x) => x.value);
    m.name = $('#tm-name').value.trim(); m.email = $('#tm-email').value.trim().toLowerCase(); m.role = $('#tm-role').value; m.active = $('#tm-active').value === '1'; m.notes = $('#tm-notes').value.trim();
    m.mailboxes = vals('tm-mb'); m.buckets = vals('tm-bk'); m.campaign_codes = vals('tm-cp'); m._rights = vals('tm-rt');
    return m;
  }
  async function onTeamClick(t) {
    const a = t.getAttribute('data-tm'); const id = t.getAttribute('data-id') || '';
    if (a === 'new') { TM.edit = { role: 'staff', mailboxes: [], buckets: [], campaign_codes: [], active: true }; render(); window.scrollTo(0, 0); return; }
    if (a === 'close') { TM.edit = null; render(); return; }
    if (a === 'edit') { const m = TM.members.find((x) => x.member_id === id); if (!m) return; TM.edit = Object.assign({}, m, { _rights: (m.rights || []).slice() }); render(); window.scrollTo(0, 0); return; }
    if (a === 'log' || a === 'logall') { TM.auditFor = a === 'log' ? id : ''; try { const j = await authPost('audit', { member_id: TM.auditFor }); TM.audit = j.entries || []; } catch (e) { toast(e.message, true); } render(); return; }
    if (a === 'approve' || a === 'reject') {
      const c = TM.pend.find((x) => x.campaign_id === id); if (!c) return;
      let note = '';
      if (a === 'approve' && !confirm('Approve "' + c.name + '" and start sending to ' + (c.sendable || 0) + ' people?')) return;
      if (a === 'reject') { const n = prompt('What should they change? (they see this note)', ''); if (n === null) return; note = n; }
      t.disabled = true;
      try { const j = await bkPost(BULK_CAMP_API, 'approve', { campaign_id: id, decision: a === 'approve' ? 'approve' : 'reject', note: note }); toast(j.message || 'Done.'); BK.loaded = false; await loadTeam(true); }
      catch (e) { toast(e.message, true); t.disabled = false; }
    }
  }
  function assignPanel(c) {
    const who = c.assigned_to ? memberName(c.assigned_to) : '';
    const info = '<div class="faint">' + (who ? 'Assigned to <b>' + esc(who) + '</b>' : 'Not assigned to anyone') + (c.send_mailbox ? ' · home mailbox ' + esc(mbAddr(c.send_mailbox) || c.send_mailbox) : '') + '</div>';
    if (!S.me || !can('assign') || S.mode !== 'live') return S.me && S.me.role !== 'owner' ? '<div class="panel section">' + info + '</div>' : '';
    if (!TM.team) { loadTeamList(); return '<div class="panel section"><h3>Assign</h3>' + info + '<div class="faint">Loading the team…</div></div>'; }
    const myBoxes = S.me.role === 'owner' ? MAILBOXES.map((m) => m[0]) : (S.me.mailboxes || []);
    return '<form class="panel section" id="assign-form"><h3>Assign</h3>' + info + '<div class="form-grid">' +
      '<label class="field" for="as-who">Person responsible<select id="as-who"><option value="">Nobody</option>' + TM.team.map((m) => '<option value="' + esc(m.member_id) + '"' + (m.member_id === c.assigned_to ? ' selected' : '') + '>' + esc(m.name) + ' (' + esc(ROLE_LABEL[m.role] || m.role) + ')</option>').join('') + '</select></label>' +
      '<label class="field" for="as-mb">Home mailbox<select id="as-mb"><option value="">Automatic</option>' + myBoxes.map((k) => '<option value="' + esc(k) + '"' + (k === c.send_mailbox ? ' selected' : '') + '>' + esc(mbLabel(k)) + '</option>').join('') + '</select></label></div>' +
      '<div class="actions"><button class="btn" type="submit">Save assignment</button></div></form>';
  }

  // ---------- render & events ----------
  function render() {
    renderChrome();
    const v = $('#view');
    if (!S.data) { v.innerHTML = '<div class="empty">Loading…</div>'; return; }
    const views = { today: renderToday, pipeline: renderPipeline, contacts: renderContacts, campaigns: renderCampaigns, bulk: renderBulk, library: renderLibrary, add: renderAdd, guide: renderGuide, settings: renderSettings, team: renderTeam };
    if (!viewAllowed(S.view)) S.view = 'today';
    v.innerHTML = (views[S.view] || renderToday)();
    renderDrawer();
    bindViewInputs();
    if (S.view === 'bulk') { bindBulk(); if (S.mode === 'live' && !BK.loaded && !BK.loading) loadBulk(); }
    if (S.view === 'team') { bindTeam(); if (S.mode === 'live' && !TM.loaded && !TM.loading) loadTeam(); }
    if (S.view === 'settings' && !S.sid) mountGoogleButton();
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
          const r = await fetch(CARD_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(JSON.stringify({ ...cred(), op: 'card', payload: { image: image, mime: 'image/jpeg', campaign_code: camp, note: note } })) });
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
      wireSigForm();
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
    const tm = e.target.closest('[data-tm],[data-signout]');
    if (tm) { e.preventDefault(); if (tm.hasAttribute('data-signout')) signOut(); else onTeamClick(tm); return; }
    const t = e.target.closest('[data-nav],[data-act],[data-copy],[data-open],[data-close],[data-refresh],[data-sort],[data-run],[data-campedit],[data-campfilter],[data-libedit],[data-libdel],[data-sendmail],[data-delete],[data-inboxreply],[data-inboxdone],[data-signew],[data-sigedit],[data-sigdel],[data-sigcancel],[data-rcdraft],[data-rcadd],[data-rcsnooze],[data-rcnever],[data-rcmore]');
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
    if (t.hasAttribute('data-rcmore')) { S.rcAll = !S.rcAll; render(); return; }
    if (t.hasAttribute('data-rcdraft') || t.hasAttribute('data-rcadd') || t.hasAttribute('data-rcsnooze') || t.hasAttribute('data-rcnever')) {
      const email = t.getAttribute('data-rcdraft') || t.getAttribute('data-rcadd') || t.getAttribute('data-rcsnooze') || t.getAttribute('data-rcnever');
      const r = (S.reconnect.list || []).find((x) => x.email === email); if (!r) return;
      const drop = () => { S.reconnect.list = S.reconnect.list.filter((x) => x.email !== email); S.reconnect.total = Math.max(0, S.reconnect.total - 1); render(); };
      if (t.hasAttribute('data-rcnever') && !confirm('Remove ' + r.name + ' from the reconnect list for good? Nothing is deleted.')) return;
      t.disabled = true;
      if (t.hasAttribute('data-rcdraft')) {
        t.textContent = 'Writing…';
        rcApi('draft', { email: email }).then((j) => { toast('Draft ready. Review it, pick the From address and signature, then send.'); r.has_draft = true; return load(true).then(() => { S.drawer = j.person_key || r.person_key; renderDrawer(); }); })
          .catch((er) => { toast(er.message, true); t.disabled = false; t.textContent = 'Draft a note'; });
      } else if (t.hasAttribute('data-rcadd')) {
        rcApi('add', { email: email }).then((j) => { toast(j.message || 'Added.'); drop(); setTimeout(() => { load(true); loadReconnect(); }, 240000); }).catch((er) => { toast(er.message, true); t.disabled = false; });
      } else {
        rcApi('snooze', t.hasAttribute('data-rcnever') ? { email: email, never: true } : { email: email, days: 90 }).then((j) => { toast(j.message || 'Done.'); drop(); }).catch((er) => { toast(er.message, true); t.disabled = false; });
      }
      return;
    }
    if (t.hasAttribute('data-signew')) { S.sigEdit = { addresses: 'all' }; render(); const l = $('#sg-label'); if (l) l.focus(); return; }
    if (t.hasAttribute('data-sigcancel')) { S.sigEdit = null; render(); return; }
    if (t.hasAttribute('data-sigedit')) { const g = (S.sigs || []).find((x) => x.sig_id === t.getAttribute('data-sigedit')); if (g) { S.sigEdit = Object.assign({}, g); render(); const p = $('#sig-form'); if (p) p.scrollIntoView({ block: 'start' }); } return; }
    if (t.hasAttribute('data-sigdel')) {
      const g = (S.sigs || []).find((x) => x.sig_id === t.getAttribute('data-sigdel')); if (!g) return;
      if (!confirm('Delete the signature "' + g.label + '"? Emails already sent are not affected.')) return;
      t.disabled = true;
      inboxApi('sig_delete', { sig_id: g.sig_id }).then(() => { toast('Signature deleted.'); return loadSigs(); }).then(() => render()).catch((er) => { toast(er.message, true); t.disabled = false; });
      return;
    }
    if (t.hasAttribute('data-inboxreply') || t.hasAttribute('data-inboxdone')) {
      const id = t.getAttribute('data-inboxreply') || t.getAttribute('data-inboxdone');
      const m = (S.inbox || []).find((x) => x.gmail_id === id); if (!m) return;
      if (t.hasAttribute('data-inboxdone')) { t.disabled = true; inboxApi('done', { gmail_id: id }).then(() => { S.inbox = S.inbox.filter((x) => x.gmail_id !== id); render(); }).catch((er) => { toast(er.message, true); t.disabled = false; }); return; }
      const ta = document.getElementById('ib-' + id); const body = ta ? ta.value.trim() : '';
      if (!body) { toast('Write your reply first.', true); if (ta) ta.focus(); return; }
      const ss = document.getElementById('ibs-' + id); const sigId = ss ? ss.value : '';
      const sigName = ss && ss.selectedIndex >= 0 ? ss.options[ss.selectedIndex].text : '';
      if (!confirm('Send this reply to ' + m.from_email + ' from ' + (m.to_address || mbAddr(m.mailbox)) + '?\nSignature: ' + sigName)) return;
      t.disabled = true;
      inboxApi('reply', { person_key: m.person_key, gmail_id: id, thread_id: m.thread_id, header_id: m.header_id, mailbox: m.mailbox, to_address: m.to_address || '', signature_id: sigId, subject: m.subject, body: body })
        .then((j) => { toast(j.message || 'Sent.'); S.inbox = S.inbox.filter((x) => x.gmail_id !== id); delete S.threads[m.person_key]; render(); })
        .catch((er) => { toast(er.message, true); t.disabled = false; });
      return;
    }
    if (t.hasAttribute('data-sendmail')) {
      const c = contactByKey(t.getAttribute('data-sendmail')); if (!c) return;
      if (/\[[^\]]{2,80}\]/.test(c.pending_message || '')) { toast('The draft still has a [placeholder]. Edit it in your email app or fill it first; it will not be sent with placeholders.', true); return; }
      const fsel = document.getElementById('d-from'); const mbox = fsel && S.drawer === c.person_key ? fsel.value : '';
      const dsig = document.getElementById('d-sig'); const sigId = dsig && S.drawer === c.person_key ? dsig.value : '';
      const sigName = dsig && dsig.selectedIndex >= 0 ? dsig.options[dsig.selectedIndex].text : '';
      if (!confirm('Send this email now to ' + c.email + ' from ' + (mbox ? mbAddr(mbox) : (c.send_mailbox ? mbAddr(c.send_mailbox) + ' (or the address they last wrote to)' : 'the campaign\'s address')) + '?\nSignature: ' + sigName + '\nAn unsubscribe line is added at the bottom.')) return;
      if (S.mode === 'demo') { toast('Demo mode: nothing was sent.'); return; }
      t.disabled = true;
      api('send_email', { person_key: c.person_key, subject: c.pending_subject || '', body: c.pending_message || '', mailbox: mbox, from: mbox.includes('@') ? mbox : '', signature_id: sigId }).then((j) => { toast(j.message || 'Sent.'); delete S.threads[c.person_key]; return load(true); }).catch((er) => { toast(er.message, true); t.disabled = false; });
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
    if (t.hasAttribute('data-refresh')) { load(); if (S.view === 'bulk') loadBulk(true); return; }
    if (t.hasAttribute('data-sort')) {
      const col = t.getAttribute('data-sort');
      S.sort = S.sort.col === col ? { col, dir: -S.sort.dir } : { col, dir: col === 'full_name' || col === 'next_followup_date' ? 1 : -1 };
      render();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'd-from') {
      const c = contactByKey(S.drawer); const ds = document.getElementById('d-sig'); if (!ds) return;
      const addr = e.target.value ? mbAddr(e.target.value) : (c && c.send_mailbox ? mbAddr(c.send_mailbox) : '');
      ds.innerHTML = sigOptionsHtml(addr, ds.value);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.drawer) { S.drawer = null; renderDrawer(); }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open]')) { e.preventDefault(); S.drawer = e.target.getAttribute('data-open'); renderDrawer(); }
  });

  const initial = (location.hash || '').replace('#', '');
  if (VIEWS.some((v) => v.id === initial)) S.view = initial;
  load();
  setInterval(() => { if (S.mode === 'live' && document.visibilityState === 'visible' && !S.drawer && !(S.view === 'bulk' && (BK.edit || BK.imp || BK.bucketEdit))) { load(true); if (S.view === 'bulk') loadBulk(true); if (S.view === 'team') loadTeam(true); } }, 5 * 60 * 1000);
})();
