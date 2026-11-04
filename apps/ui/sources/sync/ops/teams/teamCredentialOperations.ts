import {
    TeamCredentialResourceActivityPageV1Schema,
    TeamCredentialResourceEntitledPageV1Schema,
    TeamCredentialResourceDiscoveryPageV1Schema,
    type TeamCredentialResourceDiscoveryPageV1,
    TeamCredentialResourceMutationResultV1Schema,
    TeamCredentialResourcePageV1Schema,
    TeamCredentialResourceSummaryV1Schema,
    type TeamCredentialRouteV1,
    type TeamCredentialBrokerPlacementV1,
    type TeamCredentialDeliveryPolicyV1,
    type TeamCredentialResourceActivityPageV1,
    type TeamCredentialResourceEntitledPageV1,
    type TeamCredentialResourceAudienceGrantV1,
    type TeamCredentialResourceMemberGrantV1,
    type TeamCredentialResourceMutationResultV1,
    type TeamCredentialResourcePageV1,
    type TeamCredentialResourceSummaryV1,
    type TeamCredentialSessionUsePolicyV1,
    type TeamCredentialRequestPolicyV1,
    type TeamCredentialResourceCreateInputV1,
    type TeamCredentialResourceUpdateInputV1,
    TeamCredentialSourceResourceListOutputV1Schema,
    type TeamCredentialSourceLocatorV1,
    type TeamCredentialSourceResourceListOutputV1,
    TeamCredentialUsageLimitListOutputV1Schema,
    TeamCredentialUsageLimitUpsertOutputV1Schema,
    TeamCredentialUsageQueryResultV1Schema,
    type TeamCredentialUsageLimitListOutputV1,
    type TeamCredentialUsageLimitUpsertInputV1,
    type TeamCredentialUsageLimitUpsertOutputV1,
    type TeamCredentialUsageQueryInputV1,
    type TeamCredentialUsageQueryResultV1,
    TeamCredentialExternalApiKeyCreateOutputV1Schema,
    TeamCredentialExternalApiKeyAuthorizeOutputV1Schema,
    TeamCredentialExternalApiKeyListOutputV1Schema,
    TeamCredentialExternalApiKeyRevokeOutputV1Schema,
    TeamCredentialExternalApiKeyRevokeAllOutputV1Schema,
    type TeamCredentialExternalApiKeyCreateOutputV1,
    type TeamCredentialExternalApiKeyAuthorizeOutputV1,
    type TeamCredentialExternalApiKeyListOutputV1,
    type TeamCredentialExternalApiKeyRevokeOutputV1,
    type TeamCredentialExternalApiKeyRevokeAllOutputV1,
    TeamCredentialSourceCandidateListOutputV1Schema,
    type TeamCredentialSourceCandidateListOutputV1,
    TeamCredentialPreparationOutputV1Schema,
    type TeamCredentialPreparationOutputV1,
    TeamCredentialTestActionOutputV1Schema,
    type TeamCredentialTestActionOutputV1,
    TeamCredentialRequestPolicySupportOutputV1Schema,
    type TeamCredentialRequestPolicySupportInputV1,
    type TeamCredentialRequestPolicySupportOutputV1,
} from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ProviderBrokerApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { invalidateTeamCredentialResources } from '@/sync/store/teams/teamsSnapshots';

import { runTeamAction, type HomeDomainFailure } from './teamActionClient';

/**
 * Team shared-credential reads and mutations, addressed to one explicit Home.
 *
 * Mutating intents go through the same Team Action front door as membership and
 * Group work, so approval, per-surface enablement and provenance are enforced
 * identically. User-facing preparation reads use that same front door; the
 * daemon retains ownership of the recipient census and material preparation.
 *
 * `expectedRevision` travels on every mutation the contract fences. A refusal
 * carrying `conflict` means the resource moved under the editor; the caller
 * re-reads rather than resubmitting, because a blind retry would overwrite
 * whoever moved it.
 */

export type TeamCredentialOutcome<TValue> =
    | Readonly<{ kind: 'succeeded'; value: TValue }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>;

/**
 * What a screen wants to happen when its mutation was deferred for approval.
 *
 * A deferred mutation is not a lost one: the Home performs it when the approval
 * is granted, and the screen that asked still owns what the answer means —
 * which resource to open, which row to leave, which draft to release. Without
 * these the surface can only refresh, which loses creation navigation and the
 * one-time secrets a create answer carries.
 */
