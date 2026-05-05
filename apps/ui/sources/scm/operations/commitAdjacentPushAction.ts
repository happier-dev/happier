import type { ScmOperationPreflightResult } from '@/scm/core/operationPolicy';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { inferRemoteTargetFromSnapshot, type ScmRemoteSelection } from './remoteTarget';

export type CommitAdjacentPushActionState =
    | { visible: false }
    | {
        visible: true;
        disabled: boolean;
        busy: boolean;
        target: ScmRemoteSelection;
    };

export function resolveCommitAdjacentPushActionState(input: Readonly<{
    snapshot: ScmWorkingSnapshot | null;
    pushPreflight: ScmOperationPreflightResult;
    scmWriteEnabled: boolean;
    sessionPath: string | null;
    scmOperationBusy: boolean;
    hasGlobalOperationInFlight: boolean;
    isLockedByOtherSession: boolean;
}>): CommitAdjacentPushActionState {
    const snapshot = input.snapshot;
    if (!input.sessionPath || !input.scmWriteEnabled || !snapshot?.repo.isRepo) {
        return { visible: false };
    }

    if (snapshot.capabilities?.writeRemotePush !== true) {
        return { visible: false };
    }

    if (snapshot.branch.detached || !snapshot.branch.upstream) {
        return { visible: false };
    }

    if (snapshot.branch.ahead <= 0 || snapshot.branch.behind > 0) {
        return { visible: false };
    }

    if (!snapshot.repo.remotes || snapshot.repo.remotes.length === 0) {
        return { visible: false };
    }

    if (!input.pushPreflight.allowed) {
        return { visible: false };
    }

    const target = inferRemoteTargetFromSnapshot(snapshot);
    if (!target.branch) {
        return { visible: false };
    }

    const busy = input.scmOperationBusy || input.hasGlobalOperationInFlight || input.isLockedByOtherSession;
    return {
        visible: true,
        disabled: busy,
        busy,
        target,
    };
}
