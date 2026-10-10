import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { ResolvedRoleV1, RoleEngineV1 } from '@happier-dev/protocol';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';

/** All run intents consume the same role selection as review. The snapshot is
 * host admission output, never an authored RPC input. */
export function resolveExecutionRunRoleV1(input: Readonly<{
  roleId?: string;
  resolvedRole?: ResolvedRoleV1;
  accountRoleOverrides?: AccountRoleOverridesReadV1;
  sessionMetadata?: unknown;
  defaultEngine?: RoleEngineV1;
}>): ResolvedRoleV1 | undefined {
  if (!input.roleId) return undefined;
  if (input.resolvedRole && (input.resolvedRole.roleId !== input.roleId || !input.resolvedRole.enabled)) {
    throw Object.assign(new Error('role_target_unavailable'), { code: 'role_target_unavailable' });
  }
  const sessionRoles = readSessionRolesV1(input.sessionMetadata);
  // Accepted workflow/Run and inherited Session snapshots retain their authority.
  const frozen = input.resolvedRole ?? sessionRoles?.sessionRoles[input.roleId];
  if (!frozen && input.accountRoleOverrides?.status !== 'ready') {
    throw Object.assign(new Error('account_role_overrides_unavailable'), { code: 'account_role_overrides_unavailable' });
  }
  const resolved = resolveRoleSelectionV1({
    roleId: input.roleId, settingsOverrides: input.accountRoleOverrides?.status === 'ready' ? input.accountRoleOverrides.overrides : undefined,
    ...(sessionRoles ? { sessionRoles } : {}),
    ...(input.resolvedRole ? { workflowRoles: [input.resolvedRole] } : {}),
    ...(input.defaultEngine ? { defaultEngine: input.defaultEngine } : {}),
  });
  if (!resolved.ok) throw Object.assign(new Error(resolved.refusal.code), { code: resolved.refusal.code });
  return resolved.selection;
}

/** The role owner resolves text; review runtime only places its resolved prefix. */
export function resolveReviewRunReviewerInstructions(input: Readonly<{
  accountRoleOverrides?: AccountRoleOverridesReadV1;
  sessionMetadata?: unknown;
}>): string {
  return resolveExecutionRunRoleV1({ ...input, roleId: 'reviewer' })!.instructions;
}
