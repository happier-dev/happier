import axios from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ConnectedAccountCatalogRowReadResponseV1Schema, CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { configuration } from '@/configuration';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as persistence from '@/persistence';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { ApiClient } from '@/api/api';
import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol/account/authoringMemory';
import { PROFILE_ROWS_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';

const credentials = { token: 'default-binding-owner', encryption: null } as const;
const serverHttpBaseUrl = 'https://spawn-defaults.example';
const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;

beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
});
afterAll(async () => { await runtime?.dispose(); });
afterEach(() => {
  vi.restoreAllMocks();
  resetInMemoryAccountSettingsContextForTests();
  resetActiveAccountSettingsSnapshotForTests();
});

function installHome(purposeTarget: 'account' | 'group' | 'empty' | 'unavailable') {
  const scope = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'codex',
    contributions: runtime.registry.contributes })?.authorizedPurposes.find(entry => entry.serviceRefs[0]?.localId === 'openai-codex');
  if (!scope?.serviceRefs[0]) throw new Error('Bundled Codex purpose unavailable');
  const service = scope.serviceRefs[0];
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 4,
    scopeKey: resolveAccountSettingsScopeKey(credentials), loadedAtMs: 1, settingsSecretsReadKeys: [] });
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  // HTTP and persisted credentials are the only replaced boundaries. Agent
  // identity, purpose declaration, catalog admission and spawn preparation stay real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: {} } } };
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) };
    if (path === '/v1/account/encryption') return { status: 200,
      data: AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 0 }) };
    if (path === `${AUTHORING_MEMORY_ROUTE_V1}/lastUsedProfile`) return { status: 200,
      data: { status: 'present', revision: 1, content: { t: 'plain', v: null } } };
    if (path.startsWith(PROFILE_ROWS_ROUTE_V1)) return { status: 503, data: { error: 'unavailable' } };
    if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) {
      if (purposeTarget === 'unavailable') throw new Error('Home unavailable');
      return { status: 200, data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1461,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: purposeTarget === 'empty' ? [] : [{
          purpose: scope.purpose, target: purposeTarget === 'account'
            ? { kind: 'account', account: { service, accountId: 'saved-account' } }
            : { kind: 'group', service, groupId: 'saved-group' },
        }] } } } }) };
    }
    return { status: 404, data: { error: 'unsupported' } };
  });
  return { serviceKey: `${service.pluginId}/${service.localId}`, get };
}

function prepare(connectedServices?: unknown, operationContext?: SavedSecretOperationContextV1, accountSettings?: Record<string, unknown>) {
  // Exercise the exact daemon ingress schema, including released V1 native bindings.
  const options = SpawnDaemonSessionRequestSchema.parse({ directory: configuration.happyHomeDir, agentTarget,
    ...(connectedServices === undefined ? {} : { connectedServices }) });
  return runWithServerHttpBaseUrl(serverHttpBaseUrl, () => prepareExecuteSpawnSessionRequest({
    request: { options, credentials, ...(operationContext ? { operationContext } : {}), ...(accountSettings ? { accountSettings } : {}) }, validateEnvVarRecordStrict,
  }));
}

function execute(options: SpawnSessionOptions) {
  return runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => executeSpawnSessionRequest({
    options, credentials, api: await ApiClient.create(credentials),
    connectedServicesMaterializationBaseDir: configuration.happyHomeDir,
    connectedServiceRefreshCoordinator: null, connectedServiceQuotasCoordinator: null,
    connectedServiceRuntimeRegistry: new ConnectedServiceRuntimeRegistry(),
    pidToTrackedSession: new Map(), pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(), spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
    resolveCanonicalTrackedSessionId: () => '', onChildExited: () => {},
  }));
}

