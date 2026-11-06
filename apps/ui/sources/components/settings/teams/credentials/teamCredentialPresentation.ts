import { deliveryModeLabel } from '@/sync/domains/teams/teamCredentialDeliveryPresentation';
export { deliveryModeLabel } from '@/sync/domains/teams/teamCredentialDeliveryPresentation';
import type {
    TeamCredentialBrokerPlacementV1,
    TeamCredentialRouteV1,
    TeamCredentialRequestProtocolKindV1,
    TeamCredentialResourceRecoveryActionV1,
    TeamCredentialResourceSummaryV1,
    TeamCredentialResourceReadinessV1,
    TeamCredentialResourceSourcePresentationV1,
    TeamCredentialSessionUsePolicyV1,
    TeamCredentialSourceBindingV1,
    TeamCredentialUsageBreakdownDimensionV1,
    TeamCredentialUsageLimitMetricV1,
    TeamCredentialUsageLimitPeriodV1,
    TeamCredentialUsageLimitSubjectKindV1,
    TeamCredentialUsageLimitV1,
} from '@happier-dev/protocol/teams';

import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import { t } from '@/text';
import { teamMutationFailureLabel } from '../teamMutationPresentation';
import type { ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveQualifiedConnectedServiceMarkId } from '@/components/settings/connectedServices/model/resolveQualifiedConnectedServiceMarkId';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveUsageQueryPeriod, type UsageRelativePeriod } from '@happier-dev/protocol/inputs/usageQuery';

/** Team Usage requires explicit numeric bounds; its All range keeps the existing epoch contract. */
export function resolveTeamCredentialUsageStartTimeSeconds(period: UsageRelativePeriod, nowMs: number): number {
    if (period === 'all') return 0;
    if (period === 'today') {
        const today = new Date(nowMs);
        today.setHours(0, 0, 0, 0);
        return Math.floor(today.getTime() / 1000);
    }
    return resolveUsageQueryPeriod({ period: { relative: period }, timeZoneOffsetMinutes: 0 }, nowMs).startMs! / 1000;
}

/** Member keys are Account identities; their titles consume the Members presentation rule. */
export function usageBreakdownPresentation(
    dimension: TeamCredentialUsageBreakdownDimensionV1,
    entry: Readonly<{ key: string; label?: string }>,
    viewerAccountId?: string | null,
): Readonly<{ name: string; hint: string | null }> {
    if (dimension !== 'member') return { name: entry.label ?? entry.key, hint: null };
    return resolveAccountDisplayName({
        // The Home's label already resolves canonical name/username through Protocol.
        profile: { name: entry.label ?? null, firstName: null, lastName: null, username: null, avatarUrl: null },
        accountId: entry.key,
        viewerAccountId,
    });
}

export function resourceConnectedServiceMarkId(
    resource: Readonly<{ sourcePresentation: TeamCredentialResourceSourcePresentationV1 | null }>,
    registry: Pick<ConnectedServiceRegistrySnapshot, 'entries'>,
): string | null {
    return resource.sourcePresentation?.kind === 'connected_service'
        ? resolveQualifiedConnectedServiceMarkId(registry, resource.sourcePresentation.service)
        : null;
}

export function teamCredentialBrokerPlacementsEqual(
    left: TeamCredentialBrokerPlacementV1 | null,
    right: TeamCredentialBrokerPlacementV1 | null,
): boolean {
    if (left === null || right === null) return left === right;
    return left.kind === 'machine'
        ? right.kind === 'machine' && left.machineId === right.machineId
        : right.kind === 'machine_pool' && left.poolId === right.poolId;
}

export function teamCredentialBrokerPoolAvailabilityLabel(
    availability: 'available' | 'unavailable' | 'not_verified',
    availableMachineCount: number | null,
): string {
    if (availability === 'not_verified') return t('machinePools.notVerified');
    if (availability === 'unavailable') return t('machinePools.brokerUnavailable');
    return availableMachineCount === null
        ? t('machinePools.notVerified')
        : t('machinePools.brokerAvailable', { count: availableMachineCount });
}

/**
 * How a shared credential reads in a list, a header and a screen reader.
 *
 * Everything here is a projection of the Home's own answer. Nothing in this
 * module decides availability, authority or delivery: a row says what the
 * resource *is* and what the Home said about it, and the surfaces gate their
 * controls on the separately projected viewer decision.
 */

