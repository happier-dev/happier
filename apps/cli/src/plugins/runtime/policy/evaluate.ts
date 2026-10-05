import {
  evaluatePluginActionPolicy,
  type PluginActionPolicyDecision,
  type PluginActionPolicyInput,
} from '@happier-dev/protocol/plugins/actions/policy';
import type {
  PluginActionConfirmationV2,
  PluginActionDangerLevelV2,
  PluginActionPresentUserAuthorizationFacts,
} from '@happier-dev/protocol';
import { pluginActionRequiresPresentUserIntent } from '@happier-dev/protocol';
import {
  evaluatePluginPolicyExpressionV2,
  type PluginAvailabilityDescriptorV2,
} from '@happier-dev/protocol/plugins/contributions/public-types';

export type TargetActionPolicyOutcome = PluginActionPolicyDecision['outcome'];

export type ContributionAvailabilityOutcome = 'visible' | 'hidden' | 'disabled' | 'unavailable';
export type ContributionAvailabilityDecision = Readonly<{
  outcome: ContributionAvailabilityOutcome;
  code: string;
}>;
export type ContributionPolicyFacts = Readonly<Record<string, boolean | string | readonly string[] | undefined>>;

export function resolveInvocationContributionPolicyFacts(params: Readonly<{
  sessionId?: string;
  projectId?: string;
  browserOrigin?: string;
  featureIds?: readonly string[];
  facts?: ContributionPolicyFacts;
}> = {}): ContributionPolicyFacts {
  return Object.freeze({
    'plugin.enabled': true,
    'session.exists': Boolean(params.sessionId),
    'project.exists': Boolean(params.projectId),
    'browser.exists': Boolean(params.browserOrigin),
    'host.platform': 'desktop',
    ...(params.featureIds ? { 'host.feature': Object.freeze([...params.featureIds]) } : {}),
    ...(params.projectId ? { 'project.id': params.projectId } : {}),
    ...(params.browserOrigin ? { 'browser.origin': params.browserOrigin } : {}),
    ...(params.facts ?? {}),
  });
}

export function evaluateContributionAvailability(params: Readonly<{
  availability: PluginAvailabilityDescriptorV2 | undefined;
  facts: ContributionPolicyFacts;
}>): ContributionAvailabilityDecision {
  const when = params.availability?.when;
  if (when) {
    const result = evaluatePluginPolicyExpressionV2(when, params.facts);
    if (result === null) return Object.freeze({ outcome: 'unavailable', code: 'plugin_contribution_policy_fact_unavailable' });
    if (!result) return Object.freeze({ outcome: 'hidden', code: 'plugin_contribution_not_applicable' });
  }
  const disabledWhen = params.availability?.disabledWhen;
  if (disabledWhen) {
    const result = evaluatePluginPolicyExpressionV2(disabledWhen, params.facts);
    if (result === null) return Object.freeze({ outcome: 'unavailable', code: 'plugin_contribution_policy_fact_unavailable' });
    if (result) return Object.freeze({ outcome: 'disabled', code: 'plugin_contribution_disabled' });
  }
  return Object.freeze({ outcome: 'visible', code: 'plugin_contribution_available' });
}

export function resolveTargetActionAvailability(params: Readonly<{
  availability: PluginAvailabilityDescriptorV2 | undefined;
  facts: ContributionPolicyFacts;
}>): NormalizedTargetActionPolicy['availability'] | undefined {
  if (!params.availability) return undefined;
  const availability = evaluateContributionAvailability(params);
  return Object.freeze({
    status: availability.outcome === 'hidden' ? 'unavailable' : availability.outcome,
    code: availability.code,
  });
}

export type TargetActionHostAccessDecision = Readonly<{
  id: string;
  required: boolean;
  status: 'available' | 'denied' | 'unavailable' | 'notApplicable';
  code?: string;
  requestFingerprint: string;
  resourceSelection?: Readonly<{
    requestedResourceId: string;
    selectedResourceId?: string;
  }>;
}>;

export type NormalizedTargetActionPolicy = Readonly<{
  qualifiedId: string;
  occurrenceId: string;
  dangerLevel: PluginActionDangerLevelV2;
  scopes: readonly string[];
  surfaces: readonly string[];
  hostAccess: readonly TargetActionHostAccessDecision[];
  availability?: Readonly<{ status: 'visible' | 'disabled' | 'denied' | 'unavailable'; code: string }>;
  confirmation?: PluginActionConfirmationV2;
  /** Host-resolved effective decision; absent means the manifest default. */
  approvalRequiredByActionSettings?: boolean;
}>;