describe('fresh daemon spawn Account purpose defaults', () => {
  it('carries the Account default model into fresh native admission when no model was selected', async () => {
    installHome('unavailable');
    const modelSelection = { v: 1 as const, updatedAt: 7,
      ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5.6-luna' } };
    const result = await prepare({ v: 2, bindingsByServiceId: {} }, undefined, {
      providerDefaultModelSelectionsByAgentTargetKeyV1: { [modelSelection.ref.agentTargetKey]: modelSelection },
    });
    expect(result).toMatchObject({ modelSelection });
  });

  it.each(['account', 'group'] as const)('admits the saved %s when a Voice/Action spawn omits its choice', async target => {
    const { serviceKey } = installHome(target);
    const result = await prepare();
    expect(result).toMatchObject({ connectedServices: { v: 2, bindingsByServiceId: {
      [serviceKey]: target === 'account'
        ? { source: 'connected', selection: 'profile', profileId: 'saved-account' }
        : { source: 'connected', selection: 'group', groupId: 'saved-group' },
    } }, connectedServicesUpdatedAt: expect.any(Number) });
    if ('type' in result) throw new Error('Expected admitted spawn');
    expect(SpawnDaemonSessionRequestSchema.parse({ directory: result.directory,
      connectedServices: result.connectedServices }).connectedServices).toEqual(result.connectedServices);
  });

  it.each([
    { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'native' } } },
    { v: 2, bindingsByServiceId: {} },
    { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
      source: 'connected', selection: 'profile', profileId: 'explicit-account',
    } } },
    { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
      source: 'team_resource', resourceId: 'explicit-resource', deliveryMode: 'brokered',
    } } },
  ])('preserves explicit native/Session bindings without reading defaults (%j)', async connectedServices => {
    const { get } = installHome('unavailable');
    const result = await prepare(connectedServices);
    expect(result).not.toHaveProperty('type');
    expect(result).toMatchObject({ connectedServices: SpawnDaemonSessionRequestSchema.parse({
      directory: configuration.happyHomeDir, connectedServices,
    }).connectedServices });
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps an admitted empty purpose catalog native', async () => {
    installHome('empty');
    const result = await prepare();
    expect(result).not.toHaveProperty('type');
    expect(result).not.toHaveProperty('connectedServices');
  });

  it('resolves requester defaults without replacing the custodian Account', async () => {
    const { serviceKey } = installHome('group');
    await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
      const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl,
        snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 4,
          scopeKey: resolveAccountSettingsScopeKey(credentials), loadedAtMs: 1, settingsSecretsReadKeys: [] },
        isCurrent: async () => true });
      const custodian = { source: 'network' as const, settings: accountSettingsParse({}), settingsVersion: 1,
        scopeKey: 'another-account', loadedAtMs: 1, settingsSecretsReadKeys: [] };
      setActiveAccountSettingsSnapshot(custodian);
      expect(await prepare(undefined, operationContext)).toMatchObject({ connectedServices: { bindingsByServiceId: {
        [serviceKey]: { source: 'connected', selection: 'group', groupId: 'saved-group' },
      } } });
      expect(getActiveAccountSettingsSnapshot()).toBe(custodian);
      expect(operationContext.readSnapshot()?.connectedPurposeCatalog).toMatchObject({ status: 'ready', revision: 1461 });
    });
  });

  it('carries default-admission refusal through the real daemon spawn composition before launch', async () => {
    installHome('unavailable');
    const beforeSessionRunnerLaunch = vi.fn(async () => false);
    const result = await execute({ directory: configuration.happyHomeDir, agentTarget, beforeSessionRunnerLaunch });
    expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED',
      errorMessage: 'connected_account_purpose_catalog_unavailable' });
    if (result.type !== 'error') throw new Error('Expected default-admission refusal');
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure(result))).toMatchObject({
      type: 'error', code: 'spawn_failed', retryable: true,
      launchError: { code: 'connected_account_purpose_catalog_unavailable', failureCause: {
        code: 'connected_account_purpose_catalog_unavailable', phase: 'authentication',
        connectedServicesDefault: { v: 1, source: 'account_default',
          reason: 'connected_account_purpose_catalog_unavailable', phase: 'purpose_binding', catalogReason: 'unreachable' },
      } },
    });
    expect(beforeSessionRunnerLaunch).not.toHaveBeenCalled();
  });

  it('retains and logs the selected Profile when catalog admission refuses the real daemon spawn', async () => {
    installHome('empty');
    const profileId = 'foreign-default-profile';
    const info = vi.spyOn(logger, 'infoFile');
    const result = await execute({ directory: configuration.happyHomeDir, agentTarget, profileId,
      connectedServices: { v: 2, bindingsByServiceId: {} } });
    expect(result).toMatchObject({ type: 'error', errorCode: 'INVALID_REQUEST' });
    if (result.type !== 'error') throw new Error('Expected Profile refusal');
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure(result))).toMatchObject({
      type: 'error', code: 'spawn_failed', retryable: false,
      launchError: { code: 'profile_launch_unavailable', profileRefusal: {
        profileId, reason: 'profile_catalog_unavailable', catalogStatus: 'unavailable',
      } },
    });
    expect(info).toHaveBeenCalledWith('[DAEMON RUN] Profile launch refused', expect.objectContaining({
      profileId, reason: 'profile_catalog_unavailable', catalogStatus: 'unavailable',
    }));
  });
});
