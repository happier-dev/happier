import type { McpServerConfig } from '@/agent';
import { applyAcpRuntimeSessionModel } from '@/agent/acp/runtime/sessionControls/applySessionControls';
import { createCatalogProviderExecutionRunBackend } from '@/agent/runtime/bridges/executionRun/runtime/catalog';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { Credentials } from '@/persistence';
import { createConfiguredAcpBackend } from './createConfiguredAcpBackend';
import { materializeConfiguredAcpEnvironment } from './materializeEnvironment';
import {
  normalizeConfiguredAcpDefinition,
  type AcpRuntimeDefinitionV1,
} from '@/agent/acp/runtime/definition';
import {
  resolveConfiguredAcpBackendFromAccountSettingsOrPlugins,
  type ResolvedConfiguredAcpBackend,
} from './resolveBackend';

export type ConfiguredAcpRuntimeOwner = Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  definition: AcpRuntimeDefinitionV1;
  providerId: string;
  loggerLabel: string;
  launchEnv: Readonly<Record<string, string>>;
  createBackend: (params: Readonly<{
    cwd: string;
    env?: NodeJS.ProcessEnv;
    mcpServers: Record<string, McpServerConfig>;
    permissionHandler: Parameters<typeof createConfiguredAcpBackend>[0]['permissionHandler'];
    permissionMode?: string;
  }>) => ReturnType<typeof createConfiguredAcpBackend>;
  createExecutionRunBackend: (params: CreateCliExecutionRunBackendParams & Readonly<{
    mcpServers: Record<string, McpServerConfig>;
  }>) => ReturnType<typeof createCatalogProviderExecutionRunBackend>;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function withConfiguredExecutionRunSelectedModel(params: Readonly<{
  runtime: ReturnType<typeof createConfiguredAcpBackend>;
  providerId: string;
  selectedModelId: string | null;
}>): ReturnType<typeof createConfiguredAcpBackend> {
  if (!params.selectedModelId) {
    return params.runtime;
  }

  const selectedModelId = params.selectedModelId;
  const provisionSession = params.runtime.provisionSession.bind(params.runtime);
  params.runtime.provisionSession = async (...args) => {
    const started = await provisionSession(...args);
    await applyAcpRuntimeSessionModel({
      provider: params.providerId,
      getSessionId: () => started.sessionId,
      ensureBackend: async () => ({
        setSessionModel: params.runtime.setSessionModel.bind(params.runtime),
      }),
    }, selectedModelId);
    return started;
  };
  return params.runtime;
}

export async function resolveConfiguredAcpRuntimeOwner(params: Readonly<{
  credentials: Credentials;
  accountSettings: Readonly<Record<string, unknown>>;
  backendId: string;
  happyHomeDir?: string;
}>): Promise<ConfiguredAcpRuntimeOwner> {
  const backend = await resolveConfiguredAcpBackendFromAccountSettingsOrPlugins({
    settings: params.accountSettings,
    backendId: params.backendId,
    happyHomeDir: params.happyHomeDir,
  });
  if (!backend) {
    throw new Error(`Configured ACP backend not found: ${params.backendId}`);
  }

  const launchEnv = materializeConfiguredAcpEnvironment({
    backend,
    accountSettings: params.accountSettings,
    credentials: params.credentials,
  });
  const definition = normalizeConfiguredAcpDefinition({
    backend,
    launchEnv,
  });
  const providerId = `acp:${backend.backendId}`;
  const loggerLabel = `${backend.title}ACP`;
  const createBackend: ConfiguredAcpRuntimeOwner['createBackend'] = ({
    cwd,
    env,
    mcpServers,
    permissionHandler,
    permissionMode,
  }) => createConfiguredAcpBackend({
    cwd,
    env,
    definition,
    launchEnv,
    mcpServers,
    permissionHandler,
    ...(permissionMode ? { permissionMode } : {}),
  });

  return {
    backend,
    definition,
    providerId,
    loggerLabel,
    launchEnv,
    createBackend,
    createExecutionRunBackend: (opts) => createCatalogProviderExecutionRunBackend({
      providerId,
      createRuntime: ({ cwd, env, permissionMode, permissionHandler }) => {
        const runtime = createBackend({
          cwd,
          env,
          mcpServers: opts.mcpServers,
          permissionHandler,
          permissionMode,
        });
        return withConfiguredExecutionRunSelectedModel({
          runtime,
          providerId,
          selectedModelId: normalizeNonEmptyString(opts.modelId) ?? normalizeNonEmptyString(backend.defaultModel),
        });
      },
      buildRuntimeDescriptor: () => ({
        backendId: backend.backendId,
        runtimeKind: 'acp',
      }),
      runtimeCapabilities: {
        executionRun: { supported: true },
      },
    }, opts),
  };
}