/** The source family, which is metadata rather than the administrator's task. */
export function sourceKindLabel(source: TeamCredentialSourceBindingV1 | TeamCredentialResourceSourcePresentationV1 | null): string {
    if (source === null) return t('teams.credentials.errors.sourceMissing');
    switch (source.kind) {
        case 'connected_account':
            return t('teams.credentials.source.connectedAccount');
        case 'connected_pool':
            return t('teams.credentials.source.pool');
        case 'provider_connection':
            return t('teams.credentials.source.providerConnection');
        case 'connected_service':
            return t('teams.credentials.source.connectedAccount');
        case 'provider':
            return t('teams.credentials.source.providerConnection');
    }
}

export function recipientDeliveryMode(
    resource: Readonly<{ allowedRoutes?: readonly TeamCredentialRouteV1[] }>,
): readonly TeamCredentialRouteV1[] | null {
    return resource.allowedRoutes?.length ? resource.allowedRoutes : null;
}

/**
 * The delivery summary for a whole resource.
 *
 * Effective access is additive, so a resource whose grants disagree is reported
 * as mixed rather than flattened to the safest or the most alarming of them.
 * A resource nobody can reach yet says so instead of claiming a mode.
 */
export function resourceDeliverySummary(resource: TeamCredentialResourceSummaryV1): string | null {
    const audiences = [
        ...(resource.allMembersAllowedRoutes === null ? [] : [resource.allMembersAllowedRoutes]),
        ...resource.groupGrants.map((grant) => grant.allowedRoutes),
        ...resource.memberGrants.map((grant) => grant.allowedRoutes),
    ];
    const modes = new Set(audiences.map(routes => [...routes].sort().join(',')));
    if (modes.size === 0) return null;
    if (modes.size === 1) {
        const [only] = audiences;
        return only === undefined ? null : deliveryModeLabel(only);
    }
    return t('teams.credentials.delivery.mixed');
}

/**
 * How much of this resource's audience receives material directly.
 *
 * Limits and usage both need this fact and neither may infer it from a label:
 * Happier records nothing that happens on a recipient's own machine, so a
 * resource shared only directly cannot be metered at all, and a mixed one can be
 * metered only in part. `none` is also the answer for a resource nobody holds
 * yet, because no disclosure exists.
 */
export type TeamCredentialDirectExposure = 'none' | 'some' | 'only';

export function resourceDirectExposure(
    resource: TeamCredentialResourceSummaryV1,
): TeamCredentialDirectExposure {
    const modes = [
        ...(resource.allMembersAllowedRoutes === null ? [] : [resource.allMembersAllowedRoutes]),
        ...resource.groupGrants.map((grant) => grant.allowedRoutes),
        ...resource.memberGrants.map((grant) => grant.allowedRoutes),
    ];
    if (modes.length === 0) return 'none';
    if (modes.every((routes) => routes.length === 1 && routes.includes('direct'))) return 'only';
    return modes.some((routes) => routes.includes('direct')) ? 'some' : 'none';
}

/**
 * Who currently holds access, counted rather than named.
 *
 * The Team-wide grant is reported first and separately: it is not one more
 * audience entry, it is the statement that everyone in the Team holds access by
 * default, and collapsing it into a count would hide it behind the Groups.
 */
export function audienceSummary(resource: TeamCredentialResourceSummaryV1): string {
    const parts: string[] = [];
    if (resource.allMembersAllowedRoutes !== null) parts.push(t('teams.credentials.audience.everyone'));
    if (resource.groupGrants.length > 0) {
        parts.push(t('teams.credentials.audience.groupCount', { count: resource.groupGrants.length }));
    }
    if (resource.memberGrants.length > 0) {
        parts.push(t('teams.credentials.audience.memberCount', { count: resource.memberGrants.length }));
    }
    return parts.length === 0 ? t('teams.credentials.audience.none') : parts.join(' · ');
}

/**
 * The one status treatment a row or header may show.
 *
 * The Home computes this from current source, broker, policy and limit facts.
 * The client renders that answer without becoming a second evaluator.
 */
export type TeamCredentialResourceState = TeamCredentialResourceReadinessV1['kind'];

export function resourceState(
    resource: TeamCredentialResourceSummaryV1,
    options?: Readonly<{ audienceKnown?: boolean }>,
): TeamCredentialResourceState {
    void options;
    return resource.readiness.kind;
}

