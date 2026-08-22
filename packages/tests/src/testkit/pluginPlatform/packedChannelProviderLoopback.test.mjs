import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  startPackedChannelProviderLoopback,
} from '../../plugin-platform/packedChannelProviderLoopback.mjs';

test('serves the archive-bound Channel protocol over a CA-backed TLS loopback socket', async (context) => {
  const loopback = await startPackedChannelProviderLoopback();
  context.after(async () => await loopback.stop());

  assert.match(loopback.origin, /^https:\/\/127\.0\.0\.1:\d+$/u);
  assert.equal(
    loopback.socketUrl,
    `${loopback.origin.replace('https:', 'wss:')}/socket`,
  );

  const socket = new WebSocket(loopback.socketUrl, ['channels-fixture-v1'], {
    ca: await readFile(loopback.caCertificatePath),
  });
  context.after(() => socket.terminate());
  await once(socket, 'open');
  socket.send(JSON.stringify({ kind: 'subscribe', connectionId: 'connection-1' }));
  await loopback.waitForObserverSocketCount(
    1,
    'native loopback observer subscription',
  );

  loopback.sendObservation();
  const [observation] = await once(socket, 'message');
  const observationFrame = JSON.parse(observation.toString('utf8'));
  assert.equal(observationFrame.kind, 'observation');
  assert.equal(observationFrame.observation.v, 1);
  assert.match(observationFrame.observation.providerMessageId, /^fixture-message-/u);
  assert.deepEqual(observationFrame.observation.endpoint, {
    kind: 'direct',
    audience: 'direct',
    id: 'fixture:room',
    label: 'Fixture room',
  });
  assert.deepEqual(observationFrame.observation.sender, {
    id: 'fixture:human',
    kind: 'human',
    label: 'Fixture human',
  });
  assert.equal(observationFrame.observation.text, 'fixture loopback observation');
  assert.equal(Number.isSafeInteger(observationFrame.observation.observedAt), true);

  loopback.sendHistoryGap();
  const [historyGap] = await once(socket, 'message');
  assert.deepEqual(JSON.parse(historyGap.toString('utf8')), {
    kind: 'historyGap',
  });
  assert.deepEqual(loopback.receivedFrameKinds(), ['subscribe']);
});
