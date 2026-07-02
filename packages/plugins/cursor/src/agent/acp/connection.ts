import type {
  AcpBackendSpecV1,
  AcpRuntimeHandleV1,
  AcpSessionRuntimeConfigUpdateV1,
  AcpSessionRuntimeV1,
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import type { RuntimeEventV1 } from '@happier-dev/protocol/runtime';

import { createCursorAcpRuntimeExtensions } from './extensions.js';
import { createCursorAcpTransportCustomHandler } from './transport.js';

type HostSessionRuntimeFactoryParams = Readonly<{
  directory?: string;
  session?: Readonly<{ sessionId?: string }>;
  getPermissionMode?: () => unknown;
}>;

type CursorRuntimeTurnOperations = Readonly<{
  beginTurnLifecycle(): void;
  startOrLoadSession(opts?: Readonly<Record<string, unknown>>): Promise<string>;
  sendTurnPrompt(prompt: string): Promise<void>;
  steerInFlightTurn(message: string): Promise<void>;
  waitForTurnCompletion(): Promise<void>;
  subscribeRuntimeEvents(handler: (message: RuntimeEventV1) => void): () => void;
  respondToPermission(requestId: string, approved: boolean): Promise<void>;
  cancelTurn(): Promise<void>;
  readSessionIdentity(): Readonly<{ sessionId: string | null }>;
  updateSessionRuntimeConfig(update: Readonly<Record<string, unknown>>): Promise<void>;
  resetOrDisposeRuntime(): Promise<void>;
}>;

export type CursorHostSessionRuntimePlan = Readonly<{
  kind: 'hostSessionRuntimePlan';
  providerId: 'cursor';
  opts: Readonly<Record<string, unknown>>;
  config: Readonly<{
    flavor: 'cursor';
    policyAgentId: 'cursor';
    backendDisplayName: 'Cursor';
    uiLogPrefix: '[Cursor]';
    providerName: 'cursor';
    waitingForCommandLabel: 'Cursor';
    agentMessageType: 'cursor';
    checkpointToolProtocol: 'acp';
    supportsMcpServers: false;
    machineMetadata: Readonly<Record<string, unknown>>;
    terminalDisplay: () => null;
    formatPromptErrorMessage: (error: unknown) => string;
    createSessionRuntime: (params: HostSessionRuntimeFactoryParams) => Promise<CursorRuntimeTurnOperations>;
  }>;
}>;

export type CursorAcpRuntimeConnectionParams = Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
}>;

const CURSOR_API_ENDPOINT_ENV = 'HAPPIER_CURSOR_API_ENDPOINT';
const CURSOR_API_KEY_ENV = 'CURSOR_API_KEY';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readDirectory(sessionParams: CreateSessionRuntimeParamsV1): string {
  return readString(sessionParams.cwd)
    ?? readString(sessionParams.directory)
    ?? process.cwd();
}

function readSessionId(sessionParams: CreateSessionRuntimeParamsV1): string {
  return readString(sessionParams.sessionId) ?? `cursor-${Date.now().toString(36)}`;
}

function readInitialProviderSessionId(sessionParams: CreateSessionRuntimeParamsV1): string | null {
  const state = sessionParams.initialRuntimeState;
  if (!isRecord(state)) {
    return null;
  }
  return readString(state.cursorSessionId)
    ?? readString(state.providerSessionId);
}

function readRuntimeProviderSessionId(params: unknown, fallback: string | null): string | null {
  if (!isRecord(params)) {
    return fallback;
  }
  return readString(params.providerSessionId)
    ?? readString(params.cursorSessionId)
    ?? fallback;
}

function readCursorApiEndpoint(ctx: PluginContextV1, sessionParams: CreateSessionRuntimeParamsV1): string | null {
  const env = isRecord(sessionParams.isolation?.env)
    ? sessionParams.isolation.env
    : sessionParams.env;
  return readString(env?.[CURSOR_API_ENDPOINT_ENV])
    ?? readString(ctx.env.get(CURSOR_API_ENDPOINT_ENV))
    ?? readString(ctx.config.values[CURSOR_API_ENDPOINT_ENV]);
}

