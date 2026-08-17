import { areConversationEndpointIdentitiesEqual } from '@happier-dev/channels-protocol/v1';
import type {
  ConversationBindingInputModeV1,
  ConversationBindingTargetMutationV1,
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
    authorityChanged: boolean;
    /** The caller must disclose/reconfirm a future broader Session policy. */
    policyClamped: boolean;
  }>
  | Readonly<{
    kind: 'rejected';
    code:
      | 'connectionImmutable'
      | 'duplicateAllowedPrincipal'
      | 'policyPrincipalNotAllowed'
      | 'authorityEpochExhausted';
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

function sameTargetIdentity(
  left: ConversationBindingTargetV1,
  right: ConversationBindingTargetV1,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'session' && right.kind === 'session') {
    return left.sessionId === right.sessionId;
  }
  if (left.kind === 'automation' && right.kind === 'automation') {
    return left.automationId === right.automationId
      && left.templateVersion === right.templateVersion;
  }
  return false;
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
      && left.policy.deliveryMode === right.policy.deliveryMode
      && left.policy.permissionCeiling === right.policy.permissionCeiling
      && sameSessionApprovals(left.policy.approvals, right.policy.approvals)
      && sameSessionNewSession(left.policy.newSession, right.policy.newSession);
  }
  if (left.kind === 'automation' && right.kind === 'automation') {
    return left.automationId === right.automationId
      && left.templateVersion === right.templateVersion
      && left.policy.resultDelivery === right.policy.resultDelivery;
  }
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
  target: ConversationBindingTargetV1,
  allowedPrincipalIds: readonly string[],
): boolean {
  if (target.kind !== 'session') return false;
  const allowed = new Set(allowedPrincipalIds);
  const approvals = target.policy.approvals.kind === 'enabled'
    ? target.policy.approvals.principalIds
    : undefined;
  const newSession = target.policy.newSession.kind === 'enabled'
    ? target.policy.newSession.principalIds
    : undefined;
  return (approvals?.some((principalId) => !allowed.has(principalId)) ?? false)
    || (newSession?.some((principalId) => !allowed.has(principalId)) ?? false);
}

/** Shared persisted/mutation-policy predicate for the feature-local C5 persistence gate. */
export function hasConversationApprovalPolicyEnabled(
  target: ConversationBindingTargetV1 | ConversationBindingTargetMutationV1,
): boolean {
  return target.kind === 'session' && target.policy.approvals.kind === 'enabled';
}

function hasAddedPrincipal(current: readonly string[], requested: readonly string[]): boolean {
  const currentMembers = new Set(current);
  return requested.some((principalId) => !currentMembers.has(principalId));
}

function clampSessionPolicy(target: ConversationSessionBindingTargetV1): ConversationSessionBindingTargetV1 {
  return {
    ...target,
    policy: {
      ...target.policy,
      permissionCeiling: 'read-only',
      approvals: { kind: 'off' },
    },
  };
}

function sameBinding(
  left: ConversationBindingStateV1,
  right: ConversationBindingStateV1,
): boolean {
  return left.connectionId === right.connectionId
    && sameEndpoint(left.endpoint, right.endpoint)
    && sameTargetAuthority(left.target, right.target)
    && sameStringSequence(left.allowedPrincipalIds, right.allowedPrincipalIds)
    && left.allowBotSenders === right.allowBotSenders
    && left.inputMode === right.inputMode
    && left.inboundDebounceMs === right.inboundDebounceMs
    && left.linkPreviewPolicy === right.linkPreviewPolicy
    && left.senderFeedback === right.senderFeedback
    && left.authorityEpoch === right.authorityEpoch
    && left.enabled === right.enabled;
}

/**
 * Applies the Packet 01 §4.1 field-sensitive authority and clamp rules without
 * owning a Collection revision/CAS or making any provider call.
 */
export function transitionConversationBinding(input: Readonly<{
  current: ConversationBindingStateV1;
  requested: ConversationBindingRequestedStateV1;
}>): ConversationBindingTransitionResultV1 {
  const { current, requested } = input;
  if (current.connectionId !== requested.connectionId) {
    return { kind: 'rejected', code: 'connectionImmutable' };
  }
  if (hasDuplicate(requested.allowedPrincipalIds)) {
    return { kind: 'rejected', code: 'duplicateAllowedPrincipal' };
  }
  if (hasPolicyPrincipalOutsideAllowlist(requested.target, requested.allowedPrincipalIds)) {
    return { kind: 'rejected', code: 'policyPrincipalNotAllowed' };
  }

  const endpointIdentityChanged = !areConversationEndpointIdentitiesEqual(current.endpoint, requested.endpoint);
  const targetChangedToSession = requested.target.kind === 'session'
    && !sameTargetIdentity(current.target, requested.target);
  const policyClamped = hasAddedPrincipal(current.allowedPrincipalIds, requested.allowedPrincipalIds)
    || endpointIdentityChanged
    || targetChangedToSession;
  const target = policyClamped && requested.target.kind === 'session'
    ? clampSessionPolicy(requested.target)
    : requested.target;
  const authorityChanged = endpointIdentityChanged
    || !sameTargetAuthority(current.target, target)
    || !sameStringMembership(current.allowedPrincipalIds, requested.allowedPrincipalIds)
    || current.allowBotSenders !== requested.allowBotSenders
    || current.inputMode !== requested.inputMode
    || current.inboundDebounceMs !== requested.inboundDebounceMs
    || current.linkPreviewPolicy !== requested.linkPreviewPolicy
    || current.enabled !== requested.enabled;

  if (authorityChanged && current.authorityEpoch >= MAX_SAFE_INTEGER) {
    return { kind: 'rejected', code: 'authorityEpochExhausted' };
  }

  const next: ConversationBindingStateV1 = {
    connectionId: requested.connectionId,
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
  return { kind: 'updated', binding: next, authorityChanged, policyClamped };
}
