import { resolveCliPathOverride } from '@/agent/acp/resolveCliPathOverride';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import type { PermissionMode } from '@/api/types';
import { PiRpcBackend } from '@/backends/pi/rpc/PiRpcBackend';
import { pi } from '@happier-dev/agents';

export interface PiBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionMode?: PermissionMode;
}

export function buildPiToolsForPermissionMode(permissionMode?: PermissionMode): string[] {
  const mode = typeof permissionMode === 'string' ? permissionMode : 'default';
  if (mode === 'read-only' || mode === 'plan') {
    return ['read', 'grep', 'find', 'ls'];
  }
  return ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
}

export function buildPiRpcArgs(opts?: Readonly<{ permissionMode?: PermissionMode; thinkingLevel?: string | null }>): string[] {
  const permissionMode = opts?.permissionMode;
  const args: string[] = ['--mode', 'rpc', '--tools', buildPiToolsForPermissionMode(permissionMode).join(',')];
  const thinking = pi.normalizePiThinkingLevel(opts?.thinkingLevel);
  if (thinking) args.push('--thinking', thinking);
  return args;
}

export function createPiBackend(options: PiBackendOptions): AgentBackend {
  const env = { ...(options.env ?? {}) };
  const thinkingLevel = pi.resolvePiThinkingLevelFromEnv(env);
  return new PiRpcBackend({
    cwd: options.cwd,
    command: resolveCliPathOverride({ agentId: 'pi' }) ?? 'pi',
    args: buildPiRpcArgs({ permissionMode: options.permissionMode, thinkingLevel }),
    env: {
      ...env,
      NODE_ENV: 'production',
      DEBUG: '',
      CI: '1',
    },
  });
}
