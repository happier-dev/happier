import { normalizeStackRuntimeOwnerStartedAt } from '../stack/runtime_owner_incarnation.mjs';

function isActiveChild(child) {
  return Boolean(child && child.exitCode == null && child.signalCode == null);
}

function normalizeRuntimeOwnerIncarnation(runtimeOwner) {
  const ownerPid = Number(runtimeOwner?.ownerPid);
  const startedAt = normalizeStackRuntimeOwnerStartedAt(runtimeOwner?.startedAt);
  if (!Number.isInteger(ownerPid) || ownerPid <= 1 || !startedAt) return null;
  return { ownerPid, startedAt };
}

function isSameRuntimeOwnerIncarnation(left, right) {
  return Boolean(left && right && left.ownerPid === right.ownerPid && left.startedAt === right.startedAt);
}

function normalizeRunnerLogPath(value) {
  return String(value ?? '').trim();
}

export function createTuiRuntimeOwnershipTracker({ runtimeOwnerBeforeSpawn = null } = {}) {
  const baseline = normalizeRuntimeOwnerIncarnation(runtimeOwnerBeforeSpawn);
  let expectedOwner = null;
  let detachedRunnerLogPath = '';

  return {
    observe({
      runtimeOwner = null,
      childActive = false,
      launchRequested = false,
      runtimeRunnerLogPath = '',
      replacementCandidate = false,
    } = {}) {
      const observed = normalizeRuntimeOwnerIncarnation(runtimeOwner);
      if (!observed) return false;
      const detachedRunnerMatches = Boolean(
        launchRequested
        && detachedRunnerLogPath
        && detachedRunnerLogPath === normalizeRunnerLogPath(runtimeRunnerLogPath),
      );
      // A foreground child is direct evidence of ownership. A detached launcher is not: it
      // becomes eligible only once its canonical runner-log announcement matches runtime state.
      const launchOwnsRuntime = launchRequested ? detachedRunnerMatches : childActive;
      if (replacementCandidate) {
        const incumbent = expectedOwner ?? baseline;
        if (!launchOwnsRuntime || isSameRuntimeOwnerIncarnation(observed, incumbent)) return false;
        expectedOwner = observed;
        return true;
      }
      if (!expectedOwner && launchOwnsRuntime && !isSameRuntimeOwnerIncarnation(observed, baseline)) {
        expectedOwner = observed;
        return true;
      }
      return false;
    },
    recordDetachedRunnerLogPath(path) {
      detachedRunnerLogPath = normalizeRunnerLogPath(path);
    },
    clearDetachedRunnerLogPath() {
      detachedRunnerLogPath = '';
    },
    getExpectedOwner() {
      return expectedOwner ? { ...expectedOwner } : null;
    },
  };
}

function uniqueActiveChildren(children) {
  const seen = new Set();
  const active = [];
  for (const child of children) {
    if (!isActiveChild(child)) continue;
    const key = Number.isFinite(Number(child?.pid)) ? `pid:${Number(child.pid)}` : child;
    if (seen.has(key)) continue;
    seen.add(key);
    active.push(child);
  }
  return active;
}

export function beginTuiRestartOperation({
  currentOperation = null,
  previousChild = null,
  previousRuntimeOwner = null,
  restartArgs = [],
  backgroundOwner = false,
  spawnChild,
  trackChild = () => {},
  log = () => {},
  refresh = () => {},
} = {}) {
  if (currentOperation?.pending) {
    log('restart: canonical replacement is already in progress');
    return { started: false, reason: 'in_progress', operation: currentOperation };
  }

  const incumbentRuntimeOwner = normalizeRuntimeOwnerIncarnation(previousRuntimeOwner);
  if (!incumbentRuntimeOwner && isActiveChild(previousChild)) {
    log('restart: current runtime owner evidence is unavailable; wait for the stack summary to refresh');
    refresh();
    return { started: false, reason: 'missing_runtime_owner', operation: null };
  }

  let replacementChild;
  try {
    replacementChild = spawnChild(restartArgs);
  } catch (error) {
    trackChild(previousChild);
    log(`restart: replacement launch failed; previous runtime preserved (${error instanceof Error ? error.message : String(error)})`);
    refresh();
    return { started: false, reason: 'spawn_failed', operation: null, error };
  }

  let pending = true;
  let settled = false;
  const isReplacementRuntimeOwner = (runtimeOwner) => {
    if (settled) return false;
    const observed = normalizeRuntimeOwnerIncarnation(runtimeOwner);
    return Boolean(observed && !isSameRuntimeOwnerIncarnation(observed, incumbentRuntimeOwner));
  };
  const operation = {
    get pending() {
      return pending;
    },
    getActiveChildren() {
      return uniqueActiveChildren([previousChild, replacementChild]);
    },
    isReplacementRuntimeOwner,
    observeRuntimeOwner(runtimeOwner) {
      if (!isReplacementRuntimeOwner(runtimeOwner)) return false;
      const observed = normalizeRuntimeOwnerIncarnation(runtimeOwner);
      settle({
        preservePrevious: false,
        message: `restart: canonical owner admitted the replacement (ownerPid=${observed.ownerPid}, startedAt=${observed.startedAt})`,
      });
      return true;
    },
  };

  const settle = ({ preservePrevious, message }) => {
    if (settled) return;
    settled = true;
    pending = false;
    trackChild(preservePrevious ? previousChild : replacementChild);
    log(message);
    refresh();
  };

  replacementChild.once('error', (error) => {
    const previousStillActive = isActiveChild(previousChild);
    settle({
      preservePrevious: previousStillActive,
      message: previousStillActive
        ? `restart: replacement launch failed; previous runtime preserved (${error instanceof Error ? error.message : String(error)})`
        : `restart: replacement launch failed (${error instanceof Error ? error.message : String(error)})`,
    });
  });
  replacementChild.once('exit', (code, signal) => {
    if (backgroundOwner && code === 0 && !signal) {
      log('restart: detached background owner command completed; waiting for owner admission');
      refresh();
      return;
    }
    const previousStillActive = isActiveChild(previousChild);
    settle({
      preservePrevious: previousStillActive,
      message: previousStillActive
        ? `restart: canonical replacement exited before admission; previous runtime preserved (code=${code}, sig=${signal ?? 'null'})`
        : `restart: replacement exited (code=${code}, sig=${signal ?? 'null'})`,
    });
  });

  if (isActiveChild(previousChild)) {
    previousChild.once('exit', () => {
      if (settled) return;
      trackChild(replacementChild);
      log('restart: previous wrapper exited; waiting for canonical runtime owner admission');
      refresh();
    });
  }

  return { started: true, reason: 'started', operation, replacementChild };
}

export function resolveTuiShutdownChildren({ trackedChild = null, restartOperation = null } = {}) {
  const operationChildren = restartOperation?.getActiveChildren?.() ?? [];
  return uniqueActiveChildren([...operationChildren, trackedChild]);
}