export function resourceStateLabel(state: TeamCredentialResourceState): string {
    switch (state) {
        case 'available':
            return t('teams.credentials.state.available');
        case 'resource_unavailable':
            return t('teams.credentials.state.disabled');
        case 'resource_corrupt':
        case 'source_unavailable':
            return t('teams.credentials.errors.sourceMissing');
        case 'broker_unavailable':
            return t('teams.credentials.errors.brokerUnavailable');
        case 'update_required':
            return t('teams.unavailable.updateRequired');
        case 'policy_denied':
            return t('teams.credentials.forbidden');
        case 'limit_reached':
            return t('teams.credentials.limits.reached');
    }
}

export function sessionUsePolicyLabel(policy: TeamCredentialSessionUsePolicyV1): string {
    switch (policy) {
        case 'personal_allowed':
            return t('teams.credentials.usePolicy.personalAllowed');
        case 'team_context_required':
            return t('teams.credentials.usePolicy.teamContextRequired');
        case 'team_visibility_required':
            return t('teams.credentials.usePolicy.teamVisibilityRequired');
    }
}

/**
 * The facts one row may state, in reading order: what the resource is, then how
 * it stands.
 *
 * The Home masks what this viewer may not administer — a member is sent empty
 * grant lists and the manager-private defaults of `sessionUsePolicy`,
 * `requestPolicy` and the limit counts — so the row asks the Home's own
 * per-resource `capabilities` before speaking, rather than printing a mask as a
 * fact. Policy, limits and usage capability belong to the detail route, which
 * checks the same capability before offering them.
 */
function resourceRowFacts(
    resource: TeamCredentialResourceSummaryV1,
): Readonly<{ identity: readonly string[]; state: string }> {
    const identity = [
        sourceKindLabel(resource.source ?? resource.sourcePresentation),
        resource.capabilities.manageAudience ? resourceDeliverySummary(resource) : null,
    ].filter((part): part is string => part !== null && part !== '');
    return { identity, state: resourceStateLabel(resourceState(resource)) };
}

/**
 * The accessible description of one row.
 *
 * Visual grouping carries the source family and the state on screen; a screen
 * reader gets them in the row itself, because a truncated subtitle or a status
 * dot beside a name is not identity. Each fact is its own comma-separated
 * clause so the name stays a name rather than a recital of the subtitle.
 */
export function resourceAccessibilityLabel(
    resource: TeamCredentialResourceSummaryV1,
    // The Home's per-resource `capabilities` is the one viewer-authority gate;
    // a caller cannot widen or narrow what this viewer was told.
    options?: Readonly<{ audienceKnown?: boolean }>,
): string {
    void options;
    const facts = resourceRowFacts(resource);
    return [resource.displayName, ...facts.identity, facts.state].join(', ');
}

/**
 * The complete list-row projection, rendered without interpreting authority.
 * Every fact comes from the one Home list answer; source internals and raw IDs
 * are intentionally absent even when the source custodian can edit them on the
 * detail route.
 */
export function resourceAdministrationSummaryLines(
    resource: TeamCredentialResourceSummaryV1,
): readonly string[] {
    const facts = resourceRowFacts(resource);
    // A usable resource says nothing about its state: only a state that needs someone earns a line.
    return resourceState(resource) === 'available'
        ? [facts.identity.join(' · ')]
        : [facts.identity.join(' · '), facts.state];
}

/**
 * List order.
 *
 * Display name, not recency: a status change or an edit elsewhere must not move
 * a row out from under someone who is reaching for it. Ties fall back to the
 * resource id so two identically named resources still have a stable order.
 */
export function orderTeamCredentialResources(
    resources: readonly TeamCredentialResourceSummaryV1[],
): readonly TeamCredentialResourceSummaryV1[] {
    return [...resources].sort((left, right) => {
        const byName = left.displayName.localeCompare(right.displayName);
        return byName !== 0 ? byName : left.id.localeCompare(right.id);
    });
}

/**
 * One broker choice, named.
 *
 * A Pool id is the Home's own opaque identifier for a group of computers that
 * belongs to the source custodian rather than to the reader. Printing it would
 * put an internal identifier on a Settings screen that nobody can act on, so an
 * unnamed Pool says it is unnamed and keeps its identity in the row key.
 */
export function brokerPoolChoiceLabel(
    pool: Readonly<{ displayName: string | null }>,
): string {
    return pool.displayName?.trim() || t('teams.credentials.detail.brokerUnnamedPool');
}

