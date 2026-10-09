import {
    HomeAccountDeleteResultV1Schema,
    HomeAccountDetailV1Schema,
    HomeAccountListResultV1Schema,
    HomeAccountSearchResultV1Schema,
    HomeAuditListResultV1Schema,
    HomeEmptinessV1Schema,
    HomeMailDeliveryReadinessV1Schema,
    HomeMailDeliveryTestResultV1Schema,
    HomeReachabilityV1Schema,
    HomeRetentionDryRunResultV1Schema,
    HomeSettingsInvalidErrorV1Schema,
    HomeSettingsProjectionV1Schema,
    type HomeAccountDetailV1,
    type HomeAccountDeleteResultV1,
    type HomeAccountListResultV1,
    type HomeAccountSearchResultV1,
    type HomeAuditListResultV1,
    type HomeEmptinessV1,
    type HomeMailDeliveryReadinessV1,
    type HomeMailDeliveryTestResultV1,
    type HomeIrohModeV1,
    type HomeReachabilityV1,
    type HomeRetentionDryRunResultV1,
    type HomeSettingSecretWriteV1,
    type HomeSettingsInvalidReasonV1,
    type HomeSettingsProjectionV1,
    type HomeAuthenticationPolicyV1,
    type HomeGovernanceActionIdV1,
    type HomeIdentityNetworkPolicyV1,
    type HomeRoleV1,
    type HomeTeamProviderPolicyV1,
    type TeamCreationPolicyV1,
} from '@happier-dev/protocol/home/governance';
import type { ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';

import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { refreshHomeGovernanceSnapshot } from '@/sync/engine/home/governance/homeGovernanceEngine';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { classifyHomeActionOutcome, type HomeActionOutcome } from './homeActionOutcome';

export { classifyHomeActionOutcome as classifyHomeGovernanceActionOutcome } from './homeActionOutcome';

/**
 * Home-governance intents, addressed to one explicit Home.
 *
 * Every one of them is an Action, executed by the one shared Action executor.
 * That executor owns admission, the Action settings policy, approval and output
 * validation, and this module owns none of those: the Home family dependency it
 * is given knows only which Home the intent belongs to, and the canonical row
 * for the id supplies the method, path and result schema. There is no local
 * route table and no permissive acknowledgement shape here any more.
 *
 * What remains genuinely local is the part a surface should not repeat: a
 * refresh of the same Home after a change the Home actually accepted, a result
 * union that keeps an incomplete erasure distinguishable from a completed one,
 * and the Home's own typed refusal carried through untouched so the surface can
 * explain the real reason. Confirmation stays with the surface, where the person
 * is; nothing here decides whether an action was intended.
 */

export type HomeGovernanceMutationOutcome =
    | Readonly<{ kind: 'succeeded' }>
    /** The shared Action owner accepted the request for later approval, but has not mutated the Home. */
    | Readonly<{ kind: 'approval_pending'; artifactId: string }>
    /**
     * Access was revoked but cleanup did not finish. This is never rendered as
     * success: the Account is now Retired and the deletion remains to be
     * completed by an authorized owner.
     */
    | Readonly<{ kind: 'incomplete' }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>;

/**
 * The result of a mutation whose answer settles it either way.
 *
 * Erasure is the only Home intent that can leave work half-done, so it is the
 * only one whose result can be `incomplete`. Saying so in the type is what lets
 * every other surface narrow to the Home's actual refusal without defending
 * itself against a state its intent cannot produce.
 */
export type HomeGovernanceAcknowledgedOutcome =
    Exclude<HomeGovernanceMutationOutcome, Readonly<{ kind: 'incomplete' }>>;

export type HomeGovernanceQueryOutcome<TValue> =
    | Readonly<{ kind: 'succeeded'; value: TValue }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>;

/**
 * A mutation whose answer is the Home's new state (settings) or its verdict (a test send).
 * Unlike a query, an approval request is a real outcome here: the change has not run yet.
 */
export type HomeGovernanceValueMutationOutcome<TValue> =
    | Readonly<{ kind: 'succeeded'; value: TValue }>
    | Readonly<{ kind: 'approval_pending'; artifactId: string }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>;

const SUCCEEDED: HomeGovernanceAcknowledgedOutcome = Object.freeze({ kind: 'succeeded' as const });
const INCOMPLETE: HomeGovernanceMutationOutcome = Object.freeze({ kind: 'incomplete' as const });

/**
 * Runs one Home intent through the shared executor.
 *
 * The executor is built per call with this Home's family dependency: the scope
 * is captured before anything is awaited, so focusing another Home while the
 * intent is in flight cannot retarget it or publish its result under the wrong
 * Home.
 */
async function executeHomeAction(params: Readonly<{
    scope: ServerAccountScope;
    actionId: HomeGovernanceActionIdV1;
    input: unknown;
    signal?: AbortSignal;
}>): Promise<HomeActionOutcome> {
    const result = await scopedHomeActionExecutor(params.scope)(params.actionId, params.input, {
        surface: 'ui',
        authority: 'present_user',
        serverId: params.scope.serverId,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    return classifyHomeActionOutcome(result);
}

/**
 * An acknowledgement-only mutation. The Action row owns what a valid answer
 * looks like, so reaching here at all means the Home accepted the change.
 */
async function mutate(params: Readonly<{
    scope: ServerAccountScope;
    actionId: HomeGovernanceActionIdV1;
    input: unknown;
}>): Promise<HomeGovernanceAcknowledgedOutcome> {
    const outcome = await executeHomeAction(params);
    if (outcome.kind === 'failed') {
        return Object.freeze({ kind: 'failed' as const, failure: outcome.failure });
    }
    if (outcome.kind === 'approval_pending') return outcome;
    // Only an accepted change can have moved this Home. Refreshing after a
    // refusal would spend a request to observe state that did not change.
    await refreshHomeGovernanceSnapshot(params.scope);
    return SUCCEEDED;
}

export function setHomeAccountRole(params: Readonly<{
    scope: ServerAccountScope;
    accountId: string;
    homeRole: HomeRoleV1;
}>): Promise<HomeGovernanceAcknowledgedOutcome> {
    return mutate({
        scope: params.scope,
        actionId: 'home.accounts.role.set',
        input: { accountId: params.accountId, homeRole: params.homeRole },
    });
}

/** The reversible hold. Presented to administrators as **Disable**. */
export function disableHomeAccount(params: Readonly<{
    scope: ServerAccountScope;
    accountId: string;
}>): Promise<HomeGovernanceAcknowledgedOutcome> {
    return mutate({
        scope: params.scope,
        actionId: 'home.accounts.disable',
        input: { accountId: params.accountId },
    });
}

export function enableHomeAccount(params: Readonly<{
    scope: ServerAccountScope;
    accountId: string;
}>): Promise<HomeGovernanceAcknowledgedOutcome> {
    return mutate({
        scope: params.scope,
        actionId: 'home.accounts.enable',
        input: { accountId: params.accountId },
    });
}

/**
 * Ends every signed-in session of one person (D-9). Their API tokens keep working until the
 * Account is disabled; nothing about their role or data changes.
 */
export function signOutHomeAccountEverywhere(params: Readonly<{
    scope: ServerAccountScope;
    accountId: string;
}>): Promise<HomeGovernanceAcknowledgedOutcome> {
    return mutate({
        scope: params.scope,
        actionId: 'home.accounts.signOutEverywhere',
        input: { accountId: params.accountId },
    });
}

/**
 * Deletes one Account and its data through the Home's single erasure owner.
 *
 * An authorized owner may call this again for an Account already left Retired by
 * a failed attempt; that is a fresh authorized request to finish the deletion,
 * not a resurrection of partially erased data.
 */
export async function deleteHomeAccount(params: Readonly<{
    scope: ServerAccountScope;
    accountId: string;
    managedResourceDispositions?: readonly ManagedResourceDispositionV1[];
    signal?: AbortSignal;
    onApprovalPending?: (approval: ActionApprovalRegistration) => void;
}>): Promise<HomeGovernanceMutationOutcome> {
    const input = { accountId: params.accountId,
        ...(params.managedResourceDispositions ? { managedResourceDispositions: params.managedResourceDispositions } : {}),
    };
    const execute = () => executeHomeAction({ scope: params.scope, actionId: 'home.accounts.delete', input,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    const outcome = params.onApprovalPending
        ? await awaitActionApprovalResult<HomeAccountDeleteResultV1, HomeActionOutcome>({
            execute: async callbacks => {
                const result = await execute();
                if (result.kind !== 'approval_pending') return result;
                params.onApprovalPending?.(createActionApprovalContinuation<HomeAccountDeleteResultV1, 'home.accounts.delete'>({
                    artifactId: result.artifactId, actionId: 'home.accounts.delete', scope: params.scope, expectedInput: input,
                    ...(callbacks.signal ? { signal: callbacks.signal } : {}),
                    onSucceeded: callbacks.onApprovalSucceeded, onFailed: callbacks.onApprovalFailed,
                }));
                return { approvalPending: true };
            },
            succeeded: result => ({ kind: 'completed', result }),
            failed: (code, failure) => ({ kind: 'failed', failure: homeDomainFailureFromActionFailure(failure ?? { errorCode: code }) }),
            aborted: () => ({ kind: 'failed', failure: homeDomainFailureFromActionFailure({ errorCode: 'aborted' }) }),
            ...(params.signal ? { signal: params.signal } : {}),
        }) : await execute();
    if (outcome.kind === 'failed') {
        return Object.freeze({ kind: 'failed' as const, failure: outcome.failure });
    }
    if (outcome.kind === 'approval_pending') return outcome;

    const parsed = HomeAccountDeleteResultV1Schema.safeParse(outcome.result);
    // Either answer means this Account's access is gone, so the Home moved.
    await refreshHomeGovernanceSnapshot(params.scope);
    if (!parsed.success) {
        // An answer this surface cannot read is never reported as a completed
        // deletion; incomplete is the only safe reading.
        return INCOMPLETE;
    }
    return parsed.data.status === 'deleted' ? SUCCEEDED : INCOMPLETE;
}

export function setHomeTeamCreationPolicy(params: Readonly<{
    scope: ServerAccountScope;
    expectedRevision: number;
    teamCreationPolicy: TeamCreationPolicyV1;
}>): Promise<HomeGovernanceAcknowledgedOutcome> {
    return mutate({
        scope: params.scope,
        actionId: 'home.policy.set',
        input: {
            expectedRevision: params.expectedRevision,
            teamCreationPolicy: params.teamCreationPolicy,
        },
    });
}

/** Whether members outside every Team see Teams: a field of the same policy document. */
export function setHomeTeamsVisibleToMembers(params: Readonly<{
    scope: ServerAccountScope;
    expectedRevision: number;
    teamsVisibleToMembers: boolean;
}>): Promise<HomeGovernanceAcknowledgedOutcome> {
    return mutate({
        scope: params.scope,
        actionId: 'home.policy.set',
        input: {
            expectedRevision: params.expectedRevision,
            teamsVisibleToMembers: params.teamsVisibleToMembers,
        },
    });
}

/**
 * Applies the authentication-related fields of the Home's one policy document.
 * Callers still receive the same compare-and-set conflict and refresh behavior
 * as Team creation; this is a typed surface over that owner, not another writer.
 *
 * Only the Home decides whether a patch widens sign-in, admission or storage
 * (plan `2026-09-26-home-owner-console` §3.4). The patch is sent as is; when the
 * Home refuses it with `home_policy_widening_unconfirmed` (nothing written),
 * `confirmWidening` asks the person and, on yes, the identical patch is resent
 * once with `confirmWidening: true`. Declining returns that refusal unchanged.
 */
export async function setHomeAuthenticationPolicies(params: Readonly<{
    scope: ServerAccountScope;
    expectedRevision: number;
    authenticationPolicy?: HomeAuthenticationPolicyV1 | null;
    teamProviderPolicy?: HomeTeamProviderPolicyV1 | null;
    identityNetworkPolicy?: HomeIdentityNetworkPolicyV1 | null;
    confirmWidening?: () => Promise<boolean>;
}>): Promise<HomeGovernanceAcknowledgedOutcome> {
    const input = {
        expectedRevision: params.expectedRevision,
        ...(params.authenticationPolicy !== undefined
            ? { authenticationPolicy: params.authenticationPolicy }
            : {}),
        ...(params.teamProviderPolicy !== undefined
            ? { teamProviderPolicy: params.teamProviderPolicy }
            : {}),
        ...(params.identityNetworkPolicy !== undefined
            ? { identityNetworkPolicy: params.identityNetworkPolicy }
            : {}),
    };
    const outcome = await mutate({ scope: params.scope, actionId: 'home.policy.set', input });
    if (
        outcome.kind !== 'failed'
        || outcome.failure.code !== 'home_policy_widening_unconfirmed'
        || !params.confirmWidening
        || !await params.confirmWidening()
    ) {
        return outcome;
    }
    return await mutate({
        scope: params.scope,
        actionId: 'home.policy.set',
        input: { ...input, confirmWidening: true },
    });
}

/**
 * Claims an ownerless Home with the one-time code printed on the server
 * (`happier-server --print-home-claim-code`). The Home answers every refusal with
 * `home_claim_refused`; on success the viewer is the owner, so the governance
 * projection is re-read like any accepted change.
 */
export function claimHomeWithCode(params: Readonly<{
    scope: ServerAccountScope;
    code: string;
}>): Promise<HomeGovernanceAcknowledgedOutcome> {
    return mutate({
        scope: params.scope,
        actionId: 'home.governance.claim',
        input: { code: params.code },
    });
}

/** Reads a typed answer whose shape the surface depends on. */
async function query<TValue>(params: Readonly<{
    scope: ServerAccountScope;
    actionId: HomeGovernanceActionIdV1;
    input: unknown;
    parse: (value: unknown) => { success: true; data: TValue } | { success: false };
}>): Promise<HomeGovernanceQueryOutcome<TValue>> {
    const outcome = await executeHomeAction(params);
    if (outcome.kind === 'failed') {
        return Object.freeze({ kind: 'failed' as const, failure: outcome.failure });
    }
    if (outcome.kind === 'approval_pending') {
        return Object.freeze({
            kind: 'failed' as const,
            failure: Object.freeze({
                kind: 'conflict' as const,
                retryable: false,
                code: null,
            }),
        });
    }
    const parsed = params.parse(outcome.result);
    if (!parsed.success) {
        return Object.freeze({
            kind: 'failed' as const,
            failure: Object.freeze({ kind: 'invalid' as const, retryable: false, code: null }),
        });
    }
    return Object.freeze({ kind: 'succeeded' as const, value: parsed.data });
}

/**
 * Reads one page of the Home's People list.
 *
 * This is a read, so it never refreshes the governance projection: the two
 * answer different questions and a list page moving does not mean the viewer's
 * own capabilities did.
 */
export function listHomeAccounts(params: Readonly<{
    scope: ServerAccountScope;
    cursor?: string | null;
    limit?: number;
}>): Promise<HomeGovernanceQueryOutcome<HomeAccountListResultV1>> {
    return query({
        scope: params.scope,
        actionId: 'home.accounts.list',
        input: {
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
        },
        parse: (value) => HomeAccountListResultV1Schema.safeParse(value),
    });
}

/**
 * One person as Home administration sees them, in one read: the People row plus Teams, counts,
 * linked providers and recent administration events about them.
 */
export function getHomeAccount(params: Readonly<{
    scope: ServerAccountScope;
    accountId: string;
}>): Promise<HomeGovernanceQueryOutcome<HomeAccountDetailV1>> {
    return query({
        scope: params.scope,
        actionId: 'home.accounts.get',
        input: { accountId: params.accountId },
        parse: (value) => HomeAccountDetailV1Schema.safeParse(value),
    });
}

/**
 * Looks up people on one Home by name.
 *
 * The scope is always stated explicitly rather than inferred from what the
 * caller happens to be administering: Home scope is authorized by Home account
 * management, and a Team scope would be authorized by that exact Team. The
 * result is the minimal picker row, so this is a way to find a person — not a
 * second, thinner view of the People list.
 */
export function searchHomeAccounts(params: Readonly<{
    scope: ServerAccountScope;
    query: string;
}>): Promise<HomeGovernanceQueryOutcome<HomeAccountSearchResultV1>> {
    return query({
        scope: params.scope,
        actionId: 'home.accounts.search',
        input: { query: params.query.trim(), scope: { kind: 'home' } },
        parse: (value) => HomeAccountSearchResultV1Schema.safeParse(value),
    });
}

/**
 * A mutation answered with a typed value. Nothing here touches the governance projection: Home
 * settings and mail are not part of what the viewer may do, so the answer itself is the new state.
 */
async function mutateForValue<TValue>(params: Readonly<{
    scope: ServerAccountScope;
    actionId: HomeGovernanceActionIdV1;
    input: unknown;
    parse: (value: unknown) => { success: true; data: TValue } | { success: false };
}>): Promise<HomeGovernanceValueMutationOutcome<TValue>> {
    const outcome = await executeHomeAction(params);
    if (outcome.kind !== 'completed') return outcome;
    const parsed = params.parse(outcome.result);
    if (!parsed.success) {
        return Object.freeze({
            kind: 'failed' as const,
            failure: Object.freeze({ kind: 'invalid' as const, retryable: false, code: null }),
        });
    }
    return Object.freeze({ kind: 'succeeded' as const, value: parsed.data });
}

/** The Home's effective configuration, one entry per registry key, with each value's source. */
export function getHomeSettings(params: Readonly<{
    scope: ServerAccountScope;
}>): Promise<HomeGovernanceQueryOutcome<HomeSettingsProjectionV1>> {
    return query({
        scope: params.scope,
        actionId: 'home.settings.get',
        input: {},
        parse: (value) => HomeSettingsProjectionV1Schema.safeParse(value),
    });
}

/** A fresh, exact-Home owner read before offering empty Personal Home removal. */
export function getHomeEmptiness(params: Readonly<{
    scope: ServerAccountScope;
}>): Promise<HomeGovernanceQueryOutcome<HomeEmptinessV1>> {
    return query({
        scope: params.scope,
        actionId: 'home.emptiness.get',
        input: {},
        parse: (value) => HomeEmptinessV1Schema.safeParse(value),
    });
}

/**
 * Stores Home setting values against the revision the caller last read. `null` clears a stored
 * value; secrets travel only as Replace or Clear, never as a value.
 */
export function setHomeSettings(params: Readonly<{
    scope: ServerAccountScope;
    expectedRevision: number;
    values: Readonly<Record<string, unknown>>;
    secrets?: Readonly<Record<string, HomeSettingSecretWriteV1>>;
    /** Discard: the Home returns every pending restart value to what its server started with. */
    discardPendingRestart?: true;
}>): Promise<HomeGovernanceValueMutationOutcome<HomeSettingsProjectionV1>> {
    return mutateForValue({
        scope: params.scope,
        actionId: 'home.settings.set',
        input: {
            expectedRevision: params.expectedRevision,
            values: params.values,
            ...(params.secrets && Object.keys(params.secrets).length > 0 ? { secrets: params.secrets } : {}),
            ...(params.discardPendingRestart ? { discardPendingRestart: true as const } : {}),
        },
        parse: (value) => HomeSettingsProjectionV1Schema.safeParse(value),
    });
}

/** The key and reason of a `home_settings_invalid` refusal, or `null` for any other failure. */
export function readHomeSettingsInvalidFailure(
    failure: HomeDomainFailure,
): Readonly<{ key: string; reason: HomeSettingsInvalidReasonV1 }> | null {
    const parsed = HomeSettingsInvalidErrorV1Schema.safeParse(failure.details);
    return parsed.success ? Object.freeze({ key: parsed.data.key, reason: parsed.data.reason }) : null;
}

/** Whether this Home can send mail: a configured transport and a link a mail can carry. */
export function getHomeMailDelivery(params: Readonly<{
    scope: ServerAccountScope;
}>): Promise<HomeGovernanceQueryOutcome<HomeMailDeliveryReadinessV1>> {
    return query({
        scope: params.scope,
        actionId: 'home.mailDelivery.get',
        input: {},
        parse: (value) => HomeMailDeliveryReadinessV1Schema.safeParse(value),
    });
}

/** Sends the Home's fixed test message; a failure is reported by its class only. */
export function sendHomeTestEmail(params: Readonly<{
    scope: ServerAccountScope;
    to: string;
}>): Promise<HomeGovernanceValueMutationOutcome<HomeMailDeliveryTestResultV1>> {
    return mutateForValue({
        scope: params.scope,
        actionId: 'home.mailDelivery.test',
        input: { to: params.to.trim() },
        parse: (value) => HomeMailDeliveryTestResultV1Schema.safeParse(value),
    });
}

/** One page of the Home's administration events, newest first. */
export function listHomeAudit(params: Readonly<{
    scope: ServerAccountScope;
    cursor?: string | null;
    limit?: number;
    targetId?: string;
}>): Promise<HomeGovernanceQueryOutcome<HomeAuditListResultV1>> {
    return query({
        scope: params.scope,
        actionId: 'home.audit.list',
        input: {
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
            ...(params.targetId ? { targetId: params.targetId } : {}),
        },
        parse: (value) => HomeAuditListResultV1Schema.safeParse(value),
    });
}

/** How this Home is reached: effective addresses with their sources, the host's access method, direct connections. */
export function getHomeReachability(params: Readonly<{
    scope: ServerAccountScope;
}>): Promise<HomeGovernanceQueryOutcome<HomeReachabilityV1>> {
    return query({
        scope: params.scope,
        actionId: 'home.reachability.get',
        input: {},
        parse: (value) => HomeReachabilityV1Schema.safeParse(value),
    });
}

/**
 * Turns direct (Iroh) connections on or off. Off retires the current direct-connection identity for
 * good; the surface confirms that with the person before calling.
 */
export function setHomeIrohMode(params: Readonly<{
    scope: ServerAccountScope;
    mode: HomeIrohModeV1;
}>): Promise<HomeGovernanceValueMutationOutcome<HomeReachabilityV1>> {
    return mutateForValue({
        scope: params.scope,
        actionId: 'home.reachability.iroh.set',
        input: { mode: params.mode },
        parse: (value) => HomeReachabilityV1Schema.safeParse(value),
    });
}

/**
 * One retention sweep of the Home's current rules with deletion forced off: per-domain would-delete
 * counts and why each domain stopped. Read-only; the answer is request state and is not kept. A
 * sweep that holds the lock answers `retention_sweep_in_progress`.
 */
export function runHomeRetentionDryRun(params: Readonly<{
    scope: ServerAccountScope;
}>): Promise<HomeGovernanceQueryOutcome<HomeRetentionDryRunResultV1>> {
    return query({
        scope: params.scope,
        actionId: 'home.retention.dryRun',
        input: {},
        parse: (value) => HomeRetentionDryRunResultV1Schema.safeParse(value),
    });
}