export type TeamCredentialApprovalHandlers<TValue> = Readonly<{
    onApprovalSucceeded?: (value: TValue) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>;

function approvalOptions<TValue>(params: Readonly<{
    scope: ServerAccountScope;
    /** Present for mutations whose commit invalidates the Team's resource list. */
    address?: TeamAddress;
    resourceId?: string;
    handlers?: TeamCredentialApprovalHandlers<TValue>;
}>): Readonly<{
    onApprovalSucceeded?: (value: TValue) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}> {
    const handlers = params.handlers;
    if (!handlers?.onApprovalSucceeded && !handlers?.onApprovalFailed) return {};
    const address = params.address;
    return Object.freeze({
        ...(handlers.onApprovalSucceeded ? {
            onApprovalSucceeded: async (value: TValue) => {
                // The Home committed this write when the approval executed, so
                // the projection is stale before the screen reads it back.
                if (address) invalidateTeamCredentialResources(params.scope, address, params.resourceId);
                await handlers.onApprovalSucceeded?.(value);
            },
        } : {}),
        ...(handlers.onApprovalFailed ? { onApprovalFailed: handlers.onApprovalFailed } : {}),
    });
}

function succeeded<TValue>(value: TValue): TeamCredentialOutcome<TValue> {
    return Object.freeze({ kind: 'succeeded' as const, value });
}

function failed<TValue>(failure: HomeDomainFailure): TeamCredentialOutcome<TValue> {
    return Object.freeze({ kind: 'failed' as const, failure });
}

function mutationMayHaveCommitted<TValue>(outcome: TeamCredentialOutcome<TValue>): boolean {
    return outcome.kind === 'succeeded' || outcome.failure.kind === 'outcome_unknown';
}

export function listTeamCredentialResources(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    cursor?: string | null;
    limit?: number;
    search?: string;
    filter?: 'all' | 'needs_attention' | 'brokered' | 'direct' | 'external_api';
    signal?: AbortSignal;
}>): Promise<TeamCredentialOutcome<TeamCredentialResourcePageV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.list',
        input: {
            teamId: params.address.teamId,
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.limit === undefined ? {} : { limit: params.limit }),
            ...(params.search === undefined ? {} : { search: params.search }),
            ...(params.filter === undefined ? {} : { filter: params.filter }),
        },
        parse: (value) => TeamCredentialResourcePageV1Schema.parse(value),
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

/** Reads the canonical administration projection for one exact resource. */
export function getTeamCredentialResource(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    signal?: AbortSignal;
}>): Promise<TeamCredentialOutcome<TeamCredentialResourceSummaryV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.get',
        input: { resourceId: params.resourceId },
        parse: (value) => TeamCredentialResourceSummaryV1Schema.parse(value),
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

/** Finite recipient probes retain their exact Team and page. */
export function listEntitledTeamCredentialResources(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    application?: ProviderBrokerApplicationBindingV1;
    signal?: AbortSignal;
    cursor?: string | null;
}>): Promise<TeamCredentialOutcome<TeamCredentialResourceEntitledPageV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.entitled.list',
        input: { teamId: params.address.teamId, ...(params.application ? { application: params.application } : {}),
            ...(params.cursor ? { cursor: params.cursor } : {}) },
        parse: value => TeamCredentialResourceEntitledPageV1Schema.parse(value),
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

/** One known catalog set receives one admission under the existing read Action. */
export function discoverEntitledTeamCredentialResources(params: Readonly<{
    scope: ServerAccountScope;
    teamIds: readonly string[];
    application?: ProviderBrokerApplicationBindingV1;
    cursor?: string;
    shouldContinue: () => boolean;
    signal?: AbortSignal;
}>): Promise<TeamCredentialOutcome<TeamCredentialResourceDiscoveryPageV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.entitled.list',
        input: { teamIds: params.teamIds, ...(params.application ? { application: params.application } : {}),
            ...(params.cursor ? { cursor: params.cursor } : {}) },
        parse: value => TeamCredentialResourceDiscoveryPageV1Schema.parse(value),
        executorOptions: { homeDomainReadCurrentness: params.shouldContinue },
        signal: params.signal,
    });
}

