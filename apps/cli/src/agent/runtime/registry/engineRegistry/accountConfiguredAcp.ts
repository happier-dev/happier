import { isCustomAcpAgentContributionIdentityV1, type AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { agentRoutingIdAddressesContributionIdentityV1, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

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
import type { AgentAcpRuntimeDefinition } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import type { PublicAcpHostLaunchResolver } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import type { HostSessionRuntimeConfig } from '@/agent/runtime/session/loop/runHostSessionRuntime';

/** Account definitions supply launch data to the declared Agent's public ACP runtime. */
export async function resolveAccountConfiguredAcpLaunch(
  definitionId: string,
  savedSecretOperationContext?: SavedSecretOperationContextV1,
) {
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
  const configuredBackend = resolveConfiguredAcpBackendFromAccountSettings(accountSnapshot.settings, definitionId, catalog);
  if (!configuredBackend) throw new AcpCatalogUnavailableError('definition-not-found');
  const definition = normalizeConfiguredAcpDefinition({ backend: configuredBackend });
  const runtimeDefinition: AgentAcpRuntimeDefinition = Object.freeze({
    mcp: definition.mcp,
    ...(definition.stderrRules ? { stderrRules: definition.stderrRules } : {}),
  });
  const sessionCapabilities: AgentSessionCapabilities = {
    open: ['create', ...(configuredBackend.capabilities.supportsLoadSession ? ['resume' as const] : [])],
    delivery: ['newTurn', 'steer', 'followUp'], cancel: true, configuration: true,
    executionRunContext: { versions: [1] },
  };
  const sessionProjection = Object.freeze({
    flavor: 'custom-acp',
    agentMessageType: 'custom-acp',
    augmentSessionMetadata: (metadata) => ({
      ...metadata,
      flavor: 'custom-acp',
      ...buildConfiguredAcpBackendSessionMetadata({ backendId: configuredBackend.backendId, title: configuredBackend.title }),
    }),
  } satisfies Readonly<{
    flavor: string;
    agentMessageType: HostSessionRuntimeConfig['agentMessageType'];
    augmentSessionMetadata: NonNullable<HostSessionRuntimeConfig['augmentSessionMetadata']>;
  }>);
  const resolveHostLaunch: PublicAcpHostLaunchResolver = async (request) => {
    await assertAccountCurrent();
    if (readSnapshot()?.acpCatalog !== catalog) throw new AcpCatalogUnavailableError('catalog-stale');
    const references = Object.values(configuredBackend.env)
      .flatMap(value => value.t === 'savedSecret' ? [{ ref: value.secretId }] : []);
    if (references.length > 0) {
      try {
        const refresh = () => refreshSavedSecretCatalogForOperation({
          expectedScopeKey: scopeKey, references, operationContext: savedSecretOperationContext,
        });
        await (savedSecretOperationContext
          ? runWithServerHttpBaseUrl(savedSecretOperationContext.serverHttpBaseUrl, refresh)
          : refresh());
      } catch (error) {
        if (!(error instanceof SavedSecretOperationAdmissionError)) throw error;
        const field = Object.entries(configuredBackend.env)
          .find(([, value]) => value.t === 'savedSecret' && value.secretId === error.reference)?.[0];
        throw new SavedSecretResolutionError({
          status: savedSecretOperationAdmissionStatus(error.reason), reference: error.reference,
          consumer: 'acp', field: `env:${field ?? error.reference}`,
        });
      }
    }
    await assertAccountCurrent();
    const launchSnapshot = readSnapshot();
    if (launchSnapshot?.acpCatalog !== catalog) throw new AcpCatalogUnavailableError('catalog-stale');
    const launchDefinition = normalizeConfiguredAcpDefinition({
      backend: configuredBackend,
      launchEnv: materializeConfiguredAcpEnvironment({
        backend: configuredBackend, accountSettings: launchSnapshot.settings, credentials,
        savedSecretResources: launchSnapshot.savedSecretResources,
      }),
    });
    const launch = await resolveAcpRuntimeLaunch({ definition: launchDefinition, cwd: request.cwd });
    await assertAccountCurrent();
    if (readSnapshot()?.acpCatalog !== catalog) throw new AcpCatalogUnavailableError('catalog-stale');
    return Object.freeze({
      command: launch.command, args: Object.freeze([...launch.args]), env: Object.freeze({ ...launch.env }),
      unsetEnv: Object.freeze([]),
      timeouts: Object.freeze({
        ...(typeof definition.timeouts?.initMs === 'number' ? { initializeMs: definition.timeouts.initMs } : {}),
        ...(typeof definition.timeouts?.idleMs === 'number' ? { idleMs: definition.timeouts.idleMs } : {}),
        ...(typeof definition.timeouts?.toolCallMs === 'number' ? { toolCallMs: definition.timeouts.toolCallMs } : {}),
      }),
    });
  };
  await assertAccountCurrent();
  if (readSnapshot()?.acpCatalog !== catalog) throw new AcpCatalogUnavailableError('catalog-stale');
  return Object.freeze({ definitionId, configuredBackend, runtimeDefinition, sessionCapabilities, sessionProjection, resolveHostLaunch });
}

/** The declared ACP contribution binds an instance, never a synthetic Agent. */
export async function resolveAccountConfiguredAcpLaunchForAgent(params: Readonly<{
  identity: PluginContributionIdentityV1;
  agentTarget?: AgentExecutionTargetV1;
  startupRuntimeDescriptorV1?: AgentSessionOpenRequest['runtimeDescriptorV1'];
  savedSecretOperationContext?: SavedSecretOperationContextV1;
}>) {
  if (!isCustomAcpAgentContributionIdentityV1(params.identity)) return null;
  const target = params.agentTarget;
  if (target && (!isCustomAcpAgentContributionIdentityV1(target.identity))) {
    throw new AcpCatalogUnavailableError('contribution-mismatch');
  }
  const selectedDefinitionId = target?.definitionId;
  if (params.startupRuntimeDescriptorV1
    && !agentRoutingIdAddressesContributionIdentityV1(params.startupRuntimeDescriptorV1.agentId, params.identity)) {
    throw new AcpCatalogUnavailableError('contribution-mismatch');
  }
  const described = params.startupRuntimeDescriptorV1?.agent?.definitionId;
  const describedDefinitionId = typeof described === 'string' ? described : undefined;
  if (selectedDefinitionId && describedDefinitionId && selectedDefinitionId !== describedDefinitionId) {
    throw new AcpCatalogUnavailableError('definition-mismatch');
  }
  const definitionId = selectedDefinitionId ?? describedDefinitionId;
  if (!definitionId) throw new AcpCatalogUnavailableError('definition-required');
  return await resolveAccountConfiguredAcpLaunch(definitionId, params.savedSecretOperationContext);
}
