import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { encryptSecretStringV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import * as persistence from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { createCliConnectedAccountCatalogStore } from './connectedAccountCatalogStore';

describe('Connected catalog source admission', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

  it.each(['empty', 'non-secret', 'partial', 'personal-locked'] as const)(
    'admits only the required source of an absent %s configuration catalog with a locked personal secret', async variant => {
      const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'configuration-source-owner' })).toString('base64url')}.signature`, encryption: null };
      const secret = { id: 'locked-personal', name: 'Locked personal credential', kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, encryptedValue: encryptSecretStringV1('unavailable-private-value',
          new Uint8Array(32).fill(9), length => new Uint8Array(length).fill(11)) }, createdAt: 1, updatedAt: 1 };
      const entry = { service: { pluginId: 'happier.connected-account.test', localId: 'api' }, modeId: 'api-key',
        revision: 'configured', values: { endpoint: 'https://api.example.test' },
        secretRefs: variant === 'personal-locked' ? { token: secret.id } : {} };
      const entries = variant === 'empty' ? [] : variant === 'partial' ? [entry, { malformed: true }] : [entry];
      let raw: Readonly<Record<string, unknown>> = { themePreference: 'dark', secrets: [secret],
        connectedAccountServiceConfigurationsV1: { v: 1, entries } };
      let settingsVersion = 7;
      const snapshot = { source: 'network' as const, scopeKey: resolveAccountSettingsScopeKey(credentials),
        settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion, loadedAtMs: 1, settingsSecretsReadKeys: [] };
      setActiveAccountSettingsSnapshot(snapshot);
      expect(createSavedSecretMaterializerFromSnapshotV1(snapshot).resolve(secret.id)).toMatchObject({ status: 'temporarily_unavailable' });
      vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
      // The importer is real. These HTTP replies admit its actual full census;
      // a locked personal value cannot become material or be promoted.
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: { teams: { enabled: true } }, capabilities: {} })));
      let record: ConnectedAccountCatalogRecordV1 | null = null;
      const unrelatedDemands: string[] = [];
      vi.spyOn(axios, 'get').mockImplementation(async input => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path.endsWith('/connected-accounts/configurations')) return { status: 200, data: record
          ? { status: 'present', revision: 4, content: { t: 'plain', v: record } } : { status: 'absent' } };
        if (path === '/v2/account/settings') return { status: 200, data: { version: settingsVersion, content: { t: 'plain', v: raw } } };
        if (!record) unrelatedDemands.push(path);
        if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [], nextCursor: null,
          complete: true, diagnostics: [], referenceGuardRevision: 3, transferControl: { status: 'absent' } } };
        if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 3 } };
        if (path === PROFILE_TRANSFER_ROUTE_V1 || path.startsWith('/v1/account/entity-rows/')) return { status: 200, data: { status: 'absent' } };
        if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [] } };
        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
        return { status: 404, data: { error: 'unsupported' } };
      });
      vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/connected-accounts/configurations')) {
          const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
          expect(mutation.expectedRevision).toBe('absent');
          expect(mutation.sourceSettingsVersion).toBe(settingsVersion);
          if (mutation.content?.t !== 'plain') throw new Error('Expected canonical Plain initialization');
          record = mutation.content.v;
          return { status: 200, data: { status: 'updated', revision: 4, cursor: 4 } };
        }
        if (path === '/v2/account/settings') {
          const mutation = AccountSettingsV2UpdateRequestSchema.parse(body);
          expect(mutation.expectedVersion).toBe(settingsVersion);
          if (mutation.content?.t !== 'plain') throw new Error('Expected canonical Plain source cleanup');
          raw = mutation.content.v;
          settingsVersion += 1;
          return { status: 200, data: { success: true, version: settingsVersion } };
        }
        throw new Error(`Unexpected promotion or mutation: ${path}`);
      });
      const result = await createCliConnectedAccountCatalogStore({ credentials }).readCatalog('configurations');
      if (variant === 'personal-locked') {
        expect(result.status).toBe('unavailable');
        expect(unrelatedDemands).toContain(PROFILE_ROWS_ROUTE_V1);
        expect(record).toBeNull();
      } else {
        expect(unrelatedDemands).toEqual([]);
        if (variant === 'partial') {
          expect(result).toMatchObject({ status: 'partial', authority: 'inactive', revision: 'absent' });
          expect(record).toBeNull();
          expect(raw).toHaveProperty('connectedAccountServiceConfigurationsV1');
        } else {
          expect(result).toMatchObject({ status: 'ready', revision: 4, record: { key: 'configurations', value: { v: 1, entries } } });
          expect(raw).not.toHaveProperty('connectedAccountServiceConfigurationsV1');
        }
      }
      expect(raw.secrets).toEqual([secret]);
    },
  );

  it.each(['source-only', 'destination-concurrent'] as const)(
    'imports a genuine personal source before fresh configuration admission: %s', async variant => {
      const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'successful-import-owner' })).toString('base64url')}.signature`, encryption: null };
      const secret = { id: 'personal-token', name: 'Personal API credential', kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'personal-private-value' }, createdAt: 1, updatedAt: 1 };
      const entry = { service: { pluginId: 'happier.connected-account.test', localId: 'api' }, modeId: 'api-key',
        revision: 'configured', values: { endpoint: 'https://api.example.test' }, secretRefs: { token: secret.id } };
      let raw: Readonly<Record<string, unknown>> = { themePreference: 'dark', secrets: [secret],
        connectedAccountServiceConfigurationsV1: { v: 1, entries: [entry] } };
      let settingsVersion = 7;
      let record: ConnectedAccountCatalogRecordV1 | null = null;
      let revision = 4;
      let sharedRef: string | null = null;
      let resourceId: string | null = null;
      const resources: unknown[] = [];
      const events: string[] = [];
      const initializations: ReturnType<typeof ConnectedAccountCatalogRowMutationV1Schema.parse>[] = [];
      setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
        settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion, loadedAtMs: 1, settingsSecretsReadKeys: [] });
      vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: { teams: { enabled: true } }, capabilities: {} })));
      // Only HTTP and persisted credentials are substituted. S2 selection,
      // promotion preparation, response admission and materialization are real.
      vi.spyOn(axios, 'get').mockImplementation(async input => {
        const url = new URL(String(input));
        expect(url.origin).toBe('https://configuration-import-home.example');
        const path = url.pathname;
        if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1, settingsVersion,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path.endsWith('/connected-accounts/configurations')) return { status: 200, data: record
          ? { status: 'present', revision, content: { t: 'plain', v: record } } : { status: 'absent' } };
        if (path === '/v2/account/settings') {
          events.push(`source:${settingsVersion}`);
          return { status: 200, data: { version: settingsVersion, content: { t: 'plain', v: raw } } };
        }
        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200,
          data: PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: [] }) };
        if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [], nextCursor: null,
          complete: true, diagnostics: [], referenceGuardRevision: 3, transferControl: { status: 'absent' } } };
        if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 3 } };
        if (path === PROFILE_TRANSFER_ROUTE_V1 || path.startsWith('/v1/account/entity-rows/')) return { status: 200, data: { status: 'absent' } };
        if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources } };
        if (path === '/v1/artifacts') return { status: 200, data: [] };
        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
        return { status: 404, data: { error: 'unsupported' } };
      });
      vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/saved-secrets/resources/promote') {
          const mutation = SharedSavedSecretPromoteInputV1Schema.parse(body);
          expect(mutation.expectedSettingsVersion).toBe(7);
          expect(mutation.referenceCensus).toMatchObject({ accountMode: 'plain', profileTransferRevision: 'absent',
            profiles: { referenceGuardRevision: 3, rows: [] } });
          expect(mutation.profileMutations).toEqual([]);
          expect(mutation.catalogMutations?.connectedConfigurations).toBeUndefined();
          if (mutation.nextSettings?.t !== 'plain') throw new Error('Expected canonical Plain S2 promotion');
          raw = mutation.nextSettings.v;
          resourceId = mutation.resourceId;
          sharedRef = `happier:shared-secret:v1:${resourceId}`;
          expect(raw).toMatchObject({ secrets: [], connectedAccountServiceConfigurationsV1: { entries: [{ secretRefs: { token: sharedRef } }] } });
          resources.push({ resourceId, encryptionMode: 'plain', storedContent: mutation.storedContent, recipientEnvelope: null,
            entry: { ref: sharedRef, source: 'shared_resource', relationship: 'owner', ownerAccountId: 'successful-import-owner',
              name: mutation.displayName, kind: mutation.kind, revision: 1, materialStatus: 'ready',
              capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } });
          events.push('promote');
          settingsVersion = 8;
          // This is an independently concurrent Home admission, not a claim
          // that absent-row S2 promotion writes a destination catalog.
          if (variant === 'destination-concurrent') {
            record = { key: 'configurations', value: { v: 1, entries: [{ ...entry, secretRefs: { token: sharedRef } }] } };
            revision = 9;
          }
          return { status: 200, data: { resourceId, settingsVersion } };
        }
        if (path.endsWith('/connected-accounts/configurations')) {
          const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
          expect(events).toContain('promote');
          expect(events.slice(events.indexOf('promote') + 1)).toContain('source:8');
          expect(mutation.expectedRevision).toBe('absent');
          expect(mutation.sourceSettingsVersion).toBe(8);
          expect(mutation.referencedSavedSecretIds).toEqual([sharedRef]);
          expect(mutation.savedSecretRevisions).toEqual([{ resourceId, expectedRevision: 1 }]);
          if (mutation.content?.t !== 'plain') throw new Error('Expected canonical Plain initialization');
          expect(mutation.content.v).toMatchObject({ key: 'configurations', value: { entries: [{ ...entry, secretRefs: { token: sharedRef } }] } });
          events.push('initialize');
          initializations.push(mutation);
          if (record) return { status: 409, data: { status: 'conflict', revision } };
          record = mutation.content.v;
          return { status: 200, data: { status: 'updated', revision, cursor: revision } };
        }
        if (path === '/v2/account/settings') {
          const mutation = AccountSettingsV2UpdateRequestSchema.parse(body);
          expect(mutation.expectedVersion).toBe(settingsVersion);
          if (mutation.content?.t !== 'plain') throw new Error('Expected canonical Plain source cleanup');
          raw = mutation.content.v;
          return { status: 200, data: { success: true, version: ++settingsVersion } };
        }
        throw new Error(`Unexpected mutation: ${path}`);
      });
      const result = await runWithServerHttpBaseUrl('https://configuration-import-home.example', () =>
        createCliConnectedAccountCatalogStore({ credentials }).readCatalog('configurations'));
      expect(events.filter(event => event === 'promote')).toEqual(['promote']);
      expect(initializations).toHaveLength(1);
      expect(result).toMatchObject({ status: 'ready', revision: variant === 'destination-concurrent' ? 9 : 4,
        record: { key: 'configurations', value: { entries: [{ ...entry, secretRefs: { token: sharedRef } }] } } });
      expect(record).toMatchObject({ value: { entries: [{ secretRefs: { token: sharedRef } }] } });
      expect(raw.secrets).toEqual([]);
      expect(raw).not.toHaveProperty('connectedAccountServiceConfigurationsV1');
    },
  );

  it('opens an existing configuration row without importing unrelated retained personal secrets', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'catalog-owner' })).toString('base64url')}.signature`, encryption: null };
    const raw = { themePreference: 'dark', secrets: [{ id: 'retained-personal', name: 'Retained unrelated credential',
      kind: 'apiKey', encryptedValue: { _isSecretValue: true, value: 'retained-private-value' }, createdAt: 1, updatedAt: 1 }] };
    const record = { key: 'configurations' as const, value: { v: 1 as const, entries: [{
      service: { pluginId: 'happier.connected-account.test', localId: 'api' }, modeId: 'api-key',
      revision: 'configured', values: { endpoint: 'https://api.example.test' }, secretRefs: {},
    }] } };
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    // HTTP and persisted credentials are genuine boundaries. A destination
    // read may clean its own retained source, but cannot activate other catalogs.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const unrelatedDemands: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path.endsWith('/connected-accounts/configurations')) return { status: 200, data: {
        status: 'present', revision: 4, content: { t: 'plain', v: record } } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: raw } } };
      // The incumbent history owner probes raw transfer authority without
      // activating Profiles; unsupported proof leaves cleanup pending.
      if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 404, data: { error: 'unsupported' } };
      if (path.includes('/settings/history')) return { status: 404, data: { error: 'unsupported' } };
      unrelatedDemands.push(path);
      return { status: 404, data: { error: 'unsupported' } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async input => {
      throw new Error(`Unexpected mutation: ${new URL(String(input)).pathname}`);
    });
    await expect(createCliConnectedAccountCatalogStore({ credentials }).readCatalog('configurations')).resolves.toMatchObject({
      status: 'ready', revision: 4, record,
    });
    expect(unrelatedDemands).toEqual([]);
  });

  it.each(['connectedServicesDefaultAuthByAgentIdV1', 'connectedServicesAdditionalDefaultAuthByAgentIdV1'] as const)(
    'initializes an absent purpose row from genuine predecessor %s through current Agent declarations', async carrier => {
      const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'purpose-import-owner' })).toString('base64url')}.signature`, encryption: null };
      const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
      const purpose = { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' };
      const raw = { futurePreference: { retained: true }, [carrier]: { v: 1, bindingsByAgentId: { codex: {
        v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'group', groupId: 'predecessor-group' } },
      } } } };
      setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
        settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] });
      let record: ConnectedAccountCatalogRecordV1 | null = null;
      vi.spyOn(axios, 'get').mockImplementation(async input => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: record
          ? { status: 'present', revision: 4, content: { t: 'plain', v: record } } : { status: 'absent' } };
        if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: raw } } };
        return { status: 404, data: { error: 'unsupported' } };
      });
      vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
        expect(new URL(String(input)).pathname).toBe('/v1/account/entity-rows/connected-accounts/purposes');
        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(body);
        expect(mutation.expectedRevision).toBe('absent');
        expect(mutation.sourceSettingsVersion).toBe(7);
        if (mutation.content?.t !== 'plain') throw new Error('Expected canonical Plain initialization');
        record = mutation.content.v;
        return { status: 200, data: { status: 'updated', revision: 4, cursor: 4 } };
      });
      await expect(createCliConnectedAccountCatalogStore({ credentials }).readCatalog('purposes')).resolves.toMatchObject({
        status: 'ready', revision: 4, record: { key: 'purposes', value: { v: 1, bindings: [{ purpose,
          target: { kind: 'group', service, groupId: 'predecessor-group' } }] } },
      });
      expect(record).toMatchObject({ key: 'purposes', value: { bindings: [{ purpose,
        target: { kind: 'group', service, groupId: 'predecessor-group' } }] } });
    },
  );
});
