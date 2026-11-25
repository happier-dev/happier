import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';

import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { stopLocalDaemon } from './daemon.mjs';
import { spawnDetachedTestProcess } from './testkit/core/spawn_test_process.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { recordStackRuntimeStart } from './utils/stack/runtime_state.mjs';


for (const publication of ['env-discovery', 'state', 'all']) {
  test(`stopLocalDaemon logs supplying PID sources and identity (${publication})`, async (t) => {
    const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-log-sources-'));
    let daemonPid;
    let fingerprint;
    try {
      const cliHomeDir = join(tmp, 'cli-home');
      const internalServerUrl = 'http://127.0.0.1:3005';
      const stackName = 'log-sources-stop';
      const cliIdentity = 'log-source-identity';
      daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName,
        processKind: publication === 'state' ? '' : 'daemon' });
      fingerprint = readProcessInstanceFingerprintSync(daemonPid);
      assert.ok(fingerprint, 'fixture birth identity must be known before stop');
      const { statePath, lockPath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
      if (publication !== 'env-discovery') {
        await mkdir(dirname(statePath), { recursive: true });
        await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }));
      }
      const runtimeStatePath = join(tmp, 'stack.runtime.json');
      if (publication === 'all') {
        await writeFile(lockPath, String(daemonPid));
        await recordStackRuntimeStart(runtimeStatePath, { stackName, ownerPid: process.pid,
          processes: { daemonPid, daemonPids: [daemonPid] } });
      }
      const logs = [];
      t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
      await stopLocalDaemon({ cliBin: join(tmp, 'missing', 'happier.mjs'), cliHomeDir,
        internalServerUrl, stackName, cliIdentity, runtimeStatePath,
        env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });
      assert.throws(() => process.kill(daemonPid, 0), { code: 'ESRCH' });
      const line = logs.find(line => line.includes(`killed stuck daemon pid ${daemonPid} `));
      assert.ok(line, 'retirement must emit a kill attribution');
      const expectedSources = publication === 'all' ? 'state,lock,env-discovery,runtime-membership' : publication;
      assert.ok(line.includes(`sources=${expectedSources};`), `expected sources=${expectedSources}; got ${line}`);
      assert.ok(line.includes(`identity=${cliIdentity}`), `expected stopped identity; got ${line}`);
    } finally {
      t.mock.restoreAll();
      if (daemonPid && fingerprint && readProcessInstanceFingerprintSync(daemonPid) === fingerprint) {
        try { process.kill(daemonPid, 'SIGKILL'); } catch {}
      }
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

for (const liveness of ['retired', 'alive', 'inconclusive']) {
  test(`stopLocalDaemon with an unloadable source bundle requires proven PID absence (${liveness === 'alive' ? 'alive reused PID' : liveness})`, async (t) => {
    const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-unloadable-source-'));
    let daemonPid = null;
    try {
      const cliHomeDir = join(tmp, 'cli-home');
      const internalServerUrl = 'http://127.0.0.1:3005';
      const stackName = 'unloadable-source-stop';
      // A foreign owner must survive even if its PID remains in our old publication.
      daemonPid = await spawnDaemonLikeProcess({ cliHomeDir,
        internalServerUrl, stackName: liveness === 'alive' ? `${stackName}-peer` : stackName });
      const entrypoint = join(tmp, 'source-bundle.mjs');
      await writeFile(entrypoint, "import './dependency-no-longer-installed.mjs';\n");
      const runtimeStatePath = join(tmp, 'stack.runtime.json');
      await recordStackRuntimeStart(runtimeStatePath, { stackName, ownerPid: process.pid,
        sourceRuntimeLaunch: { entrypoint, cliDir: tmp, env: {} },
        processes: { daemonPid } });
      if (liveness === 'alive') {
        // Model a reused retained PID. Windows proves ownership by incarnation,
        // while POSIX can also reject the foreign stack's environment markers.
        const retained = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
        retained.processInstances = { ...retained.processInstances,
          processes: { ...retained.processInstances?.processes,
            daemonPid: { pid: daemonPid, fingerprint: 'different-process-incarnation' } } };
        await writeFile(runtimeStatePath, JSON.stringify(retained));
      }
      const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }));
      // Only the OS signal boundary is replaced; all lifecycle and identity logic stays real.
      const kill = process.kill.bind(process);
      if (liveness === 'inconclusive') {
        t.mock.method(process, 'kill', (pid, signal) => {
          if (pid === daemonPid && signal === 0) throw Object.assign(new Error('signal probe unavailable'), { code: 'EIO' });
          return kill(pid, signal);
        });
      }
      const stop = () => stopLocalDaemon({ cliBin: entrypoint, cliHomeDir, internalServerUrl,
        runtimeStatePath, stackName,
        env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });
      if (liveness === 'alive') {
        await stop();
        assert.doesNotThrow(() => kill(daemonPid, 0), 'a replacement process survives retirement of the recorded daemon');
      } else if (liveness === 'retired') {
        await stop();
        assert.throws(() => kill(daemonPid, 0), { code: 'ESRCH' });
        daemonPid = null;
      } else {
        await assert.rejects(stop, { code: 'daemon_stop_incomplete', reason: 'daemon_liveness_inconclusive' });
        assert.doesNotThrow(() => kill(daemonPid, 0));
      }
    } finally {
      t.mock.restoreAll();
      if (daemonPid) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} }
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

