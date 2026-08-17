import type {
  AgentLaunchEnvironment,
  AgentPermissionIntent,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildKiloOpenCodePermissionEnv } from '../permissions/opencodePermissionPolicy.js';

export function buildKiloAcpEnv(params: Readonly<{
  launchEnvironment?: AgentLaunchEnvironment;
  permissionIntent: AgentPermissionIntent | null;
}>): Readonly<Record<string, string>> {
  return buildKiloOpenCodePermissionEnv({
    env: params.launchEnvironment?.values,
    permissionIntent: params.permissionIntent,
  });
}
