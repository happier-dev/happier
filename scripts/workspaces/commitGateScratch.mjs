import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { observeWorkerFilesystem } from '../../apps/stack/scripts/utils/dev_targets/worker_disk_budget.mjs';

// Systemic's controller recovery floor after the November 25 disk exhaustion.
const CONTROLLER_DISK_FLOOR_BYTES = 30 * 1024 ** 3;

export function commitGateScratchRoot(env = process.env) {
  return resolve(env.P03_COMMIT_TREE_WORK_DIR || env.TMPDIR || tmpdir());
}

export function assertCommitGateDisk(env, ...paths) {
  for (const path of new Set([commitGateScratchRoot(env), ...paths.filter(Boolean).map(path => resolve(path))])) {
    const { availableBytes } = observeWorkerFilesystem(path);
    if (availableBytes < CONTROLLER_DISK_FLOOR_BYTES) {
      throw new Error(`COMMIT_GATE_DISK_LOW: ${path} has ${availableBytes} bytes available; requires ${CONTROLLER_DISK_FLOOR_BYTES}`);
    }
  }
}
