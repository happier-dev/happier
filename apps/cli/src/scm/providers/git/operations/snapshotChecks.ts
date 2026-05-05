import type { ScmWorkingSnapshot } from '@happier-dev/protocol';
import type { ScmBackendContext } from '../../../types';

import { getGitSnapshot } from '../repository';

export async function readGitSnapshotForChecks(context: ScmBackendContext) {
    return getGitSnapshot({ context });
}

export function hasAnyIncludedOrPendingChanges(snapshot: ScmWorkingSnapshot): boolean {
    return snapshot.entries.length > 0;
}
