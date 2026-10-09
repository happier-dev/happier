import { readStoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import {
  refreshSavedSecretCatalogForOperation,
  SavedSecretOperationAdmissionError,
  savedSecretOperationAdmissionStatus,
  type SavedSecretOperationContextV1,
} from '@/settings/secrets/hydrateSavedSecretCatalog';
import { SavedSecretResolutionError } from '@/settings/secrets/savedSecretCatalog';
import { refreshActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { materializeConfiguredAcpEnvironment } from '@/agent/acp/catalog/configured/materializeEnvironment';
import { AcpCatalogUnavailableError, requireReadyAcpCatalog, resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import { normalizeConfiguredAcpDefinition } from '@/agent/acp/runtime/definition/configured';
import { resolveAcpRuntimeLaunch } from '@/agent/acp/runtime/definition/launch';
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
  savedSecretOperationContext?: SavedSecretOperationContextV1,
): Promise<EngineAdapterResolution | null> {
  const readSnapshot = () => savedSecretOperationContext ? savedSecretOperationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  let accountSnapshot = readSnapshot();
  if (!accountSnapshot?.scopeKey || accountSnapshot.source === 'none') throw new AcpCatalogUnavailableError('account-settings-unavailable');
  const scopeKey = accountSnapshot.scopeKey;
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const assertAccountCurrent = async () => {
    if (savedSecretOperationContext && !await savedSecretOperationContext.isCurrent()
      || readSnapshot()?.scopeKey !== scopeKey || !savedSecretOperationContext && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
      throw new AcpCatalogUnavailableError('scope-retired');
    }
  };
  const credentials = savedSecretOperationContext?.credentials ?? await readStoredCredentials();
  await assertAccountCurrent();
  const credentialScope = credentials && (savedSecretOperationContext
    ? runWithServerHttpBaseUrl(savedSecretOperationContext.serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(credentials))
    : resolveAccountSettingsScopeKey(credentials));
  if (!credentials || credentialScope !== scopeKey) throw new AcpCatalogUnavailableError('credentials-unavailable');
  if (accountSnapshot.acpCatalog?.status !== 'ready') await refreshActiveAcpCatalog({ credentials, operationContext: savedSecretOperationContext });
  await assertAccountCurrent();
  accountSnapshot = readSnapshot()!;
  if (accountSnapshot.source === 'none') throw new AcpCatalogUnavailableError('account-settings-unavailable');
  const catalog = requireReadyAcpCatalog(accountSnapshot.acpCatalog);
  const settings = accountSnapshot.settings;
  const configuredBackend = resolveConfiguredAcpBackendFromAccountSettings(settings, backendId, catalog);
  if (!configuredBackend) {
    return null;
  }
  const definition = normalizeConfiguredAcpDefinition({
    backend: configuredBackend,
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
      ...(definition.stderrRules ? { stderrRules: definition.stderrRules } : {}),
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
      occurrenceId: `account-configured:${configuredBackend.backendId}:${scopeKey}:${savedSecretOperationContext ? 'invocation' : lifetimeToken}:${catalog.revision}:${catalog.revision === 'absent' ? catalog.sourceSettingsVersion : ''}`,
      isCurrent: () => {
        const currentSnapshot = readSnapshot();
        return currentSnapshot?.scopeKey === scopeKey && (savedSecretOperationContext !== undefined || getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken)
          && currentSnapshot.acpCatalog === catalog && currentSnapshot.source !== 'none';
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
      await assertAccountCurrent();
      if (readSnapshot()?.acpCatalog !== catalog) throw new AcpCatalogUnavailableError('catalog-stale');
      const references = Object.values(configuredBackend.env)
        .flatMap(value => value.t === 'savedSecret' ? [{ ref: value.secretId }] : []);
      if (references.length > 0) {
        try {
          const refresh = () => refreshSavedSecretCatalogForOperation({
            expectedScopeKey: scopeKey,
            references,
            operationContext: savedSecretOperationContext,
          });
          await (savedSecretOperationContext
            ? runWithServerHttpBaseUrl(savedSecretOperationContext.serverHttpBaseUrl, refresh)
            : refresh());
        } catch (error) {
          if (!(error instanceof SavedSecretOperationAdmissionError)) throw error;
          const field = Object.entries(configuredBackend.env)
            .find(([, value]) => value.t === 'savedSecret' && value.secretId === error.reference)?.[0];
          throw new SavedSecretResolutionError({
            status: savedSecretOperationAdmissionStatus(error.reason),
            reference: error.reference,
            consumer: 'acp',
            field: `env:${field ?? error.reference}`,
          });
        }
      }
      await assertAccountCurrent();
      const launchSnapshot = readSnapshot();
      if (launchSnapshot?.acpCatalog !== catalog) throw new AcpCatalogUnavailableError('catalog-stale');
      const launchDefinition = normalizeConfiguredAcpDefinition({
        backend: configuredBackend,
        launchEnv: materializeConfiguredAcpEnvironment({
          backend: configuredBackend,
          accountSettings: launchSnapshot.settings,
          credentials,
          savedSecretResources: launchSnapshot.savedSecretResources,
        }),
      });
      const launch = await resolveAcpRuntimeLaunch({
        definition: launchDefinition,
        cwd: request.cwd,
      });
      await assertAccountCurrent();
      if (readSnapshot()?.acpCatalog !== catalog) throw new AcpCatalogUnavailableError('catalog-stale');
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
  await assertAccountCurrent();
  if (readSnapshot()?.acpCatalog !== catalog) throw new AcpCatalogUnavailableError('catalog-stale');

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
