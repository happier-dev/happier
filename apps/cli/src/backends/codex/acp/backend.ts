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
    authMethodId,
  };

  return { backend: new AcpBackend(backendOptions), spawn };
}
