import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshotChanges } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveSpawnConnectedServicesDefaultDisposition } from '@/session/services/spawnConnectedServicesDefaults';
import { createCliConnectedServiceAction } from './connectedServiceActionDeps';

describe('connected purpose Action dependency port', () => {
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

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