export function brokerPlacementLabel(resource: TeamCredentialResourceSummaryV1): string {
    if (resource.brokerPlacement === null) return t('teams.credentials.detail.brokerNone');
    if (resource.brokerPlacement.kind === 'machine_pool') {
        // A Pool is named as one: "Development" beside a Machine's own display
        // name is otherwise indistinguishable from a single computer, and the
        // two behave differently when a connection opens.
        const selectedPool = resource.brokerPresentation.selectedPool;
        const poolName = selectedPool?.poolId === resource.brokerPlacement.poolId
            ? selectedPool.displayName?.trim()
            : null;
        return poolName
            ? `${t('machinePools.title')} · ${poolName}`
            : t('teams.credentials.detail.brokerChosen');
    }
    const selected = resource.brokerPresentation.selectedTarget;
    if (selected?.machineId !== resource.brokerPlacement.machineId) {
        return t('teams.credentials.detail.brokerChosen');
    }
    return selected.displayName?.trim() || t('teams.credentials.detail.brokerChosen');
}

/**
 * The Home's recovery instruction for one unavailable resource, mapped to the
 * single destination that instruction names.
 *
 * The server owns the enum; this module only decides which existing destination
 * each arm means and what the row says. Nothing here decides authority: whether
 * a viewer may actually reach the resource's Settings is applied again by the
 * surface they land on, from the Home's own viewer projection.
 */
export type TeamCredentialRecoveryDestination =
    | 'retry'
    | 'resource_settings'
    | 'broker_selection'
    | 'source_owner_handoff'
    | 'app_update'
    | 'choose_another_resource';

export type TeamCredentialRecoveryTranslationKey =
    | 'teams.unavailable.retry'
    | 'teams.credentials.recovery.openSettings'
    | 'teams.credentials.recovery.selectBroker'
    | 'teams.credentials.recovery.ownerHandoff'
    | 'teams.credentials.recovery.updateApp'
    | 'teams.credentials.recovery.chooseAnother';

export type TeamCredentialRecoveryPresentation = Readonly<{
    destination: TeamCredentialRecoveryDestination;
    labelKey: TeamCredentialRecoveryTranslationKey;
}>;

/**
 * Maps the server-owned recovery enum onto one destination.
 *
 * `source_owner_action` and `select_broker` can only be repaired by the source
 * custodian, so anyone else — including a Team manager, whose surface is
 * audience and limits, not the source — is handed to the owner instead of
 * being offered a destination that would refuse them.
 */
export function teamCredentialRecoveryPresentation(
    action: TeamCredentialResourceRecoveryActionV1 | null | undefined,
    options?: Readonly<{ isSourceCustodian?: boolean }>,
): TeamCredentialRecoveryPresentation | null {
    switch (action) {
        case 'retry':
            return { destination: 'retry', labelKey: 'teams.unavailable.retry' };
        case 'source_owner_action':
            return options?.isSourceCustodian === true
                ? { destination: 'resource_settings', labelKey: 'teams.credentials.recovery.openSettings' }
                : { destination: 'source_owner_handoff', labelKey: 'teams.credentials.recovery.ownerHandoff' };
        case 'select_broker':
            return options?.isSourceCustodian === true
                ? { destination: 'broker_selection', labelKey: 'teams.credentials.recovery.selectBroker' }
                : { destination: 'source_owner_handoff', labelKey: 'teams.credentials.recovery.ownerHandoff' };
        case 'update_required':
            return { destination: 'app_update', labelKey: 'teams.credentials.recovery.updateApp' };
        case 'choose_another_resource':
            return { destination: 'choose_another_resource', labelKey: 'teams.credentials.recovery.chooseAnother' };
        default:
            return null;
    }
}

/** The localized label for surfaces that own the global translator. */
export function teamCredentialRecoveryLabel(presentation: TeamCredentialRecoveryPresentation): string {
    return t(presentation.labelKey);
}

/**
 * Whether this recovery names a destination the current surface can open.
 *
 * `source_owner_handoff` is guidance because the viewer is not the person who
 * can act. `choose_another_resource` navigates back to the existing
 * resource catalog; it does not create another selection owner.
 */
export function recoveryDestinationIsNavigable(destination: TeamCredentialRecoveryDestination): boolean {
    return destination !== 'source_owner_handoff';
}

