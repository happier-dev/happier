import type { AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import type { PermissionMode } from '@/api/types';
import { requireProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';
import { buildPiRpcArgs } from '@happier-dev/plugins-pi/agent/runtime/rpc/args';
import {
  resolvePiThinkingLevelFromEnv,
} from '@happier-dev/plugins-pi/protocol/thinking';

import { PiRpcBackend } from './PiRpcBackend';

export interface PiBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionMode?: PermissionMode;
  happierSessionId?: string | null;
}

export function createPiRpcBackend(options: PiBackendOptions): PiRpcBackend {
  const env = Object.fromEntries(
    Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const processEnv = { ...process.env, ...env };
  const thinkingLevel = resolvePiThinkingLevelFromEnv(env);
  const launch = requireProviderCliLaunchSpec('pi', { processEnv });
  return new PiRpcBackend({
    cwd: options.cwd,
    command: launch.command,
    args: [...launch.args, ...buildPiRpcArgs({ permissionMode: options.permissionMode, thinkingLevel })],
    happierSessionId: options.happierSessionId ?? null,
    env: {
      ...env,
      NODE_ENV: 'production',
      DEBUG: '',
      CI: '1',
    },
  });
}
