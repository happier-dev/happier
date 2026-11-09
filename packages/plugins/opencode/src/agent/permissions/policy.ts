import {
  resolveAcpToolPermissionPolicy,
  type AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { listHappierToolAutoApprovedNameSpellingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { sanitizeOpenCodeMcpName } from '../runtime/server/mcpRegistration.js';

export type OpenCodePermissionValue =
  ReturnType<typeof resolveAcpToolPermissionPolicy>[string];

export function resolveOpenCodePermissionConfig(
  permissionMode: string | null | undefined,
  workspaceWrites?: NonNullable<AgentSessionOpenRequest['configuration']>['workspaceWrites'],
): Readonly<Record<string, OpenCodePermissionValue>> {
  const policy = resolveAcpToolPermissionPolicy(permissionMode);
  if (workspaceWrites !== 'deny') return policy;
  // Native `edit` covers file modifications. Deny shell and child Agents too:
  // neither may become a second path to workspace writes (as in Claude).
  return { ...policy, edit: 'deny', write: 'deny', patch: 'deny',
    apply_patch: 'deny', multiedit: 'deny', bash: 'deny', task: 'deny' };
}

export function buildOpenCodeSessionPermissionRuleset(
  permissionMode: string | null | undefined,
  workspaceWrites?: NonNullable<AgentSessionOpenRequest['configuration']>['workspaceWrites'],
): ReadonlyArray<Readonly<{ permission: string; pattern: string; action: OpenCodePermissionValue }>> {
  return Object.entries(resolveOpenCodePermissionConfig(permissionMode, workspaceWrites)).map(([permission, action]) => ({
    permission,
    pattern: '*',
    action,
  }));
}

export function buildOpenCodeSessionScopedPermissionRuleset(
  permissionMode: string | null | undefined,
  projection: Readonly<{
    registrations: readonly Readonly<{ projectedName: string; originalName?: string }>[];
    requiredHappierServerName: string | null;
  }>,
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'],
  workspaceWrites?: NonNullable<AgentSessionOpenRequest['configuration']>['workspaceWrites'],
): ReadonlyArray<Readonly<{ permission: string; pattern: string; action: OpenCodePermissionValue }>> {
  const baseRules = buildOpenCodeSessionPermissionRuleset(permissionMode, workspaceWrites);
  const ownAction = resolveOpenCodePermissionConfig(permissionMode)['*'];
  return Object.freeze([
    ...baseRules,
    { permission: 'happier-session-*', pattern: '*', action: 'deny' as const },
    ...projection.registrations.map(({ projectedName }) => ({
      permission: `${sanitizeOpenCodeMcpName(projectedName)}_*`, pattern: '*', action: ownAction,
    })),
    ...buildOpenCodeMcpPermissionRules(mcpToolPolicy, projection.registrations),
    ...(projection.requiredHappierServerName
      ? listHappierToolAutoApprovedNameSpellingsV1(`${sanitizeOpenCodeMcpName(projection.requiredHappierServerName)}_`).map((permission) => ({
          permission,
          pattern: '*',
          action: 'allow' as const,
        }))
      : []),
  ]);
}

export function buildOpenCodeMcpPermissionRules(
  policy: AgentSessionOpenRequest['mcpToolPolicy'],
  servers: readonly Readonly<{ originalName?: string; projectedName: string }>[],
): ReadonlyArray<Readonly<{ permission: string; pattern: string; action: OpenCodePermissionValue }>> {
  return servers.flatMap(({ originalName, projectedName }) => {
    if (!originalName || originalName === 'happier' || !Object.prototype.hasOwnProperty.call(policy ?? {}, originalName)) return [];
    const entry = policy![originalName]!;
    const alias = sanitizeOpenCodeMcpName(projectedName);
    // Until live native revocation is proven, every Allow stays on the host permission path.
    const action = (value: 'off' | 'allow' | 'ask' | 'deny'): OpenCodePermissionValue => value === 'off' || value === 'deny' ? 'deny' : 'ask';
    const tools = new Map<string, OpenCodePermissionValue>();
    for (const [tool, value] of Object.entries(entry.tools)) {
      const name = `${alias}_${sanitizeOpenCodeMcpName(tool)}`;
      // Native sanitization can collapse distinct MCP names; never grant an ambiguous alias.
      tools.set(name, tools.has(name) ? 'deny' : action(value));
    }
    return [
      { permission: `${alias}_*`, pattern: '*', action: action(entry.unlisted) },
      ...Array.from(tools, ([permission, action]) => ({ permission, pattern: '*', action })),
    ];
  });
}

export function buildOpenCodePermissionEnv(
  permissionMode: string | null | undefined,
  workspaceWrites?: NonNullable<AgentSessionOpenRequest['configuration']>['workspaceWrites'],
): Readonly<Record<string, string>> {
  return {
    OPENCODE_PERMISSION: JSON.stringify(resolveOpenCodePermissionConfig(permissionMode, workspaceWrites)),
  };
}
