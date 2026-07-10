import {
  resolveAcpToolPermissionPolicy,
  type AcpToolPermissionValueV1,
} from '@happier-dev/plugin-sdk/experimental/acp';

export type OpenCodePermissionValue = AcpToolPermissionValueV1;

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