/**
 * The Home's typed refusal, in the words of the recovery it actually implies.
 *
 * Every arm names a different next action, which is the whole point: a single
 * "that did not go through" would leave a person who hit an uncovered cost
 * limit, a stale revision and a departed Group member with the same non-answer.
 * Codes this domain does not own fall back to the shared Team vocabulary.
 */
export function credentialFailureMessage(failure: HomeDomainFailure<string>): string {
    switch (failure.code) {
        case 'resource_changed':
            return t('teams.credentials.edit.conflict');
        case 'broker_unavailable':
            return t('teams.credentials.errors.brokerUnavailable');
        case 'source_owner_required':
            return t('teams.credentials.errors.sourceOwnerRequired');
        case 'source_replaced_or_missing':
        case 'resource_corrupt':
            return t('teams.credentials.errors.sourceMissing');
        case 'disclosure_not_allowed':
            return t('teams.credentials.audience.ceilingBlocked');
        case 'invalid_audience':
            return t('teams.credentials.errors.invalidAudience');
        case 'subject_not_in_team':
            return t('teams.credentials.errors.subjectNotInTeam');
        case 'cost_limit_unavailable':
            return t('teams.credentials.errors.costUnavailable');
        case 'token_limit_unavailable':
            return t('teams.credentials.errors.invalidLimit');
        case 'invalid_limit':
            return t('teams.credentials.errors.invalidLimit');
        // An exhausted allowance is a state of the credential, not a malformed
        // rule: telling the person to check the measure and the period would
        // send them to edit something that is already correct.
        case 'team_credential_usage_limit':
            return t('teams.credentials.limits.reached');
        case 'feature_disabled':
            return t('teams.credentials.errors.featureDisabled');
        case 'team_authentication_required':
            return t('teams.credentials.errors.teamAuthenticationRequired');
        case 'team_authentication_policy_unavailable':
            return t('teams.credentials.errors.teamAuthenticationPolicyUnavailable');
        case 'member_not_eligible':
            return t('teams.credentials.errors.memberNotEligible');
        case 'session_policy_incompatible':
            return t('teams.credentials.errors.sessionPolicyIncompatible');
        case 'limit_identity_immutable':
            return t('teams.credentials.errors.limitIdentityImmutable');
        case 'update_required':
            return t('teams.unavailable.updateRequired');
        case 'resource_not_found':
        case 'not_found_or_not_visible':
            return t('teams.credentials.detail.notFound');
        case 'forbidden':
        case 'resource_forbidden':
            return t('teams.credentials.forbidden');
        default:
            break;
    }
    return teamMutationFailureLabel(failure);
}

/**
 * Why a deferred mutation never produced its result.
 *
 * A rejected or cancelled approval is a decision, not a defect: nothing was
 * written, and saying "that did not go through" would invite the person to
 * retry something they just declined. Anything else is the Home's own refusal
 * code arriving late, so it reads in exactly the same words it would have had
 * the approval not been required.
 */
export function credentialApprovalFailureMessage(code: string): string {
    if (isActionApprovalDeclinedErrorCode(code)) {
        return t('teams.credentials.approvalDeclined');
    }
    return credentialFailureMessage({ kind: 'unknown', retryable: false, code });
}

/**
 * The wire format a Provider request takes. These are product identifiers rather
 * than prose, so they read the same in every language.
 */
export function requestProtocolKindLabel(kind: TeamCredentialRequestProtocolKindV1): string {
    switch (kind) {
        case 'openai_responses':
            return t('teams.credentials.requestPolicy.protocol.openaiResponses');
        case 'openai_chat_completions':
            return t('teams.credentials.requestPolicy.protocol.openaiChatCompletions');
        case 'anthropic_messages':
            return t('teams.credentials.requestPolicy.protocol.anthropicMessages');
    }
}

/**
 * How many constraints a request policy actually imposes.
 *
 * Counted rather than named because the detail row has one line and the fields
 * are heterogeneous: "3 restrictions" is honest at a glance, while naming one of
 * them would imply the others are absent. A policy row whose every field is open
 * is the same fact as no policy at all, so both read as "No restrictions".
 */
export function requestPolicySummary(resource: TeamCredentialResourceSummaryV1): string {
    const policy = resource.requestPolicy;
    if (policy === null) return t('teams.credentials.requestPolicy.summaryNone');
    const count = [
        policy.allowedProtocolKinds,
        policy.allowedModelIds,
        policy.reasoningEffort,
    ].filter((field) => field !== null).length;
    return count === 0
        ? t('teams.credentials.requestPolicy.summaryNone')
        : t('teams.credentials.requestPolicy.summaryActive', { count });
}

