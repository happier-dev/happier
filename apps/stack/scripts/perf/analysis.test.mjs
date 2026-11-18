import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeNetwork, summarizeProfile, summarizeLogs, compareRuns } from './analysis.mjs';
import * as analysis from './analysis.mjs';

test('duplicate candidates require the same method, full request fingerprint and overlapping lifetime', () => {
  const requests = [
    { endpoint: '/items', method: 'GET', fingerprint: 'a', startMs: 0, endMs: 20, encodedBytes: 10 },
    { endpoint: '/items', method: 'GET', fingerprint: 'a', startMs: 10, endMs: 30, encodedBytes: 20 },
    { endpoint: '/items', method: 'GET', fingerprint: 'b', startMs: 12, endMs: 25, encodedBytes: 30 },
    { endpoint: '/items', method: 'GET', fingerprint: 'a', startMs: 35, endMs: 40, encodedBytes: 40 },
    { endpoint: '/items', method: 'POST', fingerprint: 'a', startMs: 12, endMs: 18, encodedBytes: 50 },
  ];
  const result = summarizeNetwork(requests);
  assert.equal(result.requests, 5);
  assert.equal(result.duplicateCandidates, 1);
  assert.equal(result.encodedBytes, 150);
  assert.equal(result.endpoints.find(row => row.method === 'GET').count, 4);
});

test('CPU samples retain script identity and recursive frames count inclusive time once', () => {
  const frame = (scriptId, url, functionName) => ({ scriptId, url, functionName, lineNumber: 0, columnNumber: 0 });
  const profile = { startTime: 0, endTime: 6000, nodes: [
    { id: 1, callFrame: frame('0', '', '(root)'), children: [2] },
    { id: 2, callFrame: frame('1', '/a.js', 'render'), children: [3] },
    { id: 3, callFrame: frame('1', '/a.js', 'render'), children: [4] },
    { id: 4, callFrame: frame('2', '/b.js', 'render') },
  ], samples: [3, 4], timeDeltas: [2000, 4000] };
  const result = summarizeProfile(profile);
  assert.equal(result.sampledMs, 6);
  assert.equal(result.functions.find(row => row.source === '/a.js').inclusiveMs, 6);
  assert.equal(result.functions.find(row => row.source === '/b.js').selfMs, 4);
});

test('server and daemon logs are windowed, query attempts correlate by request id, payloads stay out', () => {
  const lines = [
    JSON.stringify({ time: 999, module: 'web-latency', phase: 'db.Account.findMany', elapsedMs: 7, requestId: 'r' }),
    JSON.stringify({ time: 1000, module: 'web-latency', phase: 'db.Account.findMany', elapsedMs: 4, requestId: 'r', params: 'secret' }),
    JSON.stringify({ time: 1001, module: 'web-latency', phase: 'http.GET./v1/account', elapsedMs: 9, requestId: 'r' }),
    '[00:00:01.002] [CONTROL SERVER] Request completed {"requestId":"d","route":"/rpc","durationMs":2,"body":"secret"}',
  ];
  const result = summarizeLogs(lines.join('\n'), { startMs: 1000, endMs: 1003, date: '1970-01-01' });
  assert.equal(result.db.attempts, 1);
  assert.equal(result.http[0].dbAttempts, 1);
  assert.equal(result.daemon.length, 1);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('out-of-order CPU samples normalize before window clipping without altering raw evidence', () => {
  const profile = { startTime: 1000, endTime: 11000, nodes: [
    { id: 1, callFrame: { scriptId: '1', url: '/work.js', functionName: 'work', lineNumber: 0, columnNumber: 0 } },
  ], samples: [1, 1, 1, 1], timeDeltas: [8000, -6000, 5000, 5000] };
  const original = structuredClone(profile);
  assert.equal(summarizeProfile(profile).sampledMs, 10);
  const normalized = analysis.normalizeProfileSamples(profile);
  assert.deepEqual(normalized.timeDeltas, [2000, 5000, 1000, 2000]);
  assert.ok(normalized.timeDeltas.every(delta => delta >= 0));
  assert.deepEqual(profile, original);
  const empty = analysis.normalizeProfileSamples({ ...profile, samples: [], timeDeltas: [] });
  assert.deepEqual(empty.samples, []);
});

test('comparison isolates heavy profiling and never certifies it as production timing', () => {
  const run = profiling => ({ journey: 'J13', cache: 'warm', uiMode: 'export', status: 'CAPTURED',
    captureMode: 'timing', version: 5, durationMs: 300000,
    instrumentation: { storeTelemetry: false, fiberHook: false, profiling }, counts: { requests: 2 } });
  const rows = compareRuns(Array.from({ length: 5 }, () => run(false)), Array.from({ length: 5 }, () => run(true)));
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.profiling === false).beforeTiming.p50Ms, 300000);
  assert.equal(rows.find(row => row.profiling === true).afterTiming, null);
  assert.ok(rows.every(row => row.counts.requests.delta === null));
});

