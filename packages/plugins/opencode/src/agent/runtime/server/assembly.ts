import { AGENT_DEFINITION } from '../../definition.js';
import type {
  AgentExecutionRunOpenRequest,
  AgentExecutionRunConversationRuntimeV1,
  AgentSessionOpenRequest,
  AgentSessionMcpService,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  ManagedServiceHandle,
  ManagedServiceSnapshot,
  ManagedServiceSpec,
} from '@happier-dev/plugin-sdk/managed-services';

import { asRecord } from './openCodeParsing.js';
import type { OpenCodeServerEndpoint } from './endpoint.js';
import {
  detectOpenCodeServerDialect,
  resolveRequestedOpenCodeServerDialect,
  usesOpenCodeConnectedServiceRequestAuth,
  type OpenCodeServerDialect,
} from './dialect.js';
import { resolveOpenCodeManagedServerDialect } from './managedServerDialect.js';
import { buildOpenCodeManagedServerAttachSpec } from './attachSpec.js';
import { buildOpenCodeManagedServerSpawnSpec } from './spawnSpec.js';
import { readOpenCodeProviderConfigPart } from '../../providerBinding/runtime.js';
import type { OpenCodeConfigPart } from './opencodeConfigContent.js';
import {
  buildOpenCodeSessionMcpProjection,
  readOpenCodeMcpToolNameBudget,
  disconnectOpenCodeMcpServers,
  scheduleOpenCodeMcpServerRegistration,
} from './mcpRegistration.js';
import { createOpenCodeServerClient } from './openCodeServerClient.js';
import { createOpenCodeServerTransport } from './transport.js';
import { createOpenCodeServerRuntime } from './runtime.js';
import { createOpenCodeSessionRuntime } from './sessionRuntime.js';
import { createOpenCodeExecutionRunConversation } from './executionRunRuntime.js';
import { projectOpenCodeSessionConfiguration } from './promptConfig.js';
import { buildOpenCodeAgentRuntimeDescriptorV1 } from '../../identity/runtimeDescriptor.js';
import {
  OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV,
} from './managedServerState.js';
import type { OpenCodeActiveSkillsReaderRegistrar } from '../controls.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import { OPEN_CODE_MANAGED_SERVER_STARTUP_TIMEOUT_MS } from './timeoutPolicy.js';
import {
  resolveOpenCodeSystemToolId,
  type OpenCodeSystemToolId,
} from '../../systemTool.js';

type Disposable = Readonly<{ dispose?: () => void | Promise<void> }>;

export type OpenCodeServerRuntimeAssembly<Runtime = AgentSessionRuntime | AgentExecutionRunConversationRuntimeV1> = Readonly<{
  runtime: Runtime;
  dispose(): Promise<void>;
}>;

type ResolvedOpenCodeServer = Readonly<{
  managedService: ManagedServiceHandle;
  observation: Disposable;
  readSnapshot(): ManagedServiceSnapshot;
  /**
   * The generation of the executable Happier spawned for this session, or
   * `null` for a server it only attached to. Readiness and request routing both
   * derive from this one fact, so they cannot disagree.
   */
  managedServerDialect: OpenCodeServerDialect | null;
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
  managedServerDialect: OpenCodeServerDialect | null;
}>): Promise<ResolvedOpenCodeServer> {
  let currentSnapshot = params.managedService.snapshot();
  const observation = params.managedService.observe((snapshot) => {
    currentSnapshot = snapshot;
  });
  try {
    currentSnapshot = await params.managedService.waitUntilHealthy({
      timeoutMs: OPEN_CODE_MANAGED_SERVER_STARTUP_TIMEOUT_MS,
      signal: params.signal,
    });
    return {
      managedService: params.managedService,
      observation,
      readSnapshot: () => currentSnapshot,
      managedServerDialect: params.managedServerDialect,
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
  providerConfigPart?: OpenCodeConfigPart;
  configParts?: readonly OpenCodeConfigPart[];
  permissionMode?: string | null;
  signal?: AbortSignal;
  systemToolId: OpenCodeSystemToolId;
  requestedDialect: ReturnType<typeof resolveRequestedOpenCodeServerDialect>;
  requestAuthRequested: boolean;
}>): Promise<ResolvedOpenCodeServer> {
  if (params.endpoint.mode === 'external-attach') {
    // Request-auth assets and their private capability are materialized for the owned child.
    // Never reinterpret them as configuration for a user-managed external server.
    if (params.requestAuthRequested) {
      throw new Error('OpenCode request authentication requires a managed server');
    }
    if (params.providerConfigPart !== undefined) {
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
      requestedDialect: params.requestedDialect,
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
      managedServerDialect: null,
    });
  }

  const managedServerResolution = await resolveOpenCodeManagedServerDialect({
    exec: params.ctx.exec,
    cwd: params.directory,
    logger: params.ctx.logger,
    systemToolId: params.systemToolId,
  });
  const spec: ManagedServiceSpec = buildOpenCodeManagedServerSpawnSpec({
    id: 'opencode-server',
    dialect: managedServerResolution.dialect,
    healthPath: managedServerResolution.healthPath,
    systemToolId: params.systemToolId,
    ...(params.env ? { env: params.env } : {}),
    ...(params.permissionMode === undefined
      ? {}
      : { permissionMode: params.permissionMode }),
    configParts: [
      ...(params.providerConfigPart === undefined ? [] : [params.providerConfigPart]),
      ...(params.configParts ?? []),
    ],
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
    managedServerDialect: managedServerResolution.dialect,
  });
}

