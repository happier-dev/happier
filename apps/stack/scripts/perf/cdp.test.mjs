import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createCdpConnection } from '../../../ui/scripts/perf/agentBrowserUiPerfAudit.mjs';
import { startCapture } from './capture.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

test('the existing audit CDP transport delivers unsolicited events alongside request responses and rejects pending work on disconnect', async t => {
  const server = createServer();
  let ownedSocket;
  server.on('upgrade', (request, socket) => {
    ownedSocket = socket;
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', bytes => {
      if ((bytes[0] & 15) !== 1) return;
      const length = bytes[1] & 127;
      assert.ok(length < 126, 'fixture commands fit one short WebSocket frame');
      const mask = bytes.subarray(2, 6);
      const body = Buffer.from(bytes.subarray(6, 6 + length));
      for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
      const message = JSON.parse(body.toString());
      const send = value => { const data = Buffer.from(JSON.stringify(value)); socket.write(Buffer.concat([Buffer.from([129, data.length]), data])); };
      if (message.method === 'Runtime.enable') {
        send({ method: 'Network.loadingFinished', params: { requestId: 'one' } });
        send({ id: message.id, result: { enabled: true } });
      } else socket.destroy();
    });
  });
  t.after(() => { ownedSocket?.destroy(); server.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = await createCdpConnection(`ws://127.0.0.1:${server.address().port}/devtools/page/test`);
  t.after(() => client.close());
  const events = [];
  client.on('Network.loadingFinished', event => events.push(event.requestId));
  assert.deepEqual(await client.send('Runtime.enable'), { enabled: true });
  assert.deepEqual(events, ['one']);
  await assert.rejects(client.send('Profiler.start'), /closed|error/i);
  assert.equal((await client.disconnected)?.reason, 'closed', 'stream finalization must be able to settle on transport loss');
});

