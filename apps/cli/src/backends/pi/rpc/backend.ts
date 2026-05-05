import type { AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import type { PermissionMode } from '@/api/types';
import { requireProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';
import { providers } from '@happier-dev/agents';

import { PiRpcBackend } from './PiRpcBackend';
import { buildPiToolsForPermissionMode } from '../permissionMode';

export interface PiBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionMode?: PermissionMode;
}

export function buildPiRpcArgs(opts?: Readonly<{ permissionMode?: PermissionMode; thinkingLevel?: string | null }>): string[] {
  const permissionMode = opts?.permissionMode;
  const args: string[] = ['--mode', 'rpc', '--tools', buildPiToolsForPermissionMode(permissionMode).join(',')];
  const thinking = providers.pi.normalizePiThinkingLevel(opts?.thinkingLevel);
  if (thinking) args.push('--thinking', thinking);
  return args;
}

export function createPiRpcBackend(options: PiBackendOptions): PiRpcBackend {
  const env = Object.fromEntries(
    Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const processEnv = { ...process.env, ...env };
  const thinkingLevel = providers.pi.resolvePiThinkingLevelFromEnv(env);
  const launch = requireProviderCliLaunchSpec('pi', { processEnv });
  return new PiRpcBackend({
    cwd: options.cwd,
    command: launch.command,
    args: [...launch.args, ...buildPiRpcArgs({ permissionMode: options.permissionMode, thinkingLevel })],
    env: {
      ...env,
      NODE_ENV: 'production',
      DEBUG: '',
      CI: '1',
    },
  });
}
