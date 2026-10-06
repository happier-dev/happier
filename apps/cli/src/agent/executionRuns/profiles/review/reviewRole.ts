import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { ResolvedRoleV1, RoleEngineV1 } from '@happier-dev/protocol';

/** All run intents consume the same role selection as review. The snapshot is
 * host admission output, never an authored RPC input. */
export function resolveExecutionRunRoleV1(input: Readonly<{
  roleId?: string;
  resolvedRole?: ResolvedRoleV1;
  accountSettings?: unknown;
  sessionMetadata?: unknown;
  defaultEngine?: RoleEngineV1;
}>): ResolvedRoleV1 | undefined {
  if (!input.roleId) return undefined;
  if (input.resolvedRole && (input.resolvedRole.roleId !== input.roleId || !input.resolvedRole.enabled)) {
    throw Object.assign(new Error('role_target_unavailable'), { code: 'role_target_unavailable' });
  }
  const settings = accountSettingsParse(input.accountSettings ?? {});
  const sessionRoles = readSessionRolesV1(input.sessionMetadata);
  const resolved = resolveRoleSelectionV1({
    roleId: input.roleId, settingsOverrides: settings.rolesV1.overrides,
    ...(sessionRoles ? { sessionRoles } : {}),
    ...(input.resolvedRole ? { workflowRoles: [input.resolvedRole] } : {}),
    ...(input.defaultEngine ? { defaultEngine: input.defaultEngine } : {}),
  });
  if (!resolved.ok) throw Object.assign(new Error(resolved.refusal.code), { code: resolved.refusal.code });
  return resolved.selection;
}

/** The role owner resolves text; review runtime only places its resolved prefix. */
export function resolveReviewRunReviewerInstructions(input: Readonly<{
  accountSettings?: unknown;
  sessionMetadata?: unknown;
}>): string {
  return resolveExecutionRunRoleV1({ ...input, roleId: 'reviewer' })!.instructions;
}
