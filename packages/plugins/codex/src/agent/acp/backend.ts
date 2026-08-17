import type {
  AgentAcpRuntimeOptions,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { resolveCodexApiKeyAuthMethodId } from '../cli/auth/environment.js';
import { buildCodexAcpEnvOverrides } from './env.js';
import { resolveCodexAcpSpawnWithOptions } from './command.js';
import {
  CODEX_ACP_TOOL_PATTERNS,
  resolveCodexAcpExplicitToolHint,
} from './transport.js';

export function buildCodexNativeAcpRuntimeOptions(
  request: AgentSessionOpenRequest,
): AgentAcpRuntimeOptions {
  const env = request.launchEnvironment?.values ?? {};
  const permissionMode = request.configuration?.permissionIntent.value ?? undefined;
  const spawn = resolveCodexAcpSpawnWithOptions({
    env,
    permissionMode,
    currentWorkingDirectory: request.cwd,
  });
  const timeouts = resolveCodexAcpBackendTimeouts({
    command: spawn.command,
    env,
  });
  const authMethodId = resolveCodexApiKeyAuthMethodId(env);

  return Object.freeze({
    transport: Object.freeze({
      kind: 'stdio' as const,
      executable: Object.freeze({ kind: 'managedDependency' as const, id: 'codex-acp' }),
      args: Object.freeze(spawn.args),
      env: Object.freeze(buildCodexAcpEnvOverrides({
        baseEnv: env,
        projectDir: request.cwd,
      })),
      timeouts: Object.freeze({ initializeMs: timeouts.initMs }),
    }),
    definition: Object.freeze({
      ...(authMethodId ? { auth: Object.freeze({ methodId: authMethodId }) } : {}),
      timeouts: Object.freeze(timeouts),
      toolNameInference: Object.freeze({
        patterns: CODEX_ACP_TOOL_PATTERNS,
        preferLongestPattern: true,
        unknownToolNames: ['unknown', 'other', 'unknown tool'],
      }),
      toolNameResolver: resolveCodexAcpExplicitToolHint,
      mcp: Object.freeze({ policy: 'pass_through' as const }),
    }),
  });
}

export function resolveCodexAcpBackendTimeouts(params: Readonly<{
  command: string;
  env?: Readonly<Record<string, string | undefined>>;
}>): Readonly<{
  initMs: number;
  preToolCallIdleMs: number;
}> {
  const env = params.env ?? process.env;
  const npxSpecific = params.command === 'npx'
    ? readPositiveIntEnv(env, 'HAPPIER_CODEX_ACP_NPX_INIT_TIMEOUT_MS')
    : null;
  const base = readPositiveIntEnv(env, 'HAPPIER_CODEX_ACP_INIT_TIMEOUT_MS');
  return {
    initMs: npxSpecific ?? base ?? 180_000,
    preToolCallIdleMs: readPositiveIntEnv(env, 'HAPPIER_CODEX_ACP_PRE_TOOL_IDLE_TIMEOUT_MS') ?? 1_000,
  };
}

function readPositiveIntEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | null {
  const raw = typeof env[name] === 'string' ? env[name]!.trim() : '';
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}