/** How the source-owner census reports one recipient's prepared material. */
export function directReadinessLabel(
    readiness: 'ready' | 'preparing' | 'recipient_binding_changed' | 'source_changed',
): string {
    switch (readiness) {
        case 'ready':
            return t('teams.credentials.directReadiness.state.ready');
        case 'preparing':
            return t('teams.credentials.directReadiness.state.preparing');
        case 'recipient_binding_changed':
            return t('teams.credentials.directReadiness.state.recipientBindingChanged');
        case 'source_changed':
            return t('teams.credentials.directReadiness.state.sourceChanged');
    }
}

export function limitSubjectKindLabel(kind: TeamCredentialUsageLimitSubjectKindV1): string {
    switch (kind) {
        case 'resource':
            return t('teams.credentials.limits.subject.resource');
        case 'each_member':
            return t('teams.credentials.limits.subject.eachMember');
        case 'team_group':
            return t('teams.credentials.limits.subject.group');
        case 'team_member':
            return t('teams.credentials.limits.subject.member');
    }
}

export function limitMetricLabel(metric: TeamCredentialUsageLimitMetricV1): string {
    switch (metric) {
        case 'inference_requests':
            return t('teams.credentials.limits.metric.requests');
        case 'total_tokens':
            return t('teams.credentials.limits.metric.tokens');
        case 'cost_usd':
            return t('teams.credentials.limits.metric.cost');
    }
}

export function limitPeriodLabel(period: TeamCredentialUsageLimitPeriodV1): string {
    switch (period) {
        case 'day':
            return t('teams.credentials.limits.period.day');
        case 'week':
            return t('teams.credentials.limits.period.week');
        case 'month':
            return t('teams.credentials.limits.period.month');
    }
}

export function usageBreakdownLabel(dimension: TeamCredentialUsageBreakdownDimensionV1): string {
    switch (dimension) {
        case 'member':
            return t('teams.credentials.usage.breakdown.member');
        case 'external_api_key':
            return t('teams.credentials.usage.breakdown.externalApiKey');
        case 'model':
            return t('teams.credentials.usage.breakdown.model');
        case 'session':
            return t('teams.credentials.usage.breakdown.session');
        case 'source_member':
            return t('teams.credentials.usage.breakdown.sourceMember');
        case 'worker_machine':
            return t('teams.credentials.usage.breakdown.workerMachine');
        case 'broker_machine':
            return t('teams.credentials.usage.breakdown.brokerMachine');
        case 'delivery_mode':
            return t('teams.credentials.usage.breakdown.deliveryMode');
    }
}

/**
 * Every usage dimension, and the two the usage owner answers only for an
 * administrator.
 *
 * The Home drops `source_member` and `broker_machine` for an ordinary recipient
 * rather than disclosing source identity or broker placement through analytics.
 * Offering those controls anyway would answer the question with an empty list,
 * which reads as "nothing was used" instead of "not shown to you", so this list
 * is the same decision the Home already makes.
 */
const TEAM_CREDENTIAL_USAGE_BREAKDOWNS: readonly TeamCredentialUsageBreakdownDimensionV1[] = Object.freeze([
    'member',
    'model',
    'session',
    'source_member',
    'worker_machine',
    'broker_machine',
    'delivery_mode',
    'external_api_key',
]);

const TEAM_CREDENTIAL_ADMINISTRATION_BREAKDOWNS: ReadonlySet<TeamCredentialUsageBreakdownDimensionV1> = new Set([
    'source_member',
    'broker_machine',
]);

export function offeredTeamCredentialUsageBreakdowns(
    administers: boolean,
): readonly TeamCredentialUsageBreakdownDimensionV1[] {
    return administers
        ? TEAM_CREDENTIAL_USAGE_BREAKDOWNS
        : TEAM_CREDENTIAL_USAGE_BREAKDOWNS.filter((dimension) => !TEAM_CREDENTIAL_ADMINISTRATION_BREAKDOWNS.has(dimension));
}

/**
 * How honestly a recorded request count can be named for this resource.
 *
 * Request counts come from broker admission, so they are complete only while
 * every grant is brokered. A resource that also discloses material has requests
 * Happier never saw, and one shared purely directly has no admission at all —
 * calling either total "requests" would present a partial or absent measurement
 * as the whole truth.
 */
