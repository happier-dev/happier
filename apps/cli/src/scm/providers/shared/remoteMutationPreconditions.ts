import type { ScmWorkingSnapshot } from '@happier-dev/protocol';
import {
    evaluateScmRemoteMutationPolicy,
    SCM_OPERATION_ERROR_CODES,
    type ScmRemoteMutationKind,
    type ScmRemoteMutationPolicy,
    type ScmRemoteMutationReason,
} from '@happier-dev/protocol';

export type RemoteMutationGuardResult =
    | { ok: true }
    | {
        ok: false;
        errorCode: keyof typeof SCM_OPERATION_ERROR_CODES;
        error: string;
    };

export function evaluateRemoteMutationPreconditions(input: {
    kind: ScmRemoteMutationKind;
    snapshot: ScmWorkingSnapshot;
    hasExplicitTarget: boolean;
    policy: ScmRemoteMutationPolicy;
    mapReasonToError: (
        kind: ScmRemoteMutationKind,
        reason: ScmRemoteMutationReason
    ) => Exclude<RemoteMutationGuardResult, { ok: true }>;
}): RemoteMutationGuardResult {
    const outcome = evaluateScmRemoteMutationPolicy({
        kind: input.kind,
        snapshot: {
            hasConflicts: input.snapshot.hasConflicts,
            branch: {
                head: input.snapshot.branch.head,
                upstream: input.snapshot.branch.upstream,
                behind: input.snapshot.branch.behind,
                detached: input.snapshot.branch.detached,
            },
            totals: {
                includedFiles: input.snapshot.totals.includedFiles,
                pendingFiles: input.snapshot.totals.pendingFiles,
                untrackedFiles: input.snapshot.totals.untrackedFiles,
            },
        },
        hasExplicitTarget: input.hasExplicitTarget,
        policy: input.policy,
    });

    if (outcome.ok) {
        return { ok: true };
    }

    return input.mapReasonToError(input.kind, outcome.reason);
}
