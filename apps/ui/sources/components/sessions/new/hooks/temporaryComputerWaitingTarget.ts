import type { SessionAuthoringExecutionTargetV2 } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import type { RunnerActivationProjectionV1 } from '@happier-dev/protocol/ephemeralRunner/projection';

type TemporaryComputerAuthoringTarget = Extract<
    SessionAuthoringExecutionTargetV2,
    { kind: 'temporary_computer' }
>;

/**
 * The exact destination a waiting Temporary-computer request will run on.
 *
 * The waiting surface has to keep saying this for the whole life of the request.
 * A package that is already sitting on somebody else's computer cannot be
 * described by whatever the composer happens to hold now: the author may have
 * switched Home, changed platform or started a different draft since. So once an
 * activation exists, its own frozen artifact identity is the authority and the
 * live draft is only consulted for the endpoint workspace intent the activation
 * does not carry.
 */
export type TemporaryComputerWaitingTarget = Readonly<{
    /** Readable Home name, or `null` when this client cannot name the Home. */
    homeLabel: string | null;
    /**
     * Account qualifier, present only when the request does not belong to the
     * Account currently in focus — exactly when a row's scope is ambiguous.
     */
    accountLabel: string | null;
    /** Exact published artifact target; presented through the one localized resolver. */
    artifactTarget: string;
    /** Endpoint workspace intent, known only from the authoring draft. */
    workspace: TemporaryComputerAuthoringTarget['workspace']['kind'] | null;
}>;

export function resolveTemporaryComputerWaitingTarget(input: Readonly<{
    projection: RunnerActivationProjectionV1 | null;
    committedTarget: TemporaryComputerAuthoringTarget | null;
    homeLabel: string | null;
    accountLabel: string | null;
}>): TemporaryComputerWaitingTarget | null {
    const artifactTarget = input.projection?.artifact.target ?? input.committedTarget?.artifactTarget ?? null;
    if (artifactTarget === null) return null;
    const homeLabel = input.homeLabel?.trim();
    const accountLabel = input.accountLabel?.trim();
    return {
        homeLabel: homeLabel ? homeLabel : null,
        accountLabel: accountLabel ? accountLabel : null,
        artifactTarget,
        workspace: input.committedTarget?.workspace.kind ?? null,
    };
}
