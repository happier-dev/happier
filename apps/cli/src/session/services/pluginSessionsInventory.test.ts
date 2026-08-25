import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import type { StoredCredentials } from '@/persistence';
import type { RawSessionListRow, RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { createAuthenticationHttpStatusError } from '@/api/client/httpStatusError';
import {
  type AccountEncryptionCurrentnessResponse,
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
  SessionSharedMetadataV1Schema,
} from '@happier-dev/protocol';
import {
  createPluginSessionsInventory,
  type PluginSessionHandleCapabilities,
  type PluginSessionsInventoryParams,
} from './pluginSessionsInventory';
import type { SubagentsService } from '@happier-dev/plugin-sdk/sessions/subagents';
import type { HostExternalSessionsAuthorService } from '@/session/external/privateContract';

const credentials = {
  token: 'account-token',
  encryption: null,
} satisfies StoredCredentials;

const plainAccountEncryptionCurrentness = Object.freeze({
  mode: 'plain' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
}) satisfies AccountEncryptionCurrentnessResponse;

function createTestPluginSessionsInventory(
  params: Omit<
    PluginSessionsInventoryParams,
    'signal' | 'external' | 'sessionScopes' | 'executeMessageAction' | 'createHandleCapabilities'
  > & {
    signal?: AbortSignal;
    external?: HostExternalSessionsAuthorService;
    sessionScopes?: readonly Readonly<{
      access: readonly ('read' | 'write' | 'control')[];
      machineIds?: readonly string[];
      projectIds?: readonly string[];
      sessionIds?: readonly string[];
    }>[];
    executeMessageAction?: PluginSessionsInventoryParams['executeMessageAction'];
    createHandleCapabilities?: (
      context: Parameters<PluginSessionsInventoryParams['createHandleCapabilities']>[0],
    ) => Partial<PluginSessionHandleCapabilities>;
  },
) {
  const unavailable = Object.freeze({ status: 'unavailable' as const, code: 'test_unavailable' });
  const external = params.external ?? Object.freeze({
    capabilities: async () => Object.freeze({
      list: unavailable,
      attach: unavailable,
      takeover: unavailable,
      transcript: unavailable,
      follow: unavailable,
    }),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    attach: vi.fn(async () => { throw new Error('test_unavailable'); }),
    readTranscript: vi.fn(async () => { throw new Error('test_unavailable'); }),
    followTranscript: vi.fn(async () => ({ status: 'unavailable' as const, code: 'test_unavailable' })),
    takeover: vi.fn(async () => { throw new Error('test_unavailable'); }),
  }) satisfies HostExternalSessionsAuthorService;
  const unavailableSystemRecords = Object.freeze({
    async listSystemRecords() {
      throw new Error('test_system_records_not_used');
    },
    async upsertSystemRecord() {
      throw new Error('test_system_records_not_used');
    },
    async readSystemRecord() {
      throw new Error('test_system_records_not_used');
    },
    async deleteSystemRecord() {
      throw new Error('test_system_records_not_used');
    },
  }) satisfies Pick<
    PluginSessionHandleCapabilities,
    | 'listSystemRecords'
    | 'upsertSystemRecord'
    | 'readSystemRecord'
    | 'deleteSystemRecord'
  >;
  const createHandleCapabilities: PluginSessionsInventoryParams['createHandleCapabilities'] = (context) => (
    Object.freeze({
      ...unavailableSystemRecords,
      ...(params.createHandleCapabilities?.(context) ?? {}),
    })
  );
  return createPluginSessionsInventory({
    ...params,
    createHandleCapabilities,
    external,
    executeMessageAction: params.executeMessageAction ?? (async ({ request }) => ({
      status: 'accepted' as const,
      localId: `plugin-input-v1:${request.idempotencyKey}`,
    })),
    signal: params.signal ?? new AbortController().signal,
    sessionScopes: params.sessionScopes ?? Object.freeze([Object.freeze({
      access: Object.freeze(['read', 'write', 'control'] as const),
    })]),
    readAccountEncryptionCurrentness: params.readAccountEncryptionCurrentness
      ?? (async () => plainAccountEncryptionCurrentness),
  });
}

describe('Plugin Sessions External Sessions binding', () => {
  it('publishes the injected six-method author service unchanged', () => {
    const unavailable = Object.freeze({ status: 'unavailable' as const, code: 'not_ready' });
    const external = Object.freeze({
      capabilities: vi.fn(async () => Object.freeze({
        list: unavailable,
        attach: unavailable,
        takeover: unavailable,
        transcript: unavailable,
        follow: unavailable,
      })),
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
      attach: vi.fn(async () => ({ sessionId: 'session-1' })),
      readTranscript: vi.fn(async () => ({
        mode: 'page' as const,
        items: [],
        nextCursor: null,
      })),
      followTranscript: vi.fn(async () => ({
        status: 'unavailable' as const,
        code: 'not_ready',
      })),
      takeover: vi.fn(async () => ({
        sessionId: 'session-1',
        operationId: 'operation-1',
        revision: 1,
      })),
    }) satisfies HostExternalSessionsAuthorService;

    const sessions = createTestPluginSessionsInventory({
      credentials,
      currentSessionId: null,
      isCurrent: () => true,
      external,
    });

    expect(sessions.external).toBe(external);
    expect(Reflect.ownKeys(sessions.external).sort()).toEqual([
      'attach',
      'capabilities',
      'followTranscript',
      'list',
      'readTranscript',
      'takeover',
    ]);
  });
});

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
    inventory: createTestPluginSessionsInventory({
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('represents an invocation without a bound Session as current null', () => {
    const inventory = createTestPluginSessionsInventory({
      credentials,
      currentSessionId: null,
      isCurrent: () => true,
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
      fetchById: async () => null,
    });

    expect(inventory.current).toBeNull();
  });

  it('fails closed when no final Session HostAccess scope was bound', async () => {
    const inventory = createTestPluginSessionsInventory({
      credentials,
      currentSessionId: 'session-current',
      sessionScopes: [],
      isCurrent: () => true,
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
      fetchById: async () => null,
    });

    expect(inventory.current).toBeNull();
    await expect(inventory.list()).rejects.toMatchObject({
      code: 'plugin_session_scope_unavailable',
    });
  });

  it('mints handle-local capabilities once while guarding the public handles', async () => {
    const createHandleCapabilities = vi.fn(({ sessionId }: { sessionId: string }) => {
      const subagents = Object.freeze({
        capabilities: () => Object.freeze({
          list: Object.freeze({ status: 'available' as const }),
          observe: Object.freeze({ status: 'unavailable' as const, code: 'test_unavailable' }),
          watch: Object.freeze({ status: 'unavailable' as const, code: 'test_unavailable' }),
        }),
        list: async () => Object.freeze({ items: Object.freeze([]) }),
        get: async () => null,
        observe: async () => {
          throw new Error('not used');
        },
        watch: () => Object.freeze({ dispose() {} }),
      }) satisfies SubagentsService;
      const records = Object.freeze({
        async listSystemRecords() {
          throw new Error('test_system_records_not_used');
        },
        async upsertSystemRecord() {
          throw new Error('test_system_records_not_used');
        },
        async readSystemRecord() {
          throw new Error('test_system_records_not_used');
        },
        async deleteSystemRecord() {
          throw new Error('test_system_records_not_used');
        },
      }) satisfies Pick<
        PluginSessionHandleCapabilities,
        | 'listSystemRecords'
        | 'upsertSystemRecord'
        | 'readSystemRecord'
        | 'deleteSystemRecord'
      >;
      return Object.freeze({ ...records, subagents });
    });
    const currentRow = rawSession({ id: 'session-current', active: true });
    const targetRow = rawSession({ id: 'session-target' });
    const inventory = createTestPluginSessionsInventory({
      credentials,
      currentSessionId: currentRow.id,
      isCurrent: () => true,
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [currentRow, targetRow], nextCursor: null, hasNext: false }),
      fetchById: async ({ sessionId }) => (
        sessionId === currentRow.id ? currentRow : sessionId === targetRow.id ? targetRow : null
      ),
      createHandleCapabilities,
    });

    const target = await inventory.get(targetRow.id);

    expect(inventory.subagents).toBe(inventory.current?.subagents);
    expect(inventory.current?.subagents).toBeDefined();
    expect(target?.subagents).toBeDefined();
    expect(inventory.current?.listSystemRecords).toEqual(expect.any(Function));
    expect(inventory.current?.upsertSystemRecord).toEqual(expect.any(Function));
    expect(inventory.current?.readSystemRecord).toEqual(expect.any(Function));
    expect(inventory.current?.deleteSystemRecord).toEqual(expect.any(Function));
    expect(target?.listSystemRecords).toEqual(expect.any(Function));
    expect(target?.upsertSystemRecord).toEqual(expect.any(Function));
    expect(target?.readSystemRecord).toEqual(expect.any(Function));
    expect(target?.deleteSystemRecord).toEqual(expect.any(Function));
    expect(createHandleCapabilities.mock.calls.map(([context]) => context.sessionId)).toEqual([
      currentRow.id,
      targetRow.id,
    ]);
  });

  it('exposes title mutation only on the host-stamped current Session handle', async () => {
    const setDisplayTitle = vi.fn(async () => undefined);
    const inventory = createTestPluginSessionsInventory({
      credentials,
      currentSessionId: 'session-current',
      isCurrent: () => true,
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
      fetchById: async () => rawSession({ id: 'session-current', active: true }),
      createHandleCapabilities: () => Object.freeze({ setDisplayTitle }),
    });

    await inventory.current!.setDisplayTitle('Renamed');
    expect(setDisplayTitle).toHaveBeenCalledWith('Renamed', undefined);
    expect('setDisplayTitle' in (await inventory.get('session-current'))!).toBe(false);
  });

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

  it('filters Session scope before list, get, mutation, control, and transcript disclosure', async () => {
    const inScope = rawSession({ id: 'session-in-scope', active: true });
    const outOfScope = rawSession({
      id: 'session-out-of-scope',
      active: true,
      metadata: JSON.stringify({
        machineId: 'machine-b',
        projectId: 'project-b',
        summary: { text: 'Out of scope' },
      }),
    });
    const executeMessageAction = vi.fn(async () => ({
      status: 'accepted' as const,
      localId: 'scope-test',
    }));
    const setDisplayTitle = vi.fn(async () => undefined);
    const get = vi.spyOn(axios, 'get').mockImplementation(async () => {
      throw new Error('Out-of-scope transcript access must not reach HTTP');
    });
    const inventory = createTestPluginSessionsInventory({
      credentials,
      currentSessionId: outOfScope.id,
      isCurrent: () => true,
      sessionScopes: [{
        access: ['read'],
        machineIds: ['machine-a'],
        projectIds: ['project-a'],
      }],
      readStoragePolicy: async () => 'optional',
      fetchPage: async ({ archivedOnly }) => ({
        sessions: archivedOnly ? [] : [inScope, outOfScope],
        nextCursor: null,
        hasNext: false,
      }),
      fetchById: async ({ sessionId }) => (
        sessionId === inScope.id ? inScope : sessionId === outOfScope.id ? outOfScope : null
      ),
      executeMessageAction,
      createHandleCapabilities: () => Object.freeze({ setDisplayTitle }),
      watchPollIntervalMs: 5,
    });

    await expect(inventory.list()).resolves.toMatchObject({
      items: [{ id: inScope.id }],
    });
    await expect(inventory.get(outOfScope.id)).resolves.toBeNull();
    const handle = await inventory.get(inScope.id);
    await expect(handle?.summary()).resolves.toMatchObject({ id: inScope.id });
    await expect(handle?.send({
      kind: 'userText',
      text: 'must not send',
      idempotencyKey: 'scope-read-only',
    })).rejects.toMatchObject({ code: 'plugin_session_scope_unavailable' });
    expect(executeMessageAction).not.toHaveBeenCalled();
    await expect(inventory.current?.setDisplayTitle('must not rename'))
      .rejects.toMatchObject({ code: 'plugin_session_scope_unavailable' });
    expect(setDisplayTitle).not.toHaveBeenCalled();

    const transcriptEvents: unknown[] = [];
    const subscription = inventory.current!.watch((event) => transcriptEvents.push(event));
    await new Promise((resolve) => setTimeout(resolve, 20));
    subscription.dispose();

    expect(transcriptEvents).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps Session write and control scopes distinct on the same host-stamped handle', async () => {
    const row = rawSession({ id: 'session-current', active: true });
    const writeSend = vi.fn(async () => ({ status: 'accepted' as const, localId: 'write-1' }));
    const writeTitle = vi.fn(async () => undefined);
    const writeOnly = createTestPluginSessionsInventory({
      credentials,
      currentSessionId: row.id,
      isCurrent: () => true,
      sessionScopes: [{ access: ['write'] }],
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [row], nextCursor: null, hasNext: false }),
      fetchById: async () => row,
      executeMessageAction: writeSend,
      createHandleCapabilities: () => Object.freeze({ setDisplayTitle: writeTitle }),
    });

    await expect(writeOnly.current!.send({
      kind: 'userText', text: 'allowed write', idempotencyKey: 'write-only-1',
    })).resolves.toEqual({ status: 'accepted', localId: 'write-1' });
    await expect(writeOnly.current!.setDisplayTitle('not control'))
      .rejects.toMatchObject({ code: 'plugin_session_scope_unavailable' });
    expect(writeSend).toHaveBeenCalledOnce();
    expect(writeTitle).not.toHaveBeenCalled();

    const controlSend = vi.fn(async () => ({ status: 'accepted' as const, localId: 'control-1' }));
    const controlTitle = vi.fn(async () => undefined);
    const controlOnly = createTestPluginSessionsInventory({
      credentials,
      currentSessionId: row.id,
      isCurrent: () => true,
      sessionScopes: [{ access: ['control'] }],
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [row], nextCursor: null, hasNext: false }),
      fetchById: async () => row,
      executeMessageAction: controlSend,
      createHandleCapabilities: () => Object.freeze({ setDisplayTitle: controlTitle }),
    });

    await expect(controlOnly.current!.setDisplayTitle('allowed control')).resolves.toBeUndefined();
    await expect(controlOnly.current!.send({
      kind: 'userText', text: 'not write', idempotencyKey: 'control-only-1',
    })).rejects.toMatchObject({ code: 'plugin_session_scope_unavailable' });
    expect(controlTitle).toHaveBeenCalledWith('allowed control', undefined);
    expect(controlSend).not.toHaveBeenCalled();
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
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
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

  it('does not expose broad Session metadata or state capabilities on plugin handles', async () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        machineId: 'machine-layout1',
        projectId: 'project-layout1',
      },
    });
    const sharedMetadata = SessionSharedMetadataV1Schema.parse({
      v: 1,
      summary: { text: 'Shared title', updatedAt: 20 },
    });
    const layout1 = rawSession({
      id: 'session-layout1',
      metadataLayoutVersion: 1,
      metadataVersion: 4,
      agentStateVersion: 7,
      metadata: JSON.stringify(sharedMetadata),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
      agentState: JSON.stringify({ requests: { one: { status: 'complete' } } }),
    });
    const { inventory } = createInventory({ pages: { first: [layout1] } });
    const handle = await inventory.get('session-layout1');

    expect(handle).not.toHaveProperty('readMetadata');
    expect(handle).not.toHaveProperty('readAgentState');
    expect(handle).not.toHaveProperty('readStateField');
    expect(handle).not.toHaveProperty('writeStateField');
  });

  it('mints a recipient-safe handle for a view-only shared Session without owner metadata', async () => {
    const viewer = rawSession({
      id: 'session-viewer',
      metadataLayoutVersion: 1,
      metadata: JSON.stringify(SessionSharedMetadataV1Schema.parse({
        v: 1,
        summary: { text: 'Shared viewer title', updatedAt: 20 },
        agentPresentation: { agentId: 'codex' },
      })),
      ownerMetadata: undefined,
      agentState: undefined,
      agentStateVersion: undefined,
      share: { accessLevel: 'view', canApprovePermissions: false },
    });
    const { inventory } = createInventory({ pages: { first: [viewer] } });

    const handle = await inventory.get('session-viewer');
    expect(handle).not.toBeNull();
    await expect(handle?.summary()).resolves.toMatchObject({
      id: 'session-viewer',
      title: 'Shared viewer title',
    });
    expect(await handle?.summary()).not.toHaveProperty('machineId');
    await expect(inventory.list({ machineId: 'machine-a' })).resolves.toEqual({ items: [] });
  });

  it('uses the same summary owner for current and global get and delegates user text to the canonical sender', async () => {
    const sent: string[] = [];
    const inventory = createTestPluginSessionsInventory({
      credentials,
      currentSessionId: 'session-current',
      isCurrent: () => true,
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
      fetchById: async () => rawSession({ id: 'session-current', active: true }),
      executeMessageAction: async ({ sessionId, request }) => {
        if (request.kind !== 'userText') {
          throw new Error('Expected the user-text send request exercised by this fixture');
        }
        sent.push(`${sessionId}:${request.text}`);
        return { status: 'accepted', localId: 'local-1' };
      },
    });
    const global = await inventory.get('session-current');

    await expect(inventory.current!.summary()).resolves.toEqual(await global?.summary());
    await expect(inventory.current!.send({ kind: 'userText', text: 'hi', idempotencyKey: 'message-1' }))
      .resolves.toEqual({ status: 'accepted', localId: 'local-1' });
    expect(sent).toEqual(['session-current:hi']);
  });

  it('aborts an admitted send transport and fences its late settlement when the retained invocation retires', async () => {
    const lifetime = new AbortController();
    let transportSignal: AbortSignal | undefined;
    let settle!: (result: { status: 'accepted'; localId: string }) => void;
    const executeMessageAction = vi.fn<PluginSessionsInventoryParams['executeMessageAction']>((request) => {
      transportSignal = request.signal;
      return new Promise((resolve) => {
        settle = resolve;
      });
    });
    const inventory = createTestPluginSessionsInventory({
      credentials,
      signal: lifetime.signal,
      currentSessionId: 'session-current',
      isCurrent: () => !lifetime.signal.aborted,
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
      fetchById: async () => rawSession({ id: 'session-current', active: true }),
      executeMessageAction,
    });

    const pending = inventory.current!.send({
      kind: 'userText',
      text: 'admitted before retirement',
      idempotencyKey: 'retirement-1',
    });
    await vi.waitFor(() => expect(executeMessageAction).toHaveBeenCalledOnce());
    lifetime.abort();
    const transportWasAborted = transportSignal?.aborted;
    settle({ status: 'accepted', localId: 'local-retired' });

    await expect(pending).rejects.toMatchObject({ code: 'plugin_generation_retired' });
    expect(transportWasAborted).toBe(true);
  });

  it('cancels before admission and reports acknowledgement loss as outcome-unknown', async () => {
    const abortBefore = new AbortController();
    const sendBefore = vi.fn(async () => ({
      status: 'accepted' as const,
      localId: 'local-before',
    }));
    const beforeInventory = createTestPluginSessionsInventory({
      credentials,
      currentSessionId: 'session-current',
      isCurrent: () => true,
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
      fetchById: async () => rawSession({ id: 'session-current', active: true }),
      executeMessageAction: sendBefore,
    });
    abortBefore.abort();

    await expect(beforeInventory.current!.send(
      { kind: 'userText', text: 'do not admit', idempotencyKey: 'cancel-before-1' },
      { signal: abortBefore.signal },
    )).rejects.toMatchObject({ code: 'plugin_operation_aborted' });
    expect(sendBefore).not.toHaveBeenCalled();

    const abortDuring = new AbortController();
    const sendDuring = vi.fn<PluginSessionsInventoryParams['executeMessageAction']>(async () => {
      abortDuring.abort();
      return {
        status: 'outcomeUnknown' as const,
        localId: 'plugin-input-v1:cancel-during',
        code: 'session_input_admission_acknowledgement_lost',
      };
    });
    const duringInventory = createTestPluginSessionsInventory({
      credentials,
      currentSessionId: 'session-current',
      isCurrent: () => true,
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
      fetchById: async () => rawSession({ id: 'session-current', active: true }),
      executeMessageAction: sendDuring,
    });

    await expect(duringInventory.current!.send(
      { kind: 'userText', text: 'possibly admitted', idempotencyKey: 'cancel-during-1' },
      { signal: abortDuring.signal },
    )).resolves.toEqual({
      status: 'outcomeUnknown',
      localId: 'plugin-input-v1:cancel-during',
      code: 'session_input_admission_acknowledgement_lost',
    });
    const transportSignal = sendDuring.mock.calls[0]?.[0].signal;
    expect(transportSignal).toBeDefined();
    expect(transportSignal?.aborted).toBe(true);
  });

  it('rejects a known pre-admission failure instead of fabricating outcome uncertainty', async () => {
    const inventory = createTestPluginSessionsInventory({
      credentials,
      currentSessionId: 'session-current',
      isCurrent: () => true,
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
      fetchById: async () => rawSession({ id: 'session-current', active: true }),
      executeMessageAction: async () => ({ status: 'rejected', code: 'session_input_archived' }),
    });

    await expect(inventory.current!.send({ kind: 'userText', text: 'reject me', idempotencyKey: 'reject-1' }))
      .resolves.toEqual({ status: 'rejected', code: 'session_input_archived' });
  });

  it('replays and follows the bound Session transcript identically for ordinary and Agent invocations', async () => {
    let latestSequence = 2;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const href = String(url);
      const sessionId = decodeURIComponent(href.match(/\/sessions\/([^/]+)/)?.[1] ?? '');
      if (href.endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: plainAccountEncryptionCurrentness } as never;
      }
      if (href.includes('/v2/sessions/')) {
        return {
          status: 200,
          data: { session: rawSession({ id: sessionId, active: true }) },
        } as never;
      }
      if (!href.includes('/v1/sessions/') || !href.endsWith('/messages')) {
        throw new Error(`unexpected Session watch request: ${href}`);
      }
      const after = Number((config as { params?: { afterSeq?: number } } | undefined)?.params?.afterSeq ?? 0);
      const rows = [
        {
          id: 'message-1',
          seq: 1,
          createdAt: 10,
          messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hello' } } },
        },
        {
          id: 'message-private',
          seq: 2,
          createdAt: 11,
          messageRole: 'unknown',
          content: { t: 'plain', v: { role: 'owner', ownerMetadata: 'must-not-project' } },
        },
        ...(latestSequence >= 3 ? [{
          id: 'message-3',
          seq: 3,
          createdAt: 12,
          messageRole: 'agent',
          content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'world' } } },
        }] : []),
      ].filter((item) => item.seq > after && item.seq <= latestSequence);
      return {
        status: 200,
        data: {
          messages: rows,
          nextBeforeSeq: rows[0]?.seq ?? null,
          nextAfterSeq: latestSequence,
          hasMore: false,
        },
      } as never;
    });

    let ordinaryCurrent = true;
    let agentCurrent = true;
    const createBoundInventory = (sessionId: string, isCurrent: () => boolean) => createTestPluginSessionsInventory({
      credentials,
      currentSessionId: sessionId,
      isCurrent,
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
      fetchById: async ({ sessionId }) => rawSession({ id: sessionId, active: true }),
      watchPollIntervalMs: 5,
    });
    const ordinary = createBoundInventory('session-ordinary', () => ordinaryCurrent);
    const agent = createBoundInventory('session-agent', () => agentCurrent);
    const ordinaryEvents: unknown[] = [];
    const agentEvents: unknown[] = [];
    const ordinarySubscription = ordinary.current!.watch(async (event) => {
      ordinaryEvents.push(event);
      if (ordinaryEvents.length === 1) throw new Error('listener failure must stay isolated');
    });
    const agentSubscription = agent.current!.watch((event) => agentEvents.push(event));

    await vi.waitFor(() => {
      expect(ordinaryEvents).toHaveLength(1);
      expect(agentEvents).toEqual(ordinaryEvents);
    });
    expect(ordinaryEvents).toEqual([{
      sequence: 1,
      kind: 'message',
      message: {
        version: 1,
        messageId: 'message-1',
        sender: 'user',
        parts: [{ kind: 'text', text: 'hello' }],
      },
    }]);
    expect(JSON.stringify(ordinaryEvents)).not.toContain('must-not-project');

    latestSequence = 3;
    await vi.waitFor(() => {
      expect(ordinaryEvents).toHaveLength(2);
      expect(agentEvents).toEqual(ordinaryEvents);
    });
    expect(ordinaryEvents[1]).toEqual({
      sequence: 3,
      kind: 'message',
      message: {
        version: 1,
        messageId: 'message-3',
        sender: 'agent',
        parts: [{ kind: 'text', text: 'world' }],
      },
    });
    const messageRequests = get.mock.calls.filter(([url]) => String(url).endsWith('/messages'));
    expect(messageRequests.length).toBeGreaterThanOrEqual(4);
    expect(messageRequests.every(([url, config]) => (
      (String(url).includes('/sessions/session-ordinary/messages')
        || String(url).includes('/sessions/session-agent/messages'))
      && (config as { params?: { afterSeq?: number } } | undefined)?.params?.afterSeq !== undefined
      && (config as { params?: { scope?: string } } | undefined)?.params?.scope === 'main'
    ))).toBe(true);

    ordinarySubscription.dispose();
    ordinaryCurrent = false;
    const ordinaryEventCount = ordinaryEvents.length;
    const ordinaryCallsAtDisposal = get.mock.calls.filter(
      ([url]) => String(url).includes('/sessions/session-ordinary/messages'),
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ordinaryEvents).toHaveLength(ordinaryEventCount);
    expect(get.mock.calls.filter(
      ([url]) => String(url).includes('/sessions/session-ordinary/messages'),
    )).toHaveLength(ordinaryCallsAtDisposal);

    agentCurrent = false;
    const agentCallsAtRetirement = get.mock.calls.filter(
      ([url]) => String(url).includes('/sessions/session-agent/messages'),
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(get.mock.calls.filter(
      ([url]) => String(url).includes('/sessions/session-agent/messages'),
    )).toHaveLength(agentCallsAtRetirement);
    agentSubscription.dispose();
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
    const inventory = createTestPluginSessionsInventory({
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
    const inventory = createTestPluginSessionsInventory({
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
    const authenticated = createTestPluginSessionsInventory({
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

  it('re-resolves Account credentials for an existing handle and fails closed after local revocation', async () => {
    const rotatedCredentials = {
      ...credentials,
      token: 'rotated-account-token',
    } satisfies StoredCredentials;
    let currentCredentials: StoredCredentials | null = credentials;
    const sentTokens: string[] = [];
    const fetchById = vi.fn(async ({ sessionId }: { token: string; sessionId: string }) => (
      rawSession({ id: sessionId, active: true })
    ));
    const inventory = createTestPluginSessionsInventory({
      credentials,
      readCredentials: async () => currentCredentials,
      currentSessionId: 'session-current',
      isCurrent: () => true,
      readStoragePolicy: async () => 'optional',
      fetchPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
      fetchById,
      executeMessageAction: async () => {
        sentTokens.push(currentCredentials!.token);
        return { status: 'accepted', localId: 'local-rotated' };
      },
    });
    const handle = await inventory.get('session-current');

    currentCredentials = rotatedCredentials;
    await expect(handle?.summary()).resolves.toMatchObject({ id: 'session-current' });
    expect(fetchById).toHaveBeenLastCalledWith({
      token: 'rotated-account-token',
      sessionId: 'session-current',
    });
    await expect(handle?.send({ kind: 'userText', text: 'use current authority', idempotencyKey: 'rotate-1' }))
      .resolves.toEqual({ status: 'accepted', localId: 'local-rotated' });
    expect(sentTokens).toEqual(['rotated-account-token']);

    currentCredentials = null;
    const callsBeforeRevocation = fetchById.mock.calls.length;
    await expect(handle?.summary()).rejects.toMatchObject({
      code: 'plugin_sessions_not_authenticated',
    });
    expect(fetchById).toHaveBeenCalledTimes(callsBeforeRevocation);
  });

  it('invalidates a cached inventory cursor when the Account credential changes', async () => {
    let currentCredentials: StoredCredentials | null = credentials;
    const rows = [rawSession({ id: 'session-one' }), rawSession({ id: 'session-two' })];
    const inventory = createTestPluginSessionsInventory({
      credentials,
      readCredentials: async () => currentCredentials,
      currentSessionId: null,
      isCurrent: () => true,
      readStoragePolicy: async () => 'optional',
      fetchPage: async ({ archivedOnly }) => ({
        sessions: archivedOnly ? [] : rows,
        nextCursor: null,
        hasNext: false,
      }),
      fetchById: async () => null,
    });
    const first = await inventory.list({ limit: 1 });

    currentCredentials = { ...credentials, token: 'another-account-token' };

    await expect(inventory.list({ limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({
      code: 'plugin_sessions_cursor_invalid',
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
    const inventory = createTestPluginSessionsInventory({
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
