// @happier-test-preparation source
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildRemoteStackOperationCommand, resolveRemoteStackStatePaths } from '../dev_targets/remote_commands.mjs';
import { resolveServerReadyTimeoutMs } from './server.mjs';

const execFileAsync = promisify(execFile);

test('remote readiness loads retained shared-DB env and admits only its recorded Home transition', {
  skip: process.platform === 'win32' ? 'executes the POSIX remote command shell' : false,
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-readiness-probe-' });
  const stackName = 'probe-env';
  const target = { name: 'fixture', platform: 'posix', cliHomeDir: fixture.path('remote'),
    repoDir: fileURLToPath(new URL('../../../../../', import.meta.url)) };
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'source-snapshot' });
  const serverId = 'stack_probe-env__id_default';
  const ownIdentity = 'srv_stack_minted';
  let servedIdentity = 'srv_shared_source';
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
    if (req.headers.authorization !== 'Bearer synthetic-test-token') {
      res.statusCode = 401;
      return res.end('{}');
    }
    res.end(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: servedIdentity } },
      homeConnectionDescriptor: descriptor(servedIdentity) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const descriptor = identity => ({ v: 1, homeServerIdentityId: identity, revision: 2,
    canonicalServerUrl: url, endpoints: [{ kind: 'https', url }] });
  await mkdir(dirname(paths.stackEnvPath), { recursive: true });
  await writeFile(paths.stackEnvPath, `HAPPIER_STACK_SHARED_DB_SOURCE_STACK=repo-dev\nHAPPIER_STACK_REPO_DIR=${target.repoDir}\nHAPPIER_SERVER_LIGHT_DATA_DIR=${paths.serverLightDataDir}\n`);
  await mkdir(`${paths.serverLightDataDir}/runtime`, { recursive: true });
  await writeFile(`${paths.serverLightDataDir}/runtime/server.identity`, `${ownIdentity}\n`);
  await mkdir(`${paths.cliHomeDir}/servers/${serverId}`, { recursive: true });
  await writeFile(`${paths.cliHomeDir}/servers/${serverId}/access.key`, JSON.stringify({ token: 'synthetic-test-token' }));
  await writeFile(`${paths.cliHomeDir}/settings.json`, JSON.stringify({ schemaVersion: 6, activeServerId: serverId,
    servers: { [serverId]: { id: serverId, serverUrl: url, webappUrl: url,
      homeConnectionDescriptor: descriptor('srv_shared_source') } } }));
  const command = buildRemoteStackOperationCommand(target, { stackName, runtimeMode: 'source-snapshot',
    operation: 'server-readiness', passthrough: [url, String(resolveServerReadyTimeoutMs({ env: {} }))] });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('HAPPIER_')) delete env[key];
  await execFileAsync('/bin/bash', ['-c', command], { env });
  servedIdentity = ownIdentity;
  await execFileAsync('/bin/bash', ['-c', command], { env });
  servedIdentity = 'srv_foreign_home';
  await assert.rejects(execFileAsync('/bin/bash', ['-c', command], { env }), error => {
    assert.match(error.stderr, /Authenticated Home descriptor identity does not match the established Home/);
    return true;
  });
});