test('comparison keeps cold/warm separate and withholds timing percentiles below five repeats', () => {
  const run = (cache, durationMs, requests) => ({ journey: 'J1', cache, uiMode: 'export', status: 'CAPTURED', captureMode: 'timing', instrumentation: { storeTelemetry: false, fiberHook: false }, durationMs, counts: { requests } });
  const before = Array.from({ length: 5 }, (_, i) => run('cold', i + 1, 10));
  const after = [run('cold', 2, 4), ...Array.from({ length: 5 }, () => run('warm', 3, 3))];
  const result = compareRuns(before, after);
  assert.equal(result[0].counts.requests.delta, -6);
  assert.equal(result[0].beforeTiming.p95Ms, 5);
  assert.equal(result[0].afterTiming, null);
  assert.equal(result.length, 2);
  const failed = { ...run('cold', 999, 999), status: 'FAILED', eligible: false };
  const partial = compareRuns([...before, failed], [...before, failed]);
  assert.equal(partial[0].beforeRuns, 5, 'failed journeys never enter comparison means or percentiles');
  assert.equal(partial[0].counts.requests.before, 10);
  const revised = compareRuns(before.map(run => ({ ...run, version: 2 })), before.map(run => ({ ...run, version: 3 })));
  assert.equal(revised.length, 2, 'changed collector window semantics must not pool legacy and current bundles');
  assert.ok(revised.every(row => row.counts.requests.delta === null));
});

test('comparison isolates backend profiling roles and withholds unperturbed browser timing', () => {
  const run = backendProfileRoles => ({ journey: 'J13', cache: 'warm', uiMode: 'export', status: 'CAPTURED',
    captureMode: 'timing', version: 5, durationMs: 300000, backendProfileRoles,
    instrumentation: { storeTelemetry: false, fiberHook: false }, counts: { requests: 2 } });
  const rows = compareRuns(Array.from({ length: 5 }, () => run([])), Array.from({ length: 5 }, () => run(['server', 'daemon'])));
  assert.equal(rows.length, 2, 'instrumented and uninstrumented backend workloads cannot be pooled');
  assert.equal(rows.find(row => row.backendProfileRoles.length === 0).beforeTiming.p50Ms, 300000);
  assert.equal(rows.find(row => row.backendProfileRoles.length === 2).afterTiming, null);
  const sameRoles = compareRuns([run(['server', 'daemon'])], [run(['daemon', 'server'])]);
  assert.equal(sameRoles.length, 1, 'role order does not change the workload');
  assert.equal(sameRoles[0].counts.requests.delta, 0);
});

test('decoded HTTP totals include only completed in-window responses and preserve unavailable legacy data', () => {
  const request = (endMs, decodedBytes) => ({ endpoint: 'https://qa.test/data', method: 'GET', startMs: 1, endMs, decodedBytes });
  const result = summarizeNetwork([request(2, 5632), request(20, 9999)], { startMs: 0, endMs: 10 });
  assert.equal(result.decodedBytes, 5632);
  assert.equal(summarizeNetwork([request(2, undefined)]).decodedBytes, null);
  assert.equal(summarizeNetwork([]).decodedBytes, 0);
});