export async function listTeamCredentialActivity(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
}>): Promise<TeamCredentialOutcome<TeamCredentialResourceActivityPageV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.activity.list',
        signal: params.signal,
        input: {
            resourceId: params.resourceId,
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.limit === undefined ? {} : { limit: params.limit }),
        },
        parse: (value) => TeamCredentialResourceActivityPageV1Schema.parse(value),
    });
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

/**
 * The sources this viewer may offer to this Team, each already carrying the
 * exact lifetime a resource would pin to it.
 *
 * The pin is the Home's own fact and is deliberately absent from the Connected
 * Account projections this client holds, so the chooser asks for candidates
 * instead of assembling bindings. It is read when the create surface opens
 * rather than kept in the Team snapshot: a source list is only ever needed by
 * the one screen that offers a source, and retaining it would age against a
 * Pool the owner changed elsewhere.
 */
export function listTeamCredentialSourceCandidates(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    signal?: AbortSignal;
}>): Promise<TeamCredentialOutcome<TeamCredentialSourceCandidateListOutputV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.sources.list',
        input: { teamId: params.address.teamId },
        parse: (value) => TeamCredentialSourceCandidateListOutputV1Schema.parse(value),
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

/** Exact source policy support, discovered by the Home through the broker owner. */
export function getTeamCredentialRequestPolicySupport(params: Readonly<{
    scope: ServerAccountScope;
    input: TeamCredentialRequestPolicySupportInputV1;
    signal?: AbortSignal;
}>): Promise<TeamCredentialOutcome<TeamCredentialRequestPolicySupportOutputV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.requestPolicySupport.get',
        input: params.input,
        parse: (value) => TeamCredentialRequestPolicySupportOutputV1Schema.parse(value),
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

/** Source-scoped administration remains reachable after Team membership ends. */
export function listTeamCredentialSourceResources(params: Readonly<{
    scope: ServerAccountScope;
    source: TeamCredentialSourceLocatorV1;
    signal?: AbortSignal;
    cursor?: string | null;
}>): Promise<TeamCredentialOutcome<TeamCredentialSourceResourceListOutputV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.sourceResources.list',
        input: { source: params.source, ...(params.cursor ? { cursor: params.cursor } : {}) },
        parse: (value) => TeamCredentialSourceResourceListOutputV1Schema.parse(value),
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

/** Source-owner, material-safe preparation status. Crypto remains daemon-owned. */
export function getTeamCredentialPreparation(params: Readonly<{
    scope: ServerAccountScope;
    teamId: string;
    resourceId: string;
    signal?: AbortSignal;
}>): Promise<TeamCredentialOutcome<TeamCredentialPreparationOutputV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.preparation.get',
        signal: params.signal,
        input: { teamId: params.teamId, resourceId: params.resourceId },
        parse: (value) => TeamCredentialPreparationOutputV1Schema.parse(value),
    });
}

export function testTeamCredentialResource(params: Readonly<{
    scope: ServerAccountScope;
    teamId: string;
    resourceId: string;
    handlers?: TeamCredentialApprovalHandlers<TeamCredentialTestActionOutputV1>;
}>): Promise<TeamCredentialOutcome<TeamCredentialTestActionOutputV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.test',
        input: { teamId: params.teamId, resourceId: params.resourceId },
        parse: (value) => TeamCredentialTestActionOutputV1Schema.parse(value),
        // Test is a real external effect on the production path, so its answer
        // is the readiness the person asked for, not a reason to refresh.
        ...approvalOptions({
            scope: params.scope,
            ...(params.handlers ? { handlers: params.handlers } : {}),
        }),
    });
}

/**
 * Resource writes all share the canonical Action/approval/reconciliation path.
 * Create returns the new administration row; later writes intentionally return
 * only identity and revision so a departed source custodian cannot receive
 * Team administration data through a mutation response.
 */
async function resourceMutation<TValue>(params: Readonly<{
    scope: ServerAccountScope;
    address?: TeamAddress;
    resourceId: string;
    actionId: 'teams.credentials.create' | 'teams.credentials.update' | 'teams.credentials.audience.set';
    input: unknown;
    parse: (value: unknown) => TValue;
    approval?: 'surface_confirmed';
    signal?: AbortSignal;
    handlers?: TeamCredentialApprovalHandlers<TValue>;
}>): Promise<TeamCredentialOutcome<TValue>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: params.actionId,
        input: params.input,
        parse: params.parse,
        ...(params.approval ? { approval: params.approval } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...approvalOptions({
            scope: params.scope,
            ...(params.address ? { address: params.address } : {}),
            resourceId: params.resourceId,
            ...(params.handlers ? { handlers: params.handlers } : {}),
        }),
    });
    // A settled refusal changed nothing on the Home. Outcome-unknown is
    // different: the write may have committed, so every consumer must reconcile
    // through the one canonical projection before another attempt.
    if (mutationMayHaveCommitted(outcome)) {
        if (params.address) invalidateTeamCredentialResources(params.scope, params.address, params.resourceId);
    }
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

