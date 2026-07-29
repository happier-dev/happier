import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireRuntimeBuildLock } from './runtime_build_lock.mjs';
import { spawnTestProcess } from '../testkit/core/spawn_test_process.mjs';

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid, { timeoutMs = 5_000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMs);
  }
  return !isPidAlive(pid);
}

async function terminateChildProcessAndWait(child, { timeoutMs = 5_000 } = {}) {
  const pid = Number(child?.pid);
  if (!Number.isFinite(pid) || pid <= 1) return;
  if (!isPidAlive(pid)) return;

  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  if (await waitForPidExit(pid, { timeoutMs: Math.floor(timeoutMs / 2), pollMs: 25 })) return;

  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }
  const exited = await waitForPidExit(pid, { timeoutMs: Math.floor(timeoutMs / 2), pollMs: 25 });
  assert.equal(exited, true, `expected child pid ${pid} to exit after termination`);
}

test('acquireRuntimeBuildLock replaces a stale dead-pid lock', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-stale-'));
  const lockPath = join(runtimeDir, 'build.lock');

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  await writeFile(lockPath, JSON.stringify({ pid: 999999, createdAt: '2026-03-07T00:00:00.000Z' }) + '\n', 'utf-8');

  const release = await acquireRuntimeBuildLock({ lockPath });
  const raw = await readFile(lockPath, 'utf-8');
  const json = JSON.parse(raw);

  assert.equal(json.pid, process.pid);
  assert.ok(typeof json.createdAt === 'string' && json.createdAt.length > 0);
  assert.ok(typeof json.token === 'string' && json.token.length > 0);
  assert.ok(typeof json.processInstanceFingerprint === 'string' && json.processInstanceFingerprint.length > 0);

  await release();
});

test('acquireRuntimeBuildLock retires multiple proven-dead retained locks before acquiring', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-retained-history-'));
  const lockPath = join(runtimeDir, 'build.lock');

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  for (const [suffix, pid] of [['history-a', 2_147_483_000], ['history-b', 2_147_483_001]]) {
    await writeFile(
      `${lockPath}.reclaim-${suffix}`,
      JSON.stringify({ pid, createdAt: '2026-07-11T00:00:00.000Z' }) + '\n',
      'utf8',
    );
  }

  const release = await acquireRuntimeBuildLock({
    lockPath,
    observePidLivenessImpl: () => ({ status: 'dead', reason: 'missing' }),
  });

  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
  assert.deepEqual(
    (await readdir(runtimeDir)).filter((name) => name.startsWith('build.lock.reclaim-')),
    [],
  );
  await release();
});

test('acquireRuntimeBuildLock retires stale history and restores one inconclusive retained owner', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-retained-owner-'));
  const lockPath = join(runtimeDir, 'build.lock');

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const staleOwners = [
    { pid: 2_147_483_000, createdAt: '2026-07-11T00:00:00.000Z' },
    { pid: 2_147_483_001, createdAt: '2026-07-23T00:00:00.000Z' },
  ];
  for (const [index, owner] of staleOwners.entries()) {
    await writeFile(`${lockPath}.reclaim-history-${index}`, JSON.stringify(owner) + '\n', 'utf8');
  }
  const retainedOwner = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token: 'retained-live-owner',
  };
  const retainedRaw = JSON.stringify(retainedOwner) + '\n';
  await writeFile(`${lockPath}.reclaim-current`, retainedRaw, 'utf8');

  await assert.rejects(
    () => acquireRuntimeBuildLock({
      lockPath,
      timeoutMs: 50,
      pollIntervalMs: 10,
      observePidLivenessImpl: (pid) => (
        pid === process.pid
          ? { status: 'alive', reason: 'signal_ok' }
          : { status: 'dead', reason: 'missing' }
      ),
    }),
    /timed out waiting for runtime build lock .*pid=/i,
  );

  assert.equal(await readFile(lockPath, 'utf8'), retainedRaw);
  assert.deepEqual(
    (await readdir(runtimeDir)).filter((name) => name.startsWith('build.lock.reclaim-')),
    [],
  );
});