test('transfer comparisons expose route demand, body availability and per-type delivery frame sizes', () => {
  const requests = [
    { endpoint: '/v2/sessions/query', method: 'POST', startMs: 1, endMs: 2,
      requestBodyBytes: 12, decodedBytes: 400, encodedBodyBytes: 40, encodedBytes: 90 },
    { endpoint: '/v2/sessions/read-batch', method: 'POST', startMs: 1, endMs: 2,
      requestBodyBytes: null, decodedBytes: null, encodedBodyBytes: null, encodedBytes: 0 },
  ];
  const network = summarizeNetwork(requests);
  assert.equal(network.routeClasses['session-list'], 1);
  assert.equal(network.routeClasses['session-read-batch'], 1);
  assert.equal(network.endpoints[0].requestBodyBytes, 12);
  assert.equal(network.endpoints[0].decodedBodyBytes, 400);
  assert.equal(network.endpoints[0].encodedBodyBytes, 40);
  assert.equal(network.endpoints[1].requestBodyBytes, null);
  const frame = (payload, opcode = 1) => ({ ...analysis.socketFrameClassification(payload, opcode),
    direction: 'received', bytes: Buffer.byteLength(payload) });
  const hint = '42["update",{"body":{"t":"new-message","delivery":"hint","message":{"id":"private"}}}]';
  const full = '42["update",{"body":{"t":"new-message","delivery":"full","message":{"content":"private"}}}]';
  const update = '42/admin,17["update",{"body":{"t":"update-session","metadata":"private"}}]';
  const frames = [frame(hint), frame(full), frame(update), frame('2'), frame('3'), frame('42["private",{}]')];
  const counts = analysis.transferCounts(network, frames);
  assert.equal(counts['transfer.http.POST.session-list.requests'], 1);
  assert.equal(counts['transfer.http.POST.session-list.requestBodyBytes'], 12);
  assert.equal(counts['transfer.http.POST.session-read-batch.requestBodyBytes'], null);
  assert.equal(counts['transfer.socket.received.update.new-message.hint.payloadBytes'], Buffer.byteLength(hint));
  assert.equal(counts['transfer.socket.received.update.new-message.full.payloadBytes'], Buffer.byteLength(full));
  assert.equal(counts['transfer.socket.received.update.update-session.unspecified.payloadBytes'], Buffer.byteLength(update));
  assert.equal(counts['transfer.socket.received.engine.ping.unspecified.frames'], 1);
  assert.equal(counts['transfer.socket.received.engine.pong.unspecified.frames'], 1);
  assert.equal(counts['transfer.socket.received.unknown.unknown.unspecified.frames'], 1);
  assert.ok(!JSON.stringify(counts).includes('private'));
  const run = counts => ({ journey: 'J13', cache: 'warm', uiMode: 'dev', counts });
  const comparison = compareRuns([run(counts)], [run(analysis.transferCounts(summarizeNetwork([]), []))])[0];
  assert.equal(comparison.counts['transfer.socket.received.update.new-message.full.payloadBytes'].after, 0);
  assert.equal(comparison.counts['transfer.http.POST.session-read-batch.requestBodyBytes'].delta, null);
  assert.equal(compareRuns([run({})], [run(counts)])[0].counts['transfer.http.POST.session-list.requests'].before, null);
});

test('frame classification projects fixed vocabulary across namespaces, ACKs, binary headers and unknown types', () => {
  assert.deepEqual(analysis.socketFrameClassification('42/ns,1["update",{"body":{"t":"private","delivery":"private"}}]', 1),
    { kind: 'event', event: 'update', type: 'unknown', delivery: 'unspecified' });
  assert.equal(analysis.socketFrameClassification('451-/ns,1["update",{"body":{"t":"message-updated","delivery":"hint"}}]', 1).type, 'message-updated');
  assert.equal(analysis.socketFrameClassification('42["update",{"body":{"t":"account-change","changeKinds":["session"]}}]', 1).type, 'account-change');
  assert.equal(analysis.socketFrameClassification('43/ns,12["private"]', 1).kind, 'ack');
  assert.equal(analysis.socketFrameClassification('42[broken', 1).event, 'unknown');
  assert.equal(analysis.socketFrameClassification('private', 2).event, 'binary');
  assert.equal(analysis.socketFrameClassification('', 9).type, 'ping');
});

test('network aggregation brackets starts and distinguishes failed, canceled, late and unfinished requests', () => {
  const request = (startMs, extra = {}) => ({ endpoint: 'https://qa.test/v2/sessions/active', method: 'GET', startMs, ...extra });
  const result = summarizeNetwork([
    request(99, { endMs: 110, encodedBytes: 1000 }),
    request(101, { endMs: 120, encodedBytes: 10 }),
    request(102, { endMs: 220, encodedBytes: 20 }),
    request(103, { endMs: 150, failed: true, canceled: true }),
    request(104, { endMs: 160, failed: true, canceled: false }),
    request(105), request(201, { endMs: 210, encodedBytes: 1000 }),
    { ...request(106, { endMs: 130 }), endpoint: 'https://qa.test/v2/sessions/metadata-upgrades' },
    { ...request(107, { endMs: 130 }), endpoint: 'https://qa.test/v2/sessions/01234567-89ab-cdef-0123-456789abcdef' },
  ], { startMs: 100, endMs: 200 });
  assert.equal(result.requests, 7);
  assert.deepEqual(result.dispositions, { completed: 3, failed: 1, canceled: 1, pendingAtEnd: 2, completedAfterWindow: 1 });
  assert.equal(result.encodedBytesCompletedWithinWindow, 10);
  assert.equal(result.encodedBytesObserved, 30);
  assert.equal(result.routeClasses['session-exact'], 1, 'fixed list routes must not be exact Session rows');
});
