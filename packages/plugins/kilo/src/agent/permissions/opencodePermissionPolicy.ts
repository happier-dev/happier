import {
  resolveAcpToolPermissionPolicy,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentPermissionIntent } from '@happier-dev/plugin-sdk/agents/runtime';

type OpenCodePermissionPolicy = ReturnType<typeof resolveAcpToolPermissionPolicy>;

export const KILO_OPENCODE_PERMISSION_ENV = 'OPENCODE_PERMISSION';

export function resolveKiloOpenCodePermissionPolicy(permissionIntent: AgentPermissionIntent | null): OpenCodePermissionPolicy {
  return resolveAcpToolPermissionPolicy(permissionIntent);
}

export function buildKiloOpenCodePermissionEnv(params: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  permissionIntent: AgentPermissionIntent | null;
}>): Readonly<Record<string, string>> {
  if (
    typeof params.env?.[KILO_OPENCODE_PERMISSION_ENV] === 'string'
    && params.env[KILO_OPENCODE_PERMISSION_ENV].length > 0
  ) {
    return {};
  }
  return {
    [KILO_OPENCODE_PERMISSION_ENV]: JSON.stringify(
      resolveKiloOpenCodePermissionPolicy(params.permissionIntent),
    ),
  };
}