type OpenCodeServerRuntimeAssemblyCommon = Readonly<{
  ctx: OpenCodeRuntimeContext;
  directory: string;
  endpoint: OpenCodeServerEndpoint;
  env?: Readonly<Record<string, string>>;
  configParts?: readonly OpenCodeConfigPart[];
  permissionMode?: string | null;
  mcpServers?: unknown;
  signal?: AbortSignal;
  mcpService?: AgentSessionMcpService;
  models?: AgentSessionRuntimeContext['session']['services']['models'];
  modes?: AgentSessionRuntimeContext['session']['services']['modes'];
  inputFiles?: NonNullable<AgentSessionRuntimeContext['session']['services']['inputFiles']>;
  bindActiveSkillsReader?: OpenCodeActiveSkillsReaderRegistrar;
}>;

type OpenCodeServerSessionRuntimeAssemblyParams = OpenCodeServerRuntimeAssemblyCommon & Readonly<{
      happierSessionId: string;
      executionRunId?: never;
      request: AgentSessionOpenRequest;
    }>;
type OpenCodeServerExecutionRunAssemblyParams = OpenCodeServerRuntimeAssemblyCommon & Readonly<{
      executionRunId: string;
      happierSessionId?: never;
      request: AgentExecutionRunOpenRequest;
    }>;
type OpenCodeServerRuntimeAssemblyParams =
  | OpenCodeServerSessionRuntimeAssemblyParams
  | OpenCodeServerExecutionRunAssemblyParams;

export function createOpenCodeServerRuntimeAssembly(
  params: OpenCodeServerSessionRuntimeAssemblyParams,
): Promise<OpenCodeServerRuntimeAssembly<AgentSessionRuntime>>;
export function createOpenCodeServerRuntimeAssembly(
  params: OpenCodeServerExecutionRunAssemblyParams,
): Promise<OpenCodeServerRuntimeAssembly<AgentExecutionRunConversationRuntimeV1>>;

