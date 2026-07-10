import type {
  AcpBackendSpecV1,
  AcpRuntimeHandleV1,
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
  SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';
import { isRecord, readTrimmedString as readString } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';
import { composeSessionIsolationEnvironment } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { createCursorAcpRuntimeExtensions } from './extensions.js';
import { createCursorPublicSessionRuntime } from './sessionRuntime.js';
import { createCursorAcpTransportCustomHandler } from './transport.js';

export type CursorAcpRuntimeConnectionParams = Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
}>;

const CURSOR_API_ENDPOINT_ENV = 'HAPPIER_CURSOR_API_ENDPOINT';
const CURSOR_API_KEY_ENV = 'CURSOR_API_KEY';

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

function readCursorApiEndpoint(ctx: PluginContextV1, sessionParams: CreateSessionRuntimeParamsV1): string | null {
  const env = composeSessionIsolationEnvironment({
    inheritedEnvironment: ctx.env.list(),
    isolationEnvironment: sessionParams.isolation?.env,
    environment: sessionParams.env,
    unsetEnvKeys: sessionParams.isolation?.unsetEnvKeys,
  });
  return readString(env?.[CURSOR_API_ENDPOINT_ENV])
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
        return callbackParams.env;
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

async function createCursorAcpRuntimeHandle(params: Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
  directory: string;
  happierSessionId: string;
  permissionMode?: string;
}>): Promise<AcpRuntimeHandleV1> {
  return params.ctx.agentRuntime.acp.createRuntime(createCursorAcpBackendSpec(params), {
    sessionId: params.happierSessionId,
    cwd: params.directory,
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
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
}

export async function createCursorAcpRuntimeConnection(
  params: CursorAcpRuntimeConnectionParams,
): Promise<SessionRuntimeV1> {
  const initialDirectory = readDirectory(params.sessionParams);
  const initialSessionId = readSessionId(params.sessionParams);
  const initialProviderSessionId = readInitialProviderSessionId(params.sessionParams);
  const permissionMode = readString(params.sessionParams.permissionMode) ?? undefined;

  return createCursorPublicSessionRuntime({
    createHandle: () => createCursorAcpRuntimeHandle({
      ctx: params.ctx,
      sessionParams: params.sessionParams,
      directory: initialDirectory,
      happierSessionId: initialSessionId,
      ...(permissionMode ? { permissionMode } : {}),
    }),
    initialProviderSessionId,
  });
}
