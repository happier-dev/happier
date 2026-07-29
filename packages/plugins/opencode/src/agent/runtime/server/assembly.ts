import { createHash } from 'node:crypto';

import type {
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';

import type { OpenCodeServerCredential, OpenCodeServerEndpoint } from './endpoint.js';
import {
  createOpenCodeManagedServerCredential,
  registerOpenCodeManagedServerEndpoint,
} from './endpoint.js';
import { buildOpenCodePermissionEnv } from '../../permissions/policy.js';
import {
  OPENCODE_PROVIDER_OWNED_ENV_KEYS,
} from '../../providerBinding/adapter.js';
import { readOpenCodeProviderConfigContent } from '../../providerBinding/runtime.js';
import {
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '../../auth/services/requestAuth/env.js';
import { scheduleOpenCodeMcpServerRegistration } from './mcpRegistration.js';
import { createOpenCodeServerClient } from './openCodeServerClient.js';
import { createOpenCodeServerTransport } from './transport.js';
import { createOpenCodeServerRuntime } from './runtime.js';
import { createOpenCodeSessionRuntime } from './sessionRuntime.js';
import {
  OPENCODE_BINARY_IDENTITY_ENV,
  OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV,
  resolveOpenCodeManagedServerStateFingerprintInput,
} from './managedServerState.js';
import type { OpenCodeActiveSkillsReaderRegistrar } from '../controls.js';
import type {
  OpenCodeManagedServerHandle,
  OpenCodeRuntimeContext,
} from './runtimeContext.js';

type Disposable = Readonly<{ dispose?: () => void | Promise<void> }>;

export type OpenCodeServerRuntimeAssembly = Readonly<{
  runtime: AgentSessionRuntime;
  dispose(): Promise<void>;
}>;

type ResolvedOpenCodeServer = Readonly<{
  baseUrl: string;
  instanceId: string;
  credential: OpenCodeServerCredential | null;
  managedServer: OpenCodeManagedServerHandle;
}>;

const OPENCODE_CHILD_LAUNCH_ENV_KEYS = Object.freeze([
  ...OPENCODE_PROVIDER_OWNED_ENV_KEYS,
  'XDG_CONFIG_HOME',
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
] as const);

async function disposeBestEffort(ctx: OpenCodeRuntimeContext, label: string, disposable: Disposable | null): Promise<void> {
  if (typeof disposable?.dispose !== 'function') return;
  await Promise.resolve(disposable.dispose()).catch((error: unknown) => {
    ctx.logger.debug(`[OpenCodeServer] failed to dispose ${label}`, { error });
  });
}

function readManagedServerIdentity(
  snapshot: ReturnType<OpenCodeManagedServerHandle['snapshot']>,
): Readonly<{ baseUrl: string; instanceId: string }> {
  const baseUrl = snapshot.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new Error('OpenCode managed server did not report a resolved base URL');
  }
  const instanceId = snapshot.instanceId?.trim();
  if (!instanceId) {
    throw new Error('OpenCode managed server did not report a host-issued incarnation');
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/u, ''),
    instanceId,
  };
}

function stableStringifyRecord(record: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.keys(record).sort().map((key) => [key, record[key]]));
}

function buildOpenCodeLaunchFingerprint(env: Readonly<Record<string, string>>): string {
  return createHash('sha256')
    .update(stableStringifyRecord(resolveOpenCodeManagedServerStateFingerprintInput(env as NodeJS.ProcessEnv)))
    .digest('hex');
}

function readOpenCodeExecutablePath(env: Readonly<Record<string, string>>): string {
  const explicitPath = typeof env.HAPPIER_OPENCODE_PATH === 'string' ? env.HAPPIER_OPENCODE_PATH.trim() : '';
  return explicitPath || 'opencode';
}

function buildOpenCodeManagedLaunchEnvironment(
  env: Readonly<Record<string, string>> | undefined,
  permissionMode: string | null | undefined,
  providerConfigContent: string | undefined,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...Object.fromEntries(OPENCODE_CHILD_LAUNCH_ENV_KEYS.flatMap((key) => (
      typeof env?.[key] === 'string' ? [[key, env[key]]] : []
    ))),
    ...(providerConfigContent === undefined
      ? {}
      : { OPENCODE_CONFIG_CONTENT: providerConfigContent }),
    ...buildOpenCodePermissionEnv(permissionMode),
  });
}

