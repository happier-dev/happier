import type { ScmWorkingSnapshot } from '@happier-dev/plugin-sdk/experimental/scm';
import type { ScmBackendContext } from '../types.js';

import { getGitSnapshot } from '../repository.js';

export async function readGitSnapshotForChecks(context: ScmBackendContext) {
    return getGitSnapshot({ context });
}

export function hasAnyIncludedOrPendingChanges(snapshot: ScmWorkingSnapshot): boolean {
    return snapshot.entries.length > 0;
}