export function usageRequestMetricLabel(coverage: 'complete' | 'brokered_only'): string {
    return coverage === 'complete'
        ? limitMetricLabel('inference_requests')
        : t('teams.credentials.usage.recordedRequests');
}

/**
 * When a limit's period restarts.
 *
 * The window is the Home's, so it is rendered in UTC rather than the reader's
 * zone: a person in Auckland and a person in Lisbon are governed by the same
 * instant, and showing each of them their own midnight would make one of them
 * wrong about when their allowance returns. The month and time are still
 * formatted in the reader's language.
 */
export function formatLimitResetUtc(resetsAtUtc: string): string | null {
    const at = Date.parse(resetsAtUtc);
    if (Number.isNaN(at)) return null;
    return t('teams.credentials.limits.resetsUtc', {
        when: new Intl.DateTimeFormat(undefined, {
            timeZone: 'UTC',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
        }).format(new Date(at)),
    });
}

/**
 * One limit's identity line: who it applies to, measured how, over what period.
 *
 * A Group or member limit names its subject through the roster the caller
 * already holds. An id the caller cannot resolve is reported as such instead of
 * being printed, because a raw membership id is not a person.
 */
export function limitSubjectLine(
    limit: TeamCredentialUsageLimitV1,
    resolveSubjectName: (limit: TeamCredentialUsageLimitV1) => string | null,
): string {
    if (limit.subjectKind === 'resource' || limit.subjectKind === 'each_member') {
        return limitSubjectKindLabel(limit.subjectKind);
    }
    const name = resolveSubjectName(limit);
    return name ?? t('teams.credentials.limits.unknownSubject');
}

/**
 * List order for limits, where limits are authored.
 *
 * Broadest scope first, then measure and period, so the rule that governs
 * everyone is read before the ones that narrow it. Order never depends on
 * recorded usage, which changes under the reader — an editor row must not move
 * while somebody is reaching for it.
 */
const SUBJECT_ORDER: readonly TeamCredentialUsageLimitSubjectKindV1[] = Object.freeze([
    'resource',
    'each_member',
    'team_group',
    'team_member',
]);

export function orderTeamCredentialLimits(
    limits: readonly TeamCredentialUsageLimitV1[],
): readonly TeamCredentialUsageLimitV1[] {
    return [...limits].sort((left, right) => {
        const bySubject = SUBJECT_ORDER.indexOf(left.subjectKind) - SUBJECT_ORDER.indexOf(right.subjectKind);
        if (bySubject !== 0) return bySubject;
        const bySubjectId = left.subjectId.localeCompare(right.subjectId);
        if (bySubjectId !== 0) return bySubjectId;
        const byMetric = left.metric.localeCompare(right.metric);
        if (byMetric !== 0) return byMetric;
        const byPeriod = left.period.localeCompare(right.period);
        return byPeriod !== 0 ? byPeriod : left.id.localeCompare(right.id);
    });
}

/**
 * List order for limits, where remaining allowance is being read.
 *
 * The rule that will stop the next request is the one that matters here, so the
 * tightest remaining amount is read first and ties fall back to the authoring
 * order. A reader asking "how much is left" is answered by the binding limit,
 * not by the broadest one.
 */
export function orderTeamCredentialLimitsByRemaining(
    limits: readonly TeamCredentialUsageLimitV1[],
): readonly TeamCredentialUsageLimitV1[] {
    const remaining = (limit: TeamCredentialUsageLimitV1): number => {
        const value = Number(limit.maximum) - Number(limit.currentWindow.recorded);
        return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
    };
    const authored = orderTeamCredentialLimits(limits);
    return [...authored].sort((left, right) => remaining(left) - remaining(right));
}

/**
 * Whether a limit has already stopped new requests.
 *
 * This is presentation only — the Home decides admission — so an unparseable
 * pair reports "not reached" rather than inventing a blocked state from a
 * contract this build and the Home disagree about. A disabled rule is never
 * reached because it governs nothing.
 */
export function limitReached(limit: TeamCredentialUsageLimitV1): boolean {
    const recorded = Number(limit.currentWindow.recorded);
    const maximum = Number(limit.maximum);
    if (!Number.isFinite(recorded) || !Number.isFinite(maximum)) return false;
    return limit.enabled && recorded >= maximum;
}