/**
 * `resourceId` is the caller's retry identity: the Home returns the same
 * resource for a repeated request with identical content instead of offering
 * one source to a Team twice.
 */
export function createTeamCredentialResource(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    confirmedByPresentUser?: true;
    handlers?: TeamCredentialApprovalHandlers<TeamCredentialResourceSummaryV1>;
}> & Omit<TeamCredentialResourceCreateInputV1, 'teamId'>): Promise<TeamCredentialOutcome<TeamCredentialResourceSummaryV1>> {
    return resourceMutation({
        scope: params.scope,
        ...(params.address ? { address: params.address } : {}),
        actionId: 'teams.credentials.create',
        ...(params.confirmedByPresentUser ? { approval: 'surface_confirmed' } : {}),
        resourceId: params.resourceId,
        parse: (value) => TeamCredentialResourceSummaryV1Schema.parse(value),
        ...(params.handlers ? { handlers: params.handlers } : {}),
        input: { teamId: params.address.teamId, resourceId: params.resourceId, displayName: params.displayName,
            source: params.source, deliveryPolicy: params.deliveryPolicy, sessionUsePolicy: params.sessionUsePolicy,
            brokerPlacement: params.brokerPlacement, requestPolicy: params.requestPolicy,
            allMembersAllowedRoutes: params.allMembersAllowedRoutes, groupGrants: params.groupGrants,
            memberGrants: params.memberGrants, usageLimits: params.usageLimits },
    });
}

/**
 * Sends either a legacy bounded patch or the route-owned editor's one complete
 * replacement with omitted fields retained by the Home. The Home rejects mixing both shapes and fences either form on
 * the exact revision supplied by the caller.
 */