export type TargetActionPolicyDecision = PluginActionPolicyDecision;

export type TargetActionAuthorizationFacts = Pick<
  PluginActionPolicyInput,
  | 'generation'
  | 'resourceSelections'
  | 'scopedGrants'
  | 'operatingSystemAuthorization'
>;

/** Projects daemon-owned readonly policy facts into the canonical Protocol wire DTO. */
export function projectTargetActionPresentUserAuthorizationFacts(
  authorization: TargetActionAuthorizationFacts,
  serviceAvailability: PluginActionPolicyInput['serviceAvailability'],
) {
  return {
    generation: { ...authorization.generation },
    resourceSelections: authorization.resourceSelections.map((selection) => ({ ...selection })),
    scopedGrants: authorization.scopedGrants.map((grant) => ({
      ...grant,
      requiredScope: { ...grant.requiredScope },
      ...(grant.grantedScope === undefined ? {} : { grantedScope: { ...grant.grantedScope } }),
    })),
    serviceAvailability: serviceAvailability.map((requirement) => ({ ...requirement })),
    operatingSystemAuthorization: authorization.operatingSystemAuthorization.map((requirement) => ({
      ...requirement,
    })),
  } satisfies PluginActionPresentUserAuthorizationFacts;
}

export function resolveTargetActionResourceSelectionFacts(
  action: Pick<NormalizedTargetActionPolicy, 'hostAccess'>,
): TargetActionAuthorizationFacts['resourceSelections'] {
  return Object.freeze(action.hostAccess.flatMap((access) => {
    if (access.resourceSelection) {
      return [Object.freeze({
        id: access.id,
        required: true,
        requestedResourceId: access.resourceSelection.requestedResourceId,
        ...(access.resourceSelection.selectedResourceId
          ? { selectedResourceId: access.resourceSelection.selectedResourceId }
          : {}),
      })];
    }
    // Optional host resources must carry their exact selection into the final
    // evaluator. Treat an omitted projection as unselected instead of trusting
    // the independently resolved service-availability status.
    return access.required
      ? []
      : [Object.freeze({
          id: access.id,
          required: true,
          requestedResourceId: access.requestFingerprint,
        })];
  }));
}

export function targetActionRequiresCurrentIntent(action: Pick<NormalizedTargetActionPolicy, 'dangerLevel' | 'confirmation' | 'approvalRequiredByActionSettings'>): boolean {
  return pluginActionRequiresPresentUserIntent(action, '');
}

export function evaluateTargetActionCatalogPolicy(params: Readonly<{
  action: NormalizedTargetActionPolicy;
  authorizationFacts: TargetActionAuthorizationFacts;
  /** Absent for catalog reads, which must never claim a trusted execution origin. */
  invocationSurface?: string;
}>): TargetActionPolicyDecision {
  const requiresIntent = pluginActionRequiresPresentUserIntent(
    params.action,
    params.invocationSurface ?? '',
  );
  return evaluatePluginActionPolicy({
    ...params.authorizationFacts,
    serviceAvailability: params.action.hostAccess.map((access) => ({
      id: access.id,
      // Every entry is referenced by this action, even when installing the package
      // did not require the optional resource selection.
      required: true,
      status: access.status,
      ...(access.code ? { code: access.code } : {}),
    })),
    ...(params.action.availability ? { availability: params.action.availability } : {}),
    confirmation: requiresIntent ? 'currentIntentRequired' : 'notRequired',
  });
}

export function evaluateTargetActionPolicy(params: Readonly<{
  action: NormalizedTargetActionPolicy;
  authorizationFacts: TargetActionAuthorizationFacts;
  /** Declared target capability surface. */
  surface: string;
  /** Actual host-owned invocation origin, distinct from target capability. */
  invocationSurface?: string;
  sessionId?: string;
}>): TargetActionPolicyDecision {
  const invocationSurface = params.invocationSurface ?? params.surface;
  const requiresIntent = pluginActionRequiresPresentUserIntent(
    params.action,
    invocationSurface,
  );
  if (!params.action.surfaces.includes(params.surface)) {
    return Object.freeze({ outcome: 'unavailable', code: 'plugin_action_surface_unavailable', requiresCurrentIntent: requiresIntent });
  }
  if (params.action.scopes.includes('session') && !params.sessionId) {
    return Object.freeze({ outcome: 'unavailable', code: 'plugin_action_session_required', requiresCurrentIntent: requiresIntent });
  }
  return evaluateTargetActionCatalogPolicy({
    action: params.action,
    authorizationFacts: params.authorizationFacts,
    invocationSurface,
  });
}
