import type {
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import type {
  InternalHostSessionRuntimePlanV1,
  InternalRuntimeTurnOperationsEnvelopeV1,
} from '@happier-dev/plugin-sdk/internal/runtime/session';

import { createCodexAppServerRuntime } from './runtime.js';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringRecord(value: unknown): Record<string, string> {
  const record = readRecord(value);
  const output: Record<string, string> = {};
  if (!record) return output;
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string') output[key] = child;
  }
  return output;
}

function readDirectory(value: unknown): string {
  const record = readRecord(value);
  return readString(record?.directory) ?? readString(record?.cwd) ?? process.cwd();
}

function readProcessEnv(ctx: PluginContextV1, value: unknown): Readonly<Record<string, string>> {
  const record = readRecord(value);
  const isolation = readRecord(record?.isolation);
  return {
    ...ctx.env.list(),
    ...readStringRecord(isolation?.env),
    ...readStringRecord(record?.env),
  };
}

function readHappierSessionId(value: unknown): string {
  const record = readRecord(value);
  const session = readRecord(record?.session);
  return readString(session?.sessionId)
    ?? readString(record?.sessionId)
    ?? 'codex-plugin-session';
}

function createRuntimeEnvelope(params: Readonly<{
  ctx: PluginContextV1;
  directory: string;
  happierSessionId: string;
  processEnv: Readonly<Record<string, string>>;
  mcpServers?: unknown;
  setThinking?: ((thinking: boolean) => void) | undefined;
}>): InternalRuntimeTurnOperationsEnvelopeV1 {
  const runtime = createCodexAppServerRuntime({
    ctx: params.ctx,
    directory: params.directory,
    happierSessionId: params.happierSessionId,
    processEnv: params.processEnv,
    mcpServers: params.mcpServers,
    setThinking: params.setThinking,
  });
  return {
    operations: runtime,
    nativeRuntime: runtime,
    runtimeDescriptor: {
      kind: 'codex-app-server',
      providerId: 'codex',
    },
  };
}

export async function createCodexAppServerSessionRuntime(params: Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
}>): Promise<InternalHostSessionRuntimePlanV1> {
  const initialDirectory = readDirectory(params.sessionParams);
  const initialProcessEnv = readProcessEnv(params.ctx, params.sessionParams);
  const initialHappierSessionId = readHappierSessionId(params.sessionParams);

  return {
    kind: 'hostSessionRuntimePlan',
    providerId: 'codex',
    opts: {
      ...params.sessionParams,
      backendId: params.sessionParams.backendId ?? 'codex',
      directory: initialDirectory,
    },
    config: {
      flavor: 'codex',
      policyAgentId: 'codex',
      backendDisplayName: 'Codex',
      uiLogPrefix: '[Codex]',
      providerName: 'Codex',
      waitingForCommandLabel: 'Codex',
      agentMessageType: 'codex',
      checkpointToolProtocol: 'codex',
      terminalDisplay: () => null,
      shouldRenderTerminalDisplay: () => false,
      createSessionRuntime: async (runtimeParams: unknown) => createRuntimeEnvelope({
        ctx: params.ctx,
        directory: readDirectory(runtimeParams) || initialDirectory,
        happierSessionId: readHappierSessionId(runtimeParams) || initialHappierSessionId,
        processEnv: {
          ...initialProcessEnv,
          ...readProcessEnv(params.ctx, runtimeParams),
        },
        mcpServers: readRecord(runtimeParams)?.mcpServers,
        setThinking: readRecord(runtimeParams)?.setThinking as ((thinking: boolean) => void) | undefined,
      }),
    },
  };
}
