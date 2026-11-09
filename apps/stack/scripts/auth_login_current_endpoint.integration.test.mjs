import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildStackAuthLoginInvocation } from './utils/auth/stack_guided_login.mjs';
import { buildStackStableScopeId } from './utils/auth/stable_scope_id.mjs';
import { createAuthStackFixture, getStackRootFromMeta, terminateChildProcess } from './testkit/auth_testkit.mjs';
import { runCommandCapture } from './testkit/core/run_node_capture.mjs';

test('source stack login reaches its moved runtime port without rewriting the signed-out Home descriptor', async (t) => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const stackName = 'auth-port-move';
  const fixture = await createAuthStackFixture({ t, prefix: 'hstack-auth-move-', stackName });
  const cliHomeDir = join(fixture.storageDir, stackName, 'cli');
  await mkdir(cliHomeDir, { recursive: true });
  const oldOrigin = 'http://127.0.0.1:3020';
  const serverId = buildStackStableScopeId({ stackName });
  const settingsPath = join(cliHomeDir, 'settings.json');
  const settings = JSON.stringify({ schemaVersion: 6, activeServerId: serverId,
    servers: { [serverId]: { id: serverId, name: 'Retained Home', serverUrl: oldOrigin,
      webappUrl: oldOrigin, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
      homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_auth_port_move',
        canonicalServerUrl: oldOrigin, revision: 67, endpoints: [{ kind: 'https', url: oldOrigin }] } } } });
  await writeFile(settingsPath, settings);
  const env = fixture.buildEnv({ HAPPIER_STACK_RUNTIME_MODE: 'source', HAPPIER_STACK_RUNTIME_STATE_PATH: '',
    HAPPIER_HOME_DIR: cliHomeDir, HAPPIER_STACK_CLI_HOME_DIR: cliHomeDir, HAPPIER_ACTIVE_SERVER_ID: serverId,
    HAPPIER_STACK_ENV_FILE: fixture.envPath, HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_SERVER_PORT: '3020', HAPPIER_SERVER_URL: oldOrigin });
  // HTTP is the external boundary. A refused features read settles login before
  // enrollment while proving the real CLI selected the runtime's current port.
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    const server = createServer((request, response) => {
      if (request.url === '/v1/features') process.stdout.write('features\\n');
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{}');
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
  `], { env: { ...env, HAPPIER_STACK_PROCESS_KIND: 'server' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => terminateChildProcess(server));
  let observed = '';
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', chunk => { observed += chunk; });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', () => reject(new Error('fixture server exited before listening')));
    server.stdout.on('data', () => {
      const candidate = Number(observed.split('\n')[0]);
      if (candidate > 0) resolve(candidate);
    });
  });
  await writeFile(join(fixture.storageDir, stackName, 'stack.runtime.json'), JSON.stringify({
    version: 1, stackName, processes: { serverPid: server.pid }, ports: { server: port },
  }));
  const invocation = await buildStackAuthLoginInvocation({ rootDir, stackName, webappUrl: oldOrigin, env });
  const result = await runCommandCapture(invocation.command, invocation.args, { cwd: rootDir, env: invocation.env });
  assert.equal(result.code, 1, 'the signed-out HTTP refusal must settle without completing login');
  assert.ok(observed.includes('features'), 'the real CLI must reach features at the current runtime port');
  assert.equal(await readFile(settingsPath, 'utf8'), settings, 'signed-out recovery must preserve the retained Home descriptor');
});
