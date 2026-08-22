export type PluginFinalPolicyOutcome = 'visible' | 'disabled' | 'denied' | 'unavailable';

export type PluginFinalPolicyScope = Readonly<{
  accountId?: string;
  projectId?: string;
  workspaceId?: string;
  machineId?: string;
  actorId?: string;
}>;

export type PluginFinalPolicyRequirementStatus = 'available' | 'denied' | 'unavailable' | 'notApplicable';
export type PluginFinalPolicyTargetGenerationMode = 'current' | 'retained';

export type PluginFinalPolicyInput = Readonly<{
  packageTrust: Readonly<{
    packageIdentity: string;
    reviewedPackageIdentity: string | null;
  }>;
  generation: Readonly<{
    targetGeneration: string;
    desiredGeneration: string | null;
    appliedGeneration: string | null;
    /** Retained operations keep their target declaration while current policy narrows it. */
    targetGenerationMode?: PluginFinalPolicyTargetGenerationMode;
  }>;
  resourceSelections: readonly Readonly<{
    id: string;
    required: boolean;
    requestedResourceId?: string;
    selectedResourceId?: string;
  }>[];
  scopedGrants: readonly Readonly<{
    id: string;
    required: boolean;
    status: 'active' | 'missing' | 'revoked';
    requiredScope: PluginFinalPolicyScope;
    grantedScope?: PluginFinalPolicyScope;
  }>[];
  serviceAvailability: readonly Readonly<{
    id: string;
    required: boolean;
    status: PluginFinalPolicyRequirementStatus;
    code?: string;
  }>[];
  operatingSystemAuthorization: readonly Readonly<{
    id: string;
    required: boolean;
    status: PluginFinalPolicyRequirementStatus;
    code?: string;
  }>[];
  availability?: Readonly<{
    status: PluginFinalPolicyOutcome;
    code: string;
  }>;
  currentIntent: 'notRequired' | 'currentIntentRequired';
}>;

export type PluginFinalPolicyDecision = Readonly<{
  outcome: PluginFinalPolicyOutcome;
  code: string;
  requiresCurrentIntent: boolean;
}>;

function decision(
  input: PluginFinalPolicyInput,
  outcome: PluginFinalPolicyOutcome,
  code: string,
): PluginFinalPolicyDecision {
  return Object.freeze({
    outcome,
    code,
    requiresCurrentIntent: input.currentIntent === 'currentIntentRequired',
  });
}

function scopesMatch(required: PluginFinalPolicyScope, granted: PluginFinalPolicyScope): boolean {
  return required.accountId === granted.accountId
    && required.projectId === granted.projectId
    && required.workspaceId === granted.workspaceId
    && required.machineId === granted.machineId
    && required.actorId === granted.actorId;
}

export function evaluatePluginFinalPolicy(input: PluginFinalPolicyInput): PluginFinalPolicyDecision {
  if (
    input.packageTrust.reviewedPackageIdentity === null
    || input.packageTrust.packageIdentity !== input.packageTrust.reviewedPackageIdentity
  ) {
    return decision(input, 'denied', 'plugin_final_package_untrusted');
  }
  if (
    input.generation.desiredGeneration === null
    || (
      input.generation.targetGenerationMode !== 'retained'
      && input.generation.targetGeneration !== input.generation.desiredGeneration
    )
  ) {
    return decision(input, 'unavailable', 'plugin_final_generation_retired');
  }
  if (
    input.generation.appliedGeneration === null
    || input.generation.targetGeneration !== input.generation.appliedGeneration
  ) {
    return decision(input, 'unavailable', 'plugin_final_generation_not_applied');
  }
  if (input.availability && input.availability.status !== 'visible') {
    return decision(input, input.availability.status, input.availability.code);
  }

  for (const selection of input.resourceSelections) {
    if (!selection.required) continue;
    if (!selection.selectedResourceId) {
      return decision(input, 'denied', 'plugin_final_resource_not_selected');
    }
    if (
      selection.requestedResourceId !== undefined
      && selection.requestedResourceId !== selection.selectedResourceId
    ) {
      return decision(input, 'denied', 'plugin_final_resource_selection_mismatch');
    }
  }

  for (const grant of input.scopedGrants) {
    if (!grant.required) continue;
    if (grant.status === 'revoked') {
      return decision(input, 'denied', 'plugin_final_grant_revoked');
    }
    if (grant.status === 'missing') {
      return decision(input, 'denied', 'plugin_final_grant_missing');
    }
    if (!grant.grantedScope || !scopesMatch(grant.requiredScope, grant.grantedScope)) {
      return decision(input, 'denied', 'plugin_final_grant_scope_mismatch');
    }
  }

  const blockedService = input.serviceAvailability.find((service) => (
    service.required && service.status !== 'available' && service.status !== 'notApplicable'
  ));
  if (blockedService) {
    return decision(
      input,
      blockedService.status === 'denied' ? 'denied' : 'unavailable',
      blockedService.code ?? `plugin_final_service_${blockedService.status}`,
    );
  }

  const blockedOsAuthorization = input.operatingSystemAuthorization.find((authorization) => (
    authorization.required
      && authorization.status !== 'available'
      && authorization.status !== 'notApplicable'
  ));
  if (blockedOsAuthorization) {
    return decision(
      input,
      blockedOsAuthorization.status === 'denied' ? 'denied' : 'unavailable',
      blockedOsAuthorization.code ?? `plugin_final_os_authorization_${blockedOsAuthorization.status}`,
    );
  }

  return decision(input, 'visible', 'plugin_final_available');
}

export type PluginActionPolicyOutcome = PluginFinalPolicyOutcome;
export type PluginActionPolicyScope = PluginFinalPolicyScope;
export type PluginActionPolicyRequirementStatus = PluginFinalPolicyRequirementStatus;
export type PluginActionPolicyInput = Readonly<
  Omit<PluginFinalPolicyInput, 'currentIntent'>
  & { confirmation: 'notRequired' | 'currentIntentRequired' }
>;
export type PluginActionPolicyDecision = PluginFinalPolicyDecision;

const ACTION_POLICY_CODES: Readonly<Record<string, string>> = Object.freeze({
  plugin_final_package_untrusted: 'plugin_action_package_untrusted',
  plugin_final_generation_retired: 'plugin_action_generation_retired',
  plugin_final_generation_not_applied: 'plugin_action_generation_not_applied',
  plugin_final_resource_not_selected: 'plugin_action_resource_not_selected',
  plugin_final_resource_selection_mismatch: 'plugin_action_resource_selection_mismatch',
  plugin_final_grant_revoked: 'plugin_action_grant_revoked',
  plugin_final_grant_missing: 'plugin_action_grant_missing',
  plugin_final_grant_scope_mismatch: 'plugin_action_grant_scope_mismatch',
  plugin_final_service_denied: 'plugin_action_service_denied',
  plugin_final_service_unavailable: 'plugin_action_service_unavailable',
  plugin_final_os_authorization_denied: 'plugin_action_os_authorization_denied',
  plugin_final_os_authorization_unavailable: 'plugin_action_os_authorization_unavailable',
  plugin_final_available: 'plugin_action_available',
});

/** Action surface/session/danger adaptation remains a thin consumer of the shared final evaluator. */
export function evaluatePluginActionPolicy(input: PluginActionPolicyInput): PluginActionPolicyDecision {
  const { confirmation, ...finalInput } = input;
  const result = evaluatePluginFinalPolicy({
    ...finalInput,
    currentIntent: confirmation,
  });
  return Object.freeze({
    ...result,
    code: ACTION_POLICY_CODES[result.code] ?? result.code,
  });
}
