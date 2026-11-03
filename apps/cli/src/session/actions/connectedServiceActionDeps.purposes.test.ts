import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshotChanges } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveSpawnConnectedServicesDefaultDisposition } from '@/session/services/spawnConnectedServicesDefaults';
import { createCliConnectedServiceAction } from './connectedServiceActionDeps';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { GITHUB_TRIAGE_ACTION_IDS_V1, GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1 } from '../../../../../packages/plugins/scm-github/src/triage/contribution';
import { GITHUB_TEST_ACCOUNT } from '../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support';

describe('connected purpose Action dependency port', () => {
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  it('configures an Account-custodied GitHub purpose with no Machines and refuses foreign or disabled targets', async () => {
    const credentials = { token: 'purpose-account-origin', encryption: null };
    const base = 'https://purpose-account.test';
    let enabled = true;
    let writes = 0;
    let record: ConnectedAccountCatalogRecordV1 = { key: 'purposes', value: { v: 1, bindings: [] } };
    const purpose = { consumer: { pluginId: GITHUB_TEST_ACCOUNT.service.pluginId, localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances },
      purpose: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.purpose };
    const target = { kind: 'account' as const, account: GITHUB_TEST_ACCOUNT };
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: base,
      snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }, isCurrent: async () => true });
    const profile = AccountProfileSchema.parse({ id: 'own', connectedAccountsV4: [{ ref: GITHUB_TEST_ACCOUNT,
      status: 'connected', kind: 'token', authenticationModeId: 'pat', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationReady: true, configurationRevision: null, scopes: [] }] });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      expect(request.url).toBe(`${base}/v1/account/profile`);
      return { status: 200, data: profile };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision: writes + 1,
        content: { t: 'plain', v: record } } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      throw new Error(`Unexpected purpose read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) return { status: 200,
        data: { availabilityCursor: 1, hostingCapability: { enabled: false }, intent: { pluginId: GITHUB_TEST_ACCOUNT.service.pluginId,
          desiredVersion: null, enabled, offlineUiHosting: 'disabled', writableCollections: [], revision: 'account-purpose' },
          release: null, packageAssets: [], uiArtifacts: [] } };
      expect(path).toBe('/v1/account/entity-rows/connected-accounts/purposes');
      const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
      if (mutation.content?.t !== 'plain') throw new Error('Expected plain Account catalog');
      record = mutation.content.v;
      writes++;
      return { status: 200, data: { status: 'updated', revision: writes + 1, cursor: writes + 1 } };
    });
    const action = createCliConnectedServiceAction({ credentials, operationContext, serverHttpBaseUrl: base,
      resolveHeaders: () => ({ Authorization: 'Bearer purpose-account-origin' }),
      callMachineAction: async () => { throw new Error('Account-custodied purpose must not acquire a Machine'); } });
    const execute = (accountId = target.account.accountId) => action({ actionId: 'connectedServices.purposes.default.set',
      input: { purpose, target: { ...target, account: { ...target.account, accountId } } },
      context: { surface: 'cli', authority: 'present_user' } });
    expect(await execute()).toEqual({ applied: true });
    expect(record).toEqual({ key: 'purposes', value: { v: 1, bindings: [{ purpose, target }] } });
    expect(await execute('foreign')).toMatchObject({ ok: false, errorCode: 'connected_account_purpose_unavailable' });
    enabled = false;
    expect(await execute()).toMatchObject({ ok: false, errorCode: 'connected_account_purpose_unavailable' });
    expect(writes).toBe(1);
  });

  it.each([
    ['connectedServicesDefaultAuthByAgentIdV1', 'ready'], ['connectedServicesAdditionalDefaultAuthByAgentIdV1', 'ready'],
    ['connectedServicesDefaultAuthByAgentIdV1', 'first-demand'], ['connectedServicesAdditionalDefaultAuthByAgentIdV1', 'first-demand'],
  ] as const)(
    'atomically clears %s with captured Action authorization from %s catalog authority', async (carrier, authority) => {
      const credentials = { token: 'purpose-action', encryption: null };
      const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
      const purpose = { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' };
      let record: ConnectedAccountCatalogRecordV1 = { key: 'purposes', value: { v: 1, bindings: [{ purpose,
        target: { kind: 'group', service, groupId: 'selected-group' } }] } };
      let revision = 3;
      let settingsVersion = 7;
      let raw: Readonly<Record<string, unknown>> = { futurePreference: { retained: true }, [carrier]: {
        v: 1, bindingsByAgentId: { codex: { v: 1, bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'legacy-account' },
        } } },
      } };
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(raw), rawSettings: raw,
        settingsVersion, scopeKey: resolveAccountSettingsScopeKey(credentials), loadedAtMs: 1, settingsSecretsReadKeys: [],
        connectedPurposeCatalog: authority === 'ready' ? { status: 'ready', revision, record } : { status: 'loading' } });
      // HTTP is the only replacement; Action semantics, Agent projection,
      // legacy cleanup, paired envelope and row publication remain real.
      const unauthorizedRequests: string[] = [];
      const isCapturedAuthorization = (headers: unknown) => {
        if (!headers || typeof headers !== 'object') return false;
        const authorization = Object.entries(headers).filter(([key]) => key.toLowerCase() === 'authorization');
        return authorization.length === 1 && authorization[0]?.[1] === 'Bearer captured-action';
      };
      vi.spyOn(axios, 'get').mockImplementation(async (input, options) => {
        const path = new URL(String(input)).pathname;
        if (!isCapturedAuthorization(options?.headers)) {
          unauthorizedRequests.push(path);
          return { status: 403, data: { error: 'forbidden' } };
        }
        if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision,
          content: { t: 'plain', v: record } } };
        if (path === '/v2/account/settings') return { status: 200, data: { version: settingsVersion, content: { t: 'plain', v: raw } } };
        return { status: 404, data: { error: 'unsupported' } };
      });
      vi.spyOn(axios, 'post').mockImplementation(async (input, body, options) => {
        expect(isCapturedAuthorization(options?.headers)).toBe(true);
        expect(new URL(String(input)).pathname).toBe('/v1/account/entity-rows/connected-accounts/purposes');
        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
        expect(mutation.expectedRevision).toBe(revision);
        expect(mutation.settingsMutation?.expectedSettingsVersion).toBe(settingsVersion);
        if (mutation.content?.t !== 'plain' || mutation.settingsMutation?.content?.t !== 'plain') throw new Error('Expected actual Plain paired envelopes');
        record = mutation.content.v;
        raw = mutation.settingsMutation.content.v;
        revision += 1;
        settingsVersion += 1;
        return { status: 200, data: { status: 'updated', revision, cursor: 4, settingsVersion } };
      });
      const action = createCliConnectedServiceAction({ credentials,
        resolveHeaders: () => ({ authorization: 'Bearer captured-action' }),
        callMachineAction: async () => { throw new Error('Purpose defaults are Account owned'); } });
      const resurrectedDefaults: unknown[] = [];
      const unsubscribe = subscribeActiveAccountSettingsSnapshotChanges((_previous, snapshot) => {
        const purposes = snapshot?.connectedPurposeCatalog;
        if (snapshot && purposes?.status === 'ready' && purposes.record.key === 'purposes'
          && purposes.record.value.bindings.length === 0) {
          const disposition = resolveSpawnConnectedServicesDefaultDisposition({ accountSettings: snapshot.settings,
            agentId: 'codex', purposeCatalog: purposes });
          if (disposition.kind === 'connected') resurrectedDefaults.push(disposition);
        }
      });
      try {
        await expect(action({ actionId: 'connectedServices.pools.default.set', input: { group: { service, groupId: 'selected-group' },
          agentId: 'codex', makeDefault: false }, context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } },
        })).resolves.toEqual({ applied: true });
      } finally { unsubscribe(); }
      expect(record).toEqual({ key: 'purposes', value: { v: 1, bindings: [] } });
      expect(raw).toMatchObject({ futurePreference: { retained: true }, [carrier]: { v: 1, bindingsByAgentId: {} } });
      expect(raw).not.toHaveProperty('connectedAccountPurposeBindingsV1');
      expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toMatchObject({ status: 'ready', revision: 4, record });
      expect(unauthorizedRequests).toEqual([]);
      expect(resurrectedDefaults).toEqual([]);
    },
  );
});
