import {
    evaluateScmRemoteMutationPolicy,
    type ScmOperationErrorCode,
    type ScmRemoteMutationKind,
    type ScmRemoteMutationPolicy,
    type ScmRemoteMutationReason,
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';

export type ScmRemoteMutationGuardResult =
    | { ok: true }
    | {
        ok: false;
        errorCode: ScmOperationErrorCode;
        error: string;
    };

export type ScmRemoteMutationReasonMapper = (
    kind: ScmRemoteMutationKind,
    reason: ScmRemoteMutationReason,
) => Exclude<ScmRemoteMutationGuardResult, { ok: true }>;

export function evaluateScmRemoteMutationPreconditions(input: Readonly<{
    kind: ScmRemoteMutationKind;
    snapshot: ScmWorkingSnapshot;
    hasExplicitTarget: boolean;
    policy: ScmRemoteMutationPolicy;
    mapReasonToError: ScmRemoteMutationReasonMapper;
}>): ScmRemoteMutationGuardResult {
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

    if (outcome.ok) return { ok: true };
    return input.mapReasonToError(input.kind, outcome.reason);
}
