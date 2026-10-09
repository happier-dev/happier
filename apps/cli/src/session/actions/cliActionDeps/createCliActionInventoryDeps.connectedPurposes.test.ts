import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { resolveDirectCliConnectedServiceBindings } from '@/cli/connectedServices/resolveDirectCliConnectedServiceBindings';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';
import { createCliActionDeps } from '../createCliActionDeps';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

describe('direct CLI and Action inventory purpose authority', () => {
  it('reads purpose inventory with the original named Action token, authority ceiling and captured Home', async () => {
    const accountId = 'named-purpose-inventory';
    const home = 'https://named-purpose-inventory.example.test';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const actionToken = 'named-purpose-action-token';
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'codex',
      contributions: readCurrentContributionRegistry() })?.authorizedPurposes.find(scope => scope.serviceRefs[0]?.localId === 'openai-codex');
    if (!declaration?.serviceRefs[0]) throw new Error('Missing current declared Codex purpose');
    const service = declaration.serviceRefs[0];
    const snapshot = { source: 'network' as const, scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] };
    setActiveAccountSettingsSnapshot(snapshot);
    const incumbent = getActiveAccountSettingsSnapshot();
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: home,
      snapshot, isCurrent: async () => true });
    const denied: string[] = [];
    // Tokens are opaque HTTP credentials, not a new token parser. The real
    // Action executor and request-header owner must retain original authority.
    vi.spyOn(axios, 'get').mockImplementation(async (input, options) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(home);
      const authorization = Object.entries(options?.headers ?? {}).filter(([name]) => name.toLowerCase() === 'authorization');
      if (authorization.length !== 1 || authorization[0]?.[1] !== `Bearer ${actionToken}`
        || options?.headers?.[AUTHORITY_CEILING_HEADER_V1] !== 'account_automation') {
        denied.push(url.pathname);
        return { status: 403, data: { error: 'forbidden' } };
      }
      if (url.pathname === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: accountId }) };
      if (url.pathname.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.pathname.endsWith('/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision: 4, content: { t: 'plain', v: { key: 'purposes', value: { v: 1,
          bindings: [{ purpose: declaration.purpose, target: { kind: 'group', service, groupId: 'row-group' } }] } } } } };
      if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      throw new Error(`Unexpected named Action request: ${url.pathname}`);
    });
    const executor = createActionExecutor(createCliActionDeps({ token: actionToken, credentials,
      savedSecretOperationContext: operationContext, serverId: 'named-purpose-home', serverHttpBaseUrl: home,
      sessionId: 'named-purpose-session', mode: 'plain', ctx: null }));
    const result = await runWithServerHttpBaseUrl(home, () => executor.execute('sessions.spawn.connected_services.list',
      { agentId: 'codex', includeUnavailable: false }, { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' } }));
    expect(denied).toEqual([]);
    expect(result).toMatchObject({ ok: true, result: { defaultBindings: { v: 2, bindingsByServiceId: {
      [`${service.pluginId}/${service.localId}`]: { source: 'connected', selection: 'group', groupId: 'row-group' },
    } } } });
    expect(operationContext.readSnapshot()?.connectedPurposeCatalog).toMatchObject({ status: 'ready', revision: 4 });
    expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
  });

  it.each([
    ['direct', 'ready'], ['inventory', 'ready'],
    ['direct', 'mode-mismatch'], ['inventory', 'mode-mismatch'],
  ] as const)('%s requires %s purpose authority instead of a legacy default', async (owner, outcome) => {
    const credentials = { token: 'current-purpose-consumer', encryption: null };
    const home = 'https://purpose-consumer.example.test';
    const raw = { connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
      codex: { v: 1, bindingsByServiceId: { 'openai-codex': {
        source: 'connected', selection: 'profile', profileId: 'retired-account',
      } } },
    } } };
    const snapshot = { source: 'network' as const, scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] };
    setActiveAccountSettingsSnapshot(snapshot);
    const incumbent = getActiveAccountSettingsSnapshot();
    // Only Home HTTP is replaced. Public launch/inventory, purpose parsing,
    // captured custody and default interpretation use their real owners.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.origin).toBe(home);
      if (url.pathname.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.pathname.endsWith('/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision: 4, content: outcome === 'ready'
          ? { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } }
          : { t: 'encrypted', c: 'incompatible-account-mode' } } };
      if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: raw } } };
      throw new Error(`Unexpected Home request: ${url.pathname}`);
    });
    await runWithServerHttpBaseUrl(home, async () => {
      if (owner === 'direct') {
        const operation = resolveDirectCliConnectedServiceBindings({ agentId: 'codex', credentials,
          accountSettings: snapshot.settings, authRaw: 'default', authJsonRaw: undefined });
        if (outcome === 'ready') await expect(operation).resolves.toBeNull();
        else await expect(operation).rejects.toThrow('connected_services_default_unavailable');
        expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toMatchObject(outcome === 'ready'
          ? { status: 'ready', revision: 4 } : { status: 'unavailable', reason: 'account-mode-mismatch' });
      } else {
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: home,
          snapshot, isCurrent: async () => true });
        const deps = createCliActionInventoryDeps({ token: credentials.token, credentials,
          savedSecretOperationContext: operationContext, sessionId: 'purpose-inventory-session', mode: 'plain', ctx: null,
          accountProfile: AccountProfileSchema.parse({ id: 'purpose-inventory-account' }) });
        const operation = deps.spawnConnectedServicesList!({ agentId: 'codex', includeUnavailable: false });
        if (outcome === 'ready') expect(await operation).not.toHaveProperty('defaultBindings');
        else await expect(operation).rejects.toMatchObject({ code: 'connected_services_default_unavailable' });
        expect(operationContext.readSnapshot()?.connectedPurposeCatalog).toMatchObject(outcome === 'ready'
          ? { status: 'ready', revision: 4 } : { status: 'unavailable', reason: 'account-mode-mismatch' });
        expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
      }
    });
  });
});
