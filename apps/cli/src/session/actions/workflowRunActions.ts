import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { createWorkflowAccountRunActionOwner } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import type { WorkflowAccountRunActionDeps } from '@happier-dev/protocol';

import { resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';

/** CLI path and randomness effects for the shared admission owner. */
export function createWorkflowRunActionOwner(deps: Omit<WorkflowAccountRunActionDeps,
  'normalizeAbsolutePath' | 'randomBytes'> & Readonly<{
    randomBytes?: (length: number) => Uint8Array;
  }>) {
  return createWorkflowAccountRunActionOwner({
    ...deps,
    randomBytes: deps.randomBytes ?? ((length) => nodeRandomBytes(length)),
    normalizeAbsolutePath: (directory) => resolveCanonicalAbsolutePath(directory)?.path ?? null,
  });
}
