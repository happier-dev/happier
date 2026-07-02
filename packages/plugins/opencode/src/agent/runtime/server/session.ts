import type {
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { createOpenCodeServerRuntimeAssembly } from './assembly.js';
import { formatOpenCodeServerPromptErrorMessage } from './formatOpenCodeServerPromptErrorMessage.js';
import { asRecord, normalizeString, readStringRecord } from './openCodeParsing.js';

const DEFAULT_OPENCODE_SERVER_BASE_URL = 'http://127.0.0.1:4096';

type HostSessionRuntimeFactoryParams = Readonly<{
  directory?: string;
  session?: Readonly<{ sessionId?: string }>;
  mcpServers?: unknown;
  getPermissionMode?: () => unknown;
  setThinking?: (thinking: boolean) => void;
}>;

export type OpenCodeServerSessionPlan = Readonly<{
  kind: 'hostSessionRuntimePlan';
  providerId: 'opencode';
  opts: Readonly<Record<string, unknown>>;
  config: Readonly<{
    flavor: 'default';
    policyAgentId: 'opencode';
    backendDisplayName: 'OpenCode';
    uiLogPrefix: '[OpenCode]';
    providerName: 'opencode';
    waitingForCommandLabel: 'OpenCode';
    agentMessageType: 'opencode';
    checkpointToolProtocol: 'acp';
    supportsMcpServers: true;
    machineMetadata: Readonly<Record<string, unknown>>;
    terminalDisplay: () => null;
    formatPromptErrorMessage: (error: unknown) => string;
    createSessionRuntime: (params: HostSessionRuntimeFactoryParams) => Promise<unknown>;
  }>;
}>;

function readDirectory(sessionParams: unknown): string {
  const record = asRecord(sessionParams);
  return normalizeString(record?.cwd)
    || normalizeString(record?.directory)
    || process.cwd();
}

function readSessionId(sessionParams: unknown): string {
  const record = asRecord(sessionParams);
  return normalizeString(record?.sessionId) || `opencode-${Date.now().toString(36)}`;
}

function readBaseUrl(ctx: PluginContextV1, sessionParams: unknown): string {
  const record = asRecord(sessionParams);
  const env = readStringRecord(asRecord(record?.isolation)?.env ?? record?.env);
  return normalizeString(env.HAPPIER_OPENCODE_SERVER_URL)
    || normalizeString(ctx.config?.values?.HAPPIER_OPENCODE_SERVER_URL)
    || DEFAULT_OPENCODE_SERVER_BASE_URL;
}

export async function createOpenCodeServerSessionRuntime(params: Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
}>): Promise<OpenCodeServerSessionPlan> {
  const initialDirectory = readDirectory(params.sessionParams);
  const initialSessionId = readSessionId(params.sessionParams);
  const baseUrl = readBaseUrl(params.ctx, params.sessionParams);

  return {
    kind: 'hostSessionRuntimePlan',
    providerId: 'opencode',
    opts: {
      directory: initialDirectory,
      backendId: 'opencode',
    },
    config: {
      flavor: 'default',
      policyAgentId: 'opencode',
      backendDisplayName: 'OpenCode',
      uiLogPrefix: '[OpenCode]',
      providerName: 'opencode',
      waitingForCommandLabel: 'OpenCode',
      agentMessageType: 'opencode',
      checkpointToolProtocol: 'acp',
      supportsMcpServers: true,
      machineMetadata: {},
      terminalDisplay: () => null,
      formatPromptErrorMessage: formatOpenCodeServerPromptErrorMessage,
      createSessionRuntime: async (runtimeParams) => {
        const directory = normalizeString(runtimeParams.directory) || initialDirectory;
        const happierSessionId = normalizeString(runtimeParams.session?.sessionId) || initialSessionId;
        const assembly = await createOpenCodeServerRuntimeAssembly({
          ctx: params.ctx,
          directory,
          happierSessionId,
          baseUrl,
          mcpServers: runtimeParams.mcpServers,
          setThinking: runtimeParams.setThinking,
        });
        return assembly.runtime;
      },
    },
  };
}
