import {
  resolveAcpToolPermissionPolicy,
  type AcpToolPermissionPolicyV1,
} from '@happier-dev/plugin-sdk/experimental/acp';

type OpenCodePermissionPolicy = AcpToolPermissionPolicyV1;

export function resolveKiloOpenCodePermissionPolicy(permissionMode: string | null | undefined): OpenCodePermissionPolicy {
  return resolveAcpToolPermissionPolicy(permissionMode);
}

export function buildKiloOpenCodePermissionEnv(params: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  permissionMode?: string | null;
}>): Readonly<Record<string, string>> {
  if (typeof params.env?.OPENCODE_PERMISSION === 'string' && params.env.OPENCODE_PERMISSION.length > 0) {
    return {};
  }
  return {
    OPENCODE_PERMISSION: JSON.stringify(resolveKiloOpenCodePermissionPolicy(params.permissionMode)),
  };
}