async function resolveOpenCodeServer(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  directory: string;
  endpoint: OpenCodeServerEndpoint;
  env?: Readonly<Record<string, string>>;
  providerConfigContent?: string;
  permissionMode?: string | null;
  signal?: AbortSignal;
}>): Promise<ResolvedOpenCodeServer> {
  if (params.endpoint.mode === 'external-attach') {
    if (params.providerConfigContent !== undefined) {
      throw new Error('OpenCode Provider binding requires a managed server');
    }
    if (
      typeof params.env?.[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV] === 'string'
      && params.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV].trim().length > 0
    ) {
      throw new Error('OpenCode isolated authentication requires a managed server');
    }
    const managedServer = await params.ctx.managedServer.supervise({
      id: 'opencode-server',
      mode: {
        kind: 'external-attach',
        baseUrl: params.endpoint.baseUrl,
      },
      healthCheck: {
        kind: 'http',
        path: '/global/health',
        timeoutMs: 5_000,
      },
      watchdog: {
        intervalMs: 10_000,
        missedIntervals: 3,
      },
      startupTimeoutMs: 30_000,
      signal: params.signal,
    });
    try {
      const identity = readManagedServerIdentity(
        await managedServer.waitUntilHealthy({ timeoutMs: 30_000, signal: params.signal }),
      );
      return {
        ...identity,
        credential: null,
        managedServer,
      };
    } catch (error) {
      await disposeBestEffort(params.ctx, 'external managed server after startup failure', managedServer);
      throw error;
    }
  }

  const credential = createOpenCodeManagedServerCredential();
  const launchEnv = buildOpenCodeManagedLaunchEnvironment(
    params.env,
    params.permissionMode,
    params.providerConfigContent,
  );
  const launchFingerprintEnv = {
    ...launchEnv,
    ...(typeof params.env?.[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV] === 'string'
      ? {
          [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]:
            params.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV],
        }
      : {}),
    ...(typeof params.env?.[OPENCODE_BINARY_IDENTITY_ENV] === 'string'
      ? { [OPENCODE_BINARY_IDENTITY_ENV]: params.env[OPENCODE_BINARY_IDENTITY_ENV] }
      : {}),
    [credential.envKey]: credential.value,
  };
  const managedServer = await params.ctx.managedServer.supervise({
    id: 'opencode-server',
    mode: {
      kind: 'managed-spawn',
      host: '127.0.0.1',
      portArg: '--port',
      credential: {
        envKey: credential.envKey,
        value: credential.value,
        httpHeader: {
          name: 'authorization',
          value: credential.headers.authorization ?? '',
        },
      },
    },
    launch: {
      kind: 'agent-cli',
      agentId: 'opencode',
      args: [
        'serve',
        '--hostname',
        '127.0.0.1',
      ],
      cwd: params.directory,
      env: launchEnv,
    },
    healthCheck: {
      kind: 'http',
      path: '/global/health',
      timeoutMs: 5_000,
    },
    orphanReaper: {
      executablePath: readOpenCodeExecutablePath(launchEnv),
      commandIncludes: ['serve', '--hostname', '127.0.0.1'],
      initialSignal: 'SIGTERM',
      forceSignal: 'SIGKILL',
    },
    watchdog: {
      intervalMs: 10_000,
      missedIntervals: 3,
    },
    launchFingerprint: buildOpenCodeLaunchFingerprint(launchFingerprintEnv),
    startupTimeoutMs: 30_000,
    signal: params.signal,
    // Durable per-server log: tee post-spawn stdout/stderr to a secret-redacted log file for later
    // incident diagnosis. Handled generically by the host (shared with other managed-server
    // providers); the OpenCode plugin only opts in.
    durableLog: { enabled: true },
  });
  try {
    const identity = readManagedServerIdentity(
      await managedServer.waitUntilHealthy({ timeoutMs: 30_000, signal: params.signal }),
    );
    return {
      ...identity,
      credential,
      managedServer,
    };
  } catch (error) {
    await disposeBestEffort(params.ctx, 'managed server after startup failure', managedServer);
    throw error;
  }
}

