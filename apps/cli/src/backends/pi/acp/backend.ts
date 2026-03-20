import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import type { PermissionMode } from '@/api/types';
import { PiRpcBackend } from '@/backends/pi/rpc/PiRpcBackend';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { providers } from '@happier-dev/agents';

export interface PiBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionMode?: PermissionMode;
}

export function buildPiToolsForPermissionMode(permissionMode?: PermissionMode): string[] {
  const rawMode = typeof permissionMode === 'string' ? permissionMode : 'default';

  // Normalize legacy aliases into canonical permission intents.
  const mode = rawMode === 'acceptEdits'
    ? 'safe-yolo'
    : rawMode === 'bypassPermissions'
      ? 'yolo'
      : rawMode;

  if (mode === 'plan' || mode === 'read-only') {
    return ['read', 'grep', 'find', 'ls'];
  }
  if (mode === 'safe-yolo') {
    return ['read', 'edit', 'write', 'grep', 'find', 'ls'];
  }
  return ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
}

export function buildPiRpcArgs(opts?: Readonly<{ permissionMode?: PermissionMode; thinkingLevel?: string | null }>): string[] {
  const permissionMode = opts?.permissionMode;
  const args: string[] = ['--mode', 'rpc', '--tools', buildPiToolsForPermissionMode(permissionMode).join(',')];
  const thinking = providers.pi.normalizePiThinkingLevel(opts?.thinkingLevel);
  if (thinking) args.push('--thinking', thinking);
  return args;
}

export function createPiBackend(options: PiBackendOptions): AgentBackend {
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
