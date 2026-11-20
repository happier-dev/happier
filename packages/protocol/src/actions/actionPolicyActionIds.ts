export const ACTION_POLICY_ACTION_IDS = ['actions.policy.get', 'actions.policy.set', 'actions.policy.reset'] as const;
export type ActionPolicyActionId = typeof ACTION_POLICY_ACTION_IDS[number];
export function isActionPolicyActionId(value: string): value is ActionPolicyActionId {
  return (ACTION_POLICY_ACTION_IDS as readonly string[]).includes(value);
}

/**
 * Changes to approval rules. Their Ask is decided on the person's own Account settings only,
 * so no profile or Session "Always" can waive it (owner 2026-11-20, Q6).
 */
export const APPROVAL_RULE_CHANGE_ACTION_IDS = ['actions.policy.set', 'actions.policy.reset', 'session.approval_profile.set'] as const;
export function isApprovalRuleChangeActionId(value: string): boolean {
  return (APPROVAL_RULE_CHANGE_ACTION_IDS as readonly string[]).includes(value);
}
