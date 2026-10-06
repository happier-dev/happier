import { readStoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readAcpCatalogSettingsFromAccountSettings } from '@/agent/acp/catalog/readAcpCatalogSettingsFromAccountSettings';
import { materializeConfiguredAcpEnvironment } from '@/agent/acp/catalog/configured/materializeEnvironment';
import { resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import {
  normalizeConfiguredAcpDefinition,
  resolveAcpRuntimeLaunch,
} from '@/agent/acp/runtime/definition';
import type {
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntimeContextV1,
  AgentAcpRuntimeOptions,
  AgentRuntime,
  AgentSessionOpenRequest,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import {
  createEmptyBackendExecutionSurfaces,
  type EngineAdapterResolution,
  type EngineResolutionAgent,
  type EngineResolutionBackend,
} from '../engineRegistryTypes';

const ACCOUNT_CONFIGURED_ACP_SOURCE = Object.freeze({ kind: 'configured' as const });

export async function resolveAccountConfiguredAcpBackend(
  backendId: string,
): Promise<EngineAdapterResolution | null> {
  const accountSnapshot = getActiveAccountSettingsSnapshot();
  if (!accountSnapshot) {
    return null;
  }
  const settings = accountSnapshot.settings;

  const catalogSettings = readAcpCatalogSettingsFromAccountSettings(settings);
  if (!catalogSettings.backends.some((backend) => backend.id === backendId)) {
    return null;
  }

  const credentials = await readStoredCredentials();
  if (!credentials) {
    throw new Error('Account-configured ACP backends require credentials to resolve launch environment');
  }

  const configuredBackend = resolveConfiguredAcpBackendFromAccountSettings(settings, backendId);
  if (!configuredBackend) {
    return null;
  }
  const launchEnv = materializeConfiguredAcpEnvironment({
    backend: configuredBackend,
    accountSettings: settings,
    credentials,
    savedSecretResources: accountSnapshot.savedSecretResources,
  });
  const definition = normalizeConfiguredAcpDefinition({
    backend: configuredBackend,
    launchEnv,
  });
  const agentId = `acp:${configuredBackend.backendId}`;
  const backend: EngineResolutionBackend = Object.freeze({
    id: configuredBackend.backendId,
    agentId,
    provenance: 'configured',
    source: ACCOUNT_CONFIGURED_ACP_SOURCE,
    definition: Object.freeze({
      kindVersion: 1,
      id: configuredBackend.backendId,
      agentId,
    }),
    runtimeKind: 'acp',
    surfaceHandlers: Object.freeze([]),
  });
  const agent: EngineResolutionAgent = Object.freeze({
    id: agentId,
    provenance: 'configured',
    source: ACCOUNT_CONFIGURED_ACP_SOURCE,
    definition: Object.freeze({
      kindVersion: 1,
      id: agentId,
      ownedBackendIds: Object.freeze([configuredBackend.backendId]),
    }),
    runtimeSpec: null,
  });
  const runtimeOwner = Object.freeze({
    backendId: configuredBackend.backendId,
    selected: Object.freeze({
      kind: 'host_configured' as const,
      ownerId: configuredBackend.backendId,
      provenance: 'configured' as const,
    }),
    candidates: Object.freeze([Object.freeze({
      kind: 'host_configured' as const,
      ownerId: configuredBackend.backendId,
      provenance: 'configured' as const,
    })]),
  });
  const runtimeOptions: AgentAcpRuntimeOptions = Object.freeze({
    // Account-configured executable custody is resolved by the host below. The
    // canonical ACP composer still requires a strict declarative transport, but
    // never resolves this sentinel through plugin exec services.
    transport: Object.freeze({
      kind: 'stdio' as const,
      executable: Object.freeze({
        kind: 'systemTool' as const,
        id: 'account-configured-acp',
      }),
    }),
    definition: Object.freeze({
      mcp: definition.mcp,
    }),
  });
  const runtime: AgentRuntime = Object.freeze({
    sessions: Object.freeze({
      async open(request: AgentSessionOpenRequest, context: AgentSessionRuntimeContext) {
        return await context.protocols.acp.open(request, runtimeOptions);
      },
      executionRunContextV1: Object.freeze({
        async open(
          request: AgentExecutionRunOpenRequest,
          context: AgentExecutionRunRuntimeContextV1,
        ) {
          return await context.protocols.acp.openExecutionRunV1(request, runtimeOptions);
        },
      }),
    }),
  });
  const sessionCapabilities: AgentSessionCapabilities = {
    open: [
      'create',
      ...(configuredBackend.capabilities.supportsLoadSession
        ? ['resume' as const]
        : []),
    ],
    delivery: ['newTurn', 'steer', 'followUp'],
    cancel: true,
    configuration: true,
    executionRunContext: { versions: [1] },
  };
  const { resolveBackendRuntimeCore } = await import('./runtimeCore');
  const engineAdapter = await resolveBackendRuntimeCore({
    backend,
    agent,
    executionSurfaces: createEmptyBackendExecutionSurfaces(),
    runtimeOwner,
    runtimeRegistry: null,
    nativeAgentRuntime: runtime,
    nativeAgentRuntimeIdentity: Object.freeze({
      pluginId: 'happier.host.configured-acp',
      pluginVersion: '0.0.0',
      agentId,
      localAgentId: configuredBackend.backendId,
      occurrenceId: `account-configured:${configuredBackend.backendId}:${accountSnapshot.settingsVersion}`,
      isCurrent: () => {
        const currentSnapshot = getActiveAccountSettingsSnapshot();
        return currentSnapshot?.settingsVersion === accountSnapshot.settingsVersion
          && resolveConfiguredAcpBackendFromAccountSettings(
            currentSnapshot.settings,
            configuredBackend.backendId,
          ) !== null;
      },
    }),
    nativeAgentPolicyAgentId: configuredBackend.backendId,
    nativeAgentSessionProjection: Object.freeze({
      flavor: `acp:${configuredBackend.backendId}`,
      agentMessageType: `acp:${configuredBackend.backendId}`,
      augmentSessionMetadata: (metadata) => ({
        ...metadata,
        flavor: `acp:${configuredBackend.backendId}`,
        ...buildConfiguredAcpBackendSessionMetadata({
          backendId: configuredBackend.backendId,
          title: configuredBackend.title,
        }),
      }),
    }),
    nativeAgentSessionCapabilities: sessionCapabilities,
    resolveNativeAgentAcpHostLaunch: async (request) => {
      const launch = await resolveAcpRuntimeLaunch({
        definition,
        cwd: request.cwd,
      });
      return Object.freeze({
        command: launch.command,
        args: Object.freeze([...launch.args]),
        env: Object.freeze({ ...launch.env }),
        unsetEnv: Object.freeze([]),
        timeouts: Object.freeze({
          ...(typeof definition.timeouts?.initMs === 'number'
            ? { initializeMs: definition.timeouts.initMs }
            : {}),
          ...(typeof definition.timeouts?.idleMs === 'number'
            ? { idleMs: definition.timeouts.idleMs }
            : {}),
          ...(typeof definition.timeouts?.toolCallMs === 'number'
            ? { toolCallMs: definition.timeouts.toolCallMs }
            : {}),
        }),
      });
    },
  });
  if (!engineAdapter) {
    throw new Error(`Account-configured ACP backend '${configuredBackend.backendId}' has no canonical runtime owner`);
  }

  return Object.freeze({
    backendId: configuredBackend.backendId,
    agentId,
    provenance: 'configured',
    selectedSource: 'configured',
    runtimeOwner,
    backend,
    agent,
    engineAdapter,
    executionSurfaces: createEmptyBackendExecutionSurfaces(),
    diagnostics: Object.freeze([]),
  });
}
