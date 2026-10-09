import axios from 'axios';
import { expect, it, vi } from 'vitest';
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

it('resolves fresh requester defaults without replacing the custodian Account snapshot', async () => {
  const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
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
  } finally { get.mockRestore(); stored.mockRestore(); await runtime.dispose(); resetInMemoryAccountSettingsContextForTests(); }
});