test('stopLocalDaemon retires unpublished starting generations only for the exact stack home', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-unpublished-daemon-'));
  const pids = [];
  try {
    const cliHomeDir = join(tmp, 'cli-home');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const stackName = 'unpublished-stop';
    const own = { cliHomeDir, internalServerUrl, stackName };
    pids.push(await spawnDaemonLikeProcess(own));
    pids.push(await spawnDaemonLikeProcess({ ...own, internalServerUrl: 'http://127.0.0.1:3006' }));
    pids.push(await spawnDaemonLikeProcess({ ...own, stackName: `${stackName}-peer` }));
    pids.push(await spawnDaemonLikeProcess({ ...own, cliHomeDir: `${cliHomeDir}-peer` }));
    pids.push(await spawnDaemonLikeProcess({ ...own, processKind: 'session' }));

    await stopLocalDaemon({ cliBin: join(tmp, 'missing', 'happier.mjs'), cliHomeDir,
      internalServerUrl, stackName, expectedPid: pids[0],
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });
    for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0), 'guarded old-owner shutdown must not sweep an unpublished successor');

    await stopLocalDaemon({ cliBin: join(tmp, 'missing', 'happier.mjs'), cliHomeDir,
      internalServerUrl, stackName,
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });

    for (const pid of pids.slice(0, 2)) assert.throws(() => process.kill(pid, 0), 'unpublished daemon generations must retire');
    for (const pid of pids.slice(2)) assert.doesNotThrow(() => process.kill(pid, 0), 'other stacks, sibling homes and sessions must survive');
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon retires the recorded source bundle owner even when CLI stop removes its publication', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-source-owner-'));
  let daemonPid = null;
  try {
    const cliHomeDir = join(tmp, 'cli-home');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const stackName = 'source-owner-stop';
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
    daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }));
    const oldEntrypoint = join(tmp, 'bundle-old.mjs');
    const newEntrypoint = join(tmp, 'bundle-new.mjs');
    const markerPath = join(tmp, 'old-owner-stop');
    await writeFile(oldEntrypoint, `import { unlinkSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerPath)}, 'old');\nunlinkSync(${JSON.stringify(statePath)});\n`);
    await writeFile(newEntrypoint, 'process.exit(0);\n');
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, { stackName, ownerPid: process.pid,
      sourceRuntimeLaunch: { entrypoint: oldEntrypoint, cliDir: tmp, env: {} },
      processes: { daemonPid, daemonPids: [daemonPid] } });

    await stopLocalDaemon({ cliBin: newEntrypoint, cliEntrypoint: newEntrypoint, cliHomeDir,
      internalServerUrl, runtimeStatePath, stackName,
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });

    assert.equal(existsSync(markerPath), true, 'retirement must use the retained source CLI launch');
    assert.throws(() => process.kill(daemonPid, 0), 'retirement must not forget a PID when its publication disappears');
    daemonPid = null;
  } finally {
    if (daemonPid) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon remembers the scoped owner before a stop command removes daemon state', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-source-publication-'));
  let daemonPid = null;
  try {
    const cliHomeDir = join(tmp, 'cli-home');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const stackName = 'source-publication-stop';
    daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName });
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }));
    const cliEntrypoint = join(tmp, 'stop.mjs');
    await writeFile(cliEntrypoint, `import { unlinkSync } from 'node:fs';\nunlinkSync(${JSON.stringify(statePath)});\n`);
    await stopLocalDaemon({ cliBin: cliEntrypoint, cliEntrypoint, cliHomeDir, internalServerUrl, stackName,
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });
    assert.throws(() => process.kill(daemonPid, 0), 'disappearing publication is not proof of process retirement');
    daemonPid = null;
  } finally {
    if (daemonPid) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon retires retained bundle PIDs only for its CLI home without requiring moving CLI dist', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-source-pid-set-'));
  const pids = [];
  try {
    const cliHomeDir = join(tmp, 'cli-home');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const stackName = 'source-pid-set-stop';
    // Legacy retained daemons may lack the current process-kind discovery marker.
    pids.push(await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName, processKind: '' }));
    pids.push(await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName, processKind: '' }));
    pids.push(await spawnDaemonLikeProcess({ cliHomeDir: join(tmp, 'cli-identities', 'account-b'),
      stackCliHomeDir: cliHomeDir, internalServerUrl, stackName, processKind: '' }));
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, { stackName, ownerPid: process.pid,
      processes: { daemonPid: pids[2], daemonPids: pids } });
    await stopLocalDaemon({ cliBin: join(tmp, 'missing', 'happier.mjs'), cliHomeDir,
      internalServerUrl, runtimeStatePath, stackName,
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });
    for (const pid of pids.slice(0, 2)) assert.throws(() => process.kill(pid, 0), `retained bundle PID ${pid} must be retired`);
    assert.doesNotThrow(() => process.kill(pids[2], 0), 'another identity must survive even when it is the latest runtime PID');
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(tmp, { recursive: true, force: true });
  }
});

