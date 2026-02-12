import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmOperationIntent } from '@/scm/core/operationPolicy';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';

function canRunIntentWithSnapshot(
    snapshot: ScmWorkingSnapshot | null | undefined,
    intent: ScmOperationIntent
): boolean {
    if (!snapshot) return false;
    const result = evaluateScmOperationPreflight({
        intent,
        scmWriteEnabled: true,
        sessionPath: snapshot.repo.rootPath ?? '.',
        snapshot,
    });
    return result.allowed;
}

export function canRevertFromSnapshot(snapshot: ScmWorkingSnapshot | null | undefined): boolean {
    return canRunIntentWithSnapshot(snapshot, 'revert');
}

export function canCreateCommitFromSnapshot(snapshot: ScmWorkingSnapshot | null | undefined): boolean {
    return canRunIntentWithSnapshot(snapshot, 'commit');
}

export function canPullFromSnapshot(snapshot: ScmWorkingSnapshot | null | undefined): boolean {
    return canRunIntentWithSnapshot(snapshot, 'pull');
}

export function canPushFromSnapshot(snapshot: ScmWorkingSnapshot | null | undefined): boolean {
    return canRunIntentWithSnapshot(snapshot, 'push');
}
