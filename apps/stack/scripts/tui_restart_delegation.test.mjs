import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import {
  beginTuiRestartOperation,
  createTuiRuntimeOwnershipTracker,
  resolveTuiShutdownChildren,
} from './utils/tui/restart_operation.mjs';

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.killCalls = 0;
  }

  kill() {
    this.killCalls += 1;
  }

  exit(code = 0, signal = null) {
    this.exitCode = signal ? null : code;
    this.signalCode = signal;
    this.emit('exit', this.exitCode, signal);
  }
}

function createHarness({ previousChild = new FakeChild(101), replacementChild = new FakeChild(202), spawnError = null } = {}) {
  const tracked = [previousChild];
  const logs = [];
  const refreshes = [];
  const spawnArgs = [];
  const spawnChild = (args) => {
    spawnArgs.push([...args]);
    if (spawnError) throw spawnError;
    return replacementChild;
  };
  return {
    previousChild,
    replacementChild,
    tracked,
    logs,
    refreshes,
    spawnArgs,
    spawnChild,
    trackChild: (child) => tracked.push(child),
    log: (message) => logs.push(message),
    refresh: () => refreshes.push('refresh'),
  };
}

function begin(harness, currentOperation = null) {
  return beginTuiRestartOperation({
    currentOperation,
    previousChild: harness.previousChild,
    previousRuntimeOwner: { ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' },
    restartArgs: ['stack', 'dev', 'exp1', '--watch', '--restart'],
    spawnChild: harness.spawnChild,
    trackChild: harness.trackChild,
    log: harness.log,
    refresh: harness.refresh,
  });
}

test('TUI cleanup remains bound to the runtime owner admitted by its own child', () => {
  const tracker = createTuiRuntimeOwnershipTracker({
    runtimeOwnerBeforeSpawn: { ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' },
  });

  tracker.observe({
    runtimeOwner: { ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' },
    childActive: true,
  });
  assert.equal(tracker.getExpectedOwner(), null);

  tracker.observe({
    runtimeOwner: { ownerPid: 202, startedAt: '2026-07-21T08:00:00.000Z' },
    childActive: true,
  });
  assert.deepEqual(tracker.getExpectedOwner(), {
    ownerPid: 202,
    startedAt: '2026-07-21T08:00:00.000Z',
  });

  tracker.observe({
    runtimeOwner: { ownerPid: 303, startedAt: '2026-07-21T09:00:00.000Z' },
    childActive: false,
  });
  assert.deepEqual(tracker.getExpectedOwner(), {
    ownerPid: 202,
    startedAt: '2026-07-21T08:00:00.000Z',
  });
});

test('TUI reports a successful detached launcher completion without implying its runtime owner exited', async () => {
  const module = await import('./utils/tui/restart_operation.mjs');
  assert.equal(typeof module.formatTuiForwardedChildExit, 'function');
  assert.equal(
    module.formatTuiForwardedChildExit({ code: 0, signal: null, detachedBackgroundOwner: true }),
    'launcher completed (code=0); detached runtime continues independently',
  );
  assert.equal(
    module.formatTuiForwardedChildExit({ code: 1, signal: null, detachedBackgroundOwner: true }),
    'child exited (code=1, sig=null)',
  );
});

test('TUI can admit its detached owner after the short-lived launch wrapper exits', () => {
  const tracker = createTuiRuntimeOwnershipTracker({ runtimeOwnerBeforeSpawn: null });
  tracker.recordDetachedRunnerLogPath('/stacks/exp1/logs/dev.202.log');

  tracker.observe({
    runtimeOwner: { ownerPid: 202, startedAt: '2026-07-21T08:00:00.000Z' },
    childActive: false,
    launchRequested: true,
    runtimeRunnerLogPath: '/stacks/exp1/logs/dev.202.log',
  });

  assert.deepEqual(tracker.getExpectedOwner(), {
    ownerPid: 202,
    startedAt: '2026-07-21T08:00:00.000Z',
  });
});

test('TUI only adopts a detached owner after its own runner log identifies the runtime', () => {
  const tracker = createTuiRuntimeOwnershipTracker({ runtimeOwnerBeforeSpawn: null });
  const runtimeOwner = { ownerPid: 202, startedAt: '2026-07-21T08:00:00.000Z' };

  tracker.observe({
    runtimeOwner,
    childActive: false,
    launchRequested: true,
    runtimeRunnerLogPath: '/stacks/exp1/logs/unrelated.log',
  });
  assert.equal(tracker.getExpectedOwner(), null);

  tracker.recordDetachedRunnerLogPath('/stacks/exp1/logs/dev.202.log');
  tracker.observe({
    runtimeOwner,
    childActive: false,
    launchRequested: true,
    runtimeRunnerLogPath: '/stacks/exp1/logs/unrelated.log',
  });
  assert.equal(tracker.getExpectedOwner(), null);

  tracker.observe({
    runtimeOwner,
    childActive: false,
    launchRequested: true,
    runtimeRunnerLogPath: '/stacks/exp1/logs/dev.202.log',
  });
  assert.deepEqual(tracker.getExpectedOwner(), runtimeOwner);
});

test('TUI does not admit a changed owner while its detached launcher is still active without matching runner evidence', () => {
  const tracker = createTuiRuntimeOwnershipTracker({
    runtimeOwnerBeforeSpawn: { ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' },
  });
  const unrelatedOwner = { ownerPid: 202, startedAt: '2026-07-21T08:00:00.000Z' };

  tracker.observe({
    runtimeOwner: unrelatedOwner,
    childActive: true,
    launchRequested: true,
    runtimeRunnerLogPath: '/stacks/exp1/logs/unrelated.log',
  });
  assert.equal(tracker.getExpectedOwner(), null);

  tracker.recordDetachedRunnerLogPath('/stacks/exp1/logs/dev.303.log');
  tracker.observe({
    runtimeOwner: unrelatedOwner,
    childActive: true,
    launchRequested: true,
    runtimeRunnerLogPath: '/stacks/exp1/logs/unrelated.log',
  });
  assert.equal(tracker.getExpectedOwner(), null);

  const launchedOwner = { ownerPid: 303, startedAt: '2026-07-21T08:05:00.000Z' };
  tracker.observe({
    runtimeOwner: launchedOwner,
    childActive: true,
    launchRequested: true,
    runtimeRunnerLogPath: '/stacks/exp1/logs/dev.303.log',
  });
  assert.deepEqual(tracker.getExpectedOwner(), launchedOwner);
});

test('TUI does not transfer restart stop authority until the replacement runner matches', () => {
  const tracker = createTuiRuntimeOwnershipTracker({ runtimeOwnerBeforeSpawn: null });
  const incumbentOwner = { ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' };
  tracker.recordDetachedRunnerLogPath('/stacks/exp1/logs/dev.101.log');
  tracker.observe({
    runtimeOwner: incumbentOwner,
    childActive: false,
    launchRequested: true,
    runtimeRunnerLogPath: '/stacks/exp1/logs/dev.101.log',
  });
  tracker.clearDetachedRunnerLogPath();

  const unrelatedReplacement = { ownerPid: 202, startedAt: '2026-07-21T08:00:00.000Z' };
  tracker.observe({
    runtimeOwner: unrelatedReplacement,
    childActive: true,
    launchRequested: true,
    runtimeRunnerLogPath: '/stacks/exp1/logs/dev.101.log',
    replacementCandidate: true,
  });
  assert.deepEqual(tracker.getExpectedOwner(), incumbentOwner);

  const launchedReplacement = { ownerPid: 303, startedAt: '2026-07-21T08:05:00.000Z' };
  tracker.recordDetachedRunnerLogPath('/stacks/exp1/logs/dev.303.log');
  tracker.observe({
    runtimeOwner: launchedReplacement,
    childActive: true,
    launchRequested: true,
    runtimeRunnerLogPath: '/stacks/exp1/logs/dev.303.log',
    replacementCandidate: true,
  });
  assert.deepEqual(tracker.getExpectedOwner(), launchedReplacement);
});

test('restart refuses to spawn until the incumbent runtime owner incarnation is known', () => {
  const harness = createHarness();

  const result = beginTuiRestartOperation({
    previousChild: harness.previousChild,
    previousRuntimeOwner: { ownerPid: 101, startedAt: 'not-a-timestamp' },
    restartArgs: ['stack', 'dev', 'exp1', '--watch', '--restart'],
    spawnChild: harness.spawnChild,
    trackChild: harness.trackChild,
    log: harness.log,
    refresh: harness.refresh,
  });

  assert.equal(result.started, false);
  assert.equal(result.reason, 'missing_runtime_owner');
  assert.equal(harness.spawnArgs.length, 0);
  assert.match(harness.logs.at(-1), /current runtime owner evidence is unavailable/i);
});

test('restart recovers a terminal child when no runtime owner remains', () => {
  const harness = createHarness();
  harness.previousChild.exit(1);

  const result = beginTuiRestartOperation({
    previousChild: harness.previousChild,
    previousRuntimeOwner: null,
    restartArgs: ['stack', 'dev', 'exp1', '--watch', '--restart'],
    spawnChild: harness.spawnChild,
    trackChild: harness.trackChild,
    log: harness.log,
    refresh: harness.refresh,
  });

  assert.equal(result.started, true);
  assert.equal(result.reason, 'started');
  assert.deepEqual(harness.spawnArgs, [['stack', 'dev', 'exp1', '--watch', '--restart']]);
  assert.equal(result.replacementChild, harness.replacementChild);
});

test('terminal replacement startup failure preserves the incumbent lifecycle owner', () => {
  const harness = createHarness();

  const result = begin(harness);
  harness.replacementChild.exit(1);

  assert.equal(result.operation.pending, false);
  assert.equal(harness.previousChild.killCalls, 0);
  assert.equal(harness.previousChild.exitCode, null);
  assert.equal(harness.tracked.at(-1), harness.previousChild);
  assert.deepEqual(result.operation.getActiveChildren(), [harness.previousChild]);
  assert.match(harness.logs.at(-1), /replacement.*exited.*previous runtime preserved/i);
});

test('terminal replacement process failure leaves the incumbent OS process alive', async (t) => {
  const previousChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  t.after(() => {
    if (previousChild.exitCode == null && previousChild.signalCode == null) previousChild.kill('SIGKILL');
  });
  const tracked = [];
  const result = beginTuiRestartOperation({
    previousChild,
    previousRuntimeOwner: { ownerPid: previousChild.pid, startedAt: '2026-07-21T07:50:00.000Z' },
    restartArgs: [],
    spawnChild: () => spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' }),
    trackChild: (child) => tracked.push(child),
  });

  const deadline = Date.now() + 3_000;
  while (result.operation.pending && Date.now() < deadline) {
    await delay(10);
  }

  assert.equal(result.operation.pending, false);
  assert.equal(previousChild.exitCode, null);
  assert.equal(previousChild.signalCode, null);
  assert.equal(tracked.at(-1), previousChild);
  assert.doesNotThrow(() => process.kill(previousChild.pid, 0));
});

test('new runtime owner observation admits the replacement and transfers active-child ownership', () => {
  const harness = createHarness();
  const result = begin(harness);

  harness.previousChild.exit(0, 'SIGTERM');
  result.operation.observeRuntimeOwner({ ownerPid: 303, startedAt: '2026-07-21T08:00:00.000Z' });

  assert.equal(result.operation.pending, false);
  assert.equal(harness.tracked.at(-1), harness.replacementChild);
  assert.deepEqual(result.operation.getActiveChildren(), [harness.replacementChild]);
});

test('detached background restart waits for owner admission after its command exits successfully', () => {
  const harness = createHarness();
  const result = beginTuiRestartOperation({
    previousChild: harness.previousChild,
    previousRuntimeOwner: { ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' },
    restartArgs: ['stack', 'dev', 'exp1', '--background', '--restart'],
    backgroundOwner: true,
    spawnChild: harness.spawnChild,
    trackChild: harness.trackChild,
    log: harness.log,
    refresh: harness.refresh,
  });

  harness.replacementChild.exit(0);

  assert.equal(result.operation.pending, true);
  assert.match(harness.logs.at(-1), /detached.*waiting.*owner admission/i);
  assert.equal(
    result.operation.observeRuntimeOwner({ ownerPid: 303, startedAt: '2026-07-21T08:00:00.000Z' }),
    true,
  );
  assert.equal(result.operation.pending, false);
});

test('previous wrapper exit does not admit a replacement until a new runtime owner incarnation is observed', () => {
  const harness = createHarness();
  const first = beginTuiRestartOperation({
    previousChild: harness.previousChild,
    previousRuntimeOwner: { ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' },
    restartArgs: ['stack', 'dev', 'exp1', '--watch', '--restart'],
    spawnChild: harness.spawnChild,
    trackChild: harness.trackChild,
    log: harness.log,
    refresh: harness.refresh,
  });

  harness.previousChild.exit(0, 'SIGTERM');
  const second = begin(harness, first.operation);

  assert.equal(first.operation.pending, true);
  assert.equal(harness.tracked.at(-1), harness.replacementChild);
  assert.equal(second.started, false);
  assert.equal(harness.spawnArgs.length, 1);
  assert.equal(first.operation.observeRuntimeOwner({ ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' }), false);
  assert.equal(first.operation.pending, true);
  assert.equal(first.operation.observeRuntimeOwner({ ownerPid: 303, startedAt: 'not-a-timestamp' }), false);
  assert.equal(first.operation.observeRuntimeOwner({ ownerPid: 101, startedAt: '2026-07-21T08:00:00.000Z' }), true);
  assert.equal(first.operation.pending, false);
});

test('a second restart is suppressed while canonical admission is pending', () => {
  const harness = createHarness();
  const first = begin(harness);
  const second = begin(harness, first.operation);

  assert.equal(second.started, false);
  assert.equal(second.reason, 'in_progress');
  assert.equal(harness.spawnArgs.length, 1);
});

test('shutdown retains both owners while replacement admission is pending', () => {
  const harness = createHarness();
  const result = begin(harness);

  assert.deepEqual(
    resolveTuiShutdownChildren({ trackedChild: harness.previousChild, restartOperation: result.operation }),
    [harness.previousChild, harness.replacementChild],
  );
});
