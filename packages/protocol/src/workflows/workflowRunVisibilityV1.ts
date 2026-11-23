import type { AutomationActionConsentTrigger } from '../automations/automationActionTriggerV1.js';

export type WorkflowRunConsentForV1 = Readonly<AutomationActionConsentTrigger['consentFor']>;

/** Actor-consented checks are private; ordinary shared Runs freeze one granted Team. */
export function resolveWorkflowRunVisibleTeamV1(
  grantedTeamIds: readonly string[],
  visibleTeamId?: string | null,
  consentFor?: WorkflowRunConsentForV1 | null,
): Readonly<{ ok: true; visibleTeamId: string | null }> | Readonly<{ ok: false; code: 'visible_team_not_granted' }> {
  if (consentFor) return { ok: true, visibleTeamId: null };
  if (visibleTeamId === undefined) {
    return grantedTeamIds.length > 1
      ? { ok: false, code: 'visible_team_not_granted' }
      : { ok: true, visibleTeamId: grantedTeamIds[0] ?? null };
  }
  if (visibleTeamId === null ? grantedTeamIds.length !== 0 : !grantedTeamIds.includes(visibleTeamId)) {
    return { ok: false, code: 'visible_team_not_granted' };
  }
  return { ok: true, visibleTeamId };
}