export async function createOpenCodeServerRuntimeAssembly(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  directory: string;
  happierSessionId: string;
  endpoint: OpenCodeServerEndpoint;
  env?: Readonly<Record<string, string>>;
  permissionMode?: string | null;
  mcpServers?: unknown;
  request: AgentSessionOpenRequest;
  signal?: AbortSignal;
  models?: AgentSessionRuntimeContext['session']['services']['models'];
  bindActiveSkillsReader?: OpenCodeActiveSkillsReaderRegistrar;
}>): Promise<OpenCodeServerRuntimeAssembly> {
  let managedServer: OpenCodeManagedServerHandle | null = null;
  let managedServerEndpoint: Disposable | null = null;
  let disposed = false;
  try {
    const providerConfigContent = await readOpenCodeProviderConfigContent(params.request);
    const server = await resolveOpenCodeServer({
      ctx: params.ctx,
      directory: params.directory,
      endpoint: params.endpoint,
      env: params.env,
      providerConfigContent,
      permissionMode: params.permissionMode,
      signal: params.signal,
    });
    managedServer = server.managedServer;
    const transport = createOpenCodeServerTransport({
      baseUrl: server.baseUrl,
      instanceId: server.instanceId,
      ...(server.credential ? { headers: server.credential.headers } : {}),
      signal: params.signal ?? params.ctx.abort.signal,
      readManagedServerSnapshot: () => server.managedServer.snapshot(),
    });
    managedServerEndpoint = registerOpenCodeManagedServerEndpoint({
      baseUrl: server.baseUrl,
      credential: server.credential,
      transport,
    });
    const client = createOpenCodeServerClient({
      transport,
      directory: params.directory,
    });
    scheduleOpenCodeMcpServerRegistration({
      ctx: params.ctx,
      client,
      directory: params.directory,
      mcpServers: params.mcpServers,
    });
    const operations = createOpenCodeServerRuntime({
      ctx: params.ctx,
      directory: params.directory,
      happierSessionId: params.happierSessionId,
      baseUrl: server.baseUrl,
      client,
      env: params.env,
      readManagedServerSnapshot: () => managedServer?.snapshot() ?? null,
    });
    await operations.openSession(
      params.request.kind === 'create'
        ? { kind: 'create' }
        : params.request.kind === 'resume'
          ? {
              kind: 'resume',
              providerSessionId: params.request.providerSessionId,
            }
          : {
              kind: 'fork',
              source: {
                providerSessionId: params.request.source.providerSessionId,
                ...(params.request.source.target?.providerCheckpoint === undefined
                  ? {}
                  : {
                      providerCheckpoint:
                        params.request.source.target.providerCheckpoint,
                    }),
              },
            },
    );
    if (params.request.configuration) {
      await operations.updateSessionRuntimeConfig({
        modelId: params.request.configuration.model.value,
        permissionMode: params.request.configuration.permissionIntent.value,
        ...Object.fromEntries(
          Object.entries(params.request.configuration.options).map(
            ([key, value]) => [key, value.value],
          ),
        ),
      });
    }
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await operations.resetOrDisposeRuntime();
      await disposeBestEffort(params.ctx, 'managed server', managedServer);
      await disposeBestEffort(params.ctx, 'managed server endpoint', managedServerEndpoint);
    };
    const runtime = createOpenCodeSessionRuntime({
      operations,
      request: params.request,
      disposeOperations: dispose,
      ...(params.models ? { models: params.models } : {}),
      ...(params.bindActiveSkillsReader
        ? { bindActiveSkillsReader: params.bindActiveSkillsReader }
        : {}),
    });

    return {
      runtime,
      dispose,
    };
  } catch (error) {
    await disposeBestEffort(params.ctx, 'managed server', managedServer);
    await disposeBestEffort(params.ctx, 'managed server endpoint', managedServerEndpoint);
    throw error;
  }
}
