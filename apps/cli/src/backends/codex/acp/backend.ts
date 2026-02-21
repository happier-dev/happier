/**
 * Codex ACP Backend Factory
 *
 * Creates an ACP backend for Codex via the optional `codex-acp` capability install.
 * Mirrors the Gemini ACP factory pattern (single place for command resolution).
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import { DefaultTransport } from '@/agent/transport/DefaultTransport';
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
  const npx = readPositiveIntEnv('HAPPIER_CODEX_ACP_NPX_INIT_TIMEOUT_MS');
  if (spawn.command === 'npx') {
    return npx ?? base ?? 180_000;
  }
  return base ?? 60_000;
}

class CodexAcpTransport extends DefaultTransport {
  constructor(private readonly initTimeoutMs: number) {
    super('codex');
  }

  override getInitTimeout(): number {
    return this.initTimeoutMs;
  }
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
    transportHandler: spawn.command === 'npx'
      ? new CodexAcpTransport(resolveCodexAcpInitTimeoutMs(spawn))
      : undefined,
    authMethodId,
  };

  return { backend: new AcpBackend(backendOptions), spawn };
}
