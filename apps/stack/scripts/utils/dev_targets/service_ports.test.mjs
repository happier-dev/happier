// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { selectStackServicePortOnHost } from '../stack/runtime_ports.mjs';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { pickNextFreeTcpPort } from '../net/ports.mjs';
import { buildRemoteServicePortSelectionCommand } from './service_ports.mjs';

const repoDir = fileURLToPath(new URL('../../../../../', import.meta.url));

test('two Stacks selecting a service port on one host before either binds get different ports', { skip: process.platform === 'win32' }, async t => {
  // 2026-11-16 17:15Z: agent-qa-infra2-bed and agent-qa-uireq-bed both selected nl3:3018
  // within seconds; the second runner found the first one's server on it and failed.
  const fixture = await createTempFixture(t, { prefix: 'hstack-service-ports-' });
  const target = { name: 'host', platform: 'linux', repoDir, cliHomeDir: fixture.path('home') };
  const startPort = await pickNextFreeTcpPort(42000);
  const select = async stackName => {
    const command = buildRemoteServicePortSelectionCommand(target, { stackName, startPort, preferredServerPort: null });
    const { stdout } = await promisify(execFile)('bash', ['-c', command]);
    return JSON.parse(stdout).port;
  };
  const first = await select('stack-a');
  const second = await select('stack-b');
  assert.notEqual(second, first, 'a selected, not yet bound port belongs to its Stack');
  assert.equal(await select('stack-a'), first, 'a Stack keeps its own selection');
  assert.notEqual(second, startPort, "another Stack's canonical loopback port is never selected");
});

test("a Stack's canonical port wins over another Stack's earlier server selection, which moves on its next selection", { skip: process.platform === 'win32' }, async t => {
  // 2026-11-16 18:51Z: qa-release-now-1116's server took nl3:3018 before agent-qa-infra3-bed
  // (controller port 3018) had claimed it, so the bed's reverse forward could never bind.
  const fixture = await createTempFixture(t, { prefix: 'hstack-service-ports-canonical-' });
  const target = { name: 'host', platform: 'linux', repoDir, cliHomeDir: fixture.path('home') };
  const exec = async options => JSON.parse((await promisify(execFile)('bash', ['-c',
    buildRemoteServicePortSelectionCommand(target, options)])).stdout).port;
  const contested = await pickNextFreeTcpPort(43000);
  const early = await exec({ stackName: 'early', startPort: contested - 1, preferredServerPort: contested });
  assert.equal(early, contested, 'the earlier Stack first selected the contested port');
  await exec({ stackName: 'owner', startPort: contested, preferredServerPort: null });
  const moved = await exec({ stackName: 'early', startPort: contested - 1, preferredServerPort: contested });
  assert.notEqual(moved, contested, "the earlier Stack leaves the other Stack's canonical port");
});

for (const privatePort of [false, true]) {
  test(`retained host allocation survives inconclusive interface discovery after incumbent release (${privatePort ? 'private' : 'canonical'})`, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-retained-port-' });
    const options = { reservationDir: fixture.path('reservations'), stackName: 'restarting', startPort: 43100,
      ...(privatePort ? { reservedPorts: new Set([43100]) } : {}) };
    const port = await selectStackServicePortOnHost(options);
    const incumbent = createServer();
    incumbent.listen(port, '127.0.0.1');
    await once(incumbent, 'listening');
    await new Promise((resolve, reject) => incumbent.close(error => error ? reject(error) : resolve()));

    // The OS inventory is a genuine boundary: emulate the inconclusive observation
    // seen after #172b's confirmed stop without changing the selector or its probe.
    const inventory = t.mock.method(os, 'networkInterfaces', () => { throw new Error('inventory unavailable'); });
    syncBuiltinESMExports();
    t.after(() => { inventory.mock.restore(); syncBuiltinESMExports(); });
    const selected = await selectStackServicePortOnHost({ ...options, preferredServerPort: port });
    assert.equal(selected, port);
    const replacement = createServer();
    replacement.unref();
    t.after(() => { replacement.close(); });
    replacement.listen(selected, '127.0.0.1');
    await once(replacement, 'listening');
    assert.equal(replacement.address().port, port, 'the replacement binds the retained endpoint');
  });
}
