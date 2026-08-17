import type {
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  ManagedServiceHandle,
  ManagedServiceSnapshot,
  ManagedServiceSpec,
} from '@happier-dev/plugin-sdk/managed-services';

import type { OpenCodeServerEndpoint } from './endpoint.js';
import { buildOpenCodeManagedServerAttachSpec } from './attachSpec.js';
import { buildOpenCodeManagedServerSpawnSpec } from './spawnSpec.js';
import { readOpenCodeProviderConfigContent } from '../../providerBinding/runtime.js';
import { scheduleOpenCodeMcpServerRegistration } from './mcpRegistration.js';
import { createOpenCodeServerClient } from './openCodeServerClient.js';
import { createOpenCodeServerTransport } from './transport.js';
import { createOpenCodeServerRuntime } from './runtime.js';
import { createOpenCodeSessionRuntime } from './sessionRuntime.js';
import {
  OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV,
} from './managedServerState.js';
import type { OpenCodeActiveSkillsReaderRegistrar } from '../controls.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';

type Disposable = Readonly<{ dispose?: () => void | Promise<void> }>;

export type OpenCodeServerRuntimeAssembly = Readonly<{
  runtime: AgentSessionRuntime;
  dispose(): Promise<void>;
}>;

type ResolvedOpenCodeServer = Readonly<{
  managedService: ManagedServiceHandle;
  observation: Disposable;
  readSnapshot(): ManagedServiceSnapshot;
}>;

async function disposeBestEffort(ctx: OpenCodeRuntimeContext, label: string, disposable: Disposable | null): Promise<void> {
  if (typeof disposable?.dispose !== 'function') return;
  await Promise.resolve(disposable.dispose()).catch((error: unknown) => {
    ctx.logger.debug(`[OpenCodeServer] failed to dispose ${label}`, { error });
  });
}

async function observeHealthyManagedService(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  managedService: ManagedServiceHandle;
  signal?: AbortSignal;
  failureLabel: string;
}>): Promise<ResolvedOpenCodeServer> {
  let currentSnapshot = params.managedService.snapshot();
  const observation = params.managedService.observe((snapshot) => {
    currentSnapshot = snapshot;
  });
  try {
    currentSnapshot = await params.managedService.waitUntilHealthy({
      timeoutMs: 30_000,
      signal: params.signal,
    });
    return {
      managedService: params.managedService,
      observation,
      readSnapshot: () => currentSnapshot,
    };
  } catch (error) {
    await disposeBestEffort(params.ctx, `${params.failureLabel} observation`, observation);
    await disposeBestEffort(params.ctx, params.failureLabel, params.managedService);
    throw error;
  }
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
    const spec: ManagedServiceSpec = buildOpenCodeManagedServerAttachSpec({
      id: 'opencode-server',
      baseUrl: params.endpoint.baseUrl,
    });
    const managedService = await params.ctx.managedServices.supervise(
      spec,
      { signal: params.signal ?? params.ctx.abort.signal },
    );
    return await observeHealthyManagedService({
      ctx: params.ctx,
      managedService,
      signal: params.signal,
      failureLabel: 'external managed server after startup failure',
    });
  }

  const spec: ManagedServiceSpec = buildOpenCodeManagedServerSpawnSpec({
    id: 'opencode-server',
    ...(params.env ? { env: params.env } : {}),
    ...(params.permissionMode === undefined
      ? {}
      : { permissionMode: params.permissionMode }),
    ...(params.providerConfigContent === undefined
      ? {}
      : { providerConfigContent: params.providerConfigContent }),
  });
  const managedService = await params.ctx.managedServices.supervise(
    spec,
    { signal: params.signal ?? params.ctx.abort.signal },
  );
  return await observeHealthyManagedService({
    ctx: params.ctx,
    managedService,
    signal: params.signal,
    failureLabel: 'managed server after startup failure',
  });
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
  let managedService: ManagedServiceHandle | null = null;
  let managedServiceObservation: Disposable | null = null;
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
    managedService = server.managedService;
    managedServiceObservation = server.observation;
    const transport = createOpenCodeServerTransport({
      managedService: server.managedService,
      signal: params.signal ?? params.ctx.abort.signal,
    });
    const client = createOpenCodeServerClient({
      transport,
      directory: params.directory,
    });
    const mcpRegistration = scheduleOpenCodeMcpServerRegistration({
      ctx: params.ctx,
      client,
      directory: params.directory,
      mcpServers: params.mcpServers,
    });
    const operations = createOpenCodeServerRuntime({
      ctx: params.ctx,
      directory: params.directory,
      happierSessionId: params.happierSessionId,
      client,
      env: params.env,
      readManagedServiceSnapshot: () => server.readSnapshot(),
      mcpRegistration,
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
      await disposeBestEffort(params.ctx, 'managed service observation', managedServiceObservation);
      await disposeBestEffort(params.ctx, 'managed service', managedService);
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
    await disposeBestEffort(params.ctx, 'managed service observation', managedServiceObservation);
    await disposeBestEffort(params.ctx, 'managed service', managedService);
    throw error;
  }
}
