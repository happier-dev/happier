import { areConversationEndpointIdentitiesEqual, conversationThreadRouterAllowedPrincipalIdsV1, isChannelSessionSpawnRecipeAuthorableV1 } from '@happier-dev/channels-protocol/v1';
import type {
  ConversationBindingInputModeV1,
  ConversationBindingTargetV1,
  ConversationResolvedEndpointV1,
  ConversationSessionBindingTargetV1,
} from '@happier-dev/channels-protocol/v1';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';

/**
 * Canonical pure binding-policy transition used by eventual online Actions and
 * Account-local Collection CAS. Persistence, revision comparison, and present
 * user confirmation remain owned by their existing generic boundaries.
 */

export type ConversationBindingEndpointV1 = ConversationResolvedEndpointV1;

/** The private logical binding payload, after generic Collection validation. */
export type ConversationBindingStateV1 = Readonly<{
  connectionId: string;
  parentBindingId?: string;
  endpoint: ConversationBindingEndpointV1;
  target: ConversationBindingTargetV1;
  allowedPrincipalIds: readonly string[];
  allowBotSenders: boolean;
  inputMode: ConversationBindingInputModeV1;
  inboundDebounceMs: number;
  linkPreviewPolicy: 'suppress' | 'providerDefault';
  senderFeedback: 'off' | 'eligibleRefusals';
  authorityEpoch: number;
  enabled: boolean;
}>;

/** Caller input deliberately cannot choose the next authority epoch. */
export type ConversationBindingRequestedStateV1 = Omit<ConversationBindingStateV1, 'authorityEpoch'>;

export type ConversationBindingTransitionResultV1 =
  | Readonly<{
    kind: 'unchanged';
    binding: ConversationBindingStateV1;
  }>
  | Readonly<{
    kind: 'updated';
    binding: ConversationBindingStateV1;
  }>
  | Readonly<{
    kind: 'rejected';
    code:
      | 'connectionImmutable'
      | 'duplicateAllowedPrincipal'
      | 'policyPrincipalNotAllowed'
      | 'pullRequestCorrespondenceMismatch'
      | 'authorityEpochExhausted'
      | 'parentBindingImmutable'
      | 'routerGroupNotFound'
      | 'routerDuplicateId'
      | 'routerAudienceEmpty'
      | 'recipeAttestationForbidden';
  }>;

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

function sameEndpoint(
  left: ConversationBindingEndpointV1,
  right: ConversationBindingEndpointV1,
): boolean {
  return areConversationEndpointIdentitiesEqual(left, right)
    && left.label === right.label
    && left.parentLabel === right.parentLabel;
}

function sameOptionalStringMembership(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameStringMembership(left, right);
}

function sameSessionApprovals(
  left: Extract<ConversationSessionBindingTargetV1['policy']['approvals'], Readonly<{ kind: 'off' | 'enabled' }>>,
  right: Extract<ConversationSessionBindingTargetV1['policy']['approvals'], Readonly<{ kind: 'off' | 'enabled' }>>,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'off'
    || (right.kind === 'enabled'
      && left.maximumScope === right.maximumScope
      && sameOptionalStringMembership(left.principalIds, right.principalIds));
}

function sameSessionNewSession(
  left: ConversationSessionBindingTargetV1['policy']['newSession'],
  right: ConversationSessionBindingTargetV1['policy']['newSession'],
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'off'
    || (right.kind === 'enabled'
      && sameOptionalStringMembership(left.principalIds, right.principalIds)
      && pluginJsonValuesEqual(left.recipe, right.recipe));
}