export function updateTeamCredentialResource(params: Readonly<{
    scope: ServerAccountScope;
    address?: TeamAddress;
    resourceId: string;
    expectedRevision: number;
    enabled?: boolean;
    displayName?: string;
    deliveryPolicy?: TeamCredentialDeliveryPolicyV1;
    sessionUsePolicy?: TeamCredentialSessionUsePolicyV1;
    brokerPlacement?: TeamCredentialBrokerPlacementV1 | null;
    requestPolicy?: TeamCredentialRequestPolicyV1 | null;
    replacement?: TeamCredentialResourceUpdateInputV1['replacement'];
    confirmedByPresentUser?: true;
    signal?: AbortSignal;
    handlers?: TeamCredentialApprovalHandlers<TeamCredentialResourceMutationResultV1>;
}>): Promise<TeamCredentialOutcome<TeamCredentialResourceMutationResultV1>> {
    return resourceMutation({
        scope: params.scope,
        ...(params.address ? { address: params.address } : {}),
        actionId: 'teams.credentials.update',
        resourceId: params.resourceId,
        parse: (value) => TeamCredentialResourceMutationResultV1Schema.parse(value),
        ...(params.handlers ? { handlers: params.handlers } : {}),
        input: {
            resourceId: params.resourceId,
            expectedRevision: params.expectedRevision,
            ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
            ...(params.displayName === undefined ? {} : { displayName: params.displayName }),
            ...(params.deliveryPolicy === undefined ? {} : { deliveryPolicy: params.deliveryPolicy }),
            ...(params.sessionUsePolicy === undefined ? {} : { sessionUsePolicy: params.sessionUsePolicy }),
            ...(params.brokerPlacement === undefined ? {} : { brokerPlacement: params.brokerPlacement }),
            ...(params.requestPolicy === undefined ? {} : { requestPolicy: params.requestPolicy }),
            ...(params.replacement === undefined ? {} : { replacement: params.replacement }),
        },
        ...(params.confirmedByPresentUser ? { approval: 'surface_confirmed' } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

/**
 * The audience is replaced whole, which is what makes removal expressible: a
 * per-grant patch could never say "this Group no longer has access". The
 * Team-wide grant is `null` when nobody holds access by default; it is
 * deliberately not conflated with an empty grant list.
 */
export function setTeamCredentialAudience(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    resourceId: string;
    expectedRevision: number;
    allMembersAllowedRoutes: readonly TeamCredentialRouteV1[] | null;
    groupGrants: readonly TeamCredentialResourceAudienceGrantV1[];
    memberGrants: readonly TeamCredentialResourceMemberGrantV1[];
    handlers?: TeamCredentialApprovalHandlers<TeamCredentialResourceMutationResultV1>;
}>): Promise<TeamCredentialOutcome<TeamCredentialResourceMutationResultV1>> {
    return resourceMutation({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.credentials.audience.set',
        resourceId: params.resourceId,
        parse: (value) => TeamCredentialResourceMutationResultV1Schema.parse(value),
        ...(params.handlers ? { handlers: params.handlers } : {}),
        input: {
            resourceId: params.resourceId,
            expectedRevision: params.expectedRevision,
            allMembersAllowedRoutes: params.allMembersAllowedRoutes,
            groupGrants: [...params.groupGrants],
            memberGrants: [...params.memberGrants],
        },
    });
}

export async function deleteTeamCredentialResource(params: Readonly<{
    scope: ServerAccountScope;
    address?: TeamAddress;
    resourceId: string;
    expectedRevision: number;
    confirmedByPresentUser?: true;
    signal?: AbortSignal;
    handlers?: TeamCredentialApprovalHandlers<TeamCredentialResourceMutationResultV1>;
}>): Promise<TeamCredentialOutcome<TeamCredentialResourceMutationResultV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.delete',
        input: { resourceId: params.resourceId, expectedRevision: params.expectedRevision },
        parse: (value) => TeamCredentialResourceMutationResultV1Schema.parse(value),
        ...(params.confirmedByPresentUser ? { approval: 'surface_confirmed' } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...approvalOptions({
            scope: params.scope,
            ...(params.address ? { address: params.address } : {}),
            resourceId: params.resourceId,
            ...(params.handlers ? { handlers: params.handlers } : {}),
        }),
    });
    if (mutationMayHaveCommitted(outcome)) {
        if (params.address) invalidateTeamCredentialResources(params.scope, params.address, params.resourceId);
    }
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

/**
 * Usage and limits are resource-scoped Actions, not a second Team analytics
 * transport. These wrappers deliberately stay beside the resource mutations so
 * every credential surface keeps the same exact-Home Action front door.
 */
export function listTeamCredentialUsageLimits(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    signal?: AbortSignal;
}>): Promise<TeamCredentialOutcome<TeamCredentialUsageLimitListOutputV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.limits.list',
        signal: params.signal,
        input: { resourceId: params.resourceId },
        parse: (value) => TeamCredentialUsageLimitListOutputV1Schema.parse(value),
    });
}

export async function upsertTeamCredentialUsageLimit(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    input: TeamCredentialUsageLimitUpsertInputV1;
    handlers?: TeamCredentialApprovalHandlers<TeamCredentialUsageLimitUpsertOutputV1>;
}>): Promise<TeamCredentialOutcome<TeamCredentialUsageLimitUpsertOutputV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.limits.upsert',
        input: params.input,
        parse: (value) => TeamCredentialUsageLimitUpsertOutputV1Schema.parse(value),
        ...approvalOptions({
            scope: params.scope,
            address: params.address,
            resourceId: params.input.resourceId,
            ...(params.handlers ? { handlers: params.handlers } : {}),
        }),
    });
    if (mutationMayHaveCommitted(outcome)) invalidateTeamCredentialResources(params.scope, params.address, params.input.resourceId);
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

export async function deleteTeamCredentialUsageLimit(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    resourceId: string;
    expectedRevision: number;
    limitId: string;
    confirmedByPresentUser?: true;
    handlers?: TeamCredentialApprovalHandlers<TeamCredentialResourceMutationResultV1>;
}>): Promise<TeamCredentialOutcome<TeamCredentialResourceMutationResultV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.limits.delete',
        input: {
            resourceId: params.resourceId,
            expectedRevision: params.expectedRevision,
            limitId: params.limitId,
        },
        parse: (value) => TeamCredentialResourceMutationResultV1Schema.parse(value),
        ...(params.confirmedByPresentUser ? { approval: 'surface_confirmed' } : {}),
        ...approvalOptions({
            scope: params.scope,
            address: params.address,
            resourceId: params.resourceId,
            ...(params.handlers ? { handlers: params.handlers } : {}),
        }),
    });
    if (mutationMayHaveCommitted(outcome)) invalidateTeamCredentialResources(params.scope, params.address, params.resourceId);
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

