import { formatMcpToolWireNameV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  AgentLaunchEnvironment,
  AgentPermissionIntent,
  AgentSessionOpenRequest,
  AgentAcpToolNameResolver,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildKiloOpenCodePermissionEnv, sanitizeKiloMcpName } from '../permissions/kiloPermissionPolicy.js';

export function buildKiloAcpToolNameResolver(
  request: Pick<AgentSessionOpenRequest, 'mcpServers'>,
): AgentAcpToolNameResolver {
  const keys = Object.keys(request.mcpServers ?? {});
  return ({ toolName, input }) => {
    const acp = input._acp !== null && typeof input._acp === 'object' ? input._acp as Readonly<Record<string, unknown>> : undefined;
    for (const name of [toolName, acp?.title]) {
      if (typeof name !== 'string') continue;
      const matches = keys.filter((key) => name.startsWith(`${sanitizeKiloMcpName(key)}_`));
      if (matches.length === 0) continue;
      if (matches.length !== 1) throw new Error('Kilo MCP server identity is ambiguous');
      const key = matches[0]!;
      // Happier binding names are fixed by its Action owner, which already
      // recognizes the native prefix without treating it as third-party policy.
      if (key === 'happier') return name;
      const suffix = name.slice(sanitizeKiloMcpName(key).length + 1);
      // A native underscore could be a raw underscore, dot, slash or another
      // replaced character. A birth policy is not a complete tool inventory.
      if (!/^[a-zA-Z0-9-]+$/.test(suffix)) throw new Error('Kilo MCP tool identity is lossy');
      return formatMcpToolWireNameV1(key, suffix);
    }
    return toolName;
  };
}

export function buildKiloAcpEnv(params: Readonly<{
  launchEnvironment?: AgentLaunchEnvironment;
  permissionIntent: AgentPermissionIntent | null;
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
}>): Readonly<Record<string, string>> {
  return {
    ...buildKiloOpenCodePermissionEnv({
      env: params.launchEnvironment?.values,
      permissionIntent: params.permissionIntent,
      mcpToolPolicy: params.mcpToolPolicy,
    }),
    // Kilo 7.8.27 excludes offline recovery from its default retry budget and
    // omits offline status over ACP. Use its minimum supported positive limit
    // (zero is ignored) so repeated connection refusals return a native error.
    KILO_SESSION_RETRY_LIMIT: '1',
  };
}
