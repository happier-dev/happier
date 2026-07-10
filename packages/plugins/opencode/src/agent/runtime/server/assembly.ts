import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import type { ManagedServerHandleV1, PluginContextV1, SessionRuntimeV1 } from '@happier-dev/plugin-sdk';

import type { OpenCodeServerCredential, OpenCodeServerEndpoint } from './endpoint.js';
import {
  createOpenCodeManagedServerCredential,
  registerOpenCodeManagedServerCredential,
} from './endpoint.js';
import { buildOpenCodePermissionEnv } from '../../permissions/policy.js';
import {
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
  OPEN_CODE_BROKER_PROVIDERS,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  parseOpenCodeBrokerSelections,
  prepareOpenCodeBrokerForConnectedSession,
  verifyOpenCodeBrokerLoadHandshakeForConnectedSession,
} from '../../auth/services/broker/index.js';
import { scheduleOpenCodeMcpServerRegistration } from './mcpRegistration.js';
import { createOpenCodeServerClient } from './openCodeServerClient.js';
import { createOpenCodeServerRuntime } from './runtime.js';
import { createOpenCodePublicSessionRuntime } from './sessionRuntime.js';
import { createOpenCodeTranscriptSourceDefinition } from './transcript/source.js';
import { resolveOpenCodeManagedServerStateFingerprintInput } from './managedServerState.js';

type Disposable = Readonly<{ dispose?: () => void | Promise<void> }>;

export type OpenCodeServerRuntimeAssembly = Readonly<{
  runtime: SessionRuntimeV1;
  dispose(): Promise<void>;
}>;

type ResolvedOpenCodeServer = Readonly<{
  baseUrl: string;
  credential: OpenCodeServerCredential | null;
  managedServer: ManagedServerHandleV1 | null;
}>;

async function disposeBestEffort(ctx: PluginContextV1, label: string, disposable: Disposable | null): Promise<void> {
  if (typeof disposable?.dispose !== 'function') return;
  await Promise.resolve(disposable.dispose()).catch((error: unknown) => {
    ctx.logger.debug(`[OpenCodeServer] failed to dispose ${label}`, { error });
  });
}

async function ensureExternalServerHealthy(params: Readonly<{
  ctx: PluginContextV1;
  baseUrl: string;
  signal?: AbortSignal;
}>): Promise<void> {
  const response = await params.ctx.fetch({
    url: `${params.baseUrl.replace(/\/+$/u, '')}/global/health`,
    method: 'GET',
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`OpenCode external server health check failed: ${response.status} ${response.statusText ?? ''}`.trim());
  }
}

function readManagedBaseUrl(handle: ManagedServerHandleV1): string {
  const baseUrl = handle.snapshot().baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new Error('OpenCode managed server did not report a resolved base URL');
  }
  return baseUrl.replace(/\/+$/u, '');
}