test('capture composes CDP events, safe network records, telemetry and mapped CPU output through the public collector', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-perf-profile-' });
  let ownedSocket;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([{ id: 'owned', type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/page` }]));
  });
  t.after(() => { ownedSocket?.destroy(); server.close(); });
  const epoch = Date.now();
  const rendererDelayMs = 15827;
  let rendererClockRequests = 0;
  const asyncDepthCommands = [];
  let traceCategories;
  const map = 'data:application/json;base64,' + Buffer.from(JSON.stringify({ version: 3, sources: ['src/Owner.ts'], names: ['realOwner'], mappings: 'AAAAA' })).toString('base64');
  server.on('upgrade', (request, socket) => {
    ownedSocket = socket;
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    const send = value => {
      const body = Buffer.from(JSON.stringify(value));
      const header = body.length < 126 ? Buffer.from([129, body.length]) : Buffer.from([129, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([header, body]));
    };
    socket.on('data', bytes => {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15;
        let length = buffered[1] & 127, offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        if (buffered.length < offset + 4 + length) return;
        const mask = buffered.subarray(offset, offset + 4), body = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
        buffered = buffered.subarray(offset + 4 + length);
        if (opcode !== 1) continue;
        for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
        const message = JSON.parse(body.toString());
        let result = {};
        if (message.method === 'Debugger.setAsyncCallStackDepth') asyncDepthCommands.push(message.params.maxDepth);
        if (message.method === 'Tracing.start') traceCategories = message.params.traceConfig.includedCategories;
        if (message.method === 'HeapProfiler.stopSampling') result.profile = { head: { callFrame: { scriptId: '1', url: 'http://app.test/bundle.js?key=never-save', functionName: 'a', lineNumber: 0, columnNumber: 0 }, selfSize: 2048, children: [] } };
        if (message.method === 'Tracing.end') {
          send({ method: 'Tracing.dataCollected', params: { value: [
            { name: 'happier-perf:start', ph: 'I', pid: 1, tid: 2, ts: 10000000, cat: 'blink.user_timing' },
            { name: 'RunTask', ph: 'X', pid: 1, tid: 2, ts: 10000000, dur: 10000 },
            { name: 'Layout', ph: 'X', pid: 1, tid: 2, ts: 10001000, dur: 1000, args: { data: { url: 'http://app.test/?token=never-save', payload: 'never-save' } } },
            { name: 'happier-perf:end', ph: 'I', pid: 1, tid: 2, ts: 10100000, cat: 'blink.user_timing' },
          ] } });
          send({ method: 'Tracing.tracingComplete', params: { dataLossOccurred: false } });
        }
        if (message.method === 'Debugger.getStackTrace') result.stackTrace = { description: 'never-save description',
          callFrames: [{ functionName: 'asyncOwner', url: 'http://app.test/issuer.js?token=never-save', lineNumber: 4, columnNumber: 2 }] };
        if (message.method === 'Debugger.enable') send({ method: 'Debugger.scriptParsed', params: { scriptId: '1', url: 'http://app.test/bundle.js', sourceMapURL: map } });
        if (message.method === 'Page.addScriptToEvaluateOnNewDocument') result.identifier = 'probe';
        if (message.method === 'Performance.getMetrics') result.metrics = [{ name: 'Timestamp', value: 10 }];
        // OS/CDP boundary simulation: the renderer clock is sampled 15.827s
        // later than Performance.Timestamp, without spending that wall time.
        if (message.method === 'Runtime.evaluate' && message.params.expression === 'Date.now()') rendererClockRequests++;
        if (message.method === 'Runtime.evaluate') result = { result: { value: message.params.expression === 'Date.now()' ? epoch + rendererDelayMs
          : message.params.expression === 'location.href' ? 'http://app.test/'
          : message.params.expression.includes("performance.mark('happier-perf:") ? { epochMs: epoch + (message.params.expression.includes('happier-perf:end') ? 100 : 0), startTime: message.params.expression.includes('happier-perf:end') ? 10100 : 10000, timeOrigin: epoch - 10000 }
          : message.params.expression.includes('.collect()') ? { commits: 2, renders: 3, components: {}, timeOrigin: epoch - 10000,
            longTasks: [{ atMs: 9900, durationMs: 60 }, { atMs: 10020, durationMs: 60 }, { atMs: 10101, durationMs: 60 }],
            renderers: [{ version: '19' }], telemetryAvailable: true,
            diagnostics: { scopedRpcSetupAvailable: true, timeOrigin: epoch - 10000, supportedEntryTypes: ['measure', 'long-animation-frame'], loafs: [], reactMeasures: [{name:'\u200bOwner',startTime:10000,duration:2,track:'Components ⚛'}], storeNotifications: [{atMs:epoch,changedKeys:['machines']}], socketEvents: [] },
            telemetry: { events: [{ name: 'sync.store.storage.notify', count: 2 }] } } : undefined } };
        if (message.method === 'Profiler.start') {
          // The simulated trace owns this clock; host setup delay must not move
          // its requests outside the fixed epoch..epoch+100 capture window.
          const timestamp = 10;
          send({ method: 'Network.requestWillBeSent', params: { requestId: 'socket-poll', wallTime: epoch / 1000, timestamp,
            request: { method: 'POST', url: 'http://app.test/v1/updates/?transport=polling&sid=never-save-connection',
              postData: '40' + JSON.stringify({ clientPurpose: 'sync', clientType: 'user-scoped', private: 'never-save' }) }, initiator: { type: 'script' } } });
          send({ method: 'Network.webSocketCreated', params: { requestId: 'upgrade', timestamp,
            url: 'ws://app.test/v1/updates/?transport=websocket&sid=never-save-connection' } });
          for (const [direction, payloadData] of [['Sent', '2probe'], ['Received', '3probe'], ['Sent', '5']]) {
            send({ method: `Network.webSocketFrame${direction}`, params: { requestId: 'upgrade', timestamp,
              response: { opcode: 1, payloadData } } });
          }
          for (const [direction, payloadData, delta] of [
            ['Received', '40{"sid":"never-save-namespace"}', .001],
            ['Sent', '42["rpc-register",{"method":"never-save"}]', .002],
            ['Sent', '42["rpc-call",{"params":"never-save"}]', .003],
            ['Sent', '41', .004],
          ]) send({ method: `Network.webSocketFrame${direction}`, params: { requestId: 'upgrade', timestamp: timestamp + delta,
            response: { opcode: 1, payloadData } } });
          send({ method: 'Network.webSocketClosed', params: { requestId: 'upgrade', timestamp: timestamp + .05 } });
          for (const [phase, delta] of [['acquire', 1], ['connect', 2], ['connected', 15]]) {
            send({ method: 'Runtime.bindingCalled', params: { name: '__happierPerfTelemetry', payload: JSON.stringify({
              scopedRpcSetup: { phase, connectionId: 7, timeOrigin: epoch - 10000, atMs: epoch + delta, origin: 'http://app.test',
                ...(phase === 'connected' ? { engineId: 'never-save-fallback' } : {}), private: 'never-save' },
            }) } });
          }
          for (const [requestId, delta, postData] of [
            ['scoped-admission', .01, '40' + JSON.stringify({ clientPurpose: 'scoped-rpc' })],
            ['scoped-poll', .04, undefined],
          ]) send({ method: 'Network.requestWillBeSent', params: { requestId, wallTime: epoch / 1000 + delta, timestamp: timestamp + delta,
            request: { method: postData ? 'POST' : 'GET', url: 'http://app.test/v1/updates/?transport=polling&sid=never-save-fallback', postData }, initiator: { type: 'script' } } });
          send({ method: 'Network.webSocketCreated', params: { requestId: 'failed-probe', timestamp: timestamp + .01,
            url: 'ws://app.test/v1/updates/?transport=websocket&sid=never-save-fallback' } });
          send({ method: 'Network.webSocketFrameError', params: { requestId: 'failed-probe', timestamp: timestamp + .02, errorMessage: 'never-save' } });
          send({ method: 'Network.webSocketClosed', params: { requestId: 'failed-probe', timestamp: timestamp + .03 } });
          send({ method: 'Network.requestWillBeSent', params: { requestId: 'session-admission', wallTime: epoch / 1000, timestamp,
            request: { method: 'POST', url: 'http://app.test/v1/updates/?transport=polling&sid=never-save-session',
              postData: '40' + JSON.stringify({ clientPurpose: 'sync', clientType: 'session-scoped', sessionId: 'never-save' }) }, initiator: { type: 'script' } } });
          send({ method: 'Network.requestWillBeSent', params: { requestId: 'machine-admission', wallTime: epoch / 1000, timestamp,
            request: { method: 'POST', url: 'http://app.test/v1/updates/?transport=polling&sid=never-save-machine',
              postData: '40' + JSON.stringify({ clientType: 'machine-scoped', machineId: 'never-save' }) }, initiator: { type: 'script' } } });
          // WebSocket-only connections have no sid in their URL. The real
          // Engine open packet is the only join to the producer's Engine id.
          send({ method: 'Network.webSocketCreated', params: { requestId: 'websocket-only', url: 'ws://app.test/v1/updates/?transport=websocket' } });
          for (const [direction, payloadData, delta] of [
            ['Received', '0{"sid":"never-save-websocket-only"}', .02],
            ['Sent', '40{"clientPurpose":"scoped-rpc","clientType":"user-scoped"}', .025],
            ['Received', '40{"sid":"never-save-namespace"}', .03],
            ['Sent', '42["rpc-call",{"params":"never-save"}]', .035],
          ]) send({ method: `Network.webSocketFrame${direction}`, params: { requestId: 'websocket-only', timestamp: timestamp + delta,
            response: { opcode: 1, payloadData } } });
          for (const [phase, delta] of [['acquire', 19], ['connect', 20], ['connected', 31]]) {
            send({ method: 'Runtime.bindingCalled', params: { name: '__happierPerfTelemetry', payload: JSON.stringify({
              scopedRpcSetup: { phase, connectionId: 8, timeOrigin: epoch - 10000, atMs: epoch + delta, origin: 'http://app.test',
                ...(phase === 'connected' ? { engineId: 'never-save-websocket-only' } : {}) },
            }) } });
          }
          send({ method: 'Network.webSocketClosed', params: { requestId: 'websocket-only', timestamp: timestamp + .04 } });
          send({ method: 'Network.webSocketCreated', params: { requestId: 'websocket-reconnected', url: 'ws://app.test/v1/updates/?transport=websocket' } });
          send({ method: 'Network.webSocketFrameReceived', params: { requestId: 'websocket-reconnected', timestamp: timestamp + .045,
            response: { opcode: 1, payloadData: '0{"sid":"never-save-reconnected"}' } } });
          for (const [direction, payloadData, delta] of [
            ['Sent', '40{"clientPurpose":"scoped-rpc","clientType":"user-scoped"}', .046],
            ['Received', '40{"sid":"never-save-namespace"}', .047],
          ]) send({ method: `Network.webSocketFrame${direction}`, params: { requestId: 'websocket-reconnected', timestamp: timestamp + delta,
            response: { opcode: 1, payloadData } } });
          for (const [phase, delta] of [['acquire', 41], ['connect', 42], ['connected', 48]]) {
            send({ method: 'Runtime.bindingCalled', params: { name: '__happierPerfTelemetry', payload: JSON.stringify({
              scopedRpcSetup: { phase, connectionId: 8, timeOrigin: epoch - 10000, atMs: epoch + delta, origin: 'http://app.test',
                ...(phase === 'connected' ? { engineId: 'never-save-reconnected' } : {}) },
            }) } });
          }
          for (const scopedRpcSetup of [
            { phase: 'acquire', connectionId: 7, timeOrigin: epoch - 10, atMs: epoch + 90, origin: 'http://app.test' },
            { phase: 'never-save', connectionId: 99, timeOrigin: epoch - 10, atMs: epoch + 91, origin: 'never-save' },
          ]) send({ method: 'Runtime.bindingCalled', params: { name: '__happierPerfTelemetry', payload: JSON.stringify({ scopedRpcSetup }) } });
          send({ method: 'Network.webSocketFrameReceived', params: { timestamp, response: { opcode: 1, payloadData: '42["before-native-pair",{}]' } } });
          send({ method: 'Network.requestWillBeSent', params: { requestId: 'n', wallTime: epoch / 1000, timestamp,
            request: { method: 'GET', url: 'http://app.test/v1/data?key=never-save' }, initiator: { type: 'script', stack: { callFrames: [],
              parent: { callFrames: [{ functionName: 'inlineScheduler', url: 'http://app.test/scheduler.js?token=never-save', lineNumber: 1, columnNumber: 0 }],
                parentId: { id: 'out-of-line', debuggerId: 'fixture' }, description: 'never-save description' } } } } });
          send({ method: 'Network.responseReceived', params: { requestId: 'n', timestamp, response: { status: 200, headers: { 'x-request-id': 'returned-id' },
            timing: { requestTime: timestamp, sendStart: 0, receiveHeadersStart: 0 } } } });
          send({ method: 'Network.dataReceived', params: { requestId: 'n', timestamp, dataLength: 20, encodedDataLength: 8 } });
          send({ method: 'Network.dataReceived', params: { requestId: 'n', timestamp, dataLength: 22, encodedDataLength: 9 } });
          send({ method: 'Network.loadingFinished', params: { requestId: 'n', timestamp, encodedDataLength: 25 } });
          for (const [requestId, delta] of [['canceled', 0], ['unknown-failure', 0], ['late', 0], ['outside', 1000]]) send({ method: 'Network.requestWillBeSent', params: {
            requestId, wallTime: epoch / 1000 + delta + (requestId === 'outside' ? .5 : 0), timestamp: timestamp + delta,
            request: { method: 'GET', url: 'http://app.test/v1/data' }, initiator: { type: 'script' } } });
          send({ method: 'Network.loadingFailed', params: { requestId: 'canceled', timestamp, canceled: true, errorText: 'net::ERR_ABORTED' } });
          send({ method: 'Network.loadingFailed', params: { requestId: 'unknown-failure', timestamp, errorText: 'never-save private URL or diagnostic' } });
          send({ method: 'Runtime.bindingCalled', params: { name: '__happierPerfTelemetry', payload: '{"events":[{"name":"sync.store.storage.notify","count":3}]}' } });
          send({ method: 'Runtime.bindingCalled', params: { name: '__happierPerfTelemetry', payload: '{"events":[{"name":"sync.store.storage.notify","count":3}]}' } });
          send({ method: 'Network.webSocketFrameReceived', params: { timestamp, response: { opcode: 1, payloadData: '42["update",{"body":{"t":"new-message","delivery":"hint"},"token":"never-save"}]' } } });
          send({ method: 'Network.webSocketFrameReceived', params: { timestamp, response: { opcode: 2, payloadData: Buffer.from([1, 2, 3, 4]).toString('base64') } } });
          send({ method: 'Network.webSocketFrameReceived', params: { timestamp, response: { opcode: 8, payloadData: Buffer.from([3, 232]).toString('base64') } } });
        }
        if (message.method === 'Profiler.stop') {
          send({ method: 'Network.dataReceived', params: { requestId: 'late', timestamp: 1010, dataLength: 91, encodedDataLength: 40 } });
          send({ method: 'Network.loadingFinished', params: { requestId: 'late', timestamp: 1010, encodedDataLength: 50 } });
          result.profile = { startTime: 10000000, endTime: 10100000,
          nodes: [{ id: 1, callFrame: { scriptId: '1', url: 'http://app.test/bundle.js', functionName: 'a', lineNumber: 0, columnNumber: 0 } }], samples: [1], timeDeltas: [100000] };
        }
        send({ id: message.id, result });
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const capture = await startCapture({ cdp: `http://127.0.0.1:${server.address().port}`, cache: 'warm', captureMode: 'counts', profiling: true, outputDir: fixture.root });
  try {
    await capture.begin();
    const result = await capture.finish();
    assert.deepEqual(result.sockets.slice(-2).map(row => row.bytes), [4, 2], 'all non-text CDP payloads use base64, including control messages');
    assert.equal(result.network.requests, 9);
    assert.equal(result.socketConnections.length, 6);
    const connection = result.socketConnections[0];
    assert.equal(connection.purpose, 'Account');
    assert.equal(connection.clientRole, 'user-scoped');
    assert.deepEqual(connection.transports, ['polling', 'websocket']);
    assert.equal(connection.upgradeOutcome, 'succeeded');
    assert.equal(connection.clientDisconnectObserved, true);
    assert.equal(connection.websocketLifetimeMs, 50);
    assert.equal(result.network.records.find(row => row.requestId === 'socket-poll').socketConnectionId, connection.id);
    assert.ok(result.sockets.filter(row => row.requestId === 'upgrade').every(row => row.socketConnectionId === connection.id));
    const fallback = result.socketConnections[1];
    assert.equal(fallback.purpose, 'scoped-RPC');
    assert.equal(fallback.upgradeOutcome, 'failed');
    assert.equal(fallback.closedMs, null, 'a failed WebSocket probe must not close its still-polling Engine.IO connection');
    assert.equal(result.network.records.find(row => row.requestId === 'scoped-poll').socketConnectionId, fallback.id);
    assert.equal(result.socketConnections[2].purpose, 'other', 'a Session sync socket must not be mislabeled as the Account connection');
    assert.equal(result.socketConnections[3].purpose, 'other');
    assert.equal(result.socketConnections[3].clientRole, 'machine-scoped', 'retain only the allowlisted role for clients without a purpose');
    assert.equal(result.socketSetup.producerAvailable, true);
    assert.deepEqual((result.socketSetup?.phases ?? []).filter(row => row.poolConnectionId === 'pool-1'), [
      { phase: 'acquire', atMs: epoch + 1, poolConnectionId: 'pool-1', socketConnectionId: fallback.id },
      { phase: 'connect', atMs: epoch + 2, poolConnectionId: 'pool-1', socketConnectionId: fallback.id },
      { phase: 'connected', atMs: epoch + 15, poolConnectionId: 'pool-1', socketConnectionId: fallback.id },
    ], 'producer phases join a later observed physical connection without retaining its private ids or payload');
    assert.deepEqual(result.socketSetup.phases.filter(row => row.socketConnectionId === connection.id).map(row => row.phase),
      ['upgrade', 'registered', 'rpc-register-sent', 'request-sent']);
    const websocketOnly = result.socketConnections[4];
    assert.equal(websocketOnly.purpose, 'scoped-RPC');
    assert.deepEqual(websocketOnly.transports, ['websocket']);
    assert.equal(websocketOnly.upgradeOutcome, 'not-applicable');
    assert.deepEqual(result.socketSetup.phases.filter(row => row.poolConnectionId === 'pool-2')
      .map(row => [row.phase, row.socketConnectionId]),
      [['acquire', null], ['connect', null], ['connected', websocketOnly.id],
        ['acquire', null], ['connect', null], ['connected', result.socketConnections[5].id]],
      'a reused logical socket keeps exact Engine joins; earlier ambiguous phases remain explicitly unjoined');
    assert.deepEqual(result.socketSetup.phases.filter(row => row.poolConnectionId === 'pool-3'), [
      { phase: 'acquire', atMs: epoch + 90, poolConnectionId: 'pool-3', socketConnectionId: null },
    ], 'a new document reusing a local ordinal cannot inherit an earlier document connection');
    assert.deepEqual(result.network.records.find(row => row.requestId === 'n').initiator.stack.map(frame => frame.functionName),
      ['inlineScheduler', 'asyncOwner'], 'inline and out-of-line async parents must use the same safe frame projection');
    assert.equal(asyncDepthCommands[0] > 0, true);
    assert.equal(result.network.records.find(row => row.requestId === 'n').startMs,
      result.network.records.find(row => row.requestId === 'n').nativeWallTime * 1000,
      'membership uses the native coherent wall clock, not a delayed renderer sample');
    assert.equal(result.clock.rendererRoundTripUsed, false);
    assert.equal(result.startMs, epoch, 'profiling brackets use the timestamp inside the trace marker, never delayed controller receipt');
    assert.equal(result.endMs, epoch + 100);
    assert.deepEqual(result.react.longTasks, [{ atMs: 10020, durationMs: 60 }],
      'setup and finalization tasks must not enter the measured-window count');
    assert.equal(rendererClockRequests, 0, 'a delayed renderer must never be the wall/monotonic clock source');
    assert.ok(result.clock.nativePairs.length >= 5);
    assert.equal(result.network.encodedBytes, 25);
    assert.equal(result.network.encodedBytesObserved, 75);
    assert.equal(result.network.records.find(row => row.requestId === 'n').encodedBodyBytes, 17);
    assert.equal(result.network.records.find(row => row.requestId === 'n').requestBodyBytes, 0);
    assert.equal(result.network.records.find(row => row.requestId === 'canceled').decodedBytes, null);
    assert.equal(result.sockets.find(row => row.event === 'update').type, 'new-message');
    assert.equal(result.sockets.find(row => row.event === 'update').delivery, 'hint');
    assert.equal(result.network.decodedBytes, 42, 'sum decoded chunks only for responses completed within the window');
    assert.equal(result.network.records.find(row => row.requestId === 'late').decodedBytes, 91);
    assert.equal(result.network.dispositions.canceled, 1);
    assert.equal(result.network.dispositions.completedAfterWindow, 1);
    assert.equal(result.network.records.find(row => row.requestId === 'canceled').failureCode, 'net::ERR_ABORTED');
    assert.equal(result.network.records.find(row => row.requestId === 'n').sendToHeadersMs, 0);
    assert.equal(result.network.records.find(row => row.requestId === 'n').ttfbBasis, 'response.timing.receiveHeadersStart');
    assert.equal(result.network.records.find(row => row.requestId === 'unknown-failure').canceled, null, 'missing cancellation flag is unknown, not false');
    assert.equal(result.network.records.find(row => row.requestId === 'unknown-failure').failureCode, 'unclassified');
    assert.equal(result.network.records.find(row => row.requestId === 'n').serverRequestId, 'returned-id');
    assert.equal(result.telemetry.reduce((sum, summary) => sum + summary.events[0].count, 0), 8);
    // These anonymous frames are the original clock-pair fixture; the named
    // connection vectors above independently verify transport/setup joins.
    assert.deepEqual(result.sockets.filter(row => row.requestId === undefined).map(row => row.event), ['unknown', 'update', 'binary', 'websocket'], 'buffer early sockets and do not shift them with a future native clock step');
    assert.equal(result.react.commits, 2);
    assert.equal(result.cpu.functions[0].name, 'realOwner');
    assert.equal(result.cpu.functions[0].source, 'src/Owner.ts');
    for (const category of ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing', 'disabled-by-default-v8.cpu_profiler']) assert.ok(traceCategories.includes(category));
    assert.equal(result.profiling.trace.dataLossOccurred, false);
    assert.equal(result.profiling.trace.summary.mainThreadBusyMs, 10);
    assert.equal(result.profiling.trace.summary.styleLayoutPaintMs, 1);
    assert.equal(result.profiling.heap.summary.sampledBytes, 2048);
    assert.ok(result.profiling.heap.summary.functions.some(row => row.source === 'src/Owner.ts'));
    const savedTrace = JSON.parse(gunzipSync(await readFile(fixture.path('trace.json.gz'))));
    assert.ok(savedTrace.traceEvents.some(event => event.name === 'Layout'));
    assert.ok(!JSON.stringify(savedTrace).includes('never-save'));
    assert.ok(!JSON.stringify(result).includes('never-save'));
  } finally { assert.equal((await capture.close()).asyncCallStackDepth, 0); }
  assert.equal(asyncDepthCommands.at(-1), 0);
});
