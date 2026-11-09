import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { createListenerOwnershipObservationScope } from './listener_ownership.mjs';
import { waitForServerReady } from './server.mjs';
import {
  createServerStartupAttempt,
  startServerWithOwnershipProof,
  terminateServerStartupChild,
} from './server_startup_attempt.mjs';

async function createBaseDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hstack-startup-attempt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('each attempt owns a private directory and a fresh nonce handed only to its spawn', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  const first = await createServerStartupAttempt({ stackBaseDir, env: {} });
  const second = await createServerStartupAttempt({ stackBaseDir, env: {} });

  assert.equal(isAbsolute(first.path), true);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(dirname(first.path), dirname(second.path));
  assert.deepEqual(first.env, {
    HAPPIER_SERVER_STARTUP_RECEIPT_PATH: first.path,
    HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: first.nonce,
  });
  assert.equal((await stat(dirname(first.path))).isDirectory(), true);
});

test('disposal removes only its own attempt', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  const first = await createServerStartupAttempt({ stackBaseDir, env: {} });
  const second = await createServerStartupAttempt({ stackBaseDir, env: {} });
  await writeFile(first.path, '{}');
  await writeFile(second.path, '{}');

  await first.dispose();

  assert.equal(existsSync(dirname(first.path)), false);
  assert.equal(existsSync(second.path), true);
});

test('a failed attempt is kept and reported until termination is confirmed', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  const attempt = await createServerStartupAttempt({ stackBaseDir, env: {} });
  const reports = [];

  await attempt.settleFailure({ terminated: false, report: (message) => reports.push(message) });
  assert.equal(existsSync(dirname(attempt.path)), true);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].includes(dirname(attempt.path)), true);

  await attempt.settleFailure({ terminated: true, report: (message) => reports.push(message) });
  assert.equal(existsSync(dirname(attempt.path)), false);
  assert.equal(reports.length, 1);
});

test('a role that never listens cannot be armed for an API ownership proof', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  await assert.rejects(
    createServerStartupAttempt({ stackBaseDir, env: { SERVER_ROLE: 'worker' } }),
    (error) => error.code === 'ESERVERROLEUNPROVABLE',
  );
  await (await createServerStartupAttempt({ stackBaseDir, env: { SERVER_ROLE: 'api' } })).dispose();
  await (await createServerStartupAttempt({ stackBaseDir, env: { SERVER_ROLE: 'all' } })).dispose();
});

const stableIdentityBoundary = { runCaptureImpl: async () => '2026-11-06T20:00:00.0000000Z' };

function createStartupScenario(stackBaseDir, overrides = {}) {
  const events = [];
  const child = { pid: 321, exitCode: null };
  const spawnEnvs = [];
  return {
    events,
    child,
    spawnEnvs,
    params: {
      stackBaseDir,
      env: { PORT: '53944' },
      endpoint: { host: '127.0.0.1', port: 53944 },
      exactProcess: true,
      spawnServer: async (env) => {
        spawnEnvs.push(env);
        events.push('spawn');
        return child;
      },
      waitForReady: async () => events.push('ready'),
      recordOwnership: async ({ proof }) => events.push(`record:${proof.proof}`),
      terminateServer: async () => {
        events.push('terminate');
        return true;
      },
      ...overrides,
    },
    dependencies: {
      ownershipBoundary: stableIdentityBoundary,
      proveImpl: async ({ attempt, exactProcess, spawned }) => {
        events.push(`prove:${exactProcess}:${spawned.pid}:${existsSync(dirname(attempt.path))}`);
        return { proof: 'api_identity', listenerPid: 321, wrapperPid: 321, receiptSettled: true, verifiedProcessInstances: null };
      },
    },
  };
}

const armedDirectory = (scenario) => dirname(scenario.spawnEnvs[0].HAPPIER_SERVER_STARTUP_RECEIPT_PATH);

test('startup records the proven server, then removes the attempt', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  const scenario = createStartupScenario(stackBaseDir);
  await startServerWithOwnershipProof(scenario.params, scenario.dependencies);

  assert.deepEqual(scenario.events, ['spawn', 'ready', 'prove:true:321:true', 'record:api_identity']);
  assert.equal(existsSync(armedDirectory(scenario)), false);
  assert.equal(scenario.params.env.HAPPIER_SERVER_STARTUP_RECEIPT_PATH, undefined);
});

test('a proof without a receipt keeps the attempt, because the running server could still write one', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  const reports = [];
  const scenario = createStartupScenario(stackBaseDir);
  scenario.dependencies.report = (message) => reports.push(message);
  scenario.dependencies.proveImpl = async () => ({
    proof: 'os_listener',
    listenerPid: 321,
    wrapperPid: 321,
    receiptSettled: false,
    verifiedProcessInstances: null,
  });

  await startServerWithOwnershipProof(scenario.params, scenario.dependencies);

  assert.equal(existsSync(armedDirectory(scenario)), true);
  assert.equal(reports.length, 1);
});

test('a failed proof terminates the server before the attempt is removed', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  const scenario = createStartupScenario(stackBaseDir);
  scenario.dependencies.proveImpl = async () => {
    throw Object.assign(new Error('unproven'), { code: 'ESERVEROWNERSHIPUNPROVEN' });
  };
  let attemptExistedAtTermination = null;
  scenario.params.terminateServer = async () => {
    attemptExistedAtTermination = existsSync(armedDirectory(scenario));
    return true;
  };

  await assert.rejects(
    startServerWithOwnershipProof(scenario.params, scenario.dependencies),
    (error) => error.code === 'ESERVEROWNERSHIPUNPROVEN',
  );
  assert.equal(attemptExistedAtTermination, true);
  assert.equal(existsSync(armedDirectory(scenario)), false);
});

