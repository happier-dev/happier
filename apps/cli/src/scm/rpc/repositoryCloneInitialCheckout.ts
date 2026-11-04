import type { ScmRepositoryCloneInput, ScmRepositoryCloneOutput } from '@happier-dev/protocol/scm/repositoryClone';

/** Older callbacks may ignore the operand; use their existing snapshot to observe the result. */
export function observeCloneInitialCheckout(
    initialCheckout: NonNullable<ScmRepositoryCloneInput['initialCheckout']>,
    clone: Extract<ScmRepositoryCloneOutput, { success: true }>,
): ScmRepositoryCloneOutput {
    const snapshot = clone.snapshot;
    const headOid = snapshot?.branch.headOid;
    if (!snapshot || !headOid) return {
        success: false, destinationPath: clone.destinationPath,
        errorCode: 'COMMAND_OUTCOME_UNKNOWN', error: 'Created checkout pin could not be observed.',
        outcome: {
            v: 1, kind: 'outcome_unknown', errorCode: 'COMMAND_OUTCOME_UNKNOWN',
            reconciliation: { kind: 'repository_status', cwd: clone.destinationPath }, nextActions: [{ kind: 'refresh' }],
        },
    };
    if (snapshot.branch.head === initialCheckout.branch && !snapshot.branch.detached && headOid === initialCheckout.commit) return clone;
    return {
        success: false, destinationPath: clone.destinationPath, errorCode: 'SCM_SOURCE_CHANGED',
        error: 'Checkout was created, but its current branch or commit does not match the requested pin.',
        outcome: {
            v: 1, kind: 'failed', errorCode: 'SCM_SOURCE_CHANGED',
            repositoryState: { headOid, hasConflicts: snapshot.hasConflicts, operation: snapshot.operationState ?? null },
            nextActions: [{ kind: 'refresh' }],
        },
    };
}
