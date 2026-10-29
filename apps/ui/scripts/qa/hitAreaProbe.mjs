#!/usr/bin/env node
// Live hit-area probe for an agent-browser session on the Happier web app.
//
// Reads every invisible hit-area frame the shared pressable renders (`[data-happier-hit-area]`),
// reports neighbouring effective targets that overlap (nested hosts excluded), frames a clipping ancestor cuts off
// (`elementFromPoint` just inside each edge the frame reaches past the drawn box must land on the
// control), controls whose own centre the browser hit-tests as another control (a neighbour's invisible
// hit area stealing the tap — a switch reaching into its row) and visible controls drawn below the
// WCAG 2.2 AA 24 CSS px target. A floating control its owner marks with `data-happier-floating-overlay` (the
// sidebar's "+" over the session list) is accepted painted occlusion over the surface under it (listed under
// `accepted`); every other sibling drawn over a control still reports. A control scrolled out of its overflow-clipping ancestor (a tab strip's hidden tabs)
// is not on screen and is neither a target nor a neighbour. Run it per page, per
// theme, on phone (coarse pointer) and desktop.
//
//   node apps/ui/scripts/qa/hitAreaProbe.mjs --session <name> [--out <file.json>] [--cdp <port>]
//
// Exit code 1 when any overlap or clipped frame is found, so a lane can gate on it.
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const WCAG_MINIMUM_TARGET_PX = 24;
const OVERLAP_TOLERANCE_PX = 0.5;

