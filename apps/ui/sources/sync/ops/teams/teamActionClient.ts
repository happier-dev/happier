import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isHomeDomainActionIdV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import {
    createHomeActionApprovalContinuation,
    type ActionApprovalRegistration,
} from '@/components/approvals/actionApprovalContinuation';
import {
    resetScopedHomeActionExecutorsForTests,
    scopedHomeActionExecutor,
} from '@/sync/ops/actions/scopedHomeActionExecutor';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';

/** The failure vocabulary Team surfaces speak; re-exported so a wrapper never
 * reaches past this client into the transport. */
export type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { randomUUID } from '@/platform/randomUUID';

/**
 * The one way a Team surface invokes a Team intent.
 *
 * Every Team, member, Group and invitation wrapper goes through the canonical
 * `ActionExecutor.execute` front door, so Action settings, per-surface
 * enablement, dangerous-action approval and provenance are enforced for Team
 * governance exactly as they are for every other Action. The Home HTTP executor
 * stays *below* the front door as a transport dependency; calling it directly
 * from a wrapper would bypass all of that, which is why the Home identity and
 * Team identity clients that still do so are not a precedent to copy.
 *
 * This module owns no paths, no codecs and no policy. The Action row declares
 * the method, path and schemas; the front door owns admission and approval; the
 * family dependency owns which Home the intent is carried to.
 */

/**
 * One front door per exact Home and Account.
 *
 * The executor's default Home port targets the *focused* Home, which is right
 * for an Agent or voice invocation that names none and wrong for every Team
 * screen: a Team screen was opened for one exact Home and must complete against
 * it even if the person focuses another mid-flight. So each scope gets a
 * scope-bound port passed through the executor's own `homeDomainAction` opt —
 * the sanctioned way to address another Home — while admission, Action
 * settings, approval and output validation stay with the shared front door.
 *
 * Executors are cached per scope because building one is not free and a device
 * holds few Homes; the cache holds no Team state and no credentials.
 */
/** Test-only reset of the per-scope front-door cache. */
export function resetTeamActionClientForTests(): void {
    resetScopedHomeActionExecutorsForTests();
}

/**
 * Binds one deferred approval to the operation that asked for it.
 *
 * The binding is deliberately exact: the shared continuation owner re-checks
 * the Artifact's own recorded Action id, surface, authority, Account and Home
 * against this scope before it hands a result back, so an approval executed for
 * another intent, another Account or another Home is ignored rather than
 * mistaken for this one's answer. A read intent never gets a continuation: a
 * read that needed approval is a registry defect, and replaying one as a result
 * would let a refused read look like it returned data.
 */
function buildTeamActionApprovalRegistration<TValue>(input: Readonly<{
    artifactId: string;
    actionId: ActionId;
    scope: ServerAccountScope;
    actionRequestId: string;
    parse: (value: unknown) => TValue;
    onSucceeded?: (value: TValue) => void | Promise<void>;
    onFailed?: (code: string, failure?: ActionExecuteFailure) => void;
}>): ActionApprovalRegistration {
    if (!input.onSucceeded && !input.onFailed) return input.artifactId;
    if (!isHomeDomainActionIdV1(input.actionId)) return input.artifactId;
    if (getActionSpec(input.actionId).sideEffectClass === 'read') return input.artifactId;
    const actionId = input.actionId;
    return createHomeActionApprovalContinuation<unknown, typeof actionId>({
        artifactId: input.artifactId,
        actionId,
        scope: input.scope,
        expectedRequestId: input.actionRequestId,
        // The declared output schema has already accepted this value; the
        // caller's own parse is what narrows it to the exact type its screen
        // renders, and a disagreement there is reported as a failure rather
        // than surfaced as a half-typed success.
        onSucceeded: async (value) => await input.onSucceeded?.(input.parse(value)),
        ...(input.onFailed ? { onFailed: input.onFailed } : {}),
    });
}

export type TeamActionOutcome<TValue> =
    | Readonly<{ kind: 'succeeded'; value: TValue }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>;

