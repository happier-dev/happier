import axios from 'axios';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { ConnectedAccountCatalogRowReadResponseV1Schema, CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import * as persistence from '@/persistence';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveSessionSpawnConnectedServicesDefaultsPayload } from './spawnConnectedServicesDefaults';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex', 'happier.agent.claude'] } });
});
afterAll(async () => { await runtime.dispose(); });

it.each(['profile', 'group'] as const)('resolves the Account Claude %s default before lazy Agent activation', async (selection) => {
  resetInMemoryAccountSettingsContextForTests();
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'workflow-account' })).toString('base64url')}.signature`, encryption: null } as const;
  const stored = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  const scope = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'claude',
    contributions: runtime.registry.contributes })?.authorizedPurposes.find(entry => entry.serviceRefs[0]?.localId === 'claude-subscription');
  if (!scope?.serviceRefs[0]) throw new Error('Real Claude purpose unavailable');
  // Only Home HTTP and credential storage are substituted. The cold Agent
  // projection, settings reader, purpose catalog and default resolver stay real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v2/account/settings') return { status: 200,
      data: { content: { t: 'plain', v: {} }, version: 9 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 9 }) };
    if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) return { status: 200,
      data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 3,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [{ purpose: scope.purpose,
          target: selection === 'profile'
            ? { kind: 'account', account: { service: scope.serviceRefs[0], accountId: 'connected-claude' } }
            : { kind: 'group', service: scope.serviceRefs[0], groupId: 'connected-claude' } }] } } } }) };
    return { status: 404, data: { error: 'unsupported' } };
  });
  try {
    const defaults = await runWithServerHttpBaseUrl('https://workflow-home.example', () => resolveSessionSpawnConnectedServicesDefaultsPayload({
      agentId: 'claude', credentials,
    }));
    expect(defaults?.connectedServices).toMatchObject({ v: 2, bindingsByServiceId: {
      'happier.agent.claude/claude-subscription': { source: 'connected', selection,
        ...(selection === 'profile' ? { profileId: 'connected-claude' } : { groupId: 'connected-claude' }) },
    } });
  } finally { get.mockRestore(); stored.mockRestore(); resetInMemoryAccountSettingsContextForTests(); }
});

it('admits a fresh Account default without waiting for legacy history maintenance', async () => {
  resetInMemoryAccountSettingsContextForTests();
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'admission-owner' })).toString('base64url')}.signature`, encryption: null } as const;
  const stored = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  const scope = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'claude',
    contributions: runtime.registry.contributes })?.authorizedPurposes.find(entry => entry.serviceRefs[0]?.localId === 'claude-subscription');
  if (!scope?.serviceRefs[0]) throw new Error('Real Claude purpose unavailable');
  let historyStarted!: () => void;
  let releaseHistory!: () => void;
  const started = new Promise<void>(resolve => { historyStarted = resolve; });
  const blockedHistory = new Promise<void>(resolve => { releaseHistory = resolve; });
  const get = vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v2/account/settings') return { status: 200,
      data: { content: { t: 'plain', v: {} }, version: 9 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 9 }) };
    if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) return { status: 200,
      data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 3,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [{ purpose: scope.purpose,
          target: { kind: 'account', account: { service: scope.serviceRefs[0], accountId: 'connected-claude' } } }] } } } }) };
    if (path === '/v2/account/settings/history') {
      historyStarted();
      await blockedHistory;
      return { status: 200, data: { snapshots: [] } };
    }
    return { status: 404, data: { error: 'unsupported' } };
  });
  try {
    const defaults = runWithServerHttpBaseUrl('https://workflow-home.example', () => resolveSessionSpawnConnectedServicesDefaultsPayload({
      agentId: 'claude', credentials,
    }));
    await expect(Promise.race([
      defaults,
      started.then(() => Promise.reject(new Error('legacy history maintenance blocked Session admission'))),
    ])).resolves.toMatchObject({ connectedServices: { bindingsByServiceId: {
      'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'connected-claude' },
    } } });
  } finally {
    releaseHistory();
    get.mockRestore();
    stored.mockRestore();
    resetInMemoryAccountSettingsContextForTests();
  }
});

it('resolves fresh requester defaults without replacing the custodian Account snapshot', async () => {
  resetInMemoryAccountSettingsContextForTests();
  const alice = { source: 'network' as const, settings: accountSettingsParse({}), settingsVersion: 2,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'alice' };
  setActiveAccountSettingsSnapshot(alice);
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`, encryption: null } as const;
  const stored = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  const scope = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'codex',
    contributions: runtime.registry.contributes })?.authorizedPurposes.find(entry => entry.serviceRefs[0]?.localId === 'openai-codex');
  if (!scope?.serviceRefs[0]) throw new Error('Real Codex purpose unavailable');
  const purposeCatalog = ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 3,
    content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [{ purpose: scope.purpose,
      target: { kind: 'group', service: scope.serviceRefs[0], groupId: 'bob-default-group' } }] } } } });
  // HTTP and persisted credentials are boundaries; purpose admission and requester publication stay real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (input, config) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://bob-home.example');
    expect(config?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
    if (url.pathname === '/v2/account/settings') return { status: 200,
      data: { content: { t: 'plain', v: {} }, version: 9 } };
    if (url.pathname === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 9 }) };
    if (url.pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) return { status: 200, data: purposeCatalog };
    return { status: 404, data: { error: 'unsupported' } };
  });
  try {
    const defaults = await runWithServerHttpBaseUrl('https://bob-home.example', () => resolveSessionSpawnConnectedServicesDefaultsPayload({
      agentId: 'codex', credentials,
    }));
    expect(defaults?.connectedServices).toMatchObject({ v: 2, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'bob-default-group' },
    } });
    expect(get.mock.calls.some(call => call[0] === 'https://bob-home.example/v2/account/settings')).toBe(true);
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
  } finally { get.mockRestore(); stored.mockRestore(); resetInMemoryAccountSettingsContextForTests(); }
});