export function queryTeamCredentialUsage(params: Readonly<{
    scope: ServerAccountScope;
    input: TeamCredentialUsageQueryInputV1;
    signal?: AbortSignal;
}>): Promise<TeamCredentialOutcome<TeamCredentialUsageQueryResultV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.usage.query',
        signal: params.signal,
        input: params.input,
        parse: (value) => TeamCredentialUsageQueryResultV1Schema.parse(value),
    });
}

export function listTeamCredentialExternalApiKeys(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    signal?: AbortSignal;
}>): Promise<TeamCredentialOutcome<TeamCredentialExternalApiKeyListOutputV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.externalKeys.list',
        signal: params.signal,
        input: { resourceId: params.resourceId },
        parse: (value) => TeamCredentialExternalApiKeyListOutputV1Schema.parse(value),
    });
}

export function authorizeTeamCredentialExternalApiKey(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    keyId: string;
    handlers?: TeamCredentialApprovalHandlers<TeamCredentialExternalApiKeyAuthorizeOutputV1>;
}>): Promise<TeamCredentialOutcome<TeamCredentialExternalApiKeyAuthorizeOutputV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.externalKeys.authorize',
        input: { resourceId: params.resourceId, keyId: params.keyId },
        parse: (value) => TeamCredentialExternalApiKeyAuthorizeOutputV1Schema.parse(value),
        ...approvalOptions({
            scope: params.scope,
            ...(params.handlers ? { handlers: params.handlers } : {}),
        }),
    });
}

export function createTeamCredentialExternalApiKey(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    teamMembershipId: string;
    label: string;
    expiresAt?: string | null;
    handlers?: TeamCredentialApprovalHandlers<TeamCredentialExternalApiKeyCreateOutputV1>;
}>): Promise<TeamCredentialOutcome<TeamCredentialExternalApiKeyCreateOutputV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.externalKeys.create',
        input: {
            resourceId: params.resourceId,
            teamMembershipId: params.teamMembershipId,
            label: params.label,
            expiresAt: params.expiresAt ?? null,
        },
        parse: (value) => TeamCredentialExternalApiKeyCreateOutputV1Schema.parse(value),
        // A create answer carries the one-time clear token. Losing it to a
        // deferred approval would leave a live key nobody can ever use.
        ...approvalOptions({
            scope: params.scope,
            ...(params.handlers ? { handlers: params.handlers } : {}),
        }),
    });
}

export function revokeTeamCredentialExternalApiKey(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    keyId: string;
    confirmedByPresentUser?: true;
    signal?: AbortSignal;
    handlers?: TeamCredentialApprovalHandlers<TeamCredentialExternalApiKeyRevokeOutputV1>;
}>): Promise<TeamCredentialOutcome<TeamCredentialExternalApiKeyRevokeOutputV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.externalKeys.revoke',
        input: { resourceId: params.resourceId, keyId: params.keyId },
        parse: (value) => TeamCredentialExternalApiKeyRevokeOutputV1Schema.parse(value),
        ...(params.confirmedByPresentUser ? { approval: 'surface_confirmed' } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...approvalOptions({
            scope: params.scope,
            ...(params.handlers ? { handlers: params.handlers } : {}),
        }),
    });
}

export function revokeAllTeamCredentialExternalApiKeys(params: Readonly<{
    scope: ServerAccountScope;
    resourceId: string;
    confirmedByPresentUser?: true;
    signal?: AbortSignal;
    handlers?: TeamCredentialApprovalHandlers<TeamCredentialExternalApiKeyRevokeAllOutputV1>;
}>): Promise<TeamCredentialOutcome<TeamCredentialExternalApiKeyRevokeAllOutputV1>> {
    return runTeamAction({
        scope: params.scope,
        actionId: 'teams.credentials.externalKeys.revokeAll',
        input: { resourceId: params.resourceId },
        parse: (value) => TeamCredentialExternalApiKeyRevokeAllOutputV1Schema.parse(value),
        ...(params.confirmedByPresentUser ? { approval: 'surface_confirmed' } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...approvalOptions({
            scope: params.scope,
            ...(params.handlers ? { handlers: params.handlers } : {}),
        }),
    });
}