test('an unconfirmed termination keeps the attempt so a late server write cannot escape', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  const reports = [];
  const scenario = createStartupScenario(stackBaseDir, { terminateServer: async () => false });
  scenario.dependencies.proveImpl = async () => {
    throw new Error('unproven');
  };
  scenario.dependencies.report = (message) => reports.push(message);

  await assert.rejects(startServerWithOwnershipProof(scenario.params, scenario.dependencies), /unproven/);
  assert.equal(existsSync(armedDirectory(scenario)), true);
  assert.equal(reports.length, 1);
});

test('a runtime projection failure keeps the proven server running', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  const scenario = createStartupScenario(stackBaseDir, {
    recordOwnership: async () => {
      throw Object.assign(new Error('projection'), { code: 'ESERVERRUNTIMEPROJECTION' });
    },
  });

  await assert.rejects(
    startServerWithOwnershipProof(scenario.params, scenario.dependencies),
    (error) => error.code === 'ESERVERRUNTIMEPROJECTION',
  );
  assert.equal(scenario.events.includes('terminate'), false);
  assert.equal(existsSync(armedDirectory(scenario)), false);
});

test('shutdown during startup reaches the proof and the identity capture through one lifetime', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  const controller = new AbortController();
  const scenario = createStartupScenario(stackBaseDir, { signal: controller.signal });
  let captureCancelled = false;
  scenario.dependencies.ownershipBoundary = {
    platform: 'win32',
    runCaptureImpl: (_command, _args, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        captureCancelled = true;
        reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
      }, { once: true });
    }),
  };
  scenario.dependencies.proveImpl = ({ spawned }) => new Promise((_resolve, reject) => {
    spawned.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    controller.abort();
  });

  await assert.rejects(startServerWithOwnershipProof(scenario.params, scenario.dependencies), /cancelled/);
  assert.equal(captureCancelled, true);
  assert.equal(scenario.events.includes('terminate'), true);
});

test('a spawn failure leaves no attempt behind', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  let armedPath = null;
  const scenario = createStartupScenario(stackBaseDir, {
    spawnServer: async (env) => {
      armedPath = env.HAPPIER_SERVER_STARTUP_RECEIPT_PATH;
      throw new Error('spawn failed');
    },
  });
  await assert.rejects(startServerWithOwnershipProof(scenario.params, scenario.dependencies), /spawn failed/);
  assert.equal(existsSync(dirname(armedPath)), false);
  assert.equal(scenario.events.includes('terminate'), false);
});

test('a failed startup survives a taskkill slower than the default grace', async () => {
  let alive = true;
  let taskkillAborted = false;
  const boundary = {
    platform: 'win32',
    isPidAlive: () => alive,
    observePidLiveness: () => ({ status: alive ? 'alive' : 'dead' }),
    spawn: () => {
      const taskkill = new EventEmitter();
      const finished = setTimeout(() => {
        alive = false;
        taskkill.emit('exit', 0);
      }, 1_200);
      taskkill.kill = () => {
        taskkillAborted = true;
        clearTimeout(finished);
      };
      return taskkill;
    },
  };

  assert.equal(await terminateServerStartupChild({ pid: 4242, exitCode: null }, { env: {}, boundary }), true);
  assert.equal(taskkillAborted, false);
});

test('the readiness wait does not consume the proof budget that started at spawn', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  let now = 0;
  const scenario = createStartupScenario(stackBaseDir, {
    waitForReady: async () => {
      now += 500_000;
    },
  });
  scenario.dependencies.ownershipBoundary = {
    ...stableIdentityBoundary,
    observationScope: createListenerOwnershipObservationScope({ totalTimeoutMs: 1_000, nowImpl: () => now }),
  };
  const remaining = [];
  const prove = scenario.dependencies.proveImpl;
  scenario.dependencies.proveImpl = (request) => {
    remaining.push(request.spawned.observationScope.remainingMs());
    return prove(request);
  };

  await startServerWithOwnershipProof(scenario.params, scenario.dependencies);

  assert.deepEqual(remaining, [1_000]);
});

test('cancelling during readiness reaches failure cleanup while the child stays alive and termination is unconfirmed', async (t) => {
  const stackBaseDir = await createBaseDir(t);
  const stalled = createServer(() => {});
  await new Promise((resolve) => stalled.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    stalled.closeAllConnections();
    stalled.close(resolve);
  }));
  const controller = new AbortController();
  const reports = [];
  const scenario = createStartupScenario(stackBaseDir, {
    signal: controller.signal,
    waitForReady: (child, { signal }) => waitForServerReady(`http://127.0.0.1:${stalled.address().port}`, {
      timeoutMs: 1,
      intervalMs: 5,
      continueWhileChildAlive: true,
      onTimeoutCheckpoint: () => {},
      childProcess: Object.assign(new EventEmitter(), { ...child, signalCode: null }),
      signal,
    }),
    terminateServer: async () => {
      scenario.events.push('terminate');
      return false;
    },
  });
  scenario.dependencies.report = (message) => reports.push(message);

  setTimeout(() => controller.abort(), 20);
  const outcome = await Promise.race([
    startServerWithOwnershipProof(scenario.params, scenario.dependencies).then(
      () => 'resolved',
      (error) => error.code,
    ),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 1_000)),
  ]);

  assert.equal(outcome, 'ESERVERREADINESSCANCELLED');
  assert.equal(scenario.events.includes('terminate'), true);
  assert.equal(existsSync(armedDirectory(scenario)), true);
  assert.equal(reports.length, 1);
});