test('acquireRuntimeBuildLock stale-history retirement preserves replacement bytes', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-retained-replacement-'));
  const lockPath = join(runtimeDir, 'build.lock');
  const retainedPath = `${lockPath}.reclaim-history`;

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const moduleUrl = new URL('./runtime_build_lock.mjs', import.meta.url).href;
  const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const lockPath = ${JSON.stringify(lockPath)};
const retainedPath = ${JSON.stringify(retainedPath)};
const staleRaw = JSON.stringify({ pid: 2147483000, createdAt: '2026-07-11T00:00:00.000Z' }) + '\\n';
const successorRaw = JSON.stringify({
  pid: process.pid,
  createdAt: new Date().toISOString(),
  token: 'retained-successor',
}) + '\\n';
fs.writeFileSync(retainedPath, staleRaw, 'utf8');

const originalRename = fs.promises.rename;
const originalUnlink = fs.promises.unlink;
let injected = false;
function injectSuccessor() {
  if (injected) return;
  injected = true;
  fs.writeFileSync(retainedPath, successorRaw, 'utf8');
}
fs.promises.rename = async function patchedRename(from, to) {
  if (String(from) === retainedPath) injectSuccessor();
  return await originalRename.call(this, from, to);
};
fs.promises.unlink = async function patchedUnlink(path) {
  if (String(path) === retainedPath) injectSuccessor();
  return await originalUnlink.call(this, path);
};
syncBuiltinESMExports();

const { acquireRuntimeBuildLock } = await import(${JSON.stringify(moduleUrl)});
await assert.rejects(
  () => acquireRuntimeBuildLock({
    lockPath,
    timeoutMs: 50,
    pollIntervalMs: 10,
    observePidLivenessImpl: (pid) => (
      pid === process.pid
        ? { status: 'alive', reason: 'signal_ok' }
        : { status: 'dead', reason: 'missing' }
    ),
  }),
  /recovery cleanup failed|timed out waiting for runtime build lock/i,
);
assert.equal(injected, true);
assert.equal(fs.existsSync(lockPath), false);
assert.equal(fs.readFileSync(retainedPath, 'utf8'), successorRaw);
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
});

test('acquireRuntimeBuildLock fails closed when a live pid owns the lock', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-live-'));
  const lockPath = join(runtimeDir, 'build.lock');

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const child = spawnTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(child.pid && child.pid > 1);

  try {
    await writeFile(lockPath, JSON.stringify({ pid: child.pid, createdAt: '2026-03-07T00:00:00.000Z' }) + '\n', 'utf-8');

    await assert.rejects(
      () => acquireRuntimeBuildLock({ lockPath, timeoutMs: 50, pollIntervalMs: 10 }),
      /timed out waiting for runtime build lock .*pid=/i,
    );
  } finally {
    await terminateChildProcessAndWait(child);
  }
});

test('acquireRuntimeBuildLock waits for a live owner and acquires after release', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-wait-live-'));
  const lockPath = join(runtimeDir, 'build.lock');
  let releaseFirst;

  t.after(async () => {
    await releaseFirst?.();
    await rm(runtimeDir, { recursive: true, force: true });
  });

  releaseFirst = await acquireRuntimeBuildLock({ lockPath });
  const releaseTimer = setTimeout(() => {
    void releaseFirst().then(() => {
      releaseFirst = null;
    });
  }, 40);

  try {
    const releaseSecond = await acquireRuntimeBuildLock({
      lockPath,
      timeoutMs: 500,
      pollIntervalMs: 10,
    });
    await releaseSecond();
  } finally {
    clearTimeout(releaseTimer);
  }
});

test('acquireRuntimeBuildLock release preserves a same-pid successor incarnation', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-release-successor-'));
  const lockPath = join(runtimeDir, 'build.lock');

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const release = await acquireRuntimeBuildLock({ lockPath });
  const successor = {
    pid: process.pid,
    createdAt: new Date(Date.now() + 1_000).toISOString(),
    token: 'successor-token',
    processInstanceFingerprint: 'successor-incarnation',
  };
  await writeFile(lockPath, JSON.stringify(successor) + '\n', 'utf8');

  await release();

  assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), successor);
});

test('acquireRuntimeBuildLock stale reclaim preserves a concurrently installed successor', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-reclaim-successor-'));
  const lockPath = join(runtimeDir, 'build.lock');

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const moduleUrl = new URL('./runtime_build_lock.mjs', import.meta.url).href;
  const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const lockPath = ${JSON.stringify(lockPath)};
const staleOwner = {
  pid: 999999,
  createdAt: '2026-03-07T00:00:00.000Z',
};
const successor = {
  pid: process.pid,
  createdAt: new Date().toISOString(),
  token: 'successor-token',
};
fs.writeFileSync(lockPath, JSON.stringify(staleOwner) + '\\n', 'utf8');

const originalRename = fs.promises.rename;
let injected = false;
fs.promises.rename = async function patchedRename(from, to) {
  if (String(from) === lockPath && !injected) {
    injected = true;
    fs.writeFileSync(lockPath, JSON.stringify(successor) + '\\n', 'utf8');
  }
  return await originalRename.call(this, from, to);
};
syncBuiltinESMExports();

const { acquireRuntimeBuildLock } = await import(${JSON.stringify(moduleUrl)});
await assert.rejects(
  () => acquireRuntimeBuildLock({ lockPath }),
  /runtime build is already in progress .*pid=/i,
);
assert.equal(injected, true);
assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), successor);
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
});

