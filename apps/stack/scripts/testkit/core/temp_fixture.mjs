import { mkdtempSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerTestCleanup, removeDirForce, removeDirForceSync } from '../../utils/test/test_cleanup.mjs';

// node:test runs no after hooks when its process is stopped by a signal, so a
// registered root (and a fixture broker that exits with its root) would outlive
// the run (P03-BROKER-W2: four /tmp/ha-* brokers, 2026-11-18). Remove every live
// registered root on termination: on the signal itself, and at exit for a signal
// that another module's handler turns into process.exit() before this one runs.
const liveRoots = new Set();
const TERMINATION_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
function removeLiveRoots() {
  for (const root of liveRoots) removeDirForceSync(root);
  liveRoots.clear();
  process.off('exit', removeLiveRoots);
  for (const name of TERMINATION_SIGNALS) process.off(name, removeLiveRootsOnSignal);
}
function removeLiveRootsOnSignal(signal) {
  removeLiveRoots();
  // Keep any other handler's behaviour; otherwise end as the signal would have.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}
function trackLiveRoot(root) {
  if (liveRoots.size === 0) {
    process.on('exit', removeLiveRoots);
    for (const name of TERMINATION_SIGNALS) process.on(name, removeLiveRootsOnSignal);
  }
  liveRoots.add(root);
}
function untrackLiveRoot(root) {
  if (liveRoots.delete(root) && liveRoots.size === 0) {
    process.off('exit', removeLiveRoots);
    for (const name of TERMINATION_SIGNALS) process.off(name, removeLiveRootsOnSignal);
  }
}

function buildFixtureApi(root, cleanup) {
  return {
    root,
    cleanup,
    path(...segments) {
      return join(root, ...segments);
    },
  };
}

export async function createTempFixture(t, {
  prefix = 'hstack-test-fixture-',
  parentDir = tmpdir(),
  registerCleanup = true,
  beforeCleanup,
} = {}) {
  const root = await mkdtemp(join(parentDir, prefix));
  const cleanup = async () => {
    await beforeCleanup?.(root);
    await removeDirForce(root);
    untrackLiveRoot(root);
  };
  if (registerCleanup) {
    trackLiveRoot(root);
    registerTestCleanup(t, cleanup);
  }
  return buildFixtureApi(root, cleanup);
}

export function createTempFixtureSync(t, {
  prefix = 'hstack-test-fixture-',
  parentDir = tmpdir(),
  registerCleanup = true,
} = {}) {
  const root = mkdtempSync(join(parentDir, prefix));
  const cleanup = () => {
    removeDirForceSync(root);
    untrackLiveRoot(root);
  };
  if (registerCleanup) {
    trackLiveRoot(root);
    registerTestCleanup(t, cleanup);
  }
  return buildFixtureApi(root, cleanup);
}
