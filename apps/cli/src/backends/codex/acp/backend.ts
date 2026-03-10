/**
 * Codex ACP Backend Factory
 *
 * Creates an ACP backend for Codex via the optional `codex-acp` capability install.
 * Mirrors the Gemini ACP factory pattern (single place for command resolution).
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import { resolveCodexAcpSpawn, type SpawnSpec } from '@/backends/codex/acp/resolveCommand';
import type { PermissionMode } from '@/api/types';
import { CodexAcpTransport } from './transport';

export interface CodexAcpBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  /**
   * Optional Happier permission mode. When provided and non-default, Codex ACP is started with
   * config overrides derived from this mode (approval/sandbox presets).
   */
  permissionMode?: PermissionMode;
}

export interface CodexAcpBackendResult {
  backend: AgentBackend;
  spawn: SpawnSpec;
}

function readPositiveIntEnv(name: string): number | null {
  const raw = typeof process.env[name] === 'string' ? process.env[name]!.trim() : '';
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n <= 0) return null;
  return n;
}

function resolveCodexAcpInitTimeoutMs(spawn: SpawnSpec): number {
  const base = readPositiveIntEnv('HAPPIER_CODEX_ACP_INIT_TIMEOUT_MS');
  return base ?? 180_000;
}

function resolveCodexAcpPreToolIdleTimeoutMs(): number {
  return readPositiveIntEnv('HAPPIER_CODEX_ACP_PRE_TOOL_IDLE_TIMEOUT_MS') ?? 1_000;
}

export function createCodexAcpBackend(options: CodexAcpBackendOptions): CodexAcpBackendResult {
  const spawn = resolveCodexAcpSpawn({ permissionMode: options.permissionMode });

  const authMethodId = (() => {
    const openAiKey = typeof process.env.OPENAI_API_KEY === 'string' ? process.env.OPENAI_API_KEY.trim() : '';
    if (openAiKey) return 'openai-api-key';
    const codexKey = typeof process.env.CODEX_API_KEY === 'string' ? process.env.CODEX_API_KEY.trim() : '';
    if (codexKey) return 'codex-api-key';
    return undefined;
  })();

  const backendOptions: AcpBackendOptions = {
    agentName: 'codex',
    cwd: options.cwd,
    command: spawn.command,
    args: spawn.args,
    env: options.env,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: new CodexAcpTransport(
      resolveCodexAcpInitTimeoutMs(spawn),
      resolveCodexAcpPreToolIdleTimeoutMs(),
    ),
    authMethodId,
  };

  return { backend: new AcpBackend(backendOptions), spawn };
}
