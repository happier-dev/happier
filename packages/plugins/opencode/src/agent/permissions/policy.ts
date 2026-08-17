import {
  resolveAcpToolPermissionPolicy,
} from '@happier-dev/plugin-sdk/agents/runtime';

export type OpenCodePermissionValue =
  ReturnType<typeof resolveAcpToolPermissionPolicy>[string];

export function resolveOpenCodePermissionConfig(
  permissionMode: string | null | undefined,
): Readonly<Record<string, OpenCodePermissionValue>> {
  return resolveAcpToolPermissionPolicy(permissionMode);
}

export function buildOpenCodeSessionPermissionRuleset(
  permissionMode: string | null | undefined,
): ReadonlyArray<Readonly<{ permission: string; pattern: string; action: OpenCodePermissionValue }>> {
  return Object.entries(resolveOpenCodePermissionConfig(permissionMode)).map(([permission, action]) => ({
    permission,
    pattern: '*',
    action,
  }));
}

export function buildOpenCodePermissionEnv(
  permissionMode: string | null | undefined,
): Readonly<Record<string, string>> {
  return {
    OPENCODE_PERMISSION: JSON.stringify(resolveOpenCodePermissionConfig(permissionMode)),
  };
}
