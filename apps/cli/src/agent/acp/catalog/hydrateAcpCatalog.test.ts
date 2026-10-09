import '@happier-dev/protocol';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveConfiguredAcpBackendFromAccountSettings } from './configured/resolveBackend';
import { refreshActiveAcpCatalog, refreshDemandedActiveAcpCatalog } from './hydrateAcpCatalog';
import * as persistence from '@/persistence';
import { createCliAcpCatalogStore } from './acpCatalogStore';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

function account(token = 'acp-catalog') {
  const credentials = { token, encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
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
    const historyWrites: unknown[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        ...currentness, settingsVersion: acknowledged ? 8 : 7,
      } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: retained } } };
      if (path === '/v1/account/entity-rows/acp') return { status: 200, data: acknowledged
        ? { status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, definitions: [] } } }
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
        expect(body).toMatchObject({ expectedRevision: 'absent', source: 'fresh', sourceSettingsVersion: 7,
          settingsCleanup: { expectedSettingsVersion: 7, nextSettings: { t: 'plain', v: { neighboringRoot: { keep: true } } } },
        });
        acknowledged = true;
        return { status: 200, data: { status: 'updated', revision: 0, cursor: 12 } };
      }
      if (path === '/v2/account/settings/history/7/mutate') {
        historyWrites.push(body);
        return historyUnavailable ? { status: 503, data: {} } : { status: 200, data: { status: 'applied' } };
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
