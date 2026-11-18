import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetsFromRuns, censusRouteKey, checkCensusBudgets, summarizeCensusFlow } from './request-census.mjs';

const frame = (type, extra = '') => ({ direction: 'received', opcode: 1, payload: `42["update",{"body":{"t":"${type}"${extra}}}]` });

test('a flow counts requests by route, socket events by type and full snapshot reads', () => {
  const flow = summarizeCensusFlow({
    requests: [
      { method: 'POST', url: 'http://s.test/v2/sessions/read-batch' },
      { method: 'POST', url: 'http://s.test/v2/sessions/read-batch' },
      { method: 'GET', url: 'http://s.test/v2/changes?after=12' },
      { method: 'GET', url: 'http://s.test/v2/sessions/cmweu2epy00cwmcxjcw8lo5g3' },
      { method: 'GET', url: 'http://s.test/v2/account/settings/history/7' },
    ],
    frames: [frame('account-change', ',"changeKinds":["session"]'), frame('new-message'), { direction: 'received', opcode: 1, payload: '2' }],
  });
  assert.equal(flow.requests, 5);
  assert.equal(flow.snapshotReads, 2);
  assert.equal(flow.routes['POST /v2/sessions/read-batch'], 2);
  assert.equal(flow.routes['GET /v2/sessions/:id'], 1);
  assert.equal(flow.routes['GET /v2/account/settings/history/:n'], 1);
  assert.equal(flow.socketEvents, 2);
  assert.equal(flow.socket['received update/account-change'], 1);
  assert.deepEqual(flow.wakeKinds, { session: 1 });
  assert.equal(censusRouteKey('GET', 'http://s.test/v1/features?x=1'), 'GET /v1/features');
});

test('any count above its budget fails, including a route the budget never saw', () => {
  const ok = { status: 'ok', requests: 3, socketEvents: 1, snapshotReads: 1, routes: { 'GET /v2/changes': 2, 'POST /v2/sessions/read-batch': 1 }, socket: { 'received update/new-message': 1 } };
  const budgets = budgetsFromRuns([{ flows: { turn: ok } }], 'bed');
  assert.equal(checkCensusBudgets({ flows: { turn: ok } }, budgets).ok, true);
  const repeated = { ...ok, requests: 4, routes: { ...ok.routes, 'GET /v1/features': 1 } };
  const result = checkCensusBudgets({ flows: { turn: repeated } }, budgets);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map(failure => failure.metric).sort(), ['requests', 'routes:GET /v1/features']);
  const lower = checkCensusBudgets({ flows: { turn: { ...ok, routes: { 'GET /v2/changes': 1, 'POST /v2/sessions/read-batch': 1 }, requests: 2 } } }, budgets);
  assert.equal(lower.ok, true);
  assert.equal(lower.decreases.length, 2);
  assert.deepEqual(checkCensusBudgets({ flows: {} }, budgets).notRun, ['turn']);
});

test('a flow counts React commits, renders and long-task blocked time from the browser probe, and budgets them', () => {
  const probe = { commits: 4, renders: 120, components: { SessionRow: { renders: 90, commits: 3 }, Header: { renders: 30, commits: 4 } },
    longTasks: [{ atMs: 1, durationMs: 80 }, { atMs: 2, durationMs: 40 }, { atMs: 3, durationMs: 150 }] };
  const flow = summarizeCensusFlow({ requests: [], frames: [], probe });
  assert.equal(flow.commits, 4);
  assert.equal(flow.renders, 120);
  assert.equal(flow.blockedMs, 130);
  assert.deepEqual(flow.topRenders, { SessionRow: 90, Header: 30 });
  const ok = { status: 'ok', requests: 0, socketEvents: 0, snapshotReads: 0, routes: {}, socket: {}, commits: 4, renders: 120 };
  const budgets = budgetsFromRuns([{ flows: { settings: ok } }], 'bed');
  assert.equal(budgets.flows.settings.renders, 120);
  assert.equal(budgets.flows.settings.commits, 4);
  const churn = checkCensusBudgets({ flows: { settings: { ...ok, renders: 121 } } }, budgets);
  assert.deepEqual(churn.failures.map(failure => failure.metric), ['renders']);
});

test('a flow sums bytes up and down per route, preflights, cached assets, socket frame bytes and repeated responses', () => {
  const flow = summarizeCensusFlow({
    requests: [
      { method: 'GET', url: 'http://s.test/v2/changes?after=1', requestBytes: 0, encodedBytes: 900, decodedBytes: 4000, bodyHash: 'a' },
      { method: 'GET', url: 'http://s.test/v2/changes?after=2', requestBytes: 0, encodedBytes: 900, decodedBytes: 4000, bodyHash: 'a' },
      { method: 'POST', url: 'http://s.test/v2/sessions/read-batch', requestBytes: 120, encodedBytes: 300, decodedBytes: 300, bodyHash: 'b' },
    ],
    preflights: [{ url: 'http://s.test/v2/changes', encodedBytes: 250 }],
    assets: [
      { url: 'http://ui.test/_expo/static/js/web/index-1.js', encodedBytes: 1000, decodedBytes: 5000, cached: false },
      { url: 'http://ui.test/favicon.ico', encodedBytes: 0, decodedBytes: 200, cached: true },
    ],
    frames: [frame('new-message'), { direction: 'sent', opcode: 1, payload: '2' }],
  });
  assert.equal(flow.bytes.up, 120 + frame('new-message').payload.length * 0 + 1);
  assert.equal(flow.bytes.httpEncoded, 2100);
  assert.equal(flow.bytes.httpDecoded, 8300);
  assert.equal(flow.bytes.preflights, 1);
  assert.equal(flow.bytes.preflightEncoded, 250);
  assert.equal(flow.bytes.assetEncoded, 1000);
  assert.equal(flow.bytes.assetDecoded, 5200);
  assert.equal(flow.bytes.assetsCached, 1);
  assert.equal(flow.bytes.wsDown, frame('new-message').payload.length);
  assert.equal(flow.bytes.wsUp, 1);
  assert.equal(flow.bytes.wsFramesDown, 1);
  assert.equal(flow.bytes.repeatedResponses, 1);
  assert.equal(flow.bytes.repeatedEncoded, 900);
  assert.deepEqual(flow.routeBytes['GET /v2/changes'], { count: 2, up: 0, encoded: 1800, decoded: 8000 });
  assert.equal(flow.socketBytes['received update/new-message'], frame('new-message').payload.length);
});

test('received socket frames above 1 KiB get a permessage-deflate estimate, smaller with a shared context', () => {
  const big = frame('new-message', `,"c":"${'QUJD'.repeat(400)}x"`);
  const flow = summarizeCensusFlow({ frames: [big, big, frame('new-message')] });
  assert.ok(flow.bytes.wsDownDeflatedAlone < flow.bytes.wsDown);
  assert.ok(flow.bytes.wsDownDeflatedShared < flow.bytes.wsDownDeflatedAlone);
});