function sameTargetAuthority(
  left: ConversationBindingTargetV1,
  right: ConversationBindingTargetV1,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'session' && right.kind === 'session') {
    return left.sessionId === right.sessionId
      && pluginJsonValuesEqual(left.pullRequestLink ?? null, right.pullRequestLink ?? null)
      && pluginJsonValuesEqual(left.pullRequestWatch?.policy ?? null, right.pullRequestWatch?.policy ?? null)
      && left.policy.deliveryMode === right.policy.deliveryMode
      && left.policy.permissionCeiling === right.policy.permissionCeiling
      && sameSessionApprovals(left.policy.approvals, right.policy.approvals)
      && sameSessionNewSession(left.policy.newSession, right.policy.newSession);
  }
  if (left.kind === 'automation' && right.kind === 'automation') {
    return left.automationId === right.automationId
      && pluginJsonValuesEqual(left.scopedTrigger ?? null, right.scopedTrigger ?? null)
      && left.policy.resultDelivery === right.policy.resultDelivery;
  }
  if (left.kind === 'threadRouter' && right.kind === 'threadRouter') return pluginJsonValuesEqual(left, right);
  if (left.kind === 'discussion' && right.kind === 'discussion') return left.discussionId === right.discussionId;
  return false;
}

function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringMembership(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightMembers = new Set(right);
  return left.every((value) => rightMembers.has(value));
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * The policy target schema intentionally has no binding allowlist context.
 * Enforce its cross-field subset invariant at this sole binding-policy owner
 * before a create or update can persist stale approval or /new principals.
 */
function hasPolicyPrincipalOutsideAllowlist(
  policy: ConversationSessionBindingTargetV1['policy'],
  allowedPrincipalIds: readonly string[],
): boolean {
  const allowed = new Set(allowedPrincipalIds);
  const approvals = policy.approvals.kind === 'enabled'
    ? policy.approvals.principalIds
    : undefined;
  const newSession = policy.newSession.kind === 'enabled'
    ? policy.newSession.principalIds
    : undefined;
  return (approvals?.some((principalId) => !allowed.has(principalId)) ?? false)
    || (newSession?.some((principalId) => !allowed.has(principalId)) ?? false);
}

/**
 * The outward permission-wait eligibility reader's predicate for "this
 * binding's owner enabled chat approval". The persisted
 * `target.policy.approvals` is the sole approval control and there is no
 * second enablement authority; the inbound admission owner reads that same
 * field directly (`ingressAdmissionDecision`) because it must also apply the
 * approver-principal subset, which this boolean deliberately does not carry.
 */
export function hasConversationApprovalPolicyEnabled(
  target: ConversationBindingTargetV1,
): boolean {
  return target.kind === 'session' && target.policy.approvals.kind === 'enabled';
}

function sameBinding(
  left: ConversationBindingStateV1,
  right: ConversationBindingStateV1,
): boolean {
  return left.connectionId === right.connectionId
    && left.parentBindingId === right.parentBindingId
    && sameEndpoint(left.endpoint, right.endpoint)
    && pluginJsonValuesEqual(left.target, right.target)
    && sameStringSequence(left.allowedPrincipalIds, right.allowedPrincipalIds)
    && left.allowBotSenders === right.allowBotSenders
    && left.inputMode === right.inputMode
    && left.inboundDebounceMs === right.inboundDebounceMs
    && left.linkPreviewPolicy === right.linkPreviewPolicy
    && left.senderFeedback === right.senderFeedback
    && left.authorityEpoch === right.authorityEpoch
    && left.enabled === right.enabled;
}

/** Retained routing relations, shared by reads and authoring admission. */
export function conversationThreadRouterPolicyError(input: Readonly<{
  target: Extract<ConversationBindingTargetV1, { kind: 'threadRouter' }>;
  allowedPrincipalIds: readonly string[];
}>): 'routerDuplicateId' | 'routerGroupNotFound' | 'routerAudienceEmpty' | 'policyPrincipalNotAllowed' | null {
  const { target, allowedPrincipalIds } = input;
  const groups = new Set(target.principalGroups.map((group) => group.id));
  const routes = new Set(target.routes.map((route) => route.id));
  if (groups.size !== target.principalGroups.length || routes.size !== target.routes.length) return 'routerDuplicateId';
  if (target.routes.some((route) => route.when.group !== 'any' && !groups.has(route.when.group))) return 'routerGroupNotFound';
  if (allowedPrincipalIds.length === 0) return 'routerAudienceEmpty';
  if (target.routes.some((route) => hasPolicyPrincipalOutsideAllowlist(route.policy, allowedPrincipalIds))) return 'policyPrincipalNotAllowed';
  return null;
}

/**
 * Applies the binding's field-sensitive policy rules without
 * owning a Collection revision/CAS or making any provider call.
 */
export function transitionConversationBinding(input: Readonly<{
  current: ConversationBindingStateV1;
  requested: ConversationBindingRequestedStateV1;
}>): ConversationBindingTransitionResultV1 {
  const { current } = input;
  const requested = input.requested.target.kind === 'threadRouter'
    ? { ...input.requested, allowedPrincipalIds: conversationThreadRouterAllowedPrincipalIdsV1(input.requested.target) }
    : input.requested;
  const authorableNewSession = (policy: ConversationSessionBindingTargetV1['policy']) =>
    policy.newSession.kind === 'off' || isChannelSessionSpawnRecipeAuthorableV1(policy.newSession.recipe);
  if ((requested.target.kind === 'session' && !authorableNewSession(requested.target.policy))
    || (requested.target.kind === 'threadRouter' && requested.target.routes.some(route =>
      !isChannelSessionSpawnRecipeAuthorableV1(route.recipe) || !authorableNewSession(route.policy)))) {
    return { kind: 'rejected', code: 'recipeAttestationForbidden' };
  }
  if (current.parentBindingId !== requested.parentBindingId) return { kind: 'rejected', code: 'parentBindingImmutable' };
  if (requested.target.kind === 'threadRouter') {
    const code = conversationThreadRouterPolicyError({ target: requested.target, allowedPrincipalIds: requested.allowedPrincipalIds });
    if (code !== null) return { kind: 'rejected', code };
  }
  const pullRequest = requested.target.kind === 'session' ? requested.target.pullRequestLink : requested.target.kind === 'automation' ? requested.target.scopedTrigger?.pullRequest : undefined;
  if (pullRequest !== undefined && (requested.endpoint.kind !== 'githubPullRequest'
    || !pluginJsonValuesEqual(requested.endpoint.pullRequest ?? null, pullRequest)
    || (requested.target.kind === 'automation' && requested.target.policy.resultDelivery !== 'none'))) {
    return { kind: 'rejected', code: 'pullRequestCorrespondenceMismatch' };
  }
  if (current.connectionId !== requested.connectionId) {
    return { kind: 'rejected', code: 'connectionImmutable' };
  }
  if (hasDuplicate(requested.allowedPrincipalIds)) {
    return { kind: 'rejected', code: 'duplicateAllowedPrincipal' };
  }
  if (requested.target.kind === 'session' && hasPolicyPrincipalOutsideAllowlist(requested.target.policy, requested.allowedPrincipalIds)) {
    return { kind: 'rejected', code: 'policyPrincipalNotAllowed' };
  }

  const endpointIdentityChanged = !areConversationEndpointIdentitiesEqual(current.endpoint, requested.endpoint);
  const target = requested.target;
  const authorityChanged = endpointIdentityChanged
    || !sameTargetAuthority(current.target, target)
    || !sameStringMembership(current.allowedPrincipalIds, requested.allowedPrincipalIds)
    || current.allowBotSenders !== requested.allowBotSenders
    || current.inputMode !== requested.inputMode
    || current.enabled !== requested.enabled;

  if (authorityChanged && current.authorityEpoch >= MAX_SAFE_INTEGER) {
    return { kind: 'rejected', code: 'authorityEpochExhausted' };
  }

  const next: ConversationBindingStateV1 = {
    connectionId: requested.connectionId,
    ...(current.parentBindingId === undefined ? {} : { parentBindingId: current.parentBindingId }),
    endpoint: requested.endpoint,
    target,
    allowedPrincipalIds: requested.allowedPrincipalIds,
    allowBotSenders: requested.allowBotSenders,
    inputMode: requested.inputMode,
    inboundDebounceMs: requested.inboundDebounceMs,
    linkPreviewPolicy: requested.linkPreviewPolicy,
    senderFeedback: requested.senderFeedback,
    authorityEpoch: authorityChanged ? current.authorityEpoch + 1 : current.authorityEpoch,
    enabled: requested.enabled,
  };
  if (sameBinding(current, next)) {
    return { kind: 'unchanged', binding: current };
  }
  return { kind: 'updated', binding: next };
}

export type ConversationBindingPrincipalRevocationV1 =
  | Readonly<{
    kind: 'revoked';
    allowedPrincipalIds: readonly string[];
    target: ConversationBindingTargetV1;
  }>
  | Readonly<{
    kind: 'rejected';
    code: 'principalNotAllowed' | 'audienceWouldBeEmpty';
  }>;

/**
 * Narrows a Session policy allow-list that named revoked senders.
 *
 * An enabled arm with no `principalIds` already means "every allowed sender",
 * so the audience subtraction alone narrows it. An arm that named senders is
 * turned off rather than left with an empty or omitted list: an empty list is
 * not a persistable allow-list, and omitting it would silently widen the
 * authority to everyone still allowed.
 */
function withoutRevokedPolicyPrincipals<TPolicy extends Readonly<{ kind: 'off' }> | Readonly<{ kind: 'enabled'; principalIds?: readonly string[] }>>(
  policy: TPolicy,
  revoked: ReadonlySet<string>,
): TPolicy | Readonly<{ kind: 'off' }> {
  if (policy.kind !== 'enabled' || policy.principalIds === undefined) return policy;
  const retained = policy.principalIds.filter((principalId) => !revoked.has(principalId));
  if (retained.length === policy.principalIds.length) return policy;
  if (retained.length === 0) return { kind: 'off' };
  return { ...policy, principalIds: retained };
}

/**
 * Projects the requested audience and target of a present-user revocation.
 *
 * Revocation is deliberately subtraction-only: it is decidable from the
 * retained binding alone, which is what lets a cold-offline Account run it,
 * whereas admitting a sender requires the provider resolver to prove they
 * exist on the endpoint. It lives with the allow-list invariant it upholds so
 * a caller cannot revoke an audience member while leaving the Session policy
 * that named them — the state {@link transitionConversationBinding} refuses.
 */
export function revokeConversationBindingPrincipals(input: Readonly<{
  allowedPrincipalIds: readonly string[];
  target: ConversationBindingTargetV1;
  revokedPrincipalIds: readonly string[];
}>): ConversationBindingPrincipalRevocationV1 {
  const allowed = new Set(input.allowedPrincipalIds);
  if (input.revokedPrincipalIds.some((principalId) => !allowed.has(principalId))) {
    return { kind: 'rejected', code: 'principalNotAllowed' };
  }
  const revoked = new Set(input.revokedPrincipalIds);
  const allowedPrincipalIds = input.allowedPrincipalIds.filter(
    (principalId) => !revoked.has(principalId),
  );
  if (allowedPrincipalIds.length === 0) {
    return { kind: 'rejected', code: 'audienceWouldBeEmpty' };
  }
  if (input.target.kind === 'threadRouter') {
    return { kind: 'revoked', allowedPrincipalIds, target: {
      ...input.target,
      principalGroups: input.target.principalGroups.map((group) => ({ ...group, principalIds: group.principalIds.filter((id) => !revoked.has(id)) })),
      routes: input.target.routes.map((route) => ({ ...route, policy: {
        ...route.policy,
        approvals: withoutRevokedPolicyPrincipals(route.policy.approvals, revoked),
        newSession: withoutRevokedPolicyPrincipals(route.policy.newSession, revoked),
      } })),
    } };
  }
  if (input.target.kind !== 'session') {
    return { kind: 'revoked', allowedPrincipalIds, target: input.target };
  }
  return {
    kind: 'revoked',
    allowedPrincipalIds,
    target: {
      ...input.target,
      policy: {
        ...input.target.policy,
        approvals: withoutRevokedPolicyPrincipals(input.target.policy.approvals, revoked),
        newSession: withoutRevokedPolicyPrincipals(input.target.policy.newSession, revoked),
      },
    },
  };
}
