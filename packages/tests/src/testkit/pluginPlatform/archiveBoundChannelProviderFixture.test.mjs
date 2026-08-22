import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createArchiveBoundPackedChannelProviderFixture,
} from '../../plugin-platform/archiveBoundChannelProviderFixture.mjs';

test('binds the packed Channel fixture source and manifest to one private TLS loopback origin', async () => {
  const source = await readFile(new URL(
    '../../../fixtures/plugin-platform/out-of-tree-channel-socket-provider/src/index.mjs',
    import.meta.url,
  ), 'utf8');
  const manifest = JSON.parse(await readFile(
    new URL(
      '../../../fixtures/plugin-platform/out-of-tree-channel-socket-provider/.happier-plugin/plugin.json',
      import.meta.url,
    ),
    'utf8',
  ));
  const origin = 'https://127.0.0.1:43123';

  const staged = createArchiveBoundPackedChannelProviderFixture({
    source,
    manifest,
    origin,
    strictResultSentinel: 'fixture-strict-result-sentinel',
  });

  assert.match(
    staged.source,
    /const FIXTURE_ORIGIN = 'https:\/\/127\.0\.0\.1:43123';/u,
  );
  assert.match(staged.source, /privateNetwork: true,/u);
  assert.match(
    staged.source,
    /if \(input\.pairingCode === ["']fixture-strict-result-sentinel["']\) return \{\};/u,
  );
  assert.doesNotMatch(staged.source, /channels-fixture\.invalid/u);
  assert.deepEqual(staged.manifest.hostAccess.required, [{
    id: 'fixture-network-client',
    reason: 'Receive deterministic socket frames through the host-vended WebSocket client.',
    capability: 'network.client',
    scope: {
      targets: [{ kind: 'fixedOrigin', origin }],
      transports: ['websocket'],
      privateNetwork: true,
    },
  }]);
  assert.doesNotMatch(JSON.stringify(staged.manifest), /channels-fixture\.invalid/u);
  assert.match(source, /channels-fixture\.invalid/u);
});
