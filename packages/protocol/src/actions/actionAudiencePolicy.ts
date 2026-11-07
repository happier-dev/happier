import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1, setActionApprovalOverride,
  normalizeActionSettingsActionId, isActionSettingsOptInPlacement, readScopedActionApprovalPreference,
  setScopedActionApprovalPreference, removeScopedActionApprovalPreference, actionPolicyAudienceContextV1, type ActionPolicyAudienceV1, type ActionApprovalScopeV1,
  type ActionsSettingsV1, type ActionSettingsActionId, type ActionSettingsOverride, type ActionSurfaceKey } from './actionSettings.js';
import type { ActionUiPlacement } from './actionUiPlacements.js';
import type { ActionAudiencePolicyMode, ActionAudiencePolicyResult, ActionPolicySetInput, ActionPolicySetResult } from './actionPolicyActionFamily.js';

/** One audience preference; global enablement and every neighbouring preference remain intact. */
export function setActionAudiencePolicy(settings: ActionsSettingsV1, actionId: string,
  audience: ActionPolicyAudienceV1, mode: ActionAudiencePolicyMode): ActionsSettingsV1 {
  const admittedId = normalizeActionSettingsActionId(actionId);
  if (!admittedId || admittedId !== actionId) throw new Error('invalid_action_id');
  if (audience === 'foreign_session_html') {
    const policies = { ...settings.callerSurfacePolicies?.foreign_session_html };
    if (mode === 'default') delete policies[actionId];
    else policies[actionId] = mode;
    return { ...settings, callerSurfacePolicies: { ...settings.callerSurfacePolicies, foreign_session_html: policies } };
  }
  const selected = setActionAudienceEnabled(settings, admittedId, audience, mode !== 'off');
  return setActionAudienceApproval(selected, admittedId, audience, mode);
}

function setActionAudienceApproval(settings: ActionsSettingsV1, admittedId: ActionSettingsActionId,
  audience: ActionSurfaceKey, mode: ActionAudiencePolicyMode): ActionsSettingsV1 {
  return setActionApprovalOverride({ settings, actionId: admittedId, surface: audience,
    approvalRequired: mode === 'allowed' ? false : mode === 'ask_first' ? true : null });
}

function setActionPlacementEnabled(settings: ActionsSettingsV1, actionId: ActionSettingsActionId,
  placement: ActionUiPlacement, enabled: boolean): ActionsSettingsV1 {
  const normalized = normalizeActionsSettingsV1(settings);
  const prior = normalized.actions[actionId];
  const row: ActionSettingsOverride = prior ?? { enabledPlacements: [], disabledPlacements: [], disabledSurfaces: [],
    approvalRequiredSurfaces: [], toolExposureModes: {} };
  const unique = (values: readonly ActionUiPlacement[]) => [...new Set(values)].sort();
  const next = isActionSettingsOptInPlacement(placement) ? {
    ...row,
    disabledPlacements: row.disabledPlacements.filter(value => value !== placement),
    enabledPlacements: enabled ? unique([...row.enabledPlacements, placement])
      : row.enabledPlacements.filter(value => value !== placement),
  } : { ...row, disabledPlacements: enabled ? row.disabledPlacements.filter(value => value !== placement)
    : unique([...row.disabledPlacements, placement]) };
  return { ...normalized, actions: { ...normalized.actions, [actionId]: next } };
}

