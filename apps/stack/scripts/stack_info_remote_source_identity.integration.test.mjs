import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { runCommandCapture } from './testkit/core/run_node_capture.mjs';
import { readStackInfoSnapshot } from './stack/stack_info_snapshot.mjs';
import { resolveRemoteStackStatePaths } from './utils/dev_targets/remote_commands.mjs';
import { recordStackRuntimeStart, recordStackRuntimeUpdate } from './utils/stack/runtime_state.mjs';

const repoDir = fileURLToPath(new URL('../../../', import.meta.url));

test('stack info observes replacement source processes beyond a stale controller projection', {
  timeout: 30_000, skip: process.platform === 'win32',
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-info-source-replacement-' });
  const stackName = 'replacement';
  const storageDir = fixture.path('controller');
  const baseDir = join(storageDir, stackName);
  const target = { name: 'worker', platform: 'posix', ssh: 'fixture-ssh', repoDir,
    cliHomeDir: fixture.path('worker-home') };
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'source-snapshot' });
  const targetStatePath = join(paths.stackBaseDir, 'stack.runtime.json');
  const statePath = join(baseDir, 'stack.runtime.json');
  await mkdir(baseDir, { recursive: true });
  await mkdir(paths.stackBaseDir, { recursive: true });
  const stackEnv = 'HAPPIER_STACK_RUNTIME_MODE=source-snapshot\nHAPPIER_STACK_SERVE_UI=0\n';
  await writeFile(join(baseDir, 'env'), stackEnv);
  await writeFile(paths.stackEnvPath, stackEnv);
  await writeFile(join(baseDir, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [target] }));
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: storageDir });

  const source = `
    import { createServer } from 'node:http';
    import { randomUUID } from 'node:crypto';
    import { spawn } from 'node:child_process';
    import { mkdir, writeFile } from 'node:fs/promises';
    import { dirname, join } from 'node:path';
    import { resolvePreferredStackDaemonStatePaths } from ${JSON.stringify(new URL('./utils/auth/credentials_paths.mjs', import.meta.url).href)};
    import { applyStackDaemonLifecycleScopeEnv } from ${JSON.stringify(new URL('./utils/auth/stable_scope_id.mjs', import.meta.url).href)};
    import { recordStackRuntimeStart } from ${JSON.stringify(new URL('./utils/stack/runtime_state.mjs', import.meta.url).href)};
    const [statePath, cliHomeDir, identity, stackName, ownerPid] = process.argv.slice(1);
    const server = createServer((req, res) => {
      if (req.url === '/retire-fixture') {
        res.end();
        server.close(() => process.exit(0));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/ping' ? { ok: true, pid: process.pid } :
        { service: 'happier-server', status: 'ok', identity }));
    });
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const env = applyStackDaemonLifecycleScopeEnv({ env: process.env, stackName, cliIdentity: 'default' });
      const bundleDir = join(dirname(statePath), 'fixture-bundles', identity);
      const entrypoint = join(bundleDir, 'apps', 'server', 'sources', 'main.mjs');
      await mkdir(dirname(entrypoint), { recursive: true });
      await mkdir(join(dirname(statePath), 'source-runtime'), { recursive: true });
      await writeFile(entrypoint, 'export {};');
      await writeFile(join(bundleDir, 'source-bundle.json'), JSON.stringify({ identity, entrypoint,
        dbProvider: identity === 'incumbent' ? 'postgres' : 'mysql' }));
      await writeFile(join(dirname(statePath), 'source-runtime', 'selected-server.json'), JSON.stringify({ entrypoint }));
      const { statePath: daemonStatePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, env });
      await mkdir(dirname(daemonStatePath), { recursive: true });
      await writeFile(daemonStatePath, JSON.stringify({ pid: process.pid, httpPort: port, startedAt: Date.now(), controlToken: randomUUID() }));
      await recordStackRuntimeStart(statePath, { stackName, ownerPid: Number(ownerPid), sourceUi: 'disabled',
        processes: { serverPid: process.pid, daemonPid: process.pid }, ports: { server: port },
        sourceRuntimeIdentities: { server: { selected: identity, loaded: identity }, daemon: { selected: identity, loaded: identity } } });
      process.send({ port, pid: process.pid });
    });
    process.on('message', message => {
      if (!message.reload) { server.close(() => process.exit(0)); return; }
      const successor = spawn(process.execPath, [...process.execArgv,
        statePath, cliHomeDir, message.reload, stackName, ownerPid], {
        env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      successor.once('message', ready => {
        process.send(ready, () => {
          server.close(() => { successor.disconnect(); process.exit(0); });
        });
      });
      successor.once('exit', code => process.send({ error: 'successor_exit', code }));
    });
  `;
  const children = [];
  const successors = [];
  const stop = async child => {
    if (child.exitCode !== null) return;
    const ended = once(child, 'exit');
    child.send('retire-fixture');
    await ended;
  };
  t.after(async () => {
    for (const child of children) await stop(child);
    for (const port of successors) {
      const url = new URL('/retire-fixture', `http://127.0.0.1:${port}`);
      const response = await fetch(url);
      await response.arrayBuffer();
    }
  });
  const launch = async identity => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source,
      targetStatePath, paths.cliHomeDir, identity, stackName, String(process.pid)], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, HAPPIER_STACK_STORAGE_DIR: paths.stackStorageDir,
        HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_ENV_FILE: paths.stackEnvPath,
        HAPPIER_STACK_CLI_HOME_DIR: paths.cliHomeDir, HAPPIER_STACK_PROCESS_KIND: 'daemon' },
    });
    children.push(child);
    let diagnostic = '';
    child.stderr.on('data', chunk => { diagnostic += chunk; });
    const ready = await Promise.race([once(child, 'message').then(([value]) => value),
      once(child, 'exit').then(([code]) => { throw new Error(`fixture exited ${code}: ${diagnostic}`); })]);
    return { child, ...ready };
  };
  const incumbent = await launch('incumbent');
  // The process can publish its daemon control state before the wrapper's
  // membership projection catches up. An info probe must remain read-only.
  await recordStackRuntimeUpdate(targetStatePath, { processes: { daemonPid: null, daemonPids: [] } });
  const targetBefore = await readFile(targetStatePath, 'utf8');
  await recordStackRuntimeStart(statePath, { stackName, sourceUi: 'disabled',
    ports: { server: incumbent.port }, sourceRuntimeIdentities: {},
    placement: { server: target.name, daemon: target.name },
    remoteTargets: { [target.name]: { runtimeMode: 'source-snapshot', services: { server: true, daemon: true },
      status: 'retrying', phase: 'tunnel', serviceStatus: { server: 'retrying', daemon: 'retrying' },
      sourceRuntimeIdentities: { server: { selected: 'incumbent', loaded: 'incumbent' },
        daemon: { selected: 'incumbent', loaded: 'incumbent' } } } } });
  let probes = 0;
  let unavailable = false;
  // SSH is the only substituted boundary. Execute the production-generated
  // probe against real target files, process ownership and daemon HTTP.
  const runRemoteProcessImpl = async ({ args }) => {
    probes++;
    if (unavailable) return { code: 255, out: '', err: 'fixture transport unavailable' };
    const result = await runCommandCapture('bash', ['-c', args.at(-1)]);
    assert.equal(result.code, 0, result.stderr);
    return { code: result.code, out: result.stdout, err: result.stderr };
  };
  const observe = () => readStackInfoSnapshot({ rootDir: repoDir, stackName, runRemoteProcessImpl });
  const before = await observe();
  assert.equal(before.runtime.components.daemon.running, true);
  assert.equal(before.runtime.sourceRuntimeIdentities.daemon.loaded, 'incumbent');
  assert.equal(before.database.provider, 'postgres', 'loaded bundle overrides the configured SQLite default');
  assert.equal(before.database.basis, 'loaded-source-bundle');
  assert.equal(probes, 1, 'one live target probe covers both placed services');
  assert.equal(await readFile(targetStatePath, 'utf8'), targetBefore, 'target observation must not reconcile native state');

  const replaced = once(incumbent.child, 'message');
  const incumbentExited = once(incumbent.child, 'exit');
  incumbent.child.send({ reload: 'successor' });
  const [replacement] = await replaced;
  assert.equal(typeof replacement.port, 'number', JSON.stringify(replacement));
  successors.push(replacement.port);
  await incumbentExited;
  assert.notEqual(replacement.pid, incumbent.pid);
  // Only the forwarded endpoint changes. Identities and lifecycle remain stale.
  await recordStackRuntimeUpdate(statePath, { ports: { server: replacement.port } });
  const unchanged = await readFile(statePath, 'utf8');
  const after = await observe();
  assert.deepEqual(after.runtime.sourceRuntimeIdentities, {
    server: { selected: 'successor', loaded: 'successor' },
    daemon: { selected: 'successor', loaded: 'successor' },
  });
  assert.equal(after.runtime.components.daemon.running, true);
  assert.equal(after.database.provider, 'mysql', 'replacement observation must refresh database identity');
  assert.equal(after.database.basis, 'loaded-source-bundle');
  assert.equal(after.runtime.health.status, 'healthy');
  assert.equal(after.runtime.health.issues.includes('daemon_unknown'), false);
  assert.equal(probes, 2, 'each snapshot obtains fresh evidence once per target');
  assert.equal(await readFile(statePath, 'utf8'), unchanged, 'observation must not write a second identity cache');

  await recordStackRuntimeUpdate(targetStatePath, {
    sourceRuntimeIdentities: { daemon: { selected: 'next-selection', loaded: 'successor' } },
  });
  const preparing = await observe();
  assert.deepEqual(preparing.runtime.sourceRuntimeIdentities.daemon,
    { selected: 'next-selection', loaded: 'successor' }, 'selection alone must not attest a new loaded process');
  assert.ok(preparing.runtime.health.issues.includes('runtime_identity_pending'));
  assert.equal(probes, 3);

  unavailable = true;
  const lost = await observe();
  assert.equal(lost.runtime.components.daemon.status, 'unknown');
  assert.equal(lost.runtime.sourceRuntimeIdentities.daemon.loaded, null);
  assert.ok(lost.runtime.health.issues.includes('daemon_unknown'));
  assert.equal(lost.database.provider, null, 'an unreachable loaded runtime must not be presented as configured SQLite');
  assert.equal(lost.database.basis, 'unavailable');
  assert.equal(probes, 4, 'unavailable target gets one observation, no retry loop');

  await recordStackRuntimeUpdate(statePath, { remoteTargets: { [target.name]: {
    phase: 'stop', status: 'retirement-pending', serviceStatus: { server: 'failed', daemon: 'failed' },
  } } });
  const retiring = await observe();
  assert.ok(retiring.runtime.health.issues.includes('stop_cleanup_incomplete'));
  assert.equal(probes, 4, 'live observation must not override the stop owner or probe retired targets');
});
