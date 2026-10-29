import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { HIT_AREA_PROBE_SOURCE, summarizeHitAreaCapture } from './hitAreaProbe.mjs';

const frame = (label, x, y, w, h, drawn) => ({ label, frame: { x, y, width: w, height: h }, drawn: drawn ?? { x: x + 8, y: y + 8, width: w - 16, height: h - 16 } });

test('DOM capture finds a framed switch overlapping an unframed row without either centre being stolen, excluding nested controls', () => {
  const dom = new JSDOM(`
    <style>* { opacity: 1; overflow-x: visible; overflow-y: visible; }</style>
    <button data-testid="row"></button>
    <button role="switch" data-testid="switch"><span data-happier-hit-area></span></button>
    <div role="button" data-testid="nested-row">
      <button role="switch" data-testid="nested-switch"><span data-happier-hit-area></span></button>
    </div>
  `, { url: 'https://happier.test/session/info', runScripts: 'outside-only' });
  try {
    const { window } = dom;
    const { document } = window;
    const setRect = (selector, x, y, width, height) => {
      const element = document.querySelector(selector);
      // jsdom owns the real DOM traversal; only browser layout/hit-testing is supplied here.
      element.getBoundingClientRect = () => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height });
      return element;
    };
    const row = setRect('[data-testid="row"]', 0, 0, 320, 48);
    const toggle = setRect('[data-testid="switch"]', 260, 48, 40, 24);
    const reach = setRect('[data-testid="switch"] > span', 258, 36, 44, 36);
    const nestedRow = setRect('[data-testid="nested-row"]', 0, 120, 320, 48);
    const nestedToggle = setRect('[data-testid="nested-switch"]', 260, 132, 40, 24);
    const nestedReach = setRect('[data-testid="nested-switch"] > span', 258, 126, 44, 36);
    const painted = [nestedReach, nestedToggle, nestedRow, reach, toggle, row];
    document.elementFromPoint = (x, y) => painted.find((element) => {
      const rect = element.getBoundingClientRect();
      return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    }) ?? null;
    window.matchMedia = () => ({ matches: false });

    const capture = JSON.parse(JSON.stringify(window.eval(HIT_AREA_PROBE_SOURCE)));
    assert.equal(capture.frames.length, 2);
    assert.equal(capture.controls.length, 4);
    const summary = summarizeHitAreaCapture(capture);
    assert.deepEqual(summary.stolen, []);
    assert.deepEqual(summary.clipped, []);
    assert.deepEqual(summary.undersized, []);
    assert.deepEqual(summary.overlaps, [{ a: 'row', b: 'switch', width: 44, height: 12 }]);
  } finally {
    dom.window.close();
  }
});

test('a marked floating control drawn over a row (the sidebar plus above the list) is accepted occlusion, named in the summary, while a reach beyond its drawn box still is an overlap', () => {
  const dom = new JSDOM(`
    <style>* { opacity: 1; overflow-x: visible; overflow-y: visible; }</style>
    <button data-testid="row"></button>
    <div data-happier-floating-overlay="true"><button data-testid="floating"></button></div>
    <button data-testid="reaching"><span data-happier-hit-area></span></button>
  `, { url: 'https://happier.test/', runScripts: 'outside-only' });
  try {
    const { window } = dom;
    const { document } = window;
    const setRect = (selector, x, y, width, height) => {
      const element = document.querySelector(selector);
      element.getBoundingClientRect = () => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height });
      return element;
    };
    // The row spans the list; the floating button sits over the row's centre, drawn on top of it.
    const row = setRect('[data-testid="row"]', 0, 0, 320, 48);
    const floating = setRect('[data-testid="floating"]', 138, 2, 44, 44);
    // A small control whose hit frame reaches 10 px past its drawn box, over the same row.
    const reaching = setRect('[data-testid="reaching"]', 100, 40, 24, 24);
    const reach = setRect('[data-testid="reaching"] > span', 90, 30, 44, 44);
    const painted = [floating, reach, reaching, row];
    document.elementFromPoint = (x, y) => painted.find((element) => {
      const rect = element.getBoundingClientRect();
      return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    }) ?? null;
    window.matchMedia = () => ({ matches: false });
    const summary = summarizeHitAreaCapture(JSON.parse(JSON.stringify(window.eval(HIT_AREA_PROBE_SOURCE))));
    assert.deepEqual(summary.overlaps.map((pair) => [pair.a, pair.b]), [['row', 'reaching']]);
    // The marked button paints over the row's centre: the row is covered, not stolen from, and the acceptance is recorded.
    assert.deepEqual(summary.stolen, []);
    assert.ok(summary.accepted.length > 0 && summary.accepted.every((entry) => entry.overlay === 'floating'));
  } finally {
    dom.window.close();
  }
});

