import '@happier-dev/protocol';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AcpCatalogRecordV1Schema, AcpCatalogRowMutationV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveConfiguredAcpBackendFromAccountSettings } from './configured/resolveBackend';
import { refreshActiveAcpCatalog, refreshDemandedActiveAcpCatalog } from './hydrateAcpCatalog';
import * as persistence from '@/persistence';
import { createCliAcpCatalogStore } from './acpCatalogStore';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { readAcpCatalogTransferSourceV2 } from '@happier-dev/protocol/acp/catalog/transferAcpCatalogV2';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { readSavedSecretTransferSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

function account(token = 'acp-catalog', rawSettings: Readonly<Record<string, unknown>> = {}) {
  const credentials = { token, encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(rawSettings), rawSettings,
    settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  return credentials;
}
const record = (command: string) => AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
  id: 'review', name: 'review', title: 'Review', command, args: ['acp'], env: {}, capabilities: {
    supportsLoadSession: true, supportsModes: 'unknown', supportsModels: 'unknown', supportsConfigOptions: 'unknown', promptImageSupport: 'no',
  }, createdAt: 1, updatedAt: 2,
}] });
const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };

describe('ACP Account catalog hydration', () => {
  it('promotes the original personal source before atomically transferring ACP and applying its numeric edit', async () => {
    const original = record('original-personal-source');
    const secret = { id: 'personal-acp-token', name: 'ACP credential', kind: 'apiKey',
      encryptedValue: { _isSecretValue: true, value: 'private-source-value' }, createdAt: 1, updatedAt: 1 };
    let raw: Readonly<Record<string, unknown>> = { themePreference: 'dark', secrets: [secret],
      acpCatalogSettingsV1: { v: 2, backends: original.definitions.map(backend => ({ ...backend,
        env: { API_TOKEN: { t: 'savedSecret', secretId: secret.id } } })) } };
    const credentials = account(`header.${Buffer.from(JSON.stringify({ sub: 'acp-personal-source-owner' })).toString('base64url')}.signature`, raw);
    let settingsVersion = 7;
    expect(readAcpCatalogTransferSourceV2({ rawSettings: raw, sourceSettingsVersion: settingsVersion })).toMatchObject({
      status: 'ready', references: [{ secretId: secret.id }],
    });
    expect(readSavedSecretTransferSourceV1(raw)).toMatchObject({ complete: true, secrets: [secret] });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({
      features: { teams: { enabled: true } }, capabilities: {},
    }))));
    let catalog: ReturnType<typeof record> | null = null;
    let revision = -1;
    let sharedRef: string | null = null;
    let resourceId: string | null = null;
    const resources: unknown[] = [];
    const events: string[] = [];
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { ...currentness, settingsVersion } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/acp') return { status: 200, data: catalog
        ? { status: 'present', revision, content: { t: 'plain', v: catalog } } : { status: 'absent' } };
      if (path === '/v2/account/settings') { events.push(`source:${settingsVersion}`); return { status: 200,
        data: { version: settingsVersion, content: { t: 'plain', v: raw } } }; }
      if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [], nextCursor: null,
        complete: true, diagnostics: [], referenceGuardRevision: 3, transferControl: { status: 'absent' } } };
      if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 3 } };
      if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
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
        expect(mutation).toMatchObject({ expectedSettingsVersion: 7, personalSecretPromotions: [{ personalSecretId: secret.id }],
          referenceCensus: { accountMode: 'plain', catalogs: { acp: 'absent' } } });
        expect(mutation.catalogMutations?.acp).toBeUndefined();
        if (mutation.nextSettings?.t !== 'plain') throw new Error('Expected original Plain source promotion');
        raw = mutation.nextSettings.v;
        resourceId = mutation.resourceId;
        sharedRef = `happier:shared-secret:v1:${resourceId}`;
        expect(raw).toMatchObject({ secrets: [], acpCatalogSettingsV1: { backends: [{ command: original.definitions[0].command,
          env: { API_TOKEN: { t: 'savedSecret', secretId: sharedRef } } }] } });
        resources.push({ resourceId, encryptionMode: 'plain', storedContent: mutation.storedContent, recipientEnvelope: null,
          entry: { ref: sharedRef, source: 'shared_resource', relationship: 'owner', ownerAccountId: 'acp-personal-source-owner',
            name: mutation.displayName, kind: mutation.kind, revision: 1, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } });
        events.push('promote');
        return { status: 200, data: { resourceId, settingsVersion: ++settingsVersion } };
      }
      if (path === '/v1/account/entity-rows/acp') {
        const mutation = AcpCatalogRowMutationV1Schema.parse(body);
        expect(sharedRef).not.toBeNull();
        expect(mutation.savedSecretRevisions).toEqual([{ resourceId, expectedRevision: 1 }]);
        if (mutation.content.t !== 'plain') throw new Error('Expected Plain ACP destination');
        if (revision === -1) {
          expect(events.slice(events.indexOf('promote') + 1)).toContain('source:8');
          expect(mutation).toMatchObject({ expectedRevision: 'absent', source: 'predecessor', sourceSettingsVersion: 8,
            settingsCleanup: { expectedSettingsVersion: 8, nextSettings: { t: 'plain', v: { themePreference: 'dark', secrets: [] } } },
            content: { v: { definitions: [{ command: original.definitions[0].command }] } } });
          if (mutation.settingsCleanup?.nextSettings.t !== 'plain') throw new Error('Expected atomic source cleanup');
          raw = mutation.settingsCleanup.nextSettings.v;
          settingsVersion += 1;
          events.push('transfer');
        } else {
          expect(mutation.expectedRevision).toBe(0);
          expect(mutation).not.toHaveProperty('settingsCleanup');
          events.push('edit');
        }
        catalog = mutation.content.v;
        return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision + 1 } };
      }
      throw new Error(`Unexpected personal ACP mutation: ${path}`);
    });
    const stale = await createCliAcpCatalogStore({ credentials }).updateCatalog(() => {
      throw new Error('A stale source cannot admit the edit');
    }, { expectedRevision: 'absent', sourceSettingsVersion: 6 });
    expect(stale).toEqual({ status: 'settings-conflict', revision: 7 });
    expect(events).not.toContain('promote');
    const result = await createCliAcpCatalogStore({ credentials }).updateCatalog(current => {
      expect(current).toMatchObject({ backends: [{ command: original.definitions[0].command,
        env: { API_TOKEN: { t: 'savedSecret', secretId: sharedRef } } }] });
      return { v: 2, backends: original.definitions.map(backend => ({ ...backend, command: 'edited-after-transfer',
        env: { API_TOKEN: { t: 'savedSecret', secretId: sharedRef } } })) };
    }, { expectedRevision: 'absent', sourceSettingsVersion: 7 });
    expect(result).toMatchObject({ status: 'updated', revision: 1 });
    expect(events.filter(event => ['promote', 'transfer', 'edit'].includes(event))).toEqual(['promote', 'transfer', 'edit']);
    expect(raw).toEqual({ themePreference: 'dark', secrets: [] });
    expect(catalog).toMatchObject({ definitions: [{ command: 'edited-after-transfer', env: { API_TOKEN: { secretId: sharedRef } } }] });
  });
  it('retains the acknowledged original-source revision when retirement refuses the numeric candidate', async () => {
    const credentials = account();
    const original = record('original-source');
    const rawSettings = { schemaVersion: 6, acpCatalogSettingsV1: { v: 2, backends: original.definitions } };
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (pathname === '/v1/account/entity-rows/acp') return { status: 200, data: { status: 'absent' } };
      if (pathname === '/v2/account/settings') return { status: 200, data: {
        version: 7, content: { t: 'plain', v: rawSettings },
      } };
      throw new Error(`Unexpected source admission request: ${pathname}`);
    });
    const writes: unknown[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      expect(new URL(String(input)).pathname).toBe('/v1/account/entity-rows/acp');
      const mutation = AcpCatalogRowMutationV1Schema.parse(body);
      expect(mutation).toMatchObject({ expectedRevision: 'absent', source: 'predecessor', sourceSettingsVersion: 7,
        content: { t: 'plain', v: original }, settingsCleanup: { expectedSettingsVersion: 7 } });
      writes.push(mutation);
      // The actual HTTP boundary returns the original-source acknowledgement
      // after the caller's Account retires. It never acknowledges the user delta.
      account('replacement-account');
      return { status: 200, data: { status: 'updated', revision: 0, cursor: 1 } };
    });
    await expect(createCliAcpCatalogStore({ credentials }).updateCatalog(() => ({
      v: 2, backends: original.definitions.map(backend => ({ ...backend, command: 'candidate-not-written' })),
    }))).rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE', reason: 'scope-retired', revision: 0 });
    expect(writes).toHaveLength(1);
    expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe(resolveAccountSettingsScopeKey({ token: 'replacement-account', encryption: null }));
    expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toBeUndefined();
  });
  it('returns the canonical published snapshot when the same authoritative row is refreshed again', async () => {
    const credentials = account();
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v1/account/entity-rows/acp') return { status: 200, data: {
        status: 'present', revision: 4, content: { t: 'plain', v: record('unchanged') },
      } };
      throw new Error(`Unexpected ACP observation: ${path}`);
    });
    const published: unknown[] = [];
    const unsubscribe = subscribeActiveAccountSettingsSnapshot((_previous, next) => {
      if (next?.acpCatalog?.status === 'ready') published.push(next.acpCatalog);
    });
    try {
      const first = await refreshActiveAcpCatalog({ credentials });
      expect(first).toBe(getActiveAccountSettingsSnapshot()?.acpCatalog);
      const second = await refreshActiveAcpCatalog({ credentials });
      expect(second).toBe(getActiveAccountSettingsSnapshot()?.acpCatalog);
      expect(second).toBe(first);
      expect(published).toEqual([first]);
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
    } finally { unsubscribe(); }
  });
  it('edits through the catalog row CAS and keeps the preference document unchanged', async () => {
    const credentials = account();
    let currentRecord = record('before');
    let revision = 4;
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v1/account/entity-rows/acp') return { status: 200, data: {
        status: 'present', revision, content: { t: 'plain', v: currentRecord },
      } };
      throw new Error(`Unexpected ACP mutation read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      expect(new URL(String(input)).pathname).toBe('/v1/account/entity-rows/acp');
      expect(body.expectedRevision).toBe(4);
      expect(body).not.toHaveProperty('sourceSettingsVersion');
      currentRecord = body.content.v;
      revision = 5;
      return { status: 200, data: { status: 'updated', revision, cursor: 12 } };
    });
    const result = await createCliAcpCatalogStore({ credentials }).updateCatalog(current => {
      expect(current).toMatchObject({ v: 2, backends: [{ command: 'before' }] });
      return { v: 2, backends: currentRecord.definitions.map(backend => ({ ...backend, command: 'after' })) };
    });
    expect(result).toMatchObject({ status: 'updated', revision: 5 });
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
    expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toMatchObject({ status: 'ready', revision: 5,
      record: { definitions: [{ command: 'after' }] } });
  });
  it('publishes catalog-only wakes to the real configured resolver without advancing Settings', async () => {
    const credentials = account();
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    let revision = 1;
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v1/account/entity-rows/acp') return { status: 200, data: {
        status: 'present', revision, content: { t: 'plain', v: record(`command-${revision}`) },
      } };
      throw new Error(`Unexpected ACP read: ${path}`);
    });
    const notifications: string[] = [];
    const unsubscribe = subscribeActiveAccountSettingsSnapshot((_previous, next) => {
      if (next?.acpCatalog?.status === 'ready') notifications.push(next.acpCatalog.record.definitions[0].command);
    });
    try {
      await refreshActiveAcpCatalog({ credentials });
      revision = 2;
      await refreshDemandedActiveAcpCatalog({ token: credentials.token });
      const snapshot = getActiveAccountSettingsSnapshot()!;
      expect(snapshot.settingsVersion).toBe(7);
      expect(snapshot.rawSettings).toEqual({});
      expect(resolveConfiguredAcpBackendFromAccountSettings(snapshot.settings, 'review', snapshot.acpCatalog))
        .toMatchObject({ command: 'command-2' });
      expect(notifications).toEqual(['command-1', 'command-2']);
    } finally { unsubscribe(); }
  });

  it('observes authoritative empty fresh Accounts without mutation and captures initial Settings CAS', async () => {
    const credentials = account();
    let content: unknown = null;
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      if (path === '/v1/account/entity-rows/acp') return { status: 200, data: content
        ? { status: 'present', revision: 0, content } : { status: 'absent' } };
      throw new Error(`Unexpected ACP initialization read: ${path}`);
    });
    const post = vi.spyOn(axios, 'post');
    expect(await refreshActiveAcpCatalog({ credentials })).toEqual({ status: 'ready', record: { v: 1, definitions: [] }, revision: 'absent', source: 'fresh', sourceSettingsVersion: 7 });
    expect(post).not.toHaveBeenCalled();
    expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(7);
  });

  it('keeps a tombstone as numeric empty authority without reopening retained sources', async () => {
    const credentials = account();
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v1/account/entity-rows/acp') return { status: 200, data: { status: 'deleted', revision: 6 } };
      throw new Error(`Tombstone must not reopen ${path}`);
    });
    const post = vi.spyOn(axios, 'post');
    expect(await refreshActiveAcpCatalog({ credentials })).toEqual({ status: 'ready', revision: 6, record: { v: 1, definitions: [] } });
    expect(post).not.toHaveBeenCalled();
  });

  it('preserves a malformed retained recipe and refuses empty activation', async () => {
    const credentials = account();
    const retained = { acpCatalogSettingsV1: { v: 2, backends: [{ id: 'kiro', transportProfile: 'kiro',
      auth: { statusCommand: ['whoami'], parser: 'kiroWhoamiJson' } }] } };
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: retained } } };
      if (path === '/v1/account/entity-rows/acp') return { status: 200, data: { status: 'absent' } };
      throw new Error(`Unexpected retained ACP read: ${path}`);
    });
    const post = vi.spyOn(axios, 'post');
    expect(await refreshActiveAcpCatalog({ credentials })).toMatchObject({ status: 'partial', reason: 'incomplete-inventory',
      record: { v: 1, definitions: [] }, diagnostics: [{ path: 'backends[0]', reason: 'invalid_definition' }] });
    expect(post).not.toHaveBeenCalled();
    expect(retained.acpCatalogSettingsV1.backends[0].auth.parser).toBe('kiroWhoamiJson');
  });

  it('transfers the complete retained recipe before applying an ordinary deletion CAS', async () => {
    const credentials = account();
    const retained = { unaffectedPreference: 'keep', acpCatalogSettingsV1: { v: 2, backends: [{
      ...record('retained-kiro').definitions[0], transportProfile: 'kiro',
      auth: { support: 'login_terminal', loginCommand: { command: 'retained-login', args: ['login'] },
        statusCommand: ['whoami', '--json'], parser: 'kiroWhoamiJson' },
    }] } };
    const before = structuredClone(retained);
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: retained } } };
      if (path === '/v1/account/entity-rows/acp') return { status: 200, data: { status: 'absent' } };
      throw new Error(`Unexpected retained ACP transfer read: ${path}`);
    });
    const writes: unknown[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      expect(new URL(String(input)).pathname).toBe('/v1/account/entity-rows/acp');
      writes.push(body);
      return { status: 200, data: { status: 'updated', revision: writes.length + 3, cursor: writes.length + 10 } };
    });
    const result = await createCliAcpCatalogStore({ credentials }).updateCatalog(() => ({ v: 2, backends: [] }));
    expect(result).toMatchObject({ status: 'updated', revision: 5 });
    expect(writes).toEqual([
      expect.objectContaining({ expectedRevision: 'absent', source: 'predecessor', sourceSettingsVersion: 7,
        settingsCleanup: { expectedSettingsVersion: 7, nextSettings: { t: 'plain', v: { unaffectedPreference: 'keep' } } },
        content: { t: 'plain', v: { v: 1, definitions: [expect.objectContaining({ command: 'retained-kiro',
          auth: { support: 'login_terminal', loginCommand: { command: 'retained-login', args: ['login'] } },
          runtime: { stderrRules: expect.any(Object) }, compatibility: { source: 'acp-catalog-v2', authStatus: {
            statusCommand: ['whoami', '--json'], parser: 'kiroWhoamiJson',
          } },
        })] } } }),
      expect.objectContaining({ expectedRevision: 4, content: { t: 'plain', v: { v: 1, definitions: [] } } }),
    ]);
    expect(writes[1]).not.toHaveProperty('sourceSettingsVersion');
    expect(writes[1]).not.toHaveProperty('source');
    expect(retained).toEqual(before);
    expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toMatchObject({ status: 'ready', revision: 5, record: { definitions: [] } });
  });

  it('removes an explicitly empty retained root in the same fresh catalog write without losing neighboring Settings', async () => {
    const credentials = account();
    const retained = { neighboringRoot: { nested: 'preserve-exactly' }, acpCatalogSettingsV1: { v: 2, backends: [] } };
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: retained } } };
      if (path === '/v1/account/entity-rows/acp') return { status: 200, data: { status: 'absent' } };
      throw new Error(`Unexpected empty retained ACP read: ${path}`);
    });
    const writes: unknown[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      expect(new URL(String(input)).pathname).toBe('/v1/account/entity-rows/acp');
      writes.push(body);
      return { status: 200, data: { status: 'updated', revision: 0, cursor: 10 } };
    });
    expect(await createCliAcpCatalogStore({ credentials }).updateCatalog(() => ({ v: 2, backends: record('new').definitions })))
      .toMatchObject({ status: 'updated', revision: 0 });
    expect(writes).toEqual([expect.objectContaining({ expectedRevision: 'absent', source: 'fresh', sourceSettingsVersion: 7,
      settingsCleanup: { expectedSettingsVersion: 7, nextSettings: { t: 'plain', v: { neighboringRoot: { nested: 'preserve-exactly' } } } },
    })]);
    expect(retained.acpCatalogSettingsV1).toEqual({ v: 2, backends: [] });
  });

  it.each([false, true])('preserves the initial row ACK and reports post-transfer history maintenance (pending=%s)', async historyUnavailable => {
    const credentials = account();
    const retained = { neighboringRoot: { keep: true }, acpCatalogSettingsV1: { v: 2, backends: [] } };
    let acknowledged = false;
    let rowRevision = -1;
    let authoritativeRecord: ReturnType<typeof record> = { v: 1, definitions: [] };
    const catalogWrites: unknown[] = [];
    const historyWrites: unknown[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        ...currentness, settingsVersion: acknowledged ? 8 : 7,
      } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: retained } } };
      if (path === '/v1/account/entity-rows/acp') return { status: 200, data: acknowledged
        ? { status: 'present', revision: rowRevision, content: { t: 'plain', v: authoritativeRecord } }
        : { status: 'absent' } };
      if (path === '/v1/account/entity-rows/prompt-library') return { status: 404, data: {} };
      if (path.startsWith('/v1/account/entity-rows/')) return { status: 200, data: { status: 'absent' } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{
        version: 7, contentKind: 'plain', byteLength: 100, createdAt: '2026-10-09T00:00:00.000Z',
      }] } };
      if (path === '/v2/account/settings/history/7') return { status: 200, data: {
        version: 7, content: { t: 'plain', v: retained }, createdAt: '2026-10-09T00:00:00.000Z',
      } };
      throw new Error(`Unexpected ACP history read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/entity-rows/acp') {
        const mutation = AcpCatalogRowMutationV1Schema.parse(body);
        if (!acknowledged) expect(mutation).toMatchObject({ expectedRevision: 'absent', source: 'fresh', sourceSettingsVersion: 7,
          settingsCleanup: { expectedSettingsVersion: 7, nextSettings: { t: 'plain', v: { neighboringRoot: { keep: true } } } } });
        else expect(mutation).toMatchObject({ expectedRevision: rowRevision });
        if (mutation.content.t !== 'plain') throw new Error('Expected plain ACP test row');
        authoritativeRecord = AcpCatalogRecordV1Schema.parse(mutation.content.v);
        catalogWrites.push(mutation);
        acknowledged = true;
        rowRevision += 1;
        return { status: 200, data: { status: 'updated', revision: rowRevision, cursor: 12 + rowRevision } };
      }
      if (path === '/v2/account/settings/history/7/mutate') {
        historyWrites.push(body);
        return historyUnavailable && historyWrites.length === 1 ? { status: 503, data: {} } : { status: 200, data: { status: 'applied' } };
      }
      throw new Error(`Unexpected ACP history mutation: ${path}`);
    });
    const result = await createCliAcpCatalogStore({ credentials }).updateCatalog(() => ({ v: 2, backends: [] }));
    expect(result).toMatchObject({ status: 'updated', revision: 0, cursor: 12, cleanup: historyUnavailable
      ? { status: 'cleanup-pending', reason: 'history-incomplete' } : { status: 'complete' } });
    expect(historyWrites).toEqual([expect.objectContaining({ expectedSettingsVersion: 8,
      operation: expect.objectContaining({ kind: 'normalize', removedRoots: ['acpCatalogSettingsV1'],
        transferredPrivateCatalogRevisions: { acp: 0 }, content: { t: 'plain', v: { neighboringRoot: { keep: true } } },
      }),
    })]);
    expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toMatchObject({ status: 'ready', revision: 0, record: { definitions: [] } });
    if (historyUnavailable) {
      const retry = await createCliAcpCatalogStore({ credentials }).updateCatalog(() => ({ v: 2, backends: record('retry').definitions }));
      expect(retry).toMatchObject({ status: 'updated', revision: 1, cleanup: { status: 'complete' } });
      expect(catalogWrites).toHaveLength(2);
      expect(catalogWrites[1]).not.toHaveProperty('source');
      expect(catalogWrites[1]).not.toHaveProperty('sourceSettingsVersion');
      expect(catalogWrites[1]).not.toHaveProperty('settingsCleanup');
      expect(historyWrites).toHaveLength(2);
      expect(historyWrites[1]).toMatchObject({ operation: { transferredPrivateCatalogRevisions: { acp: 1 } } });
      expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toMatchObject({ status: 'ready', revision: 1, record: { definitions: [{ command: 'retry' }] } });
    }
    expect(retained).toEqual({ neighboringRoot: { keep: true }, acpCatalogSettingsV1: { v: 2, backends: [] } });
  });

  it('does not publish a response from a retired Home even when its scope is reused', async () => {
    const credentials = account();
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let rowRequested = false;
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v1/account/entity-rows/acp') { rowRequested = true; await delayed; return { status: 200,
        data: { status: 'present', revision: 1, content: { t: 'plain', v: record('retired') } } }; }
      throw new Error(`Unexpected ACP retirement read: ${path}`);
    });
    const pending = refreshActiveAcpCatalog({ credentials });
    try {
      await vi.waitFor(() => expect(rowRequested).toBe(true));
      account('other-account');
      account();
      release();
      expect(await pending).toEqual({ status: 'unavailable', reason: 'scope-retired' });
      expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toBeUndefined();
    } finally { release(); await pending; }
  });

  it('withdraws invocation ACP authority during refresh and does not regress its acknowledged row revision', async () => {
    const credentials = account();
    const snapshot = getActiveAccountSettingsSnapshot()!;
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
      snapshot: { ...snapshot, acpCatalog: { status: 'ready', revision: 5, record: record('current') } }, isCurrent: async () => true });
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let rowRequested = false;
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v1/account/entity-rows/acp') { rowRequested = true; await delayed; return { status: 200,
        data: { status: 'present', revision: 4, content: { t: 'plain', v: record('older') } } }; }
      throw new Error(`Unexpected invocation ACP read: ${path}`);
    });
    const pending = refreshActiveAcpCatalog({ credentials, operationContext });
    try {
      await vi.waitFor(() => expect(rowRequested).toBe(true));
      expect(operationContext.readSnapshot()?.acpCatalog).toEqual({ status: 'loading' });
      release();
      expect(await pending).toEqual({ status: 'unavailable', reason: 'source-stale' });
      expect(operationContext.readSnapshot()?.acpCatalog).toEqual({ status: 'loading' });
      expect(getActiveAccountSettingsSnapshot()?.acpCatalog).toBeUndefined();
    } finally { release(); await pending; }
  });
});
