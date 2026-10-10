import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['ready', 'partial', 'unavailable'] as const)('projects real connected inventory with a %s presentation catalog in captured requester custody', async status => {
  const alice: StoredCredentials = { token: 'alice-inventory', encryption: null };
  const credentials: StoredCredentials = { token: 'bob-inventory', encryption: null };
  const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
  const account = { service, accountId: 'work' };
  const group = { service, groupId: 'team' };
  const raw = { futurePreference: 'retained', connectedServicesProfileLabelByKey: { 'happier.agent.codex%2Fopenai-codex/work': 'Stale Settings' } };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 9, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(alice) });
  const incumbent = getActiveAccountSettingsSnapshot();
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
    serverHttpBaseUrl: 'https://bob-inventory.test', isCurrent: async () => true,
    snapshot: { source: 'network', settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: 7,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) } });
  const profile = AccountProfileSchema.parse({ id: 'bob', connectedAccountsV4: [{ ref: account, status: 'connected',
    authenticationModeId: 'oauth', revisionSemantics: 'legacy_unfenced', credentialRevision: null,
    configurationReady: true, configurationRevision: null, scopes: [], displayName: 'Native Account',
    providerIdentity: { accountId: 'private-provider-identity', email: 'work@example.test' } }],
  connectedAccountGroupsV4: [{ v: 1, ref: group, incarnation: 'group-1', displayName: 'Native Group',
    policy: { autoSwitch: false }, activeConnectedAccountId: 'work', generation: 4, runtimeStateRevision: 0,
    state: {}, createdAt: 1, updatedAt: 1, members: [{ v: 1, connectedAccountId: 'work', priority: 100,
      enabled: true, state: {}, createdAt: 1, updatedAt: 1 }] }] });
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname.includes('/connected-metadata/')) expect(url.origin).toBe('https://bob-inventory.test');
    const path = url.pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: raw } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (path === '/v1/account/profile') return { status: 200, data: profile };
    if (path === '/v1/account/entity-rows/connected-accounts/purposes') return { status: 200, data: { status: 'present', revision: 1,
      content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } };
    if (path.endsWith('/connected-metadata/presentation') && status === 'unavailable') return { status: 403, data: { error: 'forbidden' } };
    if (path.endsWith('/connected-metadata/presentation')) return { status: 200, data: { status: 'present', revision: 3,
      content: { t: 'plain', v: { v: 1, entries: [
        { v: 1, subject: { kind: 'account', account }, label: 'Row Account' },
        { v: 1, subject: { kind: 'group', ...group }, label: 'Row Group' },
        ...(status === 'partial' ? [{ v: 99, subject: { kind: 'future' }, label: 'Opaque future entry' }] : []),
      ] } } } };
    if (path.endsWith('/connected-metadata/acknowledgements')) return { status: 200, data: { status: 'present', revision: 2,
      content: { t: 'plain', v: { v: 1, entries: [] } } } };
    throw new Error(`Unexpected inventory GET: ${path}`);
  });
  const writes: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (input, body: unknown) => {
    expect(new URL(String(input)).pathname).toBe('/v2/account/settings');
    const mutation = AccountSettingsV2UpdateRequestSchema.parse(body);
    expect(mutation.content?.t).toBe('plain');
    if (mutation.content?.t === 'plain') writes.push(mutation.content.v);
    return { status: 200, data: { success: true, version: 8 } };
  });
  const deps = createCliActionInventoryDeps({ token: credentials.token, credentials, sessionId: 'session',
    mode: 'plain', ctx: null, accountProfile: profile, ...{ savedSecretOperationContext: operationContext } });
  const result = await deps.spawnConnectedServicesList!({ agentId: 'codex', backendTargetKey: 'agent:happier.agent.codex/codex' });
  const accountLabel = status === 'unavailable' ? 'Native Account' : 'Row Account';
  const groupLabel = status === 'unavailable' ? 'Native Group' : 'Row Group';
  expect(result).toMatchObject({ profileOptionsByServiceId: { 'happier.agent.codex/openai-codex': [{ profileId: 'work', label: accountLabel }] },
    groupOptionsByServiceId: { 'happier.agent.codex/openai-codex': [{ groupId: 'team', label: groupLabel }] },
    items: [{ value: 'happier.agent.codex/openai-codex:profile:work', label: accountLabel }] });
  expect(JSON.stringify(result)).not.toContain('private-provider-identity');
  expect(writes).toEqual(status === 'ready' ? [{ futurePreference: 'retained' }] : []);
  expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
});