test('acquireRuntimeBuildLock fails closed and preserves a successor when quarantine recovery fails', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-reclaim-read-failure-'));
  const lockPath = join(runtimeDir, 'build.lock');

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const moduleUrl = new URL('./runtime_build_lock.mjs', import.meta.url).href;
  const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const lockPath = ${JSON.stringify(lockPath)};
const staleOwner = { pid: 999999, createdAt: '2026-03-07T00:00:00.000Z' };
const successor = {
  pid: process.pid,
  createdAt: new Date().toISOString(),
  token: 'successor-token',
};
fs.writeFileSync(lockPath, JSON.stringify(staleOwner) + '\\n', 'utf8');

const originalRename = fs.promises.rename;
const originalReadFile = fs.promises.readFile;
const originalLink = fs.promises.link;
const originalCopyFile = fs.promises.copyFile;
let injected = false;
let failedQuarantineRead = false;
let failedQuarantineRestore = false;
let failQuarantineRecovery = true;
fs.promises.rename = async function patchedRename(from, to) {
  if (String(from) === lockPath && !injected) {
    injected = true;
    fs.writeFileSync(lockPath, JSON.stringify(successor) + '\\n', 'utf8');
  }
  return await originalRename.call(this, from, to);
};
fs.promises.readFile = async function patchedReadFile(path, ...args) {
  if (String(path).includes('.reclaim-') && !failedQuarantineRead) {
    failedQuarantineRead = true;
    const error = new Error('injected quarantine read failure');
    error.code = 'EIO';
    throw error;
  }
  return await originalReadFile.call(this, path, ...args);
};
fs.promises.link = async function patchedLink(from) {
  if (String(from).includes('.reclaim-') && failQuarantineRecovery) {
    failedQuarantineRestore = true;
    const error = new Error('injected quarantine restore failure');
    error.code = 'EIO';
    throw error;
  }
  throw new Error('unexpected link');
};
fs.promises.copyFile = async function patchedCopyFile(from) {
  if (String(from).includes('.reclaim-') && failQuarantineRecovery) {
    const error = new Error('injected quarantine copy failure');
    error.code = 'EIO';
    throw error;
  }
  throw new Error('unexpected copyFile');
};
syncBuiltinESMExports();

const { acquireRuntimeBuildLock } = await import(${JSON.stringify(moduleUrl)});
await assert.rejects(
  () => acquireRuntimeBuildLock({ lockPath }),
  /runtime build is already in progress|failed to safely reclaim/i,
);
assert.equal(injected, true);
assert.equal(failedQuarantineRead, true);
assert.equal(failedQuarantineRestore, true);
assert.equal(fs.existsSync(lockPath), false);
let reclaimName = fs.readdirSync(${JSON.stringify(runtimeDir)}).find((name) => name.includes('.reclaim-'));
assert.ok(reclaimName);
assert.deepEqual(JSON.parse(fs.readFileSync(${JSON.stringify(runtimeDir)} + '/' + reclaimName, 'utf8')), successor);

await assert.rejects(
  () => acquireRuntimeBuildLock({ lockPath }),
  /recovery|already in progress|failed to safely reclaim/i,
);
assert.equal(fs.existsSync(lockPath), false);

failQuarantineRecovery = false;
fs.promises.link = originalLink;
fs.promises.copyFile = originalCopyFile;
syncBuiltinESMExports();
await assert.rejects(
  () => acquireRuntimeBuildLock({ lockPath, timeoutMs: 50, pollIntervalMs: 10 }),
  /timed out waiting for runtime build lock|recovery/i,
);
assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), successor);
reclaimName = fs.readdirSync(${JSON.stringify(runtimeDir)}).find((name) => name.includes('.reclaim-'));
assert.equal(reclaimName, undefined);
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
});

test('acquireRuntimeBuildLock revalidates retained owners after create and preserves a successor', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-post-create-retained-'));

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const moduleUrl = new URL('./runtime_build_lock.mjs', import.meta.url).href;
  const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const cases = new Map();
for (const name of ['recover', 'successor']) {
  const lockPath = ${JSON.stringify(runtimeDir)} + '/' + name + '.lock';
  cases.set(lockPath, {
    lockPath,
    retainedPath: lockPath + '.reclaim-injected',
    retainedRaw: JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      token: 'retained-' + name,
    }) + '\\n',
    successorRaw: name === 'successor'
      ? JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        token: 'successor-owner',
      }) + '\\n'
      : null,
    artifactInjected: false,
    successorInjected: false,
  });
}