function withOpenCodeBrokerLoadNonceForSpawn(env: Readonly<Record<string, string>>): Record<string, string> {
  const next = { ...env };
  const selections = parseOpenCodeBrokerSelections(next[OPEN_CODE_BROKER_SELECTIONS_ENV]);
  const hasBrokeredProvider = OPEN_CODE_BROKER_PROVIDERS.some((provider) => selections[provider]);
  if (hasBrokeredProvider) {
    next[OPEN_CODE_BROKER_LOAD_NONCE_ENV] = randomUUID();
  }
  return next;
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

async function resolveOpenCodeServer(params: Readonly<{
  ctx: PluginContextV1;
  directory: string;
  endpoint: OpenCodeServerEndpoint;
  env?: Readonly<Record<string, string>>;
  permissionMode?: string | null;
  signal?: AbortSignal;
}>): Promise<ResolvedOpenCodeServer> {
  if (params.endpoint.mode === 'external-attach') {
    await ensureExternalServerHealthy({
      ctx: params.ctx,
      baseUrl: params.endpoint.baseUrl,
      signal: params.signal,
    });
    return {
      baseUrl: params.endpoint.baseUrl,
      credential: null,
      managedServer: null,
    };
  }

  // Connected sessions auth via the Happier broker plugin: write its `.js` assets into the isolated
  // config home the materializer redirected `XDG_CONFIG_HOME` to, then fail-closed preflight. No-op for
  // native + direct-API-key sessions. The broker marker is itself non-functional without the plugin,
  // so a failed preparation must fail the session rather than silently fall back to native/upstream auth.
  const brokerEnv = withOpenCodeBrokerLoadNonceForSpawn(params.env ?? {});
  const brokerPreparation = await prepareOpenCodeBrokerForConnectedSession(brokerEnv);
  if (!brokerPreparation.ready) {
    throw new Error(`OpenCode connected-service broker not ready: ${brokerPreparation.reason}`);
  }

  const credential = createOpenCodeManagedServerCredential();
  const launchEnv = {
    ...brokerEnv,
    ...buildOpenCodePermissionEnv(params.permissionMode),
  };
  const launchFingerprintEnv = {
    ...launchEnv,
    [credential.envKey]: credential.value,
  };
  const managedServer = await params.ctx.managedServer.supervise({
    id: 'opencode-server',
    mode: {
      kind: 'managed-spawn',
      host: '127.0.0.1',
      portArg: '--port',
      baseUrlEnvKey: 'HAPPIER_OPENCODE_SERVER_URL',
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
  await managedServer.waitUntilHealthy({ timeoutMs: 30_000, signal: params.signal });
  // F4: now that the server is healthy, confirm the broker plugin actually LOADED (it pings the daemon on
  // activation). This is the POST-spawn half of the fail-closed gate — the pre-spawn `prepare` above only
  // proves the assets are on disk. No-op for native + direct-API-key sessions. A present-but-not-loaded
  // plugin must fail the session rather than silently fall back to native/upstream auth.
  const brokerLoadHandshake = await verifyOpenCodeBrokerLoadHandshakeForConnectedSession(brokerEnv);
  if (!brokerLoadHandshake.ready) {
    throw new Error(`OpenCode connected-service broker not loaded: ${brokerLoadHandshake.reason}`);
  }
  return {
    baseUrl: readManagedBaseUrl(managedServer),
    credential,
    managedServer,
  };
}

export async function createOpenCodeServerRuntimeAssembly(params: Readonly<{
  ctx: PluginContextV1;
  directory: string;
  happierSessionId: string;
  endpoint: OpenCodeServerEndpoint;
  env?: Readonly<Record<string, string>>;
  permissionMode?: string | null;
  mcpServers?: unknown;
  setThinking?: (thinking: boolean) => void;
  resumeSessionId?: string | null;
  signal?: AbortSignal;
}>): Promise<OpenCodeServerRuntimeAssembly> {
  let managedServer: ManagedServerHandleV1 | null = null;
  let managedServerCredential: Disposable | null = null;
  let transcriptSource: Disposable | null = null;
  let disposed = false;
  try {
    const server = await resolveOpenCodeServer({
      ctx: params.ctx,
      directory: params.directory,
      endpoint: params.endpoint,
      env: params.env,
      permissionMode: params.permissionMode,
      signal: params.signal,
    });
    managedServer = server.managedServer;
    managedServerCredential = server.credential
      ? registerOpenCodeManagedServerCredential({
        baseUrl: server.baseUrl,
        credential: server.credential,
      })
      : null;
    const client = createOpenCodeServerClient({
      fetch: params.ctx.fetch,
      baseUrl: server.baseUrl,
      directory: params.directory,
      ...(server.credential ? { headers: server.credential.headers } : {}),
    });
    scheduleOpenCodeMcpServerRegistration({
      ctx: params.ctx,
      client,
      directory: params.directory,
      happierSessionId: params.happierSessionId,
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
      setThinking: params.setThinking,
    });
    await operations.startOrLoadSession({
      ...(params.resumeSessionId ? { resumeId: params.resumeSessionId } : {}),
    });
    const runtime = createOpenCodePublicSessionRuntime(operations);
    transcriptSource = await params.ctx.agentRuntime.transcripts.defineSource({
      ...createOpenCodeTranscriptSourceDefinition({
        id: `opencode:${params.happierSessionId}:http-sse`,
        client: {
          mcpAdd: async () => undefined,
          sessionCreate: async () => {
            throw new Error('Transcript source does not create OpenCode sessions.');
          },
          sessionPromptAsync: async () => undefined,
          sessionAbort: async () => undefined,
          sessionStatus: async () => ({}),
          sessionMessages: async ({ sessionId }) => {
            const identity = operations.readSessionIdentity().sessionId;
            if (!identity || identity !== sessionId) return [];
            return await client.sessionMessages({ sessionId });
          },
          sessionTodo: async () => [],
          permissionReply: async () => undefined,
          appSkills: async () => [],
          subscribeGlobalEvents: async () => undefined,
          globalConfigGet: async () => ({}),
          providersList: async () => [],
        },
        readProviderSessionId: () => operations.readSessionIdentity().sessionId,
        isHappierAuthoredProviderUserMessageId: (messageId) =>
          operations.isHappierAuthoredProviderUserMessageId(messageId),
      }),
    });

    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await operations.resetOrDisposeRuntime();
      await disposeBestEffort(params.ctx, 'transcript source', transcriptSource);
      await disposeBestEffort(params.ctx, 'managed server', managedServer);
      await disposeBestEffort(params.ctx, 'managed server credential', managedServerCredential);
    };

    return {
      runtime: {
        ...runtime,
        dispose,
      },
      dispose,
    };
  } catch (error) {
    await disposeBestEffort(params.ctx, 'transcript source', transcriptSource);
    await disposeBestEffort(params.ctx, 'managed server', managedServer);
    await disposeBestEffort(params.ctx, 'managed server credential', managedServerCredential);
    throw error;
  }
}