async function writeStubHappyCli({ cliDir }) {
  const script = `
import { writeFileSync } from 'node:fs';

const markerPath = process.env.MARKER_PATH || '';
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'stop') {
  if (markerPath) {
    writeFileSync(markerPath, 'stopped\\n', 'utf8');
  }
  process.exit(0);
}
process.exit(0);
`.trimStart();
  const monoRoot = join(cliDir, '..', '..');
  const { cliBinDir } = await writeStubHappierCliFiles(monoRoot, {
    packageJsonContent: '{}\n',
    distIndexScript: script,
    // Ensure stopLocalDaemon launches via dist entrypoint (preferred).
    binHappierScript: 'process.exit(0);\n',
  });
  return join(cliBinDir, 'happier.mjs');
}

async function spawnDaemonLikeProcess({ cliHomeDir, stackCliHomeDir = cliHomeDir, internalServerUrl, stackName = '', processKind = 'daemon', envPath = process.env.HAPPIER_STACK_ENV_FILE }) {
  const logDir = join(cliHomeDir, 'logs');
  await mkdir(logDir, { recursive: true });
  const ownedLogPath = join(logDir, 'daemon-owned.log');
  const child = spawnDetachedTestProcess(
    process.execPath,
    [
      '-e',
      "const fs = require('node:fs'); const p = process.env.DAEMON_OWNED_LOG_PATH || ''; if (!p) process.exit(2); const fd = fs.openSync(p, 'a'); fs.writeSync(fd, 'ready\\n'); if (process.send) { process.send('ready'); process.disconnect(); } setInterval(() => {}, 1000);",
      'daemon',
      'start-sync',
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        DAEMON_OWNED_LOG_PATH: ownedLogPath,
        HAPPIER_STACK_ENV_FILE: envPath,
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_STACK_CLI_HOME_DIR: stackCliHomeDir,
        ...(stackName ? { HAPPIER_STACK_STACK: stackName } : {}),
        HAPPIER_STACK_PROCESS_KIND: processKind,
        HAPPIER_SERVER_URL: internalServerUrl,
      },
    },
  );
  await once(child, 'message');
  return child.pid;
}