export async function createOpenCodeServerRuntimeAssembly(
  params: OpenCodeServerRuntimeAssemblyParams,
): Promise<OpenCodeServerRuntimeAssembly> {
  const configuration = params.request.configuration;
  const noTools = configuration?.unlistedTools === 'deny' && configuration.allowedTools?.length === 0;
  if (noTools && params.endpoint.mode === 'external-attach') {
    throw new PluginError({ code: 'opencode_no_tools_requires_managed_server',
      message: 'A no-tools Run requires a managed OpenCode server to configure native tool availability.' });
  }
  // OpenCode filters the model's catalog using Agent permissions, not Session
  // approval rules. Use one launch-local native Agent whose last rule denies all
  // tools, including ambient MCP tools, and select it for every Run input.
  const noToolsAgentId = 'happier-no-tools';
  const runConfiguration = noTools && configuration
    ? { ...configuration, mode: { ...configuration.mode, value: noToolsAgentId } }
    : configuration;
  const configuredMcpServers = noTools ? undefined : params.mcpServers;
  let managedService: ManagedServiceHandle | null = null;
  let managedServiceObservation: Disposable | null = null;
  let disposed = false;
  try {
    const providerConfigPart = await readOpenCodeProviderConfigPart(params.request);
    const launchValues: Readonly<Record<string, unknown>> = {
      ...(params.ctx.config?.values ?? {}),
      ...(params.env ?? {}),
    };
    const systemToolId = resolveOpenCodeSystemToolId(
      params.request.configuration?.options.opencodeCliGeneration?.value,
    );
    const requestedDialect = resolveRequestedOpenCodeServerDialect({
      configuredGeneration: params.request.configuration?.options.opencodeCliGeneration?.value,
      values: launchValues,
      managedServerDialect: null,
    });
    const requestAuthRequested = usesOpenCodeConnectedServiceRequestAuth(launchValues);
    const server = await resolveOpenCodeServer({
      ctx: params.ctx,
      directory: params.directory,
      endpoint: params.endpoint,
      env: params.env,
      providerConfigPart,
      configParts: [
        ...(params.configParts ?? []),
        ...(noTools ? [{ default_agent: noToolsAgentId,
          agent: { [noToolsAgentId]: { mode: 'primary', permission: { '*': 'deny' } } } }] : []),
      ],
      permissionMode: params.permissionMode,
      signal: params.signal,
      systemToolId,
      requestedDialect,
      requestAuthRequested,
    });
    managedService = server.managedService;
    managedServiceObservation = server.observation;
    const transport = createOpenCodeServerTransport({
      managedService: server.managedService,
      signal: params.signal ?? params.ctx.abort.signal,
    });
    // One dialect decision per server, taken after the managed service is
    // healthy and before any operation runs, so every call in this session
    // agrees on which OpenCode surface it is talking to.
    const dialectDetection = server.managedServerDialect === null
      ? await detectOpenCodeServerDialect({
          fetch: transport.request,
          requested: requestedDialect,
        })
      : {
          dialect: server.managedServerDialect,
          requested: requestedDialect,
          probe: null,
        };
    params.ctx.logger.info('[OpenCodeServer] resolved OpenCode server dialect', {
      dialect: dialectDetection.dialect,
      requested: dialectDetection.requested,
      ...(dialectDetection.probe === null
        ? {}
        : {
            probePath: dialectDetection.probe.path,
            probeStatus: dialectDetection.probe.status,
            ...(dialectDetection.probe.error === undefined
              ? {}
              : { probeError: dialectDetection.probe.error }),
          }),
    });
    const client = createOpenCodeServerClient({
      transport,
      directory: params.directory,
      dialect: dialectDetection.dialect,
      signal: params.signal ?? params.ctx.abort.signal,
    });
    const initialProjection = buildOpenCodeSessionMcpProjection(
      params.executionRunId ?? params.happierSessionId, configuredMcpServers,
    );
    let mcpServers = configuredMcpServers;
    let toolAliasPrefix: string | undefined;
    // V2 has no registration route; retain its established unsupported capability path.
    if (dialectDetection.dialect !== 'v2' && params.mcpService?.resolveToolNaming) {
      const required = initialProjection.registrations.find(registration => registration.originalName === 'happier');
      if (required) {
        const naming = await params.mcpService.resolveToolNaming({ serverName: 'happier',
          toolNameMaxLength: readOpenCodeMcpToolNameBudget(required.projectedName) }, { signal: params.signal ?? params.ctx.abort.signal });
        if (naming) {
          mcpServers = { ...(asRecord(mcpServers) ?? {}), happier: naming.launchConfig };
          toolAliasPrefix = naming.aliasPrefix;
        }
      }
    }
    const mcpProjection = buildOpenCodeSessionMcpProjection(
      params.executionRunId ?? params.happierSessionId, mcpServers, params.mcpService?.resolveToolNaming, toolAliasPrefix,
    );
    const mcpRegistration = scheduleOpenCodeMcpServerRegistration({
      ctx: params.ctx,
      client,
      directory: params.directory,
      mcpProjection,
      configuration: noTools ? configuration : undefined,
    });
    const operations = createOpenCodeServerRuntime({
      ctx: params.ctx,
      directory: params.directory,
      ...(params.executionRunId === undefined
        ? { happierSessionId: params.happierSessionId }
        : { executionRunId: params.executionRunId }),
      client,
      env: params.env,
      permissionMode: params.permissionMode,
      dialect: dialectDetection.dialect,
      readManagedServiceSnapshot: () => server.readSnapshot(),
      mcpRegistration,
      mcpProjection,
      mcpToolPolicy: params.request.mcpToolPolicy,
    });
    await operations.openSession(params.executionRunId === undefined
      ? params.request.kind === 'create'
        ? { kind: 'create' }
        : params.request.kind === 'resume'
          ? { kind: 'resume', providerSessionId: params.request.providerSessionId }
          : {
              kind: 'fork',
              source: {
                providerSessionId: params.request.source.providerSessionId,
                ...(params.request.source.target?.providerCheckpoint === undefined
                  ? {}
                  : { providerCheckpoint: params.request.source.target.providerCheckpoint }),
              },
            }
      : params.request.kind === 'create'
        ? { kind: 'create' }
        : params.request.kind === 'resume'
          ? { kind: 'resume', providerSessionId: params.request.checkpointId }
          : params.request.checkpointId
            ? { kind: 'fork', source: { providerSessionId: params.request.checkpointId } }
            : (() => { throw new Error('OpenCode execution-run fork requires a provider checkpoint'); })());
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await operations.resetOrDisposeRuntime();
      await disconnectOpenCodeMcpServers({ ctx: params.ctx, client, registration: mcpRegistration });
      await disposeBestEffort(params.ctx, 'managed service observation', managedServiceObservation);
      await disposeBestEffort(params.ctx, 'managed service', managedService);
    };
    const runtime = params.executionRunId === undefined
      ? createOpenCodeSessionRuntime({
          operations,
          request: params.request,
          disposeOperations: dispose,
          runtimeCapabilities: {
            sessionCapabilities: AGENT_DEFINITION.core.sessionCapabilities,
            tools: { delivery: 'native_mcp', support: 'supported' },
          },
          prepareTerminalPresentation: async () => {
            const providerSessionId = operations.readSessionIdentity().sessionId;
            if (!providerSessionId) {
              throw new Error('OpenCode provider session identity is unavailable for local CLI attach');
            }
            return {
              kind: 'provider_attach' as const,
              metadata: {
                path: params.directory,
                runtimeDescriptorV1: buildOpenCodeAgentRuntimeDescriptorV1({
                  backendMode: 'server',
                  providerSessionId,
                }),
              },
            };
          },
          ...(params.models ? { models: params.models } : {}),
          ...(params.modes ? { modes: params.modes } : {}),
          ...(params.inputFiles ? { inputFiles: params.inputFiles } : {}),
          ...(params.bindActiveSkillsReader
            ? { bindActiveSkillsReader: params.bindActiveSkillsReader }
            : {}),
        })
      : createOpenCodeExecutionRunConversation({
          operations,
          executionRunId: params.executionRunId,
          disposeOperations: dispose,
        });

    // Bind the observed catalogs before applying requested configuration. The
    // host needs that evidence to classify a pre-input startup refusal even
    // when configuration prevents this open from returning its Session.
    try {
      if (runConfiguration) {
        const projection = projectOpenCodeSessionConfiguration(runConfiguration);
        for (const update of projection.updates) {
          await operations.updateSessionRuntimeConfig(update);
        }
      }
    } catch (error) {
      await disposeBestEffort(params.ctx, 'runtime after configuration refusal', runtime);
      throw error;
    }

    return {
      runtime: { ...runtime, ...(params.request.skills ? { skillsDelivered: false } : {}) },
      dispose,
    };
  } catch (error) {
    await disposeBestEffort(params.ctx, 'managed service observation', managedServiceObservation);
    await disposeBestEffort(params.ctx, 'managed service', managedService);
    throw error;
  }
}
