import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import type { RawSessionListRow, RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { createAuthenticationHttpStatusError } from '@/api/client/httpStatusError';
import {
  SessionOwnerMetadataV1Schema,
  sealSessionOwnerMetadataV1,
} from '@happier-dev/protocol';
import { createPluginSessionsInventory } from './pluginSessionsInventory';

const credentials = {
  token: 'account-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32) },
} satisfies Credentials;

function rawSession(overrides: Partial<RawSessionRecord> & Pick<RawSessionRecord, 'id'>): RawSessionRecord {
  return {
    seq: 1,
    createdAt: 10,
    updatedAt: 20,
    active: false,
    activeAt: 15,
    archivedAt: null,
    encryptionMode: 'plain',
    metadata: JSON.stringify({
      machineId: 'machine-a',
      projectId: 'project-a',
      summary: { text: `Title ${overrides.id}` },
      flavor: 'claude',
    }),
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    dataEncryptionKey: null,
    ...overrides,
  };
}

function createInventory(params?: {
  pages?: Readonly<Record<string, readonly RawSessionListRow[]>>;
  archivedPages?: Readonly<Record<string, readonly RawSessionListRow[]>>;
  currentSessionId?: string;
  isCurrent?: () => boolean;
}) {
  const pages = params?.pages ?? {
    first: [rawSession({ id: 'session-current', active: true })],
  };
  const fetchPage = vi.fn(async ({ cursor, archivedOnly }: { cursor?: string; archivedOnly?: boolean }) => {
    const selectedPages = archivedOnly ? (params?.archivedPages ?? {}) : pages;
    const key = cursor ?? 'first';
    const items = [...(selectedPages[key] ?? [])];
    const keys = Object.keys(selectedPages);
    const index = keys.indexOf(key);
    const next = index >= 0 && index + 1 < keys.length ? keys[index + 1] : null;
    return { sessions: items, nextCursor: next, hasNext: next !== null };
  });
  const all = [...Object.values(pages).flat(), ...Object.values(params?.archivedPages ?? {}).flat()];
  const fetchById = vi.fn(async ({ sessionId }: { sessionId: string }) =>
    all.find((item) => item.id === sessionId) as RawSessionRecord | undefined ?? null);

  return {
    fetchPage,
    fetchById,
    inventory: createPluginSessionsInventory({
      credentials,
      currentSessionId: params?.currentSessionId ?? 'session-current',
      isCurrent: params?.isCurrent ?? (() => true),
      readStoragePolicy: async () => 'optional',
      fetchPage,
      fetchById,
      watchPollIntervalMs: 5,
    }),
  };
}

describe('plugin sessions inventory public service boundary', () => {
  it('lists the authorized global inventory across machines with filters and opaque pagination', async () => {
    const other = rawSession({
      id: 'session-other',
      updatedAt: 30,
      metadata: JSON.stringify({ machineId: 'machine-b', projectId: 'project-b', flavor: 'codex' }),
    });
    const { inventory } = createInventory({
      pages: {
        first: [rawSession({ id: 'session-current', active: true })],
        second: [other],
      },
    });

    const first = await inventory.list({ limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual(['session-current']);
    expect(first.nextCursor).toEqual(expect.stringMatching(/^plugin_sessions_v1_/));
    await expect(inventory.list({ cursor: first.nextCursor, limit: 1 })).resolves.toMatchObject({
      items: [{ id: 'session-other', machineId: 'machine-b', projectId: 'project-b', agentId: 'codex' }],
    });
    await expect(inventory.list({ machineId: 'machine-b' })).resolves.toMatchObject({
      items: [{ id: 'session-other' }],
    });
  });

  it('reads owner-authorized session identity from the layout-v1 owner envelope', async () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        machineId: 'machine-layout1',
        projectId: 'project-layout1',
        flavor: 'grok',
      },
    });
    const layout1 = rawSession({
      id: 'session-layout1',
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({
        v: 1,
        summary: { text: 'Layout 1 title', updatedAt: 20 },
        agentPresentation: { agentId: 'grok' },
      }),
      ownerMetadata: sealSessionOwnerMetadataV1({
        material: { type: 'legacy', secret: credentials.encryption.secret },
        ownerMetadata,
        randomBytes: (length) => new Uint8Array(length).fill(7),
      }),
    });
    const { inventory } = createInventory({ pages: { first: [layout1] } });

    await expect(inventory.list()).resolves.toMatchObject({
      items: [{
        id: 'session-layout1',
        title: 'Layout 1 title',
        machineId: 'machine-layout1',
        projectId: 'project-layout1',
        agentId: 'grok',
      }],
    });
  });

  it('uses the same summary owner for current and global get while leaving messaging typed-unavailable', async () => {
    const { inventory } = createInventory();
    const global = await inventory.get('session-current');

    await expect(inventory.current.summary()).resolves.toEqual(await global?.summary());
    await expect(inventory.current.send({ kind: 'userText', text: 'hi' }))
      .rejects.toMatchObject({ code: 'plugin_session_messaging_unavailable' });
    expect(() => inventory.current.watch(() => {})).toThrow(expect.objectContaining({
      code: 'plugin_session_messaging_unavailable',
    }));
  });

  it('includes the canonical archived route in global listing and filtering', async () => {
    const archived = rawSession({ id: 'session-archived', archivedAt: 50, updatedAt: 50 });
    const { inventory, fetchPage } = createInventory({
      archivedPages: { first: [archived] },
    });

    await expect(inventory.list({ state: 'archived' })).resolves.toMatchObject({
      items: [{ id: 'session-archived', state: 'archived' }],
    });
    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ archivedOnly: true }));
  });

  it('keeps server-supplemented initial rows in a bounded stable local page', async () => {
    const supplemented = [
      rawSession({ id: 'session-pinned' }),
      rawSession({ id: 'session-attention' }),
      rawSession({ id: 'session-regular' }),
    ];
    const fetchPage = vi.fn(async ({ archivedOnly }: { archivedOnly?: boolean }) => ({
      sessions: archivedOnly ? [] : supplemented,
      nextCursor: null,
      hasNext: false,
    }));
    const inventory = createPluginSessionsInventory({
      credentials,
      currentSessionId: 'session-regular',
      isCurrent: () => true,
      readStoragePolicy: async () => 'optional',
      fetchPage,
      fetchById: async ({ sessionId }) => supplemented.find((item) => item.id === sessionId) ?? null,
    });

    const first = await inventory.list({ limit: 1 });
    const second = await inventory.list({ limit: 1, cursor: first.nextCursor });
    const third = await inventory.list({ limit: 1, cursor: second.nextCursor });
    expect([first.items[0]?.id, second.items[0]?.id, third.items[0]?.id]).toEqual([
      'session-pinned',
      'session-attention',
      'session-regular',
    ]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('emits an initial filtered snapshot and ordered diffs, then stops at generation retirement', async () => {
    let current = true;
    let rows = [rawSession({ id: 'session-current', active: true })];
    const fetchPage = vi.fn(async ({ archivedOnly }: { archivedOnly?: boolean }) => ({
      sessions: archivedOnly ? [] : rows,
      nextCursor: null,
      hasNext: false,
    }));
    const inventory = createPluginSessionsInventory({
      credentials,
      currentSessionId: 'session-current',
      isCurrent: () => current,
      readStoragePolicy: async () => 'required_e2ee',
      fetchPage,
      fetchById: async ({ sessionId }) => rows.find((item) => item.id === sessionId) ?? null,
      watchPollIntervalMs: 5,
    });
    const events: Array<{ kind: string; revision: string }> = [];
    const subscription = inventory.watch({}, (event) => events.push(event));

    await vi.waitFor(() => expect(events.map((event) => event.kind)).toEqual(['snapshot']));
    rows = [rawSession({ id: 'session-current', active: false, updatedAt: 40 })];
    await vi.waitFor(() => expect(events.map((event) => event.kind)).toEqual(['snapshot', 'upserted']));
    rows = [];
    await vi.waitFor(() => expect(events.map((event) => event.kind)).toEqual(['snapshot', 'upserted', 'removed']));
    expect(events.map((event) => event.revision)).toEqual(['1', '2', '3']);

    current = false;
    const callsAtRetirement = fetchPage.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchPage).toHaveBeenCalledTimes(callsAtRetirement);
    subscription.dispose();
  });

  it('rejects malformed or cross-query cursors instead of passing them to the server', async () => {
    const { inventory, fetchPage } = createInventory({
      pages: { first: [rawSession({ id: 'session-current' })], second: [rawSession({ id: 'session-other' })] },
    });
    const first = await inventory.list({ limit: 1, machineId: 'machine-a' });
    const callsAfterFirstPage = fetchPage.mock.calls.length;
    await expect(inventory.list({ cursor: first.nextCursor, limit: 1, machineId: 'machine-b' }))
      .rejects.toMatchObject({ code: 'plugin_sessions_cursor_invalid' });
    await expect(inventory.list({ cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'plugin_sessions_cursor_invalid',
    });
    expect(fetchPage).toHaveBeenCalledTimes(callsAfterFirstPage);
  });

  it('maps authentication and transport boundary failures to stable sanitized PluginErrors', async () => {
    const authenticated = createPluginSessionsInventory({
      credentials,
      currentSessionId: 'session-current',
      isCurrent: () => true,
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => { throw createAuthenticationHttpStatusError(401, 'token was rejected'); },
      fetchById: async () => { throw new Error('sensitive upstream response'); },
    });

    await expect(authenticated.list()).rejects.toMatchObject({
      code: 'plugin_sessions_not_authenticated',
      message: 'Session inventory authentication failed',
    });
    await expect(authenticated.get('session-current')).rejects.toMatchObject({
      code: 'plugin_sessions_inventory_unavailable',
      message: 'Session inventory is temporarily unavailable',
      retryable: true,
    });
  });

  it('does not invent an Agent identity when authorized metadata has no Agent evidence', async () => {
    const unidentified = rawSession({
      id: 'session-unidentified',
      metadata: JSON.stringify({ machineId: 'machine-a', projectId: 'project-a' }),
    });
    const { inventory } = createInventory({ pages: { first: [unidentified] } });

    const result = await inventory.list();

    expect(result.items).toEqual([
      expect.objectContaining({ id: 'session-unidentified', machineId: 'machine-a' }),
    ]);
    expect(result.items[0]).not.toHaveProperty('agentId');
  });

  it('rejects a watch created by a retired generation instead of returning a silent handle', () => {
    const { inventory } = createInventory({ isCurrent: () => false });

    expect(() => inventory.watch({}, vi.fn())).toThrow(expect.objectContaining({
      code: 'plugin_generation_retired',
    }));
  });

  it('does not emit a resync event when generation retirement interrupts an in-flight poll', async () => {
    let current = true;
    let releaseStoragePolicy!: () => void;
    const storagePolicyBlocked = new Promise<void>((resolve) => { releaseStoragePolicy = resolve; });
    const inventory = createPluginSessionsInventory({
      credentials,
      currentSessionId: 'session-current',
      isCurrent: () => current,
      readStoragePolicy: async () => {
        await storagePolicyBlocked;
        return 'optional';
      },
      fetchPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
      fetchById: async () => null,
      watchPollIntervalMs: 5,
    });
    const listener = vi.fn();
    const subscription = inventory.watch({}, listener);

    current = false;
    releaseStoragePolicy();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(listener).not.toHaveBeenCalled();
    subscription.dispose();
  });
});
