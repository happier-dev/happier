import type {
  AgentRuntimeV1,
  CreateExecutionRunBackendParamsV1,
  CreateSessionRuntimeParamsV1,
  ExecutionRunBackendCreateResultV1,
  PluginContextV1,
  SessionRuntimeCreateResultV1,
} from '@happier-dev/plugin-sdk';

import { CODEX_ACP_BACKEND_SPEC } from '../acp/backend.js';
import { createCodexExecutionRunBackend } from '../executionRuns/backend.js';
import { resolveCanonicalCodexBackendModeFromCompatInput } from '../lifecycle/backendMode.js';
import { createCodexAppServerClient } from '../runtime/appServer/client.js';
import { createCodexAppServerSessionRuntime } from '../runtime/appServer/session.js';
import { createCodexTerminalRuntimeSurface } from '../runtime/terminal/launch.js';
import { createCodexExternalSessionSurface } from '../surfaces/sessions/external/providerOps.js';
import { forkCodexNativeAppServerConversation } from '../surfaces/sessions/fork/native.js';
import { createCodexForkSurface } from '../surfaces/sessions/fork/providerOps.js';
import { codexHandoffSurface } from '../surfaces/sessions/handoff/providerOps.js';
import { createCodexOutboundTranscriptDispatchFacet } from '../transcripts/outbound.js';

type CodexBackendMode = 'appServer' | 'acp';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readEnvironmentBackendMode(value: unknown): unknown {
  const record = readRecord(value);
  const env = readRecord(record?.env);
  const isolation = readRecord(record?.isolation);
  const isolationEnv = readRecord(isolation?.env);
  return isolationEnv?.HAPPIER_CODEX_BACKEND_MODE
    ?? isolationEnv?.CODEX_BACKEND_MODE
    ?? env?.HAPPIER_CODEX_BACKEND_MODE
    ?? env?.CODEX_BACKEND_MODE;
}

function readCodexBackendMode(value: unknown): CodexBackendMode {
  const record = readRecord(value);
  const metadata = readRecord(record?.metadata);
  const accountSettings = readRecord(record?.accountSettings);
  const resolved = resolveCanonicalCodexBackendModeFromCompatInput({
    codexBackendMode: metadata?.codexBackendMode
      ?? accountSettings?.codexBackendMode
      ?? readEnvironmentBackendMode(value),
    runtimeDescriptorV1: metadata?.runtimeDescriptorV1,
  });
  return resolved === 'acp' ? 'acp' : 'appServer';
}

function createCodexAcpSessionRuntime(params: Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
}>): SessionRuntimeCreateResultV1 | Promise<SessionRuntimeCreateResultV1> {
  const acpEngine = params.ctx.agentRuntime.acp.defineAcpBackend(CODEX_ACP_BACKEND_SPEC);
  const createSessionRuntime = acpEngine.runtimeCore?.createSessionRuntime;
  if (typeof createSessionRuntime !== 'function') {
    throw new Error('Codex ACP backend definition did not expose runtimeCore.createSessionRuntime.');
  }
  return createSessionRuntime(params.sessionParams) as SessionRuntimeCreateResultV1 | Promise<SessionRuntimeCreateResultV1>;
}

function createCodexAcpExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunBackendCreateResultV1 {
  const acpEngine = params.ctx.agentRuntime.acp.defineAcpBackend(CODEX_ACP_BACKEND_SPEC);
  const createExecutionRunBackend = acpEngine.runtimeCore?.createExecutionRunBackend;
  if (typeof createExecutionRunBackend !== 'function') {
    throw new Error('Codex ACP backend definition did not expose runtimeCore.createExecutionRunBackend.');
  }
  return createExecutionRunBackend(params.executionRunParams);
}

export function createCodexBackendEngine(ctx: PluginContextV1): AgentRuntimeV1 {
  return {
    handoffSurface: codexHandoffSurface,
    terminalRuntimeSurface: createCodexTerminalRuntimeSurface({
      baseProcessEnv: ctx.env.list(),
    }),
    externalSessionSurface: createCodexExternalSessionSurface({
      baseProcessEnv: ctx.env.list(),
    }),
    forkSurface: createCodexForkSurface({
      baseProcessEnv: ctx.env.list(),
      forkNative: async ({ directory, parentCodexSessionId, processEnv }) => {
        const client = await createCodexAppServerClient({
          exec: ctx.agentRuntime.exec,
          cwd: directory,
          processEnv,
        });
        try {
          return await forkCodexNativeAppServerConversation({
            client,
            parentCodexSessionId,
          });
        } finally {
          await client.dispose().catch(() => undefined);
        }
      },
    }),
    runtimeCore: {
      createSessionRuntime: async (sessionParams) => {
        const mode = readCodexBackendMode(sessionParams);
        return mode === 'acp'
          ? await createCodexAcpSessionRuntime({ ctx, sessionParams })
          : await createCodexAppServerSessionRuntime({ ctx, sessionParams });
      },
      createExecutionRunBackend: (executionRunParams) => {
        const mode = readCodexBackendMode(executionRunParams);
        return mode === 'acp'
          ? createCodexAcpExecutionRunBackend({ ctx, executionRunParams })
          : createCodexExecutionRunBackend({ ctx, executionRunParams });
      },
    },
    facets: {
      transcriptDispatch: createCodexOutboundTranscriptDispatchFacet(),
    },
  };
}