test('an unmarked sibling drawn over a control (a badge on a button) is still an overlap and a stolen centre', () => {
  const dom = new JSDOM(`
    <style>* { opacity: 1; overflow-x: visible; overflow-y: visible; }</style>
    <button data-testid="primary"></button>
    <button data-testid="badge"></button>
    <div data-happier-floating-overlay="true"><button data-testid="floating"></button></div>
    <button data-testid="list-row"></button>
  `, { url: 'https://happier.test/', runScripts: 'outside-only' });
  try {
    const { window } = dom;
    const { document } = window;
    const setRect = (selector, x, y, width, height) => {
      const element = document.querySelector(selector);
      element.getBoundingClientRect = () => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height });
      return element;
    };
    // A 24 x 24 badge is painted over the centre of a 100 x 48 button; nothing marks it as a floating overlay.
    const primary = setRect('[data-testid="primary"]', 0, 0, 100, 48);
    const badge = setRect('[data-testid="badge"]', 38, 12, 24, 24);
    // The marked floating control sits over a row's centre far from the badge.
    const row = setRect('[data-testid="list-row"]', 0, 200, 320, 48);
    const floating = setRect('[data-testid="floating"]', 138, 202, 44, 44);
    const painted = [badge, floating, primary, row];
    document.elementFromPoint = (x, y) => painted.find((element) => {
      const rect = element.getBoundingClientRect();
      return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    }) ?? null;
    window.matchMedia = () => ({ matches: false });
    const summary = summarizeHitAreaCapture(JSON.parse(JSON.stringify(window.eval(HIT_AREA_PROBE_SOURCE))));
    assert.deepEqual(summary.overlaps.map((pair) => [pair.a, pair.b]), [['primary', 'badge']]);
    assert.deepEqual(summary.stolen, [{ label: 'primary', by: 'badge' }]);
    // The marked floating control over the row stays accepted, and is listed rather than silent.
    assert.ok(summary.accepted.some((entry) => entry.a === 'list-row' && entry.overlay === 'floating'));
  } finally {
    dom.window.close();
  }
});

test('reports only neighbouring hit frames that really overlap, and controls below the WCAG floor', () => {
  const frames = [frame('a', 0, 0, 44, 44), frame('b', 40, 0, 44, 44), frame('c', 84, 0, 44, 44)];
  const capture = {
    url: '/', viewport: { width: 390, height: 844 }, pointer: { coarse: true, hover: false },
    frames, targets: frames.map((f) => ({ label: f.label, rect: f.frame })),
    // a/b share 4 px (overlap); b/c touch edge to edge (clear); a/c do not meet.
    pairs: [[0, 1], [1, 2], [0, 2]],
    controls: [{ label: 'tiny', drawn: { x: 100, y: 100, width: 16, height: 16 }, target: { x: 100, y: 100, width: 16, height: 16 }, hasHitArea: false }],
  };
  const summary = summarizeHitAreaCapture(capture);
  assert.deepEqual(summary.overlaps, [{ a: 'a', b: 'b', width: 4, height: 44 }]);
  assert.deepEqual(summary.undersized.map((c) => c.label), ['tiny']);
});

