import { resolveApprovalSurface } from './actionApprovalSurface.js';
import { readScopedActionApprovalPreference, type ActionSettingsActionId, type ActionsSettingsV1 } from './actionSettings.js';
import type { ActionApprovalPolicyScopeV1 } from './actionApprovalPolicy.js';
import type { ActionExecutorContext } from './executor/types.js';

/** The explicit preference in the supplied policy view, using the admitted scope. */
export function readExplicitActionApprovalPreferenceFromSettingsV1(
  actionId: ActionSettingsActionId,
  settings: ActionsSettingsV1,
  ctx?: Pick<ActionExecutorContext, 'surface' | 'callerSurface'> | null,
  approvalScope?: ActionApprovalPolicyScopeV1,
  ignoreGlobalWaiver = false,
): boolean | undefined {
  if (ctx?.callerSurface === 'foreign_session_html') {
    const choice = settings.callerSurfacePolicies?.foreign_session_html?.[actionId];
    return choice === undefined ? undefined : choice === 'ask_first';
  }
  const surface = resolveApprovalSurface(ctx);
  const rawSurface = ctx?.surface;
  const scoped = approvalScope ? readScopedActionApprovalPreference(settings, actionId, approvalScope) : undefined;
  if (surface.kind !== 'ambiguous') {
    if (scoped?.approvalRequiredSurfaces.includes(surface.surface)) return true;
    // A child's explicit Ask can tighten the inherited template's choice.
    const inheritedEnvironmentId = approvalScope?.kind === 'environment' ? approvalScope.inheritedEnvironmentId : undefined;
    const effective = inheritedEnvironmentId ? readScopedActionApprovalPreference(settings, actionId,
      { kind: 'environment', environmentId: inheritedEnvironmentId }) : scoped;
    if (effective?.approvalRequiredSurfaces.includes(surface.surface)) return true;
    if (effective?.approvalWaivedSurfaces.includes(surface.surface)) return false;
  }
  const required = settings.actions?.[actionId]?.approvalRequiredSurfaces ?? [];
  if (typeof rawSurface === 'string' && required.some(requiredSurface => requiredSurface === rawSurface)) return true;
  if (ignoreGlobalWaiver) return undefined;
  const waived = settings.approvalWaivedSurfaces?.[actionId] ?? [];
  if (surface.kind !== 'ambiguous' && waived.includes(surface.surface)) return false;
  return undefined;
}