test('stopLocalDaemon skips stop when expectedPid does not match current daemon state pid', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-expected-pid-'));
  let daemonPid = null;
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const markerPath = join(tmp, 'marker.txt');
    const cliBin = await writeStubHappyCli({ cliDir });
    const stackName = 'expected-pid-stop';
    const daemonEnv = {
      ...process.env,
      // This fixture owns its CLI checkout; do not inherit the unit runner's real repo override.
      HAPPIER_STACK_REPO_DIR: '',
      HAPPIER_STACK_STACK: stackName,
      MARKER_PATH: markerPath,
    };

    const internalServerUrl = 'http://127.0.0.1:3005';
    daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName });
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }) + '\n', 'utf-8');

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      stackName,
      expectedPid: process.pid,
      env: daemonEnv,
    });
    assert.equal(existsSync(markerPath), false);
    assert.doesNotThrow(() => process.kill(daemonPid, 0));

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      stackName,
      expectedPid: daemonPid,
      env: daemonEnv,
    });
    assert.equal(existsSync(markerPath), true);
    assert.throws(() => process.kill(daemonPid, 0), { code: 'ESRCH' });
    daemonPid = null;
  } finally {
    if (daemonPid) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon does not launch moving or retained source CLI when the scoped daemon is already stopped', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-already-stopped-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const markerPath = join(tmp, 'marker.txt');
    const cliBin = await writeStubHappyCli({ cliDir });

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl: 'http://127.0.0.1:3005',
      env: {
        ...process.env,
        HAPPIER_STACK_REPO_DIR: '',
        MARKER_PATH: markerPath,
      },
    });

    assert.equal(existsSync(markerPath), false);
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, { stackName: 'already-stopped', ownerPid: process.pid,
      sourceRuntimeLaunch: { entrypoint: join(cliDir, 'dist', 'index.mjs'), cliDir, env: { MARKER_PATH: markerPath } } });
    await stopLocalDaemon({ cliBin, cliHomeDir, internalServerUrl: 'http://127.0.0.1:3005',
      runtimeStatePath, env: { ...process.env, HAPPIER_STACK_REPO_DIR: '' } });
    assert.equal(existsSync(markerPath), false, 'a retained source launch alone is not a live daemon');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon stops a live daemon from daemon.state.json when cli dist is missing', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-missing-dist-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const stackName = 'daemon-stop-test';

    await mkdir(join(cliDir, 'bin'), { recursive: true });
    await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(cliBin), "throw new Error('cli bin should not run when dist is missing');\n", 'utf-8');

    const daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName });
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName,
      ownerPid: process.pid,
      processes: { daemonPid, daemonPids: [daemonPid] },
    });
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }) + '\n', 'utf-8');

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      runtimeStatePath,
      stackName,
      env: { ...process.env, HAPPIER_STACK_STACK: stackName },
    });

    let alive = true;
    try {
      process.kill(daemonPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `expected daemon pid ${daemonPid} to be stopped`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('stopLocalDaemon delegates legacy POSIX state without persisted identity to canonical ownership', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-legacy-owner-'));
  let daemonPid = null;
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const cliBin = join(cliDir, 'bin', 'happier.mjs');
    const internalServerUrl = 'http://127.0.0.1:3005';
    const stackName = 'daemon-legacy-owner-test';

    await mkdir(join(cliDir, 'bin'), { recursive: true });
    await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');
    await writeFile(cliBin, "throw new Error('cli bin should not run when dist is missing');\n", 'utf-8');

    daemonPid = await spawnDaemonLikeProcess({ cliHomeDir, internalServerUrl, stackName });
    const runtimeStatePath = join(tmp, 'stack.runtime.json');
    await writeFile(
      runtimeStatePath,
      JSON.stringify({
        version: 1,
        stackName,
        ownerPid: process.pid,
        processes: { daemonPid },
      }) + '\n',
      'utf-8',
    );
    const { statePath } = resolvePreferredStackDaemonStatePaths({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env: {},
    });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: daemonPid, httpPort: 0 }) + '\n', 'utf-8');

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      runtimeStatePath,
      stackName,
      env: process.env,
    });

    assert.throws(() => process.kill(daemonPid, 0));
    daemonPid = null;
  } finally {
    if (daemonPid) {
      try {
        process.kill(daemonPid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
    await rm(tmp, { recursive: true, force: true });
  }
});


// A recycled numeric PID is constructed at the publication boundary; both
// incarnations are real processes. No OS PID allocator or shared process is changed.
for (const scenario of ['same-stack-no-fingerprint', 'other-stack-no-fingerprint', 'same-stack-old-fingerprint']) {
  test(`identity stop skips a stale recorded foreign PID (${scenario})`, async (t) => {
    const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-foreign-1125-'));
    const live = new Map();
    const spawnOwned = async (options) => {
      const pid = await spawnDaemonLikeProcess({ ...options, envPath: join(tmp, 'shared.env') });
      const birth = readProcessInstanceFingerprintSync(pid);
      assert.ok(birth);
      live.set(pid, birth);
      return pid;
    };
    try {
      const cliHomeDir = join(tmp, 'identity-a');
      const internalServerUrl = 'http://127.0.0.1:3005';
      const stackName = 'stop-foreign-1125';
      const envPath = join(tmp, 'shared.env');
      // All fixture processes inherit the same stack env-file marker.

      const old = await spawnOwned({ cliHomeDir, internalServerUrl, stackName });
      const oldBirth = live.get(old);
      assert.equal(readProcessInstanceFingerprintSync(old), oldBirth);
      process.kill(old, 'SIGTERM');
      // wait for the actual old child to be reaped before constructing the stale publication
      while (readProcessInstanceFingerprintSync(old) === oldBirth) await new Promise(r => setTimeout(r, 10));
      live.delete(old);
      const foreign = await spawnOwned({ cliHomeDir: join(tmp, 'identity-b'), internalServerUrl,
        stackName: scenario.startsWith('other-stack') ? 'other-stack' : stackName });
      const { statePath, lockPath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, JSON.stringify({ pid: foreign, httpPort: 0 }));
      await writeFile(lockPath, scenario.endsWith('old-fingerprint') ? JSON.stringify({
        t: 'happier_daemon_lock_v2', pid: foreign, ownerToken: '11111111-1111-1111-1111-111111111111',
        processStartedAtMs: 1, createdAtMs: 1, processInstanceFingerprint: oldBirth,
      }) : String(foreign));
      const logs = [];
      t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
      await stopLocalDaemon({ cliBin: join(tmp, 'missing.mjs'), cliHomeDir, internalServerUrl,
        stackName, cliIdentity: 'identity-a', env: { ...process.env, HAPPIER_STACK_REPO_DIR: '',
          HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_ENV_FILE: envPath } });
      assert.equal(readProcessInstanceFingerprintSync(foreign), live.get(foreign), 'foreign incarnation must survive identity stop');
      if (!scenario.endsWith('old-fingerprint')) {
        assert.ok(logs.some(line => line.includes(`skipped pid ${foreign}`) && line.includes('sources=state,lock;')),
          'skip must identify the retained PID sources');
      }
    } finally {
      t.mock.restoreAll();
      for (const [pid, birth] of live) {
        if (readProcessInstanceFingerprintSync(pid) === birth) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

test('identity stop discovers a live inherited child before CLI stop changes its effective home', { skip: process.platform === 'win32' }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-child-1125-'));
  const births = new Map();
  try {
    const cliHomeDir = join(tmp, 'identity-a');
    const stackName = 'stop-child-1125';
    const internalServerUrl = 'http://127.0.0.1:3005';
    const release = join(tmp, 'release');
    const changed = join(tmp, 'changed');
    const childScript = `const fs = require('node:fs'); process.send('ready'); process.disconnect();
      const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return;
      clearInterval(timer); process.execve(process.execPath, [process.execPath, '-e',
        ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(changed)}, 'ready'); setInterval(() => {}, 1000);`)}],
        { ...process.env, HAPPIER_HOME_DIR: ${JSON.stringify(join(tmp, 'identity-b'))}, HAPPIER_STACK_STACK: 'other-stack' }); }, 10);`;
    const parent = spawnDetachedTestProcess(process.execPath, ['-e', `
      const { fork } = require('node:child_process');
      const child = fork('-e', [${JSON.stringify(childScript)}], { detached: true, stdio: ['ignore','ignore','ignore','ipc'] });
      child.once('message', () => { process.send(child.pid); process.disconnect(); });
      setInterval(() => {}, 1000);`], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, HAPPIER_HOME_DIR: cliHomeDir, HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_PROCESS_KIND: 'daemon' },
    });
    const [childPid] = await once(parent, 'message');
    for (const pid of [parent.pid, childPid]) {
      const birth = readProcessInstanceFingerprintSync(pid); assert.ok(birth); births.set(pid, birth);
    }
    const cliEntrypoint = join(tmp, 'stop.mjs');
    await writeFile(cliEntrypoint, `import { writeFileSync, existsSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      writeFileSync(${JSON.stringify(release)}, 'go');
      while (!existsSync(${JSON.stringify(changed)})) await setTimeout(10);`);
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    await stopLocalDaemon({ cliBin: cliEntrypoint, cliEntrypoint, cliHomeDir, internalServerUrl,
      stackName, cliIdentity: 'identity-a', env: { ...process.env, HAPPIER_STACK_REPO_DIR: '', HAPPIER_STACK_STACK: stackName } });
    assert.equal(readProcessInstanceFingerprintSync(childPid), births.get(childPid), 'exec child survives with changed identity');
    assert.ok(logs.some(line => line.includes(`skipped pid ${childPid}`) && line.includes('sources=env-discovery;')));
    assert.throws(() => process.kill(parent.pid, 0), { code: 'ESRCH' });
  } finally {
    t.mock.restoreAll();
    for (const [pid, birth] of births) {
      if (readProcessInstanceFingerprintSync(pid) === birth) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test('identity stop ownership cannot use a Windows birth fingerprint as effective-home proof', async () => {
  const { killPidOwnedByStack, resolvePidStackOwnership } = await import('./utils/proc/ownership.mjs');
  let signalled = false;
  const result = await killPidOwnedByStack(424242, {
    stackName: 'stack', cliHomeDir: 'C:\\identity-a', platform: 'win32', json: true,
    processInstanceFingerprint: 'birth',
    observePidLivenessImpl: () => ({ status: 'alive' }),
    readProcessInstanceFingerprintSyncImpl: () => 'birth',
    // OS environment observation is unsupported on Windows, so identity cannot be proved.
    resolvePidStackOwnershipImpl: (pid, context) => resolvePidStackOwnership(pid, context, { platform: 'win32' }),
    terminateProcessPidImpl: async () => { signalled = true; return { ok: true }; },
  });
  assert.equal(signalled, false);
  assert.equal(result.killed, false);
});