/**
 * The shared Action front door created a durable approval request instead of
 * reaching the Home.  Team callers must surface that request to the present
 * user; treating it as an ordinary domain failure loses the artifact id and
 * makes a valid danger action look like a transport error.
 *
 * `registration` is what a caller hands to the approval host. When the caller
 * supplied result handlers it is a result-bearing continuation bound to this
 * exact Action, Home, Account and Artifact, so the operation that was deferred
 * finishes with its real answer — a created resource id, a revoked key, a
 * deleted row — instead of degrading into "something changed, reload". When it
 * did not, it stays the bare Artifact id, which is what every existing
 * non-result-bearing caller already registers.
 */
export class TeamActionApprovalPendingError extends Error {
    readonly registration: ActionApprovalRegistration;

    constructor(public readonly artifactId: string, registration?: ActionApprovalRegistration) {
        super('team_action_approval_pending');
        this.name = 'TeamActionApprovalPendingError';
        this.registration = registration ?? artifactId;
        Object.setPrototypeOf(this, TeamActionApprovalPendingError.prototype);
    }
}

export function isTeamActionApprovalPendingError(
    cause: unknown,
): cause is TeamActionApprovalPendingError {
    return cause instanceof TeamActionApprovalPendingError;
}

/**
 * Runs one Team intent against one exact Home.
 *
 * `scope` is captured by the caller before any user-independent work, and its
 * Home is carried in the execution context, so focusing another Home mid-flight
 * cannot retarget an in-flight Team mutation. Approval remains wholly owned by
 * the shared Action policy: its default recognizes UI + present-user dispatch,
 * while an explicit user requirement for UI approval must still create an
 * approval Artifact. The Home continues to perform its current feature,
 * authentication and capability checks.
 */
export async function runTeamAction<TValue>(params: Readonly<{
    scope: ServerAccountScope;
    actionId: ActionId;
    input: unknown;
    /** Parses the Action's declared output into the caller's exact type. */
    parse: (value: unknown) => TValue;
    /**
     * Legacy caller fact retained while credential operations migrate in their
     * owning lane. It is deliberately non-authoritative for Action approval.
     */
    approval?: 'surface_confirmed';
    signal?: AbortSignal;
    /**
     * Receives this intent's real answer once a deferred approval executes.
     * Supplying it is what turns the thrown pending error into a result-bearing
     * continuation; settlement never redispatches the mutation, because the
     * Home already performed it when the approval was granted.
     */
    onApprovalSucceeded?: (value: TValue) => void | Promise<void>;
    /** Receives the refusal code and the shared continuation's validated failure. */
    onApprovalFailed?: (code: string, failure?: ActionExecuteFailure) => void;
}>): Promise<TeamActionOutcome<TValue>> {
    const actionRequestId = randomUUID();
    const result = await scopedHomeActionExecutor(params.scope)(params.actionId, params.input, {
        surface: 'ui',
        authority: 'present_user',
        serverId: params.scope.serverId,
        actionRequestId,
        ...(params.signal ? { signal: params.signal } : {}),
    });

    const outcome = classifyHomeActionOutcome(result);
    if (outcome.kind === 'failed') {
        return Object.freeze({
            kind: 'failed' as const,
            failure: outcome.failure,
        });
    }

    if (outcome.kind === 'approval_pending') {
        throw new TeamActionApprovalPendingError(
            outcome.artifactId,
            buildTeamActionApprovalRegistration({
                artifactId: outcome.artifactId,
                actionId: params.actionId,
                scope: params.scope,
                actionRequestId,
                parse: params.parse,
                ...(params.onApprovalSucceeded ? { onSucceeded: params.onApprovalSucceeded } : {}),
                ...(params.onApprovalFailed ? { onFailed: params.onApprovalFailed } : {}),
            }),
        );
    }

    try {
        return Object.freeze({ kind: 'succeeded' as const, value: params.parse(outcome.result) });
    } catch {
        // The front door already validated against the row's declared output, so
        // a parse failure here means this build and the Home disagree about the
        // contract. That is not a usable answer and never renders as success.
        return Object.freeze({
            kind: 'failed' as const,
            failure: Object.freeze({ kind: 'invalid' as const, retryable: false, code: null }),
        });
    }
}
