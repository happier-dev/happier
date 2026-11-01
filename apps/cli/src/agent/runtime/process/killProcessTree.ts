import psList from 'ps-list';

import { killProcessTree as terminateProcessTree, type ProcessTreeTerminationResult } from '../../../../scripts/process_tree.cjs';
import { logger } from '@/ui/logger';

type ProcessTreeRoot = Readonly<{ pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null }>;
type ProcessTreeOptions = Readonly<{ graceMs?: number }>;

// The launcher requires this same CJS owner as a sidecar. Static imports bundle it
// into the compiled CLI, including detached installer promotion runners.

export async function killProcessTree(proc: ProcessTreeRoot, opts?: ProcessTreeOptions): Promise<ProcessTreeTerminationResult> {
  try {
    return await terminateProcessTree(proc, opts, psList);
  } catch (error) {
    // Existing best-effort callers may catch cleanup rejection. Keep this outcome
    // observable at its canonical owner without exposing OS errors or terminal noise.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'process_tree_termination_incomplete') {
      logger.infoFile('[process-tree] Owned process cleanup could not be verified', {
        code: 'process_tree_termination_incomplete',
        discoveryFailed: 'discoveryFailed' in error && error.discoveryFailed === true,
        probeFailed: 'probeFailed' in error && error.probeFailed === true,
        signallingFailed: 'signallingFailed' in error && error.signallingFailed === true,
      });
    }
    throw error;
  }
}