function buildCursorPermissionModeArgs(permissionMode: string | undefined): readonly string[] {
  switch (permissionMode) {
    case 'safe-yolo':
      return ['--force', '--sandbox', 'enabled'];
    case 'yolo':
    case 'bypassPermissions':
      return ['--force'];
    default:
      return [];
  }
}

function normalizeConfigOption(update: Readonly<Record<string, unknown>>): AcpSessionRuntimeConfigUpdateV1['configOption'] {
  const configOption = update.configOption;
  if (!isRecord(configOption)) return undefined;
  const id = readString(configOption.id);
  if (!id) return undefined;
  const rawValue = configOption.value;
  const value =
    typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean' || rawValue === null
      ? rawValue
      : undefined;
  if (value === undefined) return undefined;
  return Object.freeze({ id, value });
}

function normalizeRuntimeConfigUpdate(update: Readonly<Record<string, unknown>>): AcpSessionRuntimeConfigUpdateV1 {
  const modeId = readString(update.modeId) ?? readString(update.mode);
  const modelId = readString(update.modelId) ?? readString(update.model);
  // Singular canonical shape wins; the plural `configOptions` map is a legacy alias.
  const configOption = normalizeConfigOption(update);
  const configOptions = isRecord(update.configOptions) ? update.configOptions : undefined;
  return Object.freeze({
    ...(modeId ? { modeId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(configOption ? { configOption } : {}),
    ...(configOptions ? { configOptions } : {}),
  });
}

function createCursorAcpBackendSpec(params: Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
}>): AcpBackendSpecV1 {
  const cursorApiEndpoint = readCursorApiEndpoint(params.ctx, params.sessionParams);
  const spec: AcpBackendSpecV1 = Object.freeze({
    backendId: 'cursor',
    transport: Object.freeze({
      kind: 'stdio',
      launch: Object.freeze({
        kind: 'agent-cli',
        agentId: 'cursor',
      }),
      customHandler: createCursorAcpTransportCustomHandler(),
    }),
    ux: Object.freeze({
      name: 'Cursor',
      title: 'Cursor',
      description: 'Cursor Agent CLI over ACP',
    }),
    auth: Object.freeze({
      config: Object.freeze({
        support: 'login_terminal',
        machineLoginKey: 'cursor_login',
      }),
      buildAuthEnv: (ctx: PluginContextV1) => {
        const apiKey = readString(ctx.env.get(CURSOR_API_KEY_ENV));
        return apiKey ? Object.freeze({ [CURSOR_API_KEY_ENV]: apiKey }) : Object.freeze({});
      },
    }),
    callbacks: Object.freeze({
      argvBuilder: (callbackParams: Readonly<{
        baseArgs: readonly string[];
        cwd: string;
        permissionMode?: string;
      }>) => Object.freeze([
        ...callbackParams.baseArgs,
        ...(cursorApiEndpoint ? ['-e', cursorApiEndpoint] : []),
        ...buildCursorPermissionModeArgs(callbackParams.permissionMode),
        'acp',
      ]),
      envBuilder: (callbackParams: Readonly<{
        cwd: string;
        env: Readonly<Record<string, string>>;
      }>) => {
        const apiKey = readString(params.ctx.env.get(CURSOR_API_KEY_ENV));
        return apiKey
          ? Object.freeze({ ...callbackParams.env, [CURSOR_API_KEY_ENV]: apiKey })
          : callbackParams.env;
      },
    }),
    capabilities: Object.freeze({
      supportsPermissionRequests: true,
      supportsLoadSession: false,
      supportsModes: 'unknown',
      supportsModels: 'unknown',
      supportsConfigOptions: 'unknown',
    }),
    mcp: Object.freeze({
      policy: 'pass_through',
    }),
  });
  return spec;
}

function createCursorHostRuntimeOperations(params: Readonly<{
  handle: AcpRuntimeHandleV1;
  sessionRuntime: AcpSessionRuntimeV1;
  initialProviderSessionId: string | null;
}>): CursorRuntimeTurnOperations {
  let providerSessionId: string | null = params.initialProviderSessionId;
  return Object.freeze({
    beginTurnLifecycle() {
      params.sessionRuntime.beginTurnLifecycle();
    },
    async startOrLoadSession(opts?: Readonly<Record<string, unknown>>): Promise<string> {
      const nextProviderSessionId = readRuntimeProviderSessionId(opts, providerSessionId);
      providerSessionId = nextProviderSessionId
        ? await params.sessionRuntime.startOrLoadSession({ providerSessionId: nextProviderSessionId })
        : await params.sessionRuntime.startOrLoadSession();
      return providerSessionId;
    },
    async sendTurnPrompt(prompt: string): Promise<void> {
      await params.sessionRuntime.sendTurnPrompt(prompt);
    },
    async steerInFlightTurn(message: string): Promise<void> {
      await params.sessionRuntime.sendTurnPrompt(message);
    },
    async waitForTurnCompletion(): Promise<void> {
      await params.sessionRuntime.waitForTurnCompletion();
    },
    subscribeRuntimeEvents(handler) {
      return params.sessionRuntime.subscribeRuntimeEvents(handler);
    },
    async respondToPermission(): Promise<void> {
      return undefined;
    },
    async cancelTurn(): Promise<void> {
      await params.sessionRuntime.cancelTurn();
    },
    readSessionIdentity() {
      return {
        sessionId: providerSessionId,
      };
    },
    async updateSessionRuntimeConfig(update: Readonly<Record<string, unknown>>): Promise<void> {
      await params.sessionRuntime.updateSessionRuntimeConfig(normalizeRuntimeConfigUpdate(update));
    },
    async resetOrDisposeRuntime(): Promise<void> {
      await params.handle.dispose('cursor-session-runtime-disposed');
    },
  });
}

export async function createCursorAcpRuntimeConnection(
  params: CursorAcpRuntimeConnectionParams,
): Promise<CursorHostSessionRuntimePlan> {
  const initialDirectory = readDirectory(params.sessionParams);
  const initialSessionId = readSessionId(params.sessionParams);
  const initialProviderSessionId = readInitialProviderSessionId(params.sessionParams);

  return Object.freeze({
    kind: 'hostSessionRuntimePlan',
    providerId: 'cursor',
    opts: Object.freeze({
      directory: initialDirectory,
      backendId: 'cursor',
    }),
    config: Object.freeze({
      flavor: 'cursor',
      policyAgentId: 'cursor',
      backendDisplayName: 'Cursor',
      uiLogPrefix: '[Cursor]',
      providerName: 'cursor',
      waitingForCommandLabel: 'Cursor',
      agentMessageType: 'cursor',
      checkpointToolProtocol: 'acp',
      supportsMcpServers: false,
      machineMetadata: Object.freeze({}),
      terminalDisplay: () => null,
      formatPromptErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
      createSessionRuntime: async (runtimeParams: HostSessionRuntimeFactoryParams) => {
        const directory = readString(runtimeParams.directory) ?? initialDirectory;
        const happierSessionId = readString(runtimeParams.session?.sessionId) ?? initialSessionId;
        const permissionMode = readString(runtimeParams.getPermissionMode?.()) ?? readString(params.sessionParams.permissionMode) ?? undefined;
        const handle = await params.ctx.acp.createRuntime(createCursorAcpBackendSpec(params), {
          sessionId: happierSessionId,
          cwd: directory,
          ...(permissionMode ? { permissionMode } : {}),
          agentName: 'Cursor',
          metadata: Object.freeze({
            mcpDelivery: 'experimental',
            resume: 'experimental',
            modelConfig: 'experimental',
          }),
          lifecycle: Object.freeze({
            signal: params.sessionParams.signal,
            initialize: Object.freeze({
              protocolVersion: 1,
            }),
            authenticate: Object.freeze({
              methodId: 'cursor_login',
            }),
            initializeMeta: Object.freeze({
              parameterizedModelPicker: true,
            }),
          }),
          extensions: createCursorAcpRuntimeExtensions({
            ctx: params.ctx,
          }),
        });
        return createCursorHostRuntimeOperations({
          handle,
          sessionRuntime: handle.sessionRuntime,
          initialProviderSessionId,
        });
      },
    }),
  });
}