test('DOM capture excludes clipped-out tabs and clips partial targets without reporting their hidden centres as stolen', () => {
  const dom = new JSDOM(`
    <style>* { opacity: 1; overflow-x: visible; overflow-y: visible; }</style>
    <button data-testid="logo"></button>
    <button data-testid="toolbar"></button>
    <div data-testid="tab-scroll" style="overflow-x:auto; overflow-y:hidden">
      <button role="tab" data-testid="clipped-tab"></button>
      <button role="tab" data-testid="partial-tab"></button>
    </div>
    <button data-testid="viewport-edge"></button>
    <button data-testid="outside-viewport"></button>
  `, { url: 'https://happier.test/', runScripts: 'outside-only' });
  try {
    const { window } = dom;
    const { document } = window;
    Object.defineProperties(window, { innerWidth: { value: 1280 }, innerHeight: { value: 577 } });
    const setRect = (selector, x, y, width, height) => {
      const element = document.querySelector(selector);
      // Supply browser layout and hit-testing; selectors, ancestors and styles remain real DOM.
      element.getBoundingClientRect = () => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height });
      return element;
    };
    const logo = setRect('[data-testid="logo"]', 14, 6, 28, 28);
    const toolbar = setRect('[data-testid="toolbar"]', 340, 5, 30, 30);
    const scroll = setRect('[data-testid="tab-scroll"]', 371, 1, 751, 38);
    Object.defineProperties(scroll, {
      clientLeft: { value: 0 }, clientTop: { value: 0 }, clientWidth: { value: 751 }, clientHeight: { value: 38 },
    });
    setRect('[data-testid="clipped-tab"]', -46, 5, 120, 30);
    const partial = setRect('[data-testid="partial-tab"]', 310, 5, 90, 30);
    const viewportEdge = setRect('[data-testid="viewport-edge"]', 1256, 60, 60, 30);
    setRect('[data-testid="outside-viewport"]', 1300, 100, 60, 30);
    const painted = [logo, toolbar, partial, viewportEdge];
    document.elementFromPoint = (x, y) => painted.find((element) => {
      const rect = element.getBoundingClientRect();
      return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    }) ?? null;
    window.matchMedia = () => ({ matches: false });

    const capture = JSON.parse(JSON.stringify(window.eval(HIT_AREA_PROBE_SOURCE)));
    assert.equal(capture.controls.length, 4);
    assert.deepEqual(capture.targets.find((target) => target.label === 'partial-tab').rect, { x: 371, y: 5, width: 29, height: 30 });
    assert.deepEqual(capture.targets.find((target) => target.label === 'viewport-edge').rect, { x: 1256, y: 60, width: 24, height: 30 });
    const summary = summarizeHitAreaCapture(capture);
    assert.deepEqual(summary.overlaps, []);
    assert.deepEqual(summary.stolen, []);
    assert.deepEqual(summary.undersized, []);
  } finally {
    dom.window.close();
  }
});