/** One admitted semantic policy edit, rebased by the Account CAS owner. */
export function applyActionPolicyMutation(settings: ActionsSettingsV1, input: ActionPolicySetInput): Readonly<{
  settings: ActionsSettingsV1;
  result: ActionPolicySetResult;
}> {
  if ('profileChange' in input) {
    const normalized = normalizeActionsSettingsV1(settings);
    const change = input.profileChange;
    const id = change.kind === 'upsert' ? change.profile.id : change.id;
    const remaining = normalized.approvalProfiles?.filter(profile => profile.id !== id) ?? [];
    return { settings: { ...normalized, approvalProfiles: change.kind === 'upsert'
      ? [...remaining, change.profile] : remaining }, result: input };
  }
  if (!('change' in input)) {
    const scope = 'scope' in input ? input.scope : undefined;
    const next = scope ? setScopedActionApprovalPreference({ settings, actionId: input.actionId, scope,
      surface: actionPolicyAudienceContextV1(input.audience).surface, mode: input.mode === 'ask_first' ? 'required'
        : input.mode === 'allowed' ? 'waived' : 'inherit' })
      : setActionAudiencePolicy(settings, input.actionId, input.audience, input.mode);
    return { settings: next, result: readActionAudiencePolicy(next, input.actionId, input.audience, scope) };
  }
  if (input.change.kind === 'scoped_approval_remove') return {
    settings: removeScopedActionApprovalPreference(settings, input.actionId, input.change.scope), result: input,
  };
  const actionId = normalizeActionSettingsActionId(input.actionId);
  if (!actionId || actionId !== input.actionId) throw new Error('invalid_action_id');
  const normalized = normalizeActionsSettingsV1(settings);
  const prior = normalized.actions[actionId];
  const row: ActionSettingsOverride = prior ?? { enabledPlacements: [], disabledPlacements: [], disabledSurfaces: [],
    approvalRequiredSurfaces: [], toolExposureModes: {} };
  const changed = (next: typeof row): ActionsSettingsV1 => ({ ...normalized, actions: { ...normalized.actions, [actionId]: next } });
  const change = input.change;
  switch (change.kind) {
    case 'enabled': {
      const next = { ...row };
      if (change.enabled) delete next.enabled;
      else next.enabled = false;
      return { settings: changed(next), result: input };
    }
    case 'audience_enabled':
      return { settings: setActionAudienceEnabled(normalized, actionId, change.audience, change.enabled), result: input };
    case 'placement':
      return { settings: setActionPlacementEnabled(normalized, actionId, change.placement, change.enabled), result: input };
    case 'placement_policy': {
      const selected = setActionPlacementEnabled(normalized, actionId, change.placement, change.mode !== 'off');
      return { settings: setActionAudienceApproval(selected, actionId, 'ui', change.mode), result: input };
    }
    case 'tool_exposure': {
      const host = ActionIdSchema.safeParse(actionId);
      if (!host.success) return { settings: normalized, result: input };
      const spec = getActionSpec(host.data);
      if (!spec.bindings?.mcpToolName || spec.surfaces[change.surface] !== true) return { settings: normalized, result: input };
      const toolExposureModes = { ...row.toolExposureModes };
      if (change.mode === 'default') delete toolExposureModes[change.surface];
      else toolExposureModes[change.surface] = change.mode;
      return { settings: changed({ ...row, toolExposureModes }), result: input };
    }
    case 'plugin_host_capture': {
      const remaining = normalized.pluginHostCaptureApprovalWaived?.filter(id => id !== change.pluginId) ?? [];
      return { settings: { ...normalized, pluginHostCaptureApprovalWaived: change.approvalRequired
        ? remaining : [...remaining, change.pluginId] }, result: input };
    }
  }
}

/** The Settings switch and the policy Action share the same audience enablement writer. */
export function setActionAudienceEnabled(settings: ActionsSettingsV1, actionId: ActionSettingsActionId,
  audience: ActionPolicyAudienceV1, enabled: boolean): ActionsSettingsV1 {
  if (audience === 'foreign_session_html') return setActionAudiencePolicy(settings, actionId, audience, enabled ? 'allowed' : 'off');
  const normalized = normalizeActionsSettingsV1(settings);
  const prior = normalized.actions[actionId];
  const disabledSurfaces = prior?.disabledSurfaces.filter(surface => surface !== audience) ?? [];
  if (!enabled) disabledSurfaces.push(audience);
  if (!prior && enabled) return normalized;
  return { ...normalized, actions: { ...normalized.actions,
    [actionId]: { ...prior, enabledPlacements: prior?.enabledPlacements ?? [], disabledPlacements: prior?.disabledPlacements ?? [],
      approvalRequiredSurfaces: prior?.approvalRequiredSurfaces ?? [], toolExposureModes: prior?.toolExposureModes ?? {}, disabledSurfaces },
  } };
}

export function readActionAudiencePolicy(settings: ActionsSettingsV1, actionId: string, audience: ActionPolicyAudienceV1,
  scope?: ActionApprovalScopeV1): ActionAudiencePolicyResult {
  const admittedId = normalizeActionSettingsActionId(actionId);
  if (!admittedId || admittedId !== actionId) throw new Error('invalid_action_id');
  const normalized = normalizeActionsSettingsV1(settings);
  const row = normalized.actions[actionId];
  if (audience === 'foreign_session_html') {
    if (scope) throw new Error('invalid_policy_scope');
    return { actionId, audience, mode: normalized.callerSurfacePolicies?.foreign_session_html?.[actionId] ?? 'default',
      actionEnabled: row?.enabled !== false,
      enabled: isActionEnabledByActionsSettings(admittedId, normalized, actionPolicyAudienceContextV1(audience)) };
  }
  const scoped = scope ? readScopedActionApprovalPreference(normalized, actionId, scope) : undefined;
  const mode: ActionAudiencePolicyMode = scope
    ? scoped?.approvalRequiredSurfaces.includes(audience) ? 'ask_first'
      : scoped?.approvalWaivedSurfaces.includes(audience) ? 'allowed' : 'default'
    : row?.disabledSurfaces.includes(audience) ? 'off'
    : row?.approvalRequiredSurfaces.includes(audience) ? 'ask_first'
    : normalized.approvalWaivedSurfaces?.[actionId]?.includes(audience) ? 'allowed' : 'default';
  return { actionId, audience, ...(scope ? { scope } : {}), mode, actionEnabled: row?.enabled !== false,
    enabled: isActionEnabledByActionsSettings(admittedId, normalized, { surface: audience }) };
}
