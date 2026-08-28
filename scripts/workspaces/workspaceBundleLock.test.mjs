import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  withWorkspaceBundleLock,
  withWorkspaceBundleLockSync,
} from './workspaceBundleLock.mjs';

test('workspace publishers get a default contention budget sized for concurrent source-dev builds', () => {
  assert.ok(DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS >= 30 * 60_000);
});

test('workspace bundle lock declarations expose result reuse to production consumers', () => {
  const cliCommonDir = fileURLToPath(new URL('../../packages/cli-common/', import.meta.url));
  const fixtureDir = mkdtempSync(join(cliCommonDir, '.workspace-bundle-lock-types-'));
  try {
    const fixturePath = join(fixtureDir, 'consumer.mts');
    writeFileSync(fixturePath, `
import { withWorkspaceBundleLock } from '../workspaceBundleLock.mjs';

const result: string = await withWorkspaceBundleLock(
  async () => 'built',
  {
    lockPath: '/tmp/workspace-bundle.lock',
    tryResolveWaiter: async () => ({ resolved: true, value: 'reused' }),
  },
);
void result;
`, 'utf8');
    const compiler = fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        compiler,
        '--ignoreConfig',
        '--noEmit',
        '--strict',
        '--target',
        'ES2022',
        '--module',
        'ESNext',
        '--moduleResolution',
        'Bundler',
        fixturePath,
      ],
      { cwd: cliCommonDir, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

async function waitForCondition(predicate, label, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function runWorkspaceQuarantineReadFailureCase(mode) {
  const tempRoot = mkdtempSync(join(tmpdir(), `happier-workspace-bundle-lock-reclaim-read-${mode}-`));
  try {
    const moduleUrl = new URL('./workspaceBundleLock.mjs', import.meta.url).href;
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const lockPath = ${JSON.stringify(lockPath)};
const staleOwner = {
  pid: 999999,
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
  token: 'stale-owner',
  processInstanceFingerprint: 'stale-incarnation',
};
const successor = {
  pid: process.pid,
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
  token: 'successor-owner',
  processInstanceFingerprint: null,
};
fs.writeFileSync(lockPath, JSON.stringify(staleOwner), 'utf8');

const originalRenameSync = fs.renameSync;
const originalReadFileSync = fs.readFileSync;
const originalLinkSync = fs.linkSync;
const originalCopyFileSync = fs.copyFileSync;
let injected = false;
let failedQuarantineRead = false;
let failedQuarantineRestore = false;
let failQuarantineRecovery = true;
let entered = false;
fs.renameSync = function patchedRenameSync(from, to) {
  if (String(from) === lockPath && !injected) {
    injected = true;
    fs.writeFileSync(lockPath, JSON.stringify(successor), 'utf8');
  }
  return originalRenameSync.call(this, from, to);
};
fs.readFileSync = function patchedReadFileSync(path, ...args) {
  if (String(path).includes('.reclaim-') && !failedQuarantineRead) {
    failedQuarantineRead = true;
    const error = new Error('injected quarantine read failure');
    error.code = 'EIO';
    throw error;
  }
  return originalReadFileSync.call(this, path, ...args);
};
fs.linkSync = function patchedLinkSync(from) {
  if (String(from).includes('.reclaim-') && failQuarantineRecovery) {
    failedQuarantineRestore = true;
    const error = new Error('injected quarantine restore failure');
    error.code = 'EIO';
    throw error;
  }
  throw new Error('unexpected link');
};
fs.copyFileSync = function patchedCopyFileSync(from) {
  if (String(from).includes('.reclaim-') && failQuarantineRecovery) {
    const error = new Error('injected quarantine copy failure');
    error.code = 'EIO';
    throw error;
  }
  throw new Error('unexpected copyFileSync');
};
syncBuiltinESMExports();

const { withWorkspaceBundleLock, withWorkspaceBundleLockSync } = await import(${JSON.stringify(moduleUrl)});
const options = {
  lockPath,
  timeoutMs: 60,
  pollIntervalMs: 5,
  staleAfterMs: 5_000,
};
if (${JSON.stringify(mode)} === 'async') {
  await assert.rejects(
    () => withWorkspaceBundleLock(async () => { entered = true; }, options),
    /Timed out waiting for workspace bundle lock|failed to safely reclaim/i,
  );
} else {
  assert.throws(
    () => withWorkspaceBundleLockSync(() => { entered = true; }, options),
    /Timed out waiting for workspace bundle lock|failed to safely reclaim/i,
  );
}

assert.equal(injected, true);
assert.equal(failedQuarantineRead, true);
assert.equal(failedQuarantineRestore, true);
assert.equal(entered, false);
assert.equal(fs.existsSync(lockPath), false);
let reclaimName = fs.readdirSync(${JSON.stringify(tempRoot)}).find((name) => name.includes('.reclaim-'));
assert.ok(reclaimName);
assert.deepEqual(JSON.parse(originalReadFileSync(${JSON.stringify(tempRoot)} + '/' + reclaimName, 'utf8')), successor);

let enteredSecond = false;
if (${JSON.stringify(mode)} === 'async') {
  await assert.rejects(
    () => withWorkspaceBundleLock(async () => { enteredSecond = true; }, options),
    /recovery|Timed out waiting for workspace bundle lock|failed to safely reclaim/i,
  );
} else {
  assert.throws(
    () => withWorkspaceBundleLockSync(() => { enteredSecond = true; }, options),
    /recovery|Timed out waiting for workspace bundle lock|failed to safely reclaim/i,
  );
}
assert.equal(enteredSecond, false);
assert.equal(fs.existsSync(lockPath), false);

failQuarantineRecovery = false;
fs.linkSync = originalLinkSync;
fs.copyFileSync = originalCopyFileSync;
syncBuiltinESMExports();
if (${JSON.stringify(mode)} === 'async') {
  await assert.rejects(
    () => withWorkspaceBundleLock(async () => { enteredSecond = true; }, options),
    /Timed out waiting for workspace bundle lock|recovery/i,
  );
} else {
  assert.throws(
    () => withWorkspaceBundleLockSync(() => { enteredSecond = true; }, options),
    /Timed out waiting for workspace bundle lock|recovery/i,
  );
}
assert.equal(enteredSecond, false);
assert.deepEqual(JSON.parse(originalReadFileSync(lockPath, 'utf8')), successor);
reclaimName = fs.readdirSync(${JSON.stringify(tempRoot)}).find((name) => name.includes('.reclaim-'));
assert.equal(reclaimName, undefined);
`;
    return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 5_000,
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runRetainedHistoryCase(mode, { includeInconclusiveOwner }) {
  const tempRoot = mkdtempSync(join(
    tmpdir(),
    `happier-workspace-bundle-lock-retained-${mode}-${includeInconclusiveOwner ? 'owner' : 'history'}-`,
  ));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const historicalOwners = [
      { pid: 2_147_483_000, createdAtMs: 1_783_755_503_186, updatedAtMs: 1_783_755_503_186 },
      { pid: 2_147_483_001, createdAtMs: 1_784_793_448_608, updatedAtMs: 1_784_793_448_608 },
    ];
    for (const [index, owner] of historicalOwners.entries()) {
      writeFileSync(`${lockPath}.reclaim-history-${index}`, JSON.stringify(owner), 'utf8');
    }

    let retainedRaw = null;
    if (includeInconclusiveOwner) {
      retainedRaw = JSON.stringify({
        pid: process.pid,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        token: 'retained-live-owner',
        processInstanceFingerprint: null,
      });
      writeFileSync(`${lockPath}.reclaim-current`, retainedRaw, 'utf8');
    }

    const options = {
      lockPath,
      timeoutMs: 60,
      pollIntervalMs: 5,
      staleAfterMs: 5_000,
    };
    let entered = false;
    const callback = () => {
      entered = true;
      return 'acquired';
    };

    if (!includeInconclusiveOwner) {
      const result = mode === 'async'
        ? await withWorkspaceBundleLock(callback, options)
        : withWorkspaceBundleLockSync(callback, options);
      assert.equal(result, 'acquired');
      assert.equal(entered, true);
      assert.equal(existsSync(lockPath), false);
    } else if (mode === 'async') {
      await assert.rejects(
        () => withWorkspaceBundleLock(callback, options),
        /Timed out waiting for workspace bundle lock/,
      );
      assert.equal(entered, false);
      assert.equal(readFileSync(lockPath, 'utf8'), retainedRaw);
    } else {
      assert.throws(
        () => withWorkspaceBundleLockSync(callback, options),
        /Timed out waiting for workspace bundle lock/,
      );
      assert.equal(entered, false);
      assert.equal(readFileSync(lockPath, 'utf8'), retainedRaw);
    }

    assert.deepEqual(
      readdirSync(tempRoot).filter((name) => name.startsWith('workspace-bundling.lock.reclaim-')),
      [],
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runDuplicateRetainedOwnerCase(mode) {
  const tempRoot = mkdtempSync(join(tmpdir(), `happier-workspace-bundle-lock-duplicate-owner-${mode}-`));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const owner = {
      pid: process.pid,
      createdAtMs: Date.now() - 1_000,
      token: 'same-authenticated-owner',
      processInstanceFingerprint: 'same-process-instance',
    };
    const olderRaw = JSON.stringify({ ...owner, updatedAtMs: Date.now() - 500 });
    const newerRaw = JSON.stringify({ ...owner, updatedAtMs: Date.now() - 100 });
    writeFileSync(`${lockPath}.reclaim-older`, olderRaw, 'utf8');
    writeFileSync(`${lockPath}.reclaim-newer`, newerRaw, 'utf8');
    const options = {
      lockPath,
      timeoutMs: 40,
      pollIntervalMs: 5,
      staleAfterMs: 5_000,
      isRunningPidImpl: () => true,
      readProcessInstanceFingerprintSyncImpl: () => 'same-process-instance',
    };
    const callback = () => assert.fail('the retained live owner must remain authoritative');
    if (mode === 'async') {
      await assert.rejects(() => withWorkspaceBundleLock(callback, options), /Timed out waiting/);
    } else {
      assert.throws(() => withWorkspaceBundleLockSync(callback, options), /Timed out waiting/);
    }
    assert.equal(readFileSync(lockPath, 'utf8'), newerRaw);
    assert.deepEqual(
      readdirSync(tempRoot).filter((name) => name.startsWith('workspace-bundling.lock.reclaim-')),
      [],
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runDistinctRetainedOwnerCase(mode) {
  const tempRoot = mkdtempSync(join(tmpdir(), `happier-workspace-bundle-lock-distinct-owners-${mode}-`));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const owner = {
      pid: process.pid,
      createdAtMs: Date.now() - 1_000,
      updatedAtMs: Date.now() - 100,
      processInstanceFingerprint: 'same-process-instance',
    };
    writeFileSync(`${lockPath}.reclaim-first`, JSON.stringify({ ...owner, token: 'first-owner' }), 'utf8');
    writeFileSync(`${lockPath}.reclaim-second`, JSON.stringify({ ...owner, token: 'second-owner' }), 'utf8');
    const options = {
      lockPath,
      timeoutMs: 40,
      pollIntervalMs: 5,
      staleAfterMs: 5_000,
      isRunningPidImpl: () => true,
      readProcessInstanceFingerprintSyncImpl: () => 'same-process-instance',
    };
    const callback = () => assert.fail('must not acquire');
    if (mode === 'async') {
      await assert.rejects(() => withWorkspaceBundleLock(callback, options), /recovery is ambiguous/);
    } else {
      assert.throws(() => withWorkspaceBundleLockSync(callback, options), /recovery is ambiguous/);
    }
    assert.equal(existsSync(lockPath), false);
    assert.equal(readdirSync(tempRoot).filter((name) => name.startsWith('workspace-bundling.lock.reclaim-')).length, 2);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runPostCreateRetainedRaceCase(mode) {
  const tempRoot = mkdtempSync(join(tmpdir(), `happier-workspace-lock-post-create-${mode}-`));
  try {
    const moduleUrl = new URL('./workspaceBundleLock.mjs', import.meta.url).href;
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const cases = new Map();
for (const name of ['recover', 'successor']) {
  const lockPath = ${JSON.stringify(tempRoot)} + '/' + name + '.lock';
  cases.set(lockPath, {
    lockPath,
    retainedPath: lockPath + '.reclaim-injected',
    retainedRaw: JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      token: 'retained-' + name,
      processInstanceFingerprint: null,
    }),
    successorRaw: name === 'successor'
      ? JSON.stringify({
        pid: process.pid,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        token: 'successor-owner',
        processInstanceFingerprint: null,
      })
      : null,
    artifactInjected: false,
    successorInjected: false,
  });
}

const originalOpenSync = fs.openSync;
const originalRenameSync = fs.renameSync;
fs.openSync = function patchedOpenSync(path, flags, ...args) {
  const testCase = cases.get(String(path));
  if (testCase && flags === 'wx' && !testCase.artifactInjected) {
    testCase.artifactInjected = true;
    fs.writeFileSync(testCase.retainedPath, testCase.retainedRaw, 'utf8');
  }
  return originalOpenSync.call(this, path, flags, ...args);
};
fs.renameSync = function patchedRenameSync(from, to) {
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
  return originalRenameSync.call(this, from, to);
};
syncBuiltinESMExports();

const { withWorkspaceBundleLock, withWorkspaceBundleLockSync } = await import(${JSON.stringify(moduleUrl)});
for (const testCase of cases.values()) {
  let entered = false;
  const callback = () => {
    entered = true;
  };
  const options = {
    lockPath: testCase.lockPath,
    timeoutMs: 60,
    pollIntervalMs: 5,
    staleAfterMs: 5_000,
  };
  if (${JSON.stringify(mode)} === 'async') {
    await assert.rejects(
      () => withWorkspaceBundleLock(callback, options),
      /Timed out waiting for workspace bundle lock|failed to safely reclaim/i,
    );
  } else {
    assert.throws(
      () => withWorkspaceBundleLockSync(callback, options),
      /Timed out waiting for workspace bundle lock|failed to safely reclaim/i,
    );
  }
  assert.equal(entered, false);
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
    return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 5_000,
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runRetainedHistoryReplacementCase(mode) {
  const tempRoot = mkdtempSync(join(tmpdir(), `happier-workspace-lock-retained-replacement-${mode}-`));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const retainedPath = `${lockPath}.reclaim-history`;
    const moduleUrl = new URL('./workspaceBundleLock.mjs', import.meta.url).href;
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const lockPath = ${JSON.stringify(lockPath)};
const retainedPath = ${JSON.stringify(retainedPath)};
const staleRaw = JSON.stringify({
  pid: 2147483000,
  createdAtMs: 1783755503186,
  updatedAtMs: 1783755503186,
});
const successorRaw = JSON.stringify({
  pid: process.pid,
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
  token: 'retained-successor',
  processInstanceFingerprint: null,
});
fs.writeFileSync(retainedPath, staleRaw, 'utf8');

const originalRenameSync = fs.renameSync;
const originalUnlinkSync = fs.unlinkSync;
let injected = false;
function injectSuccessor() {
  if (injected) return;
  injected = true;
  fs.writeFileSync(retainedPath, successorRaw, 'utf8');
}
fs.renameSync = function patchedRenameSync(from, to) {
  if (String(from) === retainedPath) injectSuccessor();
  return originalRenameSync.call(this, from, to);
};
fs.unlinkSync = function patchedUnlinkSync(path) {
  if (String(path) === retainedPath) injectSuccessor();
  return originalUnlinkSync.call(this, path);
};
syncBuiltinESMExports();

const { withWorkspaceBundleLock, withWorkspaceBundleLockSync } = await import(${JSON.stringify(moduleUrl)});
let entered = false;
const options = {
  lockPath,
  timeoutMs: 60,
  pollIntervalMs: 5,
  staleAfterMs: 5_000,
};
if (${JSON.stringify(mode)} === 'async') {
  await assert.rejects(
    () => withWorkspaceBundleLock(() => { entered = true; }, options),
    /recovery cleanup failed/i,
  );
} else {
  assert.throws(
    () => withWorkspaceBundleLockSync(() => { entered = true; }, options),
    /recovery cleanup failed/i,
  );
}
assert.equal(entered, false);
assert.equal(injected, true);
assert.equal(fs.existsSync(lockPath), false);
assert.equal(fs.readFileSync(retainedPath, 'utf8'), successorRaw);
`;
    return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 5_000,
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('withWorkspaceBundleLock serializes concurrent workspace bundling through a single lock', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const events = [];
    let releaseFirst = null;

    const first = withWorkspaceBundleLock(
      async () => {
        events.push('first:start');
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
        events.push('first:end');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ['first:start']);

    const second = withWorkspaceBundleLock(
      async () => {
        events.push('second:start');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(events, ['first:start']);

    releaseFirst?.();
    await Promise.all([first, second]);

    assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock waits on lock-state changes instead of hot polling', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-change-wait-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    let releaseOwner;
    const owner = withWorkspaceBundleLock(
      async () => await new Promise((resolve) => {
        releaseOwner = resolve;
      }),
      { lockPath, timeoutMs: 2_000, staleAfterMs: 5_000 },
    );
    await waitForCondition(() => typeof releaseOwner === 'function', 'initial lock owner');

    const waits = [];
    let releaseWait;
    const waiter = withWorkspaceBundleLock(
      async () => 'acquired',
      {
        lockPath,
        timeoutMs: 2_000,
        staleAfterMs: 5_000,
        waitForLockChangeImpl: async (context) => {
          waits.push(context);
          await new Promise((resolve) => {
            releaseWait = resolve;
          });
        },
      },
    );
    await waitForCondition(() => waits.length > 0, 'event-driven lock wait');
    assert.ok(waits[0].maxWaitMs >= 1_000);

    releaseOwner();
    releaseWait();
    assert.equal(await waiter, 'acquired');
    await owner;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock lets waiters reuse a result published by the prior owner', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-reuse-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    let releaseOwner;
    let published = false;
    const owner = withWorkspaceBundleLock(
      async () => await new Promise((resolve) => {
        releaseOwner = () => {
          published = true;
          resolve();
        };
      }),
      { lockPath, timeoutMs: 2_000, staleAfterMs: 5_000 },
    );
    await waitForCondition(() => typeof releaseOwner === 'function', 'initial lock owner');

    let enteredWaiterOwner = false;
    const waiter = withWorkspaceBundleLock(
      async () => {
        enteredWaiterOwner = true;
        return 'rebuilt';
      },
      {
        lockPath,
        timeoutMs: 2_000,
        staleAfterMs: 5_000,
        tryResolveWaiter: async () => published
          ? { resolved: true, value: 'reused' }
          : { resolved: false },
      },
    );

    await waitForCondition(() => existsSync(`${lockPath}.priority-claim`), 'waiter priority claim');
    releaseOwner();
    assert.equal(await waiter, 'reused');
    assert.equal(enteredWaiterOwner, false);
    await owner;
    assert.equal(existsSync(`${lockPath}.priority-claim`), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock gives a continuous waiter priority over rotating newer contenders', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-fairness-'));
  const children = new Set();
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const moduleUrl = new URL('./workspaceBundleLock.mjs', import.meta.url).href;
    const workerScript = `
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { withWorkspaceBundleLock } from ${JSON.stringify(moduleUrl)};

const [lockPath, stateDir, id, mode, timeoutMsRaw, pollIntervalMsRaw] = process.argv.slice(1);
const timeoutMs = Number(timeoutMsRaw);
const pollIntervalMs = Number(pollIntervalMsRaw);
const readyPath = \`\${stateDir}/ready-\${id}\`;
const acquiredPath = \`\${stateDir}/acquired-\${id}\`;
const releasePath = \`\${stateDir}/release-\${id}\`;
const waitCountPath = \`\${stateDir}/wait-count-\${id}\`;
let waitCount = 0;

try {
  await withWorkspaceBundleLock(
    async () => {
      writeFileSync(acquiredPath, String(Date.now()), 'utf8');
      if (mode !== 'hold') return;
      while (!existsSync(releasePath)) await sleep(2);
    },
    {
      lockPath,
      timeoutMs,
      pollIntervalMs,
      staleAfterMs: 5_000,
      onWait: () => {
        waitCount += 1;
        writeFileSync(waitCountPath, String(waitCount), 'utf8');
        writeFileSync(readyPath, String(Date.now()), 'utf8');
      },
    },
  );
} catch (error) {
  writeFileSync(\`\${stateDir}/failed-\${id}\`, String(error?.message ?? error), 'utf8');
}
`;

    const startWorker = (id, { mode = 'hold', timeoutMs = 10_000, pollIntervalMs = 2 } = {}) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          workerScript,
          lockPath,
          tempRoot,
          id,
          mode,
          String(timeoutMs),
          String(pollIntervalMs),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      children.add(child);
      child.once('exit', () => children.delete(child));
      return child;
    };
    const waitCount = (id) => {
      try {
        return Number(readFileSync(join(tempRoot, `wait-count-${id}`), 'utf8')) || 0;
      } catch {
        return 0;
      }
    };
    const release = (id) => writeFileSync(join(tempRoot, `release-${id}`), '', 'utf8');

    startWorker('owner-0');
    await waitForCondition(() => existsSync(join(tempRoot, 'acquired-owner-0')), 'initial owner');

    startWorker('old-waiter', { mode: 'return', timeoutMs: 10_000, pollIntervalMs: 200 });
    await waitForCondition(() => waitCount('old-waiter') >= 1, 'old waiter to observe initial owner');

    let currentOwner = 'owner-0';
    let oldWaitCount = 1;
    for (let generation = 1; generation <= 6; generation += 1) {
      const contender = `contender-${generation}`;
      startWorker(contender, { timeoutMs: 10_000, pollIntervalMs: 1 });
      await waitForCondition(() => existsSync(join(tempRoot, `ready-${contender}`)), `${contender} to wait`);

      release(currentOwner);
      await waitForCondition(
        () =>
          existsSync(join(tempRoot, 'acquired-old-waiter'))
          || existsSync(join(tempRoot, `acquired-${contender}`)),
        `old waiter or ${contender} acquisition`,
      );
      if (existsSync(join(tempRoot, 'acquired-old-waiter'))) {
        await waitForCondition(() => existsSync(join(tempRoot, `acquired-${contender}`)), `${contender} cleanup acquisition`);
        release(contender);
        currentOwner = null;
        break;
      }

      currentOwner = contender;
      oldWaitCount += 1;
      await waitForCondition(
        () =>
          waitCount('old-waiter') >= oldWaitCount
          || existsSync(join(tempRoot, 'failed-old-waiter')),
        `old waiter to observe ${contender}`,
      );
      if (existsSync(join(tempRoot, 'failed-old-waiter'))) break;
    }

    if (currentOwner && !existsSync(join(tempRoot, 'acquired-old-waiter'))) {
      await waitForCondition(
        () => existsSync(join(tempRoot, 'failed-old-waiter')),
        'starved old waiter timeout',
        10_500,
      );
    }
    if (currentOwner) release(currentOwner);
    await waitForCondition(
      () =>
        existsSync(join(tempRoot, 'acquired-old-waiter'))
        || existsSync(join(tempRoot, 'failed-old-waiter')),
      'old waiter completion',
    );

    const oldWaiterFailurePath = join(tempRoot, 'failed-old-waiter');
    assert.equal(
      existsSync(join(tempRoot, 'acquired-old-waiter')),
      true,
      existsSync(oldWaiterFailurePath) ? readFileSync(oldWaiterFailurePath, 'utf8') : 'old waiter never acquired',
    );
  } finally {
    for (const child of children) child.kill();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock priority claims recover when a claimant crashes before acquiring', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-claim-crash-waiting-'));
  const lockPath = join(tempRoot, 'workspace-bundling.lock');
  const claimPath = `${lockPath}.priority-claim`;
  const moduleUrl = new URL('./workspaceBundleLock.mjs', import.meta.url).href;
  let releaseOwner;
  let child;
  try {
    const owner = withWorkspaceBundleLock(
      async () => await new Promise((resolve) => { releaseOwner = resolve; }),
      { lockPath, timeoutMs: 2_000, pollIntervalMs: 5, staleAfterMs: 5_000 },
    );
    await waitForCondition(() => existsSync(lockPath), 'initial lock owner');

    const workerScript = `
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { withWorkspaceBundleLock } from ${JSON.stringify(moduleUrl)};
await withWorkspaceBundleLock(
  async () => {
    writeFileSync(${JSON.stringify(join(tempRoot, 'unexpected-acquisition'))}, '', 'utf8');
    await sleep(10_000);
  },
  {
    lockPath: ${JSON.stringify(lockPath)},
    timeoutMs: 10_000,
    pollIntervalMs: 5,
    staleAfterMs: 5_000,
    onWait: () => writeFileSync(${JSON.stringify(join(tempRoot, 'waiter-ready'))}, '', 'utf8'),
  },
);
`;
    child = spawn(process.execPath, ['--input-type=module', '--eval', workerScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForCondition(
      () => existsSync(join(tempRoot, 'waiter-ready')) && existsSync(claimPath),
      'waiting claimant',
    );
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    releaseOwner();
    await owner;

    const result = await withWorkspaceBundleLock(
      async () => 'successor',
      { lockPath, timeoutMs: 2_000, pollIntervalMs: 5, staleAfterMs: 5_000 },
    );
    assert.equal(result, 'successor');
    assert.equal(existsSync(claimPath), false);
    assert.equal(existsSync(join(tempRoot, 'unexpected-acquisition')), false);
  } finally {
    if (child?.exitCode == null && child?.signalCode == null) child?.kill('SIGKILL');
    releaseOwner?.();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock priority claims clear before the acquired callback and recover when its owner crashes', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-claim-crash-owner-'));
  const lockPath = join(tempRoot, 'workspace-bundling.lock');
  const claimPath = `${lockPath}.priority-claim`;
  const moduleUrl = new URL('./workspaceBundleLock.mjs', import.meta.url).href;
  let releaseOwner;
  let child;
  try {
    const owner = withWorkspaceBundleLock(
      async () => await new Promise((resolve) => { releaseOwner = resolve; }),
      { lockPath, timeoutMs: 2_000, pollIntervalMs: 5, staleAfterMs: 5_000 },
    );
    await waitForCondition(() => existsSync(lockPath), 'initial lock owner');

    const acquiredPath = join(tempRoot, 'claimant-acquired');
    const workerScript = `
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { withWorkspaceBundleLock } from ${JSON.stringify(moduleUrl)};
await withWorkspaceBundleLock(
  async () => {
    writeFileSync(${JSON.stringify(acquiredPath)}, '', 'utf8');
    await sleep(10_000);
  },
  {
    lockPath: ${JSON.stringify(lockPath)},
    timeoutMs: 10_000,
    pollIntervalMs: 5,
    staleAfterMs: 5_000,
  },
);
`;
    child = spawn(process.execPath, ['--input-type=module', '--eval', workerScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForCondition(() => existsSync(claimPath), 'priority claim');
    releaseOwner();
    await owner;
    await waitForCondition(() => existsSync(acquiredPath), 'claimant acquisition');
    assert.equal(existsSync(claimPath), false, 'the acquired claimant must release priority for the next waiter');

    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));

    const result = await withWorkspaceBundleLock(
      async () => 'successor',
      { lockPath, timeoutMs: 2_000, pollIntervalMs: 5, staleAfterMs: 5_000 },
    );
    assert.equal(result, 'successor');
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(claimPath), false);
  } finally {
    if (child?.exitCode == null && child?.signalCode == null) child?.kill('SIGKILL');
    releaseOwner?.();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock priority claims recover paired dead claim and lock state after acquisition', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-claim-crash-handoff-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const claimPath = `${lockPath}.priority-claim`;
    const deadOwner = {
      pid: 999_999,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      token: 'dead-claimant',
      processInstanceFingerprint: 'dead-incarnation',
    };
    writeFileSync(lockPath, JSON.stringify(deadOwner), 'utf8');
    writeFileSync(claimPath, JSON.stringify(deadOwner), 'utf8');

    const result = await withWorkspaceBundleLock(
      async () => 'successor',
      { lockPath, timeoutMs: 2_000, pollIntervalMs: 5, staleAfterMs: 5_000 },
    );
    assert.equal(result, 'successor');
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(claimPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock priority claims reclaim stable malformed state after initialization grace', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-claim-malformed-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const claimPath = `${lockPath}.priority-claim`;
    writeFileSync(claimPath, '{"pid":', 'utf8');
    const old = new Date(Date.now() - 2_000);
    utimesSync(claimPath, old, old);

    const result = withWorkspaceBundleLockSync(
      () => 'acquired',
      {
        lockPath,
        timeoutMs: 200,
        pollIntervalMs: 5,
        staleAfterMs: 5_000,
        initializationGraceMs: 50,
      },
    );
    assert.equal(result, 'acquired');
    assert.equal(existsSync(claimPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock priority claims reclaim a reused live pid only for a different process incarnation', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-claim-reused-pid-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const claimPath = `${lockPath}.priority-claim`;
    writeFileSync(claimPath, JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      token: 'predecessor-claim',
      processInstanceFingerprint: 'old-incarnation',
    }), 'utf8');

    const result = withWorkspaceBundleLockSync(
      () => 'acquired',
      {
        lockPath,
        timeoutMs: 200,
        pollIntervalMs: 5,
        staleAfterMs: 5_000,
        readProcessInstanceFingerprintSyncImpl: () => 'current-incarnation',
      },
    );
    assert.equal(result, 'acquired');
    assert.equal(existsSync(claimPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock priority claims do not affect unrelated lock paths', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-claim-independent-'));
  try {
    const blockedLockPath = join(tempRoot, 'blocked.lock');
    const independentLockPath = join(tempRoot, 'independent.lock');
    writeFileSync(`${blockedLockPath}.priority-claim`, JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      token: 'live-unrelated-claim',
      processInstanceFingerprint: null,
    }), 'utf8');

    const result = withWorkspaceBundleLockSync(
      () => 'independent',
      {
        lockPath: independentLockPath,
        timeoutMs: 200,
        pollIntervalMs: 5,
        staleAfterMs: 5_000,
      },
    );
    assert.equal(result, 'independent');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock priority claims fence newer contenders while the live lock is absent', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-claim-handoff-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const claimPath = `${lockPath}.priority-claim`;
    const liveClaim = {
      pid: process.pid,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      token: 'adjacent-priority-metadata',
      processInstanceFingerprint: null,
    };
    writeFileSync(claimPath, JSON.stringify(liveClaim), 'utf8');

    let asyncEntered = false;
    await assert.rejects(
      withWorkspaceBundleLock(
        async () => {
          asyncEntered = true;
        },
        {
          lockPath,
          timeoutMs: 40,
          pollIntervalMs: 5,
          staleAfterMs: 5_000,
        },
      ),
      (error) => error?.code === 'EWORKSPACEBUNDLELOCKTIMEOUT',
    );
    assert.equal(asyncEntered, false);

    let syncEntered = false;
    assert.throws(
      () => withWorkspaceBundleLockSync(
        () => {
          syncEntered = true;
        },
        {
          lockPath,
          timeoutMs: 40,
          pollIntervalMs: 5,
          staleAfterMs: 5_000,
        },
      ),
      (error) => error?.code === 'EWORKSPACEBUNDLELOCKTIMEOUT',
    );
    assert.equal(syncEntered, false);
    assert.deepEqual(JSON.parse(readFileSync(claimPath, 'utf8')), liveClaim);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock priority claims expire when a live process stops refreshing the handoff', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-claim-stale-live-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const claimPath = `${lockPath}.priority-claim`;
    writeFileSync(claimPath, JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now() - 10_000,
      updatedAtMs: Date.now() - 10_000,
      token: 'abandoned-live-process-claim',
      processInstanceFingerprint: null,
    }), 'utf8');

    const result = withWorkspaceBundleLockSync(
      () => 'acquired',
      {
        lockPath,
        timeoutMs: 200,
        pollIntervalMs: 5,
        staleAfterMs: 5_000,
        initializationGraceMs: 5,
        priorityClaimStaleAfterMs: 20,
      },
    );

    assert.equal(result, 'acquired');
    assert.equal(existsSync(claimPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock priority claim cleanup preserves a concurrently installed successor claim', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-claim-successor-'));
  try {
    const moduleUrl = new URL('./workspaceBundleLock.mjs', import.meta.url).href;
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const claimPath = `${lockPath}.priority-claim`;
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';

const lockPath = ${JSON.stringify(lockPath)};
const claimPath = ${JSON.stringify(claimPath)};
const successorClaim = {
  pid: process.pid,
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
  token: 'successor-claim',
  processInstanceFingerprint: 'successor-incarnation',
};
const originalRenameSync = fs.renameSync;
let injected = false;
fs.renameSync = function patchedRenameSync(from, to) {
  if (String(from) === claimPath && !injected) {
    injected = true;
    fs.writeFileSync(claimPath, JSON.stringify(successorClaim), 'utf8');
  }
  return originalRenameSync.call(this, from, to);
};
syncBuiltinESMExports();

const { withWorkspaceBundleLock } = await import(${JSON.stringify(moduleUrl)});
let innerPromise;
await withWorkspaceBundleLock(
  async () => {
    innerPromise = withWorkspaceBundleLock(
      async () => 'inner',
      { lockPath, timeoutMs: 2_000, pollIntervalMs: 5, staleAfterMs: 5_000 },
    );
    while (!fs.existsSync(claimPath)) await sleep(2);
  },
  { lockPath, timeoutMs: 2_000, pollIntervalMs: 5, staleAfterMs: 5_000 },
);
assert.equal(await innerPromise, 'inner');
assert.equal(injected, true);
assert.deepEqual(JSON.parse(fs.readFileSync(claimPath, 'utf8')), successorClaim);
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock permits exact-path reentry when the caller inherited the lock', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-reentry-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');

    const result = await withWorkspaceBundleLock(
      async ({ heldLockValue }) =>
        await withWorkspaceBundleLock(
          async () => 'nested',
          {
            lockPath,
            heldLockPath: heldLockValue,
            timeoutMs: 60,
            pollIntervalMs: 10,
            staleAfterMs: 1_000,
          },
        ),
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.equal(result, 'nested');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock permits authenticated reentry through a filesystem path alias', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-alias-reentry-'));
  try {
    const physicalDir = join(tempRoot, 'physical');
    const aliasDir = join(tempRoot, 'alias');
    mkdirSync(physicalDir);
    symlinkSync(physicalDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');
    const physicalLockPath = join(physicalDir, 'workspace-bundling.lock');
    const aliasLockPath = join(aliasDir, 'workspace-bundling.lock');

    const result = await withWorkspaceBundleLock(
      async ({ heldLockValue }) =>
        await withWorkspaceBundleLock(
          async ({ inherited }) => ({ inherited, value: 'nested' }),
          {
            lockPath: physicalLockPath,
            heldLockValue,
            timeoutMs: 60,
            pollIntervalMs: 10,
            staleAfterMs: 1_000,
          },
        ),
      {
        lockPath: aliasLockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.deepEqual(result, { inherited: true, value: 'nested' });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock rejects path-only inheritance while another owner holds the path', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-path-only-reentry-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');

    await withWorkspaceBundleLock(
      async () => {
        await assert.rejects(
          () => withWorkspaceBundleLock(
            async () => 'nested',
            {
              lockPath,
              heldLockPath: lockPath,
              timeoutMs: 60,
              pollIntervalMs: 10,
              staleAfterMs: 1_000,
            },
          ),
          /Timed out waiting for workspace bundle lock/,
        );
        assert.equal(existsSync(`${lockPath}.priority-claim`), false, 'a timed-out claimant must clear its claim');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock does not let a released owner lease bypass its successor', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-successor-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    let releasedOwnerLease = '';

    await withWorkspaceBundleLock(
      async ({ heldLockValue }) => {
        releasedOwnerLease = heldLockValue;
      },
      { lockPath, timeoutMs: 2_000, pollIntervalMs: 10, staleAfterMs: 1_000 },
    );
    assert.equal(typeof releasedOwnerLease, 'string');
    assert.notEqual(releasedOwnerLease, '');

    await withWorkspaceBundleLock(
      async () => {
        await assert.rejects(
          () => withWorkspaceBundleLock(
            async () => 'nested',
            {
              lockPath,
              heldLockPath: releasedOwnerLease,
              timeoutMs: 60,
              pollIntervalMs: 10,
              staleAfterMs: 1_000,
            },
          ),
          /Timed out waiting for workspace bundle lock/,
        );
      },
      { lockPath, timeoutMs: 2_000, pollIntervalMs: 10, staleAfterMs: 1_000 },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock marks contention timeout as a retryable lock outcome', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-timeout-code-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    await withWorkspaceBundleLock(
      async () => {
        await assert.rejects(
          withWorkspaceBundleLock(
            async () => {},
            {
              lockPath,
              timeoutMs: 20,
              pollIntervalMs: 5,
              staleAfterMs: 1_000,
            },
          ),
          (error) => error?.code === 'EWORKSPACEBUNDLELOCKTIMEOUT',
        );
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock does not treat a different inherited lock as ownership', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-reentry-mismatch-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const differentLockPath = join(tempRoot, 'different.lock');

    await withWorkspaceBundleLock(
      async () => {
        await assert.rejects(
          () =>
            withWorkspaceBundleLock(
              async () => 'nested',
              {
                lockPath,
                heldLockPath: differentLockPath,
                timeoutMs: 60,
                pollIntervalMs: 10,
                staleAfterMs: 1_000,
              },
            ),
          /Timed out waiting for workspace bundle lock/,
        );
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock does not honor an inherited token when the lock file is absent', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-stale-token-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    let observedInherited = null;
    let lockPresentInsideFn = null;

    const result = await withWorkspaceBundleLock(
      async ({ inherited }) => {
        observedInherited = inherited;
        lockPresentInsideFn = existsSync(lockPath);
        return 'ran';
      },
      {
        // Matching token, but no parent actually holds the lock (file absent).
        lockPath,
        heldLockPath: lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
      },
    );

    assert.equal(result, 'ran');
    assert.equal(observedInherited, false, 'a stale token with no live lock must not bypass acquisition');
    assert.equal(lockPresentInsideFn, true, 'the caller must acquire its own lock when none is held');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLockSync uses the shared workspace bundle lock owner format', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-sync-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    let observedOwner = null;

    const result = withWorkspaceBundleLockSync(
      () => {
        observedOwner = JSON.parse(readFileSync(lockPath, 'utf8'));
        return 'ok';
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
        readProcessInstanceFingerprintSyncImpl: () => 'test-process-instance',
      },
    );

    assert.equal(result, 'ok');
    assert.equal(observedOwner.pid, process.pid);
    assert.equal(typeof observedOwner.createdAtMs, 'number');
    assert.equal(typeof observedOwner.processInstanceFingerprint, 'string');
    assert.notEqual(observedOwner.processInstanceFingerprint, '');
    assert.equal(typeof observedOwner.token, 'string');
    assert.notEqual(observedOwner.token, '');
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle locks reclaim a reused live pid only when the exact process incarnation differs', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-reused-pid-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      token: 'predecessor-token',
      processInstanceFingerprint: 'old-incarnation',
    }), 'utf8');

    const result = withWorkspaceBundleLockSync(
      () => 'acquired',
      {
        lockPath,
        timeoutMs: 100,
        pollIntervalMs: 5,
        staleAfterMs: 60_000,
        readProcessInstanceFingerprintSyncImpl: () => 'current-incarnation',
      },
    );

    assert.equal(result, 'acquired');
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle locks re-observe a matching live pid before reclaiming its replacement incarnation', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-reused-pid-during-wait-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      token: 'incumbent-token',
      processInstanceFingerprint: 'incumbent-incarnation',
    }), 'utf8');

    let observationCount = 0;
    let replacementObserved = false;
    let incumbentReplaced = false;
    const result = withWorkspaceBundleLockSync(
      () => 'acquired',
      {
        lockPath,
        timeoutMs: 200,
        pollIntervalMs: 5,
        staleAfterMs: 60_000,
        isRunningPidImpl: () => true,
        readProcessInstanceFingerprintSyncImpl: () => {
          observationCount += 1;
          if (observationCount === 1) return 'claimant-incarnation';
          if (!incumbentReplaced) return 'incumbent-incarnation';
          replacementObserved = true;
          return 'replacement-incarnation';
        },
        onWait: () => {
          incumbentReplaced = true;
        },
      },
    );

    assert.equal(result, 'acquired');
    assert.equal(incumbentReplaced, true);
    assert.equal(replacementObserved, true);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle locks give young empty owner files a bounded initialization window', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-initializing-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    writeFileSync(lockPath, '', 'utf8');

    assert.throws(
      () => withWorkspaceBundleLockSync(() => 'must not run', {
        lockPath,
        timeoutMs: 30,
        pollIntervalMs: 5,
        staleAfterMs: 60_000,
        initializationGraceMs: 1_000,
      }),
      /Timed out waiting for workspace bundle lock/,
    );
    assert.equal(existsSync(lockPath), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle locks reclaim a stable partial owner after the initialization window', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-partial-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    writeFileSync(lockPath, '{"pid":', 'utf8');
    const old = new Date(Date.now() - 2_000);
    utimesSync(lockPath, old, old);

    const result = withWorkspaceBundleLockSync(() => 'acquired', {
      lockPath,
      timeoutMs: 100,
      pollIntervalMs: 5,
      staleAfterMs: 60_000,
      initializationGraceMs: 50,
    });
    assert.equal(result, 'acquired');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock protection completes before owner content is written', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-protection-order-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    let protectionCalls = 0;

    withWorkspaceBundleLockSync(
      () => {
        assert.notEqual(readFileSync(lockPath, 'utf8'), '');
      },
      {
        lockPath,
        protectLockFileImpl: (path) => {
          protectionCalls += 1;
          assert.equal(path, lockPath);
          assert.equal(readFileSync(lockPath, 'utf8'), '');
        },
      },
    );

    assert.equal(protectionCalls, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock applies the Windows DACL before writing owner content', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-windows-dacl-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const calls = [];
    withWorkspaceBundleLockSync(
      () => {
        assert.notEqual(readFileSync(lockPath, 'utf8'), '');
      },
      {
        lockPath,
        platform: 'win32',
        env: { username: 'alice', SystemRoot: 'C:\\Windows', PATH: '' },
        readProcessInstanceFingerprintSyncImpl: () => 'win32-cim:current',
        spawnSyncImpl: (command, args, spawnOptions) => {
          calls.push({ command, args, shell: spawnOptions?.shell });
          assert.equal(readFileSync(lockPath, 'utf8'), '');
          return { status: 0, signal: null, stdout: '', stderr: '' };
        },
      },
    );
    assert.deepEqual(calls, [{
      command: 'C:\\Windows\\System32\\icacls.exe',
      args: [lockPath, '/inheritance:r', '/grant:r', 'alice:(F)'],
      shell: false,
    }]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock resolves Windows system roots case-insensitively with WINDIR fallback', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-windows-root-'));
  try {
    const cases = [
      {
        lockPath: join(tempRoot, 'system-root.lock'),
        env: { USERNAME: 'alice', sYsTeMrOoT: 'C:\\Windows', PATH: '' },
        expectedCommand: 'C:\\Windows\\System32\\icacls.exe',
      },
      {
        lockPath: join(tempRoot, 'windir.lock'),
        env: { USERNAME: 'alice', wInDiR: 'D:\\Windows', PATH: '' },
        expectedCommand: 'D:\\Windows\\System32\\icacls.exe',
      },
    ];

    for (const { lockPath, env, expectedCommand } of cases) {
      let command = null;
      withWorkspaceBundleLockSync(
        () => {
          assert.notEqual(readFileSync(lockPath, 'utf8'), '');
        },
        {
          lockPath,
          platform: 'win32',
          env,
          readProcessInstanceFingerprintSyncImpl: () => 'win32-cim:current',
          spawnSyncImpl: (value, args) => {
            command = value;
            assert.equal(readFileSync(args[0], 'utf8'), '');
            return { status: 0, signal: null, stdout: '', stderr: '' };
          },
        },
      );
      assert.equal(command, expectedCommand);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle locks fail closed when Windows DACL protection cannot run', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-windows-protection-failure-'));
  try {
    const missingRootLockPath = join(tempRoot, 'missing-root.lock');
    let missingRootSpawned = false;
    assert.throws(
      () => withWorkspaceBundleLockSync(() => 'must not run', {
        lockPath: missingRootLockPath,
        platform: 'win32',
        env: { USERNAME: 'alice', PATH: '' },
        readProcessInstanceFingerprintSyncImpl: () => 'win32-cim:current',
        spawnSyncImpl: () => {
          missingRootSpawned = true;
          return { status: 0, signal: null, stdout: '', stderr: '' };
        },
      }),
      /absolute Windows system root/,
    );
    assert.equal(missingRootSpawned, false);
    assert.equal(existsSync(missingRootLockPath), false);

    const failureCases = [
      {
        lockPath: join(tempRoot, 'spawn-error.lock'),
        result: { error: new Error('spawn ENOENT'), status: null, signal: null, stdout: '', stderr: '' },
      },
      {
        lockPath: join(tempRoot, 'nonzero.lock'),
        result: { status: 5, signal: null, stdout: '', stderr: 'access denied' },
      },
    ];
    for (const { lockPath, result } of failureCases) {
      assert.throws(
        () => withWorkspaceBundleLockSync(() => 'must not run', {
          lockPath,
          platform: 'win32',
          env: { USERNAME: 'alice', SystemRoot: 'C:\\Windows', PATH: '' },
          readProcessInstanceFingerprintSyncImpl: () => 'win32-cim:current',
          spawnSyncImpl: () => result,
        }),
        /Failed to protect workspace bundle lock/,
      );
      assert.equal(existsSync(lockPath), false);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock applies the Windows DACL before writing priority claim content', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-claim-windows-dacl-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const claimPath = `${lockPath}.priority-claim`;
    const protectedPaths = [];
    const options = {
      lockPath,
      timeoutMs: 2_000,
      pollIntervalMs: 5,
      staleAfterMs: 5_000,
      platform: 'win32',
      env: { USERNAME: 'alice', SystemRoot: 'C:\\Windows', PATH: '' },
      readProcessInstanceFingerprintSyncImpl: () => 'win32-cim:current',
      spawnSyncImpl: (_command, args) => {
        const path = args[0];
        protectedPaths.push(path);
        assert.equal(readFileSync(path, 'utf8'), '');
        return { status: 0, signal: null, stdout: '', stderr: '' };
      },
    };
    let contender;
    await withWorkspaceBundleLock(
      async () => {
        contender = withWorkspaceBundleLock(async () => 'contender', options);
        await waitForCondition(() => existsSync(claimPath), 'Windows priority claim');
      },
      options,
    );
    assert.equal(await contender, 'contender');
    assert.equal(protectedPaths.includes(claimPath), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle lock priority claims fail closed and clean up when protection fails', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-claim-protection-failure-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const claimPath = `${lockPath}.priority-claim`;
    await withWorkspaceBundleLock(
      async () => {
        await assert.rejects(
          () => withWorkspaceBundleLock(
            async () => 'must not run',
            {
              lockPath,
              timeoutMs: 200,
              pollIntervalMs: 5,
              protectLockFileImpl: (path) => {
                if (path === claimPath) throw new Error('claim protection failed');
              },
            },
          ),
          /claim protection failed/,
        );
        assert.equal(existsSync(claimPath), false);
      },
      { lockPath, timeoutMs: 2_000, pollIntervalMs: 5 },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle locks fail closed and clean up when pre-content protection fails', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-protection-failure-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    assert.throws(
      () => withWorkspaceBundleLockSync(() => 'must not run', {
        lockPath,
        protectLockFileImpl: () => {
          throw new Error('lock protection failed');
        },
      }),
      /lock protection failed/,
    );
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle locks clean up when the initial owner write fails', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-owner-write-'));
  try {
    const moduleUrl = new URL('./workspaceBundleLock.mjs', import.meta.url).href;
    const asyncLockPath = join(tempRoot, 'async.lock');
    const syncLockPath = join(tempRoot, 'sync.lock');
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const originalWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function patchedWriteFileSync(path, ...args) {
  if (typeof path === 'number') {
    const error = new Error('ENOSPC');
    error.code = 'ENOSPC';
    throw error;
  }
  return originalWriteFileSync.call(this, path, ...args);
};
syncBuiltinESMExports();

const { withWorkspaceBundleLock, withWorkspaceBundleLockSync } = await import(${JSON.stringify(moduleUrl)});
const asyncLockPath = ${JSON.stringify(asyncLockPath)};
const syncLockPath = ${JSON.stringify(syncLockPath)};

await assert.rejects(
  () => withWorkspaceBundleLock(async () => undefined, { lockPath: asyncLockPath }),
  /ENOSPC/,
);
assert.equal(fs.existsSync(asyncLockPath), false);

assert.throws(
  () => withWorkspaceBundleLockSync(() => undefined, { lockPath: syncLockPath }),
  /ENOSPC/,
);
assert.equal(fs.existsSync(syncLockPath), false);
`;

    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace bundle locks wait and time out when an existing owner file is unreadable', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-unreadable-'));
  try {
    const moduleUrl = new URL('./workspaceBundleLock.mjs', import.meta.url).href;
    const lockPath = join(tempRoot, 'unreadable.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }), 'utf8');
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const lockPath = ${JSON.stringify(lockPath)};
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function patchedReadFileSync(path, ...args) {
  if (String(path) === lockPath) {
    const error = new Error('EACCES');
    error.code = 'EACCES';
    throw error;
  }
  return originalReadFileSync.call(this, path, ...args);
};
syncBuiltinESMExports();

const { withWorkspaceBundleLock } = await import(${JSON.stringify(moduleUrl)});
let entered = false;
const startedAt = Date.now();
await assert.rejects(
  () => withWorkspaceBundleLock(
    async () => { entered = true; },
    { lockPath, timeoutMs: 60, pollIntervalMs: 10, staleAfterMs: 1 },
  ),
  /Timed out waiting for workspace bundle lock/,
);
assert.equal(entered, false);
assert.ok(Date.now() - startedAt >= 50);
`;

    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock does not reclaim an old lock while the owner pid is alive', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-live-owner-'));
  try {
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const owner = { pid: process.pid, createdAtMs: Date.now() - 60_000 };
    writeFileSync(lockPath, JSON.stringify(owner), 'utf8');
    let enteredCriticalSection = false;

    await assert.rejects(
      () =>
        withWorkspaceBundleLock(
          async () => {
            enteredCriticalSection = true;
          },
          {
            lockPath,
            timeoutMs: 60,
            pollIntervalMs: 10,
            staleAfterMs: 10,
          },
        ),
      /Timed out waiting for workspace bundle lock/,
    );

    assert.equal(enteredCriticalSection, false);
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), owner);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock does not remove a successor owner lock while reclaiming a stale lock', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-bundle-lock-successor-'));
  try {
    const moduleUrl = new URL('./workspaceBundleLock.mjs', import.meta.url).href;
    const lockPath = join(tempRoot, 'workspace-bundling.lock');
    const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const lockPath = ${JSON.stringify(lockPath)};
const staleOwner = { pid: 999999, createdAtMs: Date.now() };
const successorOwner = { pid: process.pid, createdAtMs: Date.now() };

fs.writeFileSync(lockPath, JSON.stringify(staleOwner), 'utf8');

const originalRenameSync = fs.renameSync;
const originalUnlinkSync = fs.unlinkSync;
let injectedSuccessor = false;

function injectSuccessorOwner(path) {
  if (String(path) !== lockPath || injectedSuccessor) return;
  injectedSuccessor = true;
  fs.writeFileSync(lockPath, JSON.stringify(successorOwner), 'utf8');
}

fs.renameSync = function patchedRenameSync(from, to) {
  injectSuccessorOwner(from);
  return originalRenameSync.call(this, from, to);
};

fs.unlinkSync = function patchedUnlinkSync(path) {
  injectSuccessorOwner(path);
  return originalUnlinkSync.call(this, path);
};

syncBuiltinESMExports();

const { withWorkspaceBundleLock } = await import(${JSON.stringify(moduleUrl)});
let enteredCriticalSection = false;

await assert.rejects(
  () =>
    withWorkspaceBundleLock(
      async () => {
        enteredCriticalSection = true;
      },
      {
        lockPath,
        timeoutMs: 80,
        pollIntervalMs: 10,
        staleAfterMs: 120_000,
      },
    ),
  /Timed out waiting for workspace bundle lock/,
);

assert.equal(injectedSuccessor, true);
assert.equal(enteredCriticalSection, false);
const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
assert.equal(owner.pid, successorOwner.pid);
assert.equal(owner.createdAtMs, successorOwner.createdAtMs);
`;

    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('withWorkspaceBundleLock fails closed and preserves a successor when quarantine recovery fails', () => {
  const result = runWorkspaceQuarantineReadFailureCase('async');
  assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
});

test('withWorkspaceBundleLockSync fails closed and preserves a successor when quarantine recovery fails', () => {
  const result = runWorkspaceQuarantineReadFailureCase('sync');
  assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
});

test('withWorkspaceBundleLock retires multiple proven-dead retained locks before acquiring', async () => {
  await runRetainedHistoryCase('async', { includeInconclusiveOwner: false });
});

test('withWorkspaceBundleLockSync retires multiple proven-dead retained locks before acquiring', async () => {
  await runRetainedHistoryCase('sync', { includeInconclusiveOwner: false });
});

test('withWorkspaceBundleLock retires stale history and restores one inconclusive retained owner', async () => {
  await runRetainedHistoryCase('async', { includeInconclusiveOwner: true });
});

test('withWorkspaceBundleLockSync retires stale history and restores one inconclusive retained owner', async () => {
  await runRetainedHistoryCase('sync', { includeInconclusiveOwner: true });
});

test('withWorkspaceBundleLock restores the newest duplicate snapshot for one authenticated owner', async () => {
  await runDuplicateRetainedOwnerCase('async');
});

test('withWorkspaceBundleLockSync restores the newest duplicate snapshot for one authenticated owner', async () => {
  await runDuplicateRetainedOwnerCase('sync');
});

test('withWorkspaceBundleLock keeps distinct authenticated retained owners ambiguous', async () => {
  await runDistinctRetainedOwnerCase('async');
});

test('withWorkspaceBundleLockSync keeps distinct authenticated retained owners ambiguous', async () => {
  await runDistinctRetainedOwnerCase('sync');
});

test('withWorkspaceBundleLock revalidates retained owners after create and preserves a successor', () => {
  const result = runPostCreateRetainedRaceCase('async');
  assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
});

test('withWorkspaceBundleLockSync revalidates retained owners after create and preserves a successor', () => {
  const result = runPostCreateRetainedRaceCase('sync');
  assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
});

test('withWorkspaceBundleLock stale-history retirement preserves replacement bytes', () => {
  const result = runRetainedHistoryReplacementCase('async');
  assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
});

test('withWorkspaceBundleLockSync stale-history retirement preserves replacement bytes', () => {
  const result = runRetainedHistoryReplacementCase('sync');
  assert.equal(result.status, 0, result.stderr || result.stdout || `signal=${String(result.signal)}`);
});