const originalOpen = fs.promises.open;
const originalRename = fs.promises.rename;
fs.promises.open = async function patchedOpen(path, flags, ...args) {
  const testCase = cases.get(String(path));
  if (testCase && flags === 'wx' && !testCase.artifactInjected) {
    testCase.artifactInjected = true;
    fs.writeFileSync(testCase.retainedPath, testCase.retainedRaw, 'utf8');
  }
  return await originalOpen.call(this, path, flags, ...args);
};
fs.promises.rename = async function patchedRename(from, to) {
  const testCase = cases.get(String(from));
  if (
    testCase?.successorRaw
    && testCase.artifactInjected
    && !testCase.successorInjected
    && String(to).includes('.reclaim-')
  ) {
    testCase.successorInjected = true;
    fs.writeFileSync(testCase.lockPath, testCase.successorRaw, 'utf8');
  }
  return await originalRename.call(this, from, to);
};
syncBuiltinESMExports();

const { acquireRuntimeBuildLock } = await import(${JSON.stringify(moduleUrl)});
for (const testCase of cases.values()) {
  await assert.rejects(
    () => acquireRuntimeBuildLock({
      lockPath: testCase.lockPath,
      timeoutMs: 50,
      pollIntervalMs: 10,
    }),
    /timed out waiting for runtime build lock|failed to safely reclaim/i,
  );
  assert.equal(testCase.artifactInjected, true);
  assert.equal(
    fs.readFileSync(testCase.lockPath, 'utf8'),
    testCase.successorRaw ?? testCase.retainedRaw,
  );
  if (testCase.successorRaw) {
    assert.equal(testCase.successorInjected, true);
    assert.equal(fs.readFileSync(testCase.retainedPath, 'utf8'), testCase.retainedRaw);
  } else {
    assert.equal(fs.existsSync(testCase.retainedPath), false);
  }
}
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
});

test('acquireRuntimeBuildLock reclaims a live reused pid only when its process incarnation differs', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-reused-pid-'));
  const lockPath = join(runtimeDir, 'build.lock');

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    createdAt: '2026-03-07T00:00:00.000Z',
    token: 'predecessor-token',
    processInstanceFingerprint: 'predecessor-incarnation',
  }) + '\n', 'utf8');

  const release = await acquireRuntimeBuildLock({
    lockPath,
    readProcessInstanceFingerprintSyncImpl: () => 'current-incarnation',
  });
  const current = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(current.pid, process.pid);
  assert.notEqual(current.token, 'predecessor-token');
  await release();
  await assert.rejects(() => access(lockPath), /ENOENT/);
});

test('acquireRuntimeBuildLock preserves a live predecessor Windows owner fingerprint', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-predecessor-fingerprint-'));
  const lockPath = join(runtimeDir, 'build.lock');
  const predecessorFingerprint = 'win32-cim:2026-07-23T12:34:56.1234567Z';
  const observedOptions = [];

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const owner = {
    pid: process.pid,
    createdAt: '2026-07-23T12:34:56.123Z',
    token: 'predecessor-token',
    processInstanceFingerprint: predecessorFingerprint,
  };
  await writeFile(lockPath, JSON.stringify(owner) + '\n', 'utf8');

  await assert.rejects(
    () => acquireRuntimeBuildLock({
      lockPath,
      timeoutMs: 30,
      pollIntervalMs: 5,
      readProcessInstanceFingerprintSyncImpl: (_pid, options) => {
        observedOptions.push(options);
        return options?.expectedFingerprint === predecessorFingerprint
          ? predecessorFingerprint
          : 'win32-cim:jeudi 23 juillet 2026 14:34:56';
      },
    }),
    /timed out waiting for runtime build lock .*pid=/i,
  );
  assert.equal(
    observedOptions.some((options) => options?.expectedFingerprint === predecessorFingerprint),
    true,
  );
  assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), owner);
});

test('acquireRuntimeBuildLock fails closed when owner liveness is inconclusive', async (t) => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'happier-runtime-build-lock-inconclusive-pid-'));
  const lockPath = join(runtimeDir, 'build.lock');

  t.after(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  const owner = {
    pid: process.pid,
    createdAt: '2026-03-07T00:00:00.000Z',
    token: 'existing-token',
    processInstanceFingerprint: 'existing-incarnation',
  };
  await writeFile(lockPath, JSON.stringify(owner) + '\n', 'utf8');

  await assert.rejects(
    () => acquireRuntimeBuildLock({
      lockPath,
      timeoutMs: 50,
      pollIntervalMs: 10,
      observePidLivenessImpl: () => ({ status: 'inconclusive', reason: 'probe_failed' }),
      readProcessInstanceFingerprintSyncImpl: () => 'different-incarnation',
    }),
    /timed out waiting for runtime build lock .*pid=/i,
  );
  assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), owner);
});
