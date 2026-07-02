import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk';

import { resolveCodexApiKeyAuthMethodId } from '../cli/auth/environment.js';
import { buildCodexAcpEnvOverrides } from './env.js';
import { resolveCodexAcpSpawnWithOptions } from './command.js';
import {
  CODEX_ACP_TOOL_PATTERNS,
  resolveCodexAcpExplicitToolHint,
} from './transport.js';

export const CODEX_ACP_BACKEND_ID = 'codex';

export function createCodexAcpBackendSpec(params: Readonly<{
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  projectDir?: string;
}> = {}): AcpBackendSpecV1 {
  const env = params.env ?? process.env;
  const command = params.command ?? 'codex-acp';
  const timeouts = resolveCodexAcpBackendTimeouts({
    command,
    env,
  });
  const callbacks: NonNullable<AcpBackendSpecV1['callbacks']> = Object.freeze({
    argvBuilder: (callbackParams) => {
      const spawn = resolveCodexAcpSpawnWithOptions({
        permissionMode: callbackParams.permissionMode,
        env: { ...callbackParams.env },
      });
      return Object.freeze([...callbackParams.baseArgs, ...spawn.args]);
    },
    envBuilder: (callbackParams) => Object.freeze(buildCodexAcpEnvOverrides({
      baseEnv: callbackParams.env,
      projectDir: params.projectDir ?? callbackParams.cwd,
    })),
    toolNameResolver: ({ toolName, input }) => resolveCodexAcpExplicitToolHint({
      toolName,
      input,
    }),
  });
  const authMethodId = resolveCodexApiKeyAuthMethodId(env);

  return Object.freeze({
    backendId: CODEX_ACP_BACKEND_ID,
    transport: Object.freeze({
      kind: 'stdio',
      launch: Object.freeze(params.command
        ? {
            kind: 'executable' as const,
            command,
            args: params.args ?? [],
          }
        : {
            kind: 'system-tool' as const,
            toolId: 'codex-acp',
            purpose: 'Run Codex ACP',
            preferredCommand: 'codex-acp',
            args: params.args ?? [],
          }),
      timeouts: Object.freeze(timeouts),
    }),
    ux: Object.freeze({
      name: 'Codex ACP',
      title: 'Codex',
      description: 'Codex ACP runtime',
    }),
    capabilities: Object.freeze({
      supportsPermissionRequests: true,
      supportsLoadSession: true,
      supportsModes: 'unknown',
      supportsModels: 'unknown',
      supportsConfigOptions: 'unknown',
    }),
    ...(authMethodId ? { auth: Object.freeze({ methodId: authMethodId }) } : {}),
    toolNameInference: Object.freeze({
      patterns: CODEX_ACP_TOOL_PATTERNS,
      preferLongestPattern: true,
      unknownToolNames: ['unknown', 'other', 'unknown tool'],
    }),
    mcp: Object.freeze({
      policy: 'pass_through',
    }),
    callbacks,
  });
}

export const CODEX_ACP_BACKEND_SPEC = createCodexAcpBackendSpec();

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