/** The in-page function: effective control targets, hit frames, and non-nested target pairs. */
export const HIT_AREA_PROBE_SOURCE = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) }; };
  const visible = (el) => { const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0; };
  // Effective targets contain only the part the viewport and overflow ancestors leave pressable.
  // Keep raw frame geometry separately so clipped invisible reach still produces edge diagnostics.
  const visibleRect = (el) => {
    const r = el.getBoundingClientRect();
    let x = Math.max(r.x, 0), y = Math.max(r.y, 0);
    let right = Math.min(r.right, innerWidth), bottom = Math.min(r.bottom, innerHeight);
    const clips = (value) => ['auto', 'scroll', 'hidden', 'clip', 'overlay'].includes(value);
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      const clipX = clips(s.overflowX), clipY = clips(s.overflowY);
      if (!clipX && !clipY) continue;
      const c = a.getBoundingClientRect();
      if (clipX) {
        const left = c.x + a.clientLeft;
        x = Math.max(x, left);
        right = Math.min(right, left + a.clientWidth);
      }
      if (clipY) {
        const top = c.y + a.clientTop;
        y = Math.max(y, top);
        bottom = Math.min(bottom, top + a.clientHeight);
      }
    }
    return right > x && bottom > y ? { x: round(x), y: round(y), width: round(right - x), height: round(bottom - y) } : null;
  };
  const centreOf = (el) => { const r = visibleRect(el); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const label = (el) => el.getAttribute('data-testid') || el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 24) || el.tagName.toLowerCase();
  const CONTROL = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"], [role="menuitem"]';
  const frames = [...document.querySelectorAll('[data-happier-hit-area]')].map((frame, index) => {
    const host = frame.parentElement;
    return { index, host, frame, hostLabel: label(host) };
  }).filter((f) => f.host && visible(f.host) && f.frame.getBoundingClientRect().width > 0);
  const framesByHost = new Map(frames.map((f) => [f.host, f]));
  const controlCandidates = [...document.querySelectorAll(CONTROL)]
    .filter((el) => visible(el) && !el.closest('[aria-hidden="true"]'))
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const targetsByHost = new Map([...new Set([...controlCandidates, ...framesByHost.keys()])]
    .map((host) => [host, visibleRect(framesByHost.get(host)?.frame ?? host)])
    .filter(([, rect]) => rect));
  const targetOf = (host) => targetsByHost.get(host);
  const targetHosts = [...targetsByHost.keys()];
  const controls = controlCandidates.filter((host) => targetsByHost.has(host));
  const nested = (a, b) => a.contains(b) || b.contains(a);
  // Just inside each edge the frame reaches past the drawn box, the browser must hit the control. A
  // control the page itself covers (scrolled under a header, behind a sheet) is skipped, not reported.
  const owns = (f, x, y) => { const el = document.elementFromPoint(x, y); return { ok: el === f.frame || f.host.contains(el), hit: el ? label(el) : null }; };
  const edgesOf = (f) => {
    const fr = f.frame.getBoundingClientRect();
    const dr = f.host.getBoundingClientRect();
    const centre = centreOf(f.host);
    if (!centre) return [];
    const { x: cx, y: cy } = centre;
    if (!owns(f, cx, cy).ok) return [];
    const probes = [
      { side: 'top', reach: dr.top - fr.top, x: cx, y: fr.top + 1 },
      { side: 'bottom', reach: fr.bottom - dr.bottom, x: cx, y: fr.bottom - 1 },
      { side: 'left', reach: dr.left - fr.left, x: fr.left + 1, y: cy },
      { side: 'right', reach: fr.right - dr.right, x: fr.right - 1, y: cy },
    ];
    return probes
      .filter((p) => p.reach >= 1.5 && p.x >= 0 && p.y >= 0 && p.x < innerWidth && p.y < innerHeight)
      .map((p) => ({ side: p.side, reach: round(p.reach), ...owns(f, p.x, p.y) }));
  };
  const out = frames.filter((f) => targetsByHost.has(f.host)).map((f) => ({ index: f.index, label: f.hostLabel, frame: rectOf(f.frame), drawn: rectOf(f.host), edges: edgesOf(f) }));
  const pointer = { coarse: matchMedia('(pointer: coarse)').matches, hover: matchMedia('(hover: hover)').matches };
  // A floating control explicitly marked by its owner (data-happier-floating-overlay, the sidebar's "+" over
  // the session list) takes the taps on the part of the surface it covers, and the person sees it there. Where
  // the whole region two targets share is that control's own drawn box, nothing invisible reaches into a
  // neighbour, so the pair is accepted painted occlusion (named in the summary), not a hit-area overlap.
  // Geometry alone never decides it: an unmarked sibling drawn over a control (a badge on a button) is a defect.
  const OVERLAY = '[data-happier-floating-overlay]';
  const overlayOf = (el) => el.closest(OVERLAY);
  const acceptedOverlay = (a, b) => {
    const ra = targetOf(a), rb = targetOf(b);
    const left = Math.max(ra.x, rb.x), top = Math.max(ra.y, rb.y);
    const right = Math.min(ra.x + ra.width, rb.x + rb.width), bottom = Math.min(ra.y + ra.height, rb.y + rb.height);
    if (right <= left || bottom <= top) return null;
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    const winner = hit && [a, b].find((host) => host.contains(hit) || framesByHost.get(host)?.frame === hit);
    const overlay = winner && overlayOf(winner);
    if (!overlay || overlay.contains(winner === a ? b : a)) return null;
    const drawn = winner.getBoundingClientRect();
    const inside = left >= drawn.left - 0.5 && right <= drawn.right + 0.5 && top >= drawn.top - 0.5 && bottom <= drawn.bottom + 0.5;
    return inside ? label(winner) : null;
  };
  const pairs = [];
  for (let i = 0; i < targetHosts.length; i++) for (let j = i + 1; j < targetHosts.length; j++) if (!nested(targetHosts[i], targetHosts[j])) pairs.push([i, j, acceptedOverlay(targetHosts[i], targetHosts[j])]);
  // Sample the visible drawn centre, so a hidden centre cannot falsely name a neighbour as owner.
  const centreOwner = (el) => {
    const centre = centreOf(el);
    if (!centre) return undefined;
    const { x, y } = centre;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return undefined;
    const frameHost = hit.matches('[data-happier-hit-area]') ? hit.parentElement : null;
    const owner = frameHost ?? hit.closest(CONTROL);
    if (!owner || owner === el || el.contains(owner) || owner.contains(el)) return null;
    // A marked floating control drawn on top of this centre (the sidebar's "+" over a list row): the person sees
    // it there, so it is the one pressed, not an invisible reach stealing the tap. Any other control that takes
    // the centre, painted or not, is reported.
    const painted = owner.getBoundingClientRect();
    const paintedOver = x >= painted.left && x < painted.right && y >= painted.top && y < painted.bottom;
    return paintedOver && overlayOf(owner) ? { accepted: label(owner) } : label(owner);
  };
  const small = controls.map((el) => {
    const owner = centreOwner(el);
    return { label: label(el), drawn: rectOf(el), target: targetOf(el), hasHitArea: framesByHost.has(el),
      centreTakenBy: typeof owner === 'string' ? owner : null, centreCoveredBy: owner && typeof owner === 'object' ? owner.accepted : null };
  });
  const targets = targetHosts.map((host) => ({ label: label(host), rect: targetOf(host) }));
  return { url: location.pathname, viewport: { width: innerWidth, height: innerHeight }, pointer, frames: out, targets, pairs, controls: small };
})()`;

const intersection = (a, b) => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
});

/** Reduce the in-page capture to overlaps and under-sized controls (pure; unit tested). */
export function summarizeHitAreaCapture(capture, minimum = WCAG_MINIMUM_TARGET_PX) {
  const overlaps = [];
  // Painted occlusion a marked floating control owns (see `acceptedOverlay`): kept as evidence, never silent.
  const accepted = [];
  for (const [i, j, overlay] of capture.pairs) {
    if (overlay) {
      accepted.push({ a: capture.targets[i].label, b: capture.targets[j].label, overlay });
      continue;
    }
    const a = capture.targets[i];
    const b = capture.targets[j];
    const shared = intersection(a.rect, b.rect);
    if (shared.width > OVERLAP_TOLERANCE_PX && shared.height > OVERLAP_TOLERANCE_PX) {
      overlaps.push({ a: a.label, b: b.label, width: Math.round(shared.width * 10) / 10, height: Math.round(shared.height * 10) / 10 });
    }
  }
  const undersized = capture.controls
    .filter((control) => {
      const rect = control.target;
      return rect.width + OVERLAP_TOLERANCE_PX < minimum || rect.height + OVERLAP_TOLERANCE_PX < minimum;
    })
    .map((control) => ({ label: control.label, width: control.drawn.width, height: control.drawn.height, hasHitArea: control.hasHitArea }));
  // A frame edge the browser does not hit-test as the control: a clipping ancestor (or the control's own
  // overflow) cut the reach off, or something unrelated is painted over it.
  const clipped = capture.frames.flatMap((frame) => (frame.edges ?? [])
    .filter((edge) => !edge.ok)
    .map((edge) => ({ label: frame.label, side: edge.side, reach: edge.reach, hit: edge.hit })));
  // A control whose own centre presses another control: a neighbour's hit area reaches over it.
  const stolen = capture.controls
    .filter((control) => control.centreTakenBy)
    .map((control) => ({ label: control.label, by: control.centreTakenBy }));
  for (const control of capture.controls) if (control.centreCoveredBy) accepted.push({ a: control.label, b: control.centreCoveredBy, overlay: control.centreCoveredBy });
  return { url: capture.url, viewport: capture.viewport, pointer: capture.pointer, frameCount: capture.frames.length, overlaps, clipped, stolen, undersized, accepted };
}

function runAgentBrowser(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('agent-browser', args, { maxBuffer: 30 * 1024 * 1024, timeout: 60000 }, (error, stdout, stderr) => {
      if (error) rejectPromise(new Error([`agent-browser ${args.join(' ')} failed`, stdout?.trim(), stderr?.trim(), error.message].filter(Boolean).join('\n')));
      else resolvePromise(stdout);
    });
  });
}

export async function captureHitAreas({ session, cdp }) {
  const args = ['--session', session, ...(cdp ? ['--cdp', String(cdp)] : []), 'eval', HIT_AREA_PROBE_SOURCE, '--json'];
  const response = JSON.parse(await runAgentBrowser(args));
  if (response?.success === false) throw new Error(response.error ?? 'hit-area probe failed');
  return response?.data?.result;
}

function readArgs(argv) {
  const args = { session: '', cdp: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') args.session = argv[++i] ?? '';
    else if (argv[i] === '--cdp') args.cdp = argv[++i] ?? '';
    else if (argv[i] === '--out') args.out = argv[++i] ?? '';
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = readArgs(process.argv.slice(2));
  if (!args.session) {
    console.error('Usage: node apps/ui/scripts/qa/hitAreaProbe.mjs --session <name> [--cdp <port>] [--out <file.json>]');
    process.exit(2);
  }
  const summary = summarizeHitAreaCapture(await captureHitAreas(args));
  const text = JSON.stringify(summary, null, 2);
  if (args.out) await writeFile(args.out, `${text}\n`);
  console.log(text);
  process.exit(summary.overlaps.length === 0 && summary.clipped.length === 0 && summary.stolen.length === 0 ? 0 : 1);
}