test('DOM capture clips framed targets on the overflow axis while preserving clipped-edge and stolen-centre findings', () => {
  const dom = new JSDOM(`
    <style>* { opacity: 1; overflow-x: visible; overflow-y: visible; }</style>
    <div data-testid="clip" style="overflow-x:clip; overflow-y:visible">
      <button data-testid="clipped-frame"><span data-happier-hit-area></span></button>
    </div>
    <button data-testid="row"></button>
    <button role="switch" data-testid="switch"><span data-happier-hit-area></span></button>
  `, { url: 'https://happier.test/session/info', runScripts: 'outside-only' });
  try {
    const { window } = dom;
    const { document } = window;
    const setRect = (selector, x, y, width, height) => {
      const element = document.querySelector(selector);
      // Only browser geometry and hit-testing are supplied; capture traverses the real DOM.
      element.getBoundingClientRect = () => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height });
      return element;
    };
    const clip = setRect('[data-testid="clip"]', 98, 100, 44, 20);
    Object.defineProperties(clip, {
      clientLeft: { value: 2 }, clientTop: { value: 0 }, clientWidth: { value: 40 }, clientHeight: { value: 20 },
    });
    setRect('[data-testid="clipped-frame"]', 102, 96, 24, 24);
    const clippedReach = setRect('[data-testid="clipped-frame"] > span', 96, 90, 36, 36);
    const row = setRect('[data-testid="row"]', 0, 200, 100, 48);
    setRect('[data-testid="switch"]', 40, 230, 24, 24);
    const reach = setRect('[data-testid="switch"] > span', 36, 220, 32, 40);
    const painted = [clippedReach, reach, row];
    document.elementFromPoint = (x, y) => painted.find((element) => {
      if (element === clippedReach && x < 100) return false;
      const rect = element.getBoundingClientRect();
      return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    }) ?? null;
    window.matchMedia = () => ({ matches: false });

    const capture = JSON.parse(JSON.stringify(window.eval(HIT_AREA_PROBE_SOURCE)));
    assert.equal(capture.frames.length, 2);
    assert.equal(capture.controls.length, 3);
    assert.deepEqual(capture.targets.find((target) => target.label === 'clipped-frame').rect, { x: 100, y: 90, width: 32, height: 36 });
    const summary = summarizeHitAreaCapture(capture);
    assert.deepEqual(summary.clipped, [{ label: 'clipped-frame', side: 'left', reach: 6, hit: null }]);
    assert.deepEqual(summary.stolen, [{ label: 'row', by: 'switch' }]);
    assert.deepEqual(summary.overlaps, [{ a: 'row', b: 'switch', width: 32, height: 28 }]);
    assert.deepEqual(summary.undersized, []);
  } finally {
    dom.window.close();
  }
});

test('a small drawn control whose hit frame reaches the floor is not under-sized', () => {
  const small = frame('mic', 0, 0, 44, 44, { x: 10, y: 10, width: 24, height: 24 });
  const capture = {
    url: '/', viewport: { width: 1440, height: 900 }, pointer: { coarse: false, hover: true },
    frames: [small], targets: [], pairs: [],
    controls: [{ label: 'mic', drawn: { x: 10, y: 10, width: 20, height: 20 }, target: small.frame, hasHitArea: true }],
  };
  assert.equal(summarizeHitAreaCapture(capture).undersized.length, 0);
});

test('reports a frame edge the browser hit-tests as something else (a clipping ancestor cut the reach off)', () => {
  const stepper = { ...frame('count.decrement', 246, 432, 38, 44, { x: 252, y: 439, width: 32, height: 30 }), edges: [
    { side: 'top', reach: 7, ok: false, hit: 'div' },
    { side: 'bottom', reach: 7, ok: true, hit: 'count.decrement' },
  ] };
  const capture = { url: '/settings/coordination', viewport: { width: 390, height: 844 }, pointer: { coarse: true, hover: false }, frames: [stepper], targets: [], pairs: [], controls: [] };
  assert.deepEqual(summarizeHitAreaCapture(capture).clipped, [{ label: 'count.decrement', side: 'top', reach: 7, hit: 'div' }]);
});

test('reports a control whose own centre presses a neighbour (a switch hit area reaching into its row)', () => {
  const capture = {
    url: '/session/info', viewport: { width: 390, height: 844 }, pointer: { coarse: true, hover: false }, frames: [], targets: [], pairs: [],
    controls: [
      { label: 'session-work-trigger:habit', drawn: { x: 2, y: 690, width: 370, height: 45 }, target: { x: 2, y: 690, width: 370, height: 45 }, hasHitArea: false, centreTakenBy: 'session-work-trigger:habit-switch' },
      { label: 'session-work-trigger:habit-switch', drawn: { x: 156, y: 723, width: 40, height: 24 }, target: { x: 154, y: 713, width: 44, height: 44 }, hasHitArea: true, centreTakenBy: null },
    ],
  };
  assert.deepEqual(summarizeHitAreaCapture(capture).stolen, [{ label: 'session-work-trigger:habit', by: 'session-work-trigger:habit-switch' }]);
});
