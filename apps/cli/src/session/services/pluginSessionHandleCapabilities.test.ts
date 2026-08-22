import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  deleteSessionSystemRecordV1,
  fetchAccountEncryptionCurrentness,
  fetchServerFeaturesSnapshot,
  fetchSessionById,
  fetchSessionsPage,
  listSessionSystemRecordsV1,
  lookupSessionsByTags,
  readSessionSystemRecordV1,
  setSessionTitleMock,
  upsertSessionSystemRecordV1,
} = vi.hoisted(() => ({
  deleteSessionSystemRecordV1: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  fetchServerFeaturesSnapshot: vi.fn(),
  fetchSessionById: vi.fn(),
  fetchSessionsPage: vi.fn(),
  listSessionSystemRecordsV1: vi.fn(),
  lookupSessionsByTags: vi.fn(),
  setSessionTitleMock: vi.fn(),
  readSessionSystemRecordV1: vi.fn(),
  upsertSessionSystemRecordV1: vi.fn(),
}));

vi.mock('./setSessionTitle', () => ({
  setSessionTitle: (...args: unknown[]) => setSessionTitleMock(...args),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: (...args: unknown[]) => fetchServerFeaturesSnapshot(...args),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: (...args: unknown[]) => fetchAccountEncryptionCurrentness(...args),
}));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: (...args: unknown[]) => fetchSessionById(...args),
  fetchSessionsPage: (...args: unknown[]) => fetchSessionsPage(...args),
  lookupSessionsByTags: (...args: unknown[]) => lookupSessionsByTags(...args),
}));
vi.mock('@/session/transport/http/sessionSystemRecordsHttp', () => ({
  deleteSessionSystemRecordV1: (...args: unknown[]) => deleteSessionSystemRecordV1(...args),
  listSessionSystemRecordsV1: (...args: unknown[]) => listSessionSystemRecordsV1(...args),
  readSessionSystemRecordV1: (...args: unknown[]) => readSessionSystemRecordV1(...args),
  upsertSessionSystemRecordV1: (...args: unknown[]) => upsertSessionSystemRecordV1(...args),
}));

vi.mock('@/session/subagents/hostSubagentStore', () => ({ hostSubagentStore: Object.freeze({}) }));
vi.mock('@/session/subagents/serverPluginSubagentDurableCustody', () => ({
  createServerPluginSubagentDurableCustody: () => Object.freeze({}),
}));
vi.mock('@/session/subagents/pluginSubagentsService', () => ({
  createPluginSubagentsService: ({ isCurrent }: { isCurrent: () => boolean }) => Object.freeze({
    capabilities: () => isCurrent()
      ? Object.freeze({
        list: { status: 'available' as const },
        observe: { status: 'available' as const },
        watch: { status: 'available' as const },
      })
      : Object.freeze({
        list: { status: 'unavailable' as const, code: 'plugin_generation_retired' },
        observe: { status: 'unavailable' as const, code: 'plugin_generation_retired' },
        watch: { status: 'unavailable' as const, code: 'plugin_generation_retired' },
      }),
  }),
}));

import type { Credentials } from '@/persistence';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { InteractionsService } from '@happier-dev/plugin-sdk/interactions';
import type { SessionHandle, SessionMediaService } from '@happier-dev/plugin-sdk/sessions';
import {
  deriveBoxPublicKeyFromSeed,
  FeaturesResponseSchema,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import { encodeBase64 } from '@/api/encryption';
import {
  decryptSessionPayload,
  encryptSessionPayload,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { createPluginSessionHandleCapabilitiesFactory } from './pluginSessionHandleCapabilities';

type PermissionHandlerBoundary = Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;

const credentials = {
  token: 'account-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32) },
} satisfies Credentials;

const plainAccountEncryptionCurrentness = Object.freeze({
  mode: 'plain' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
});

function readySystemRecordsFeatures() {
  return FeaturesResponseSchema.parse({
    features: {},
    capabilities: {
      session: {
        systemRecords: { protocolVersions: [1] },
      },
    },
  });
}

function storedPluginRecord(content: unknown = { text: 'remember this' }) {
  return Object.freeze({
    id: 'record-1',
    address: Object.freeze({
      owner: 'plugin' as const,
      namespace: 'acme.notes',
      kind: 'memo',
      localId: 'today',
    }),
    content: Object.freeze({ t: 'plain' as const, v: content }),
    revision: 'ssr1.AAAAAWkAAAAB',
    createdAt: '2026-05-19T00:00:00.000Z',
    updatedAt: '2026-05-19T00:00:01.000Z',
  });
}

describe('createPluginSessionHandleCapabilitiesFactory', () => {
  it('writes a current Session title through the canonical owner and fences a late cancellation', async () => {
    const caller = new AbortController();
    const operation = new AbortController();
    const settlements: Array<() => void> = [];
    setSessionTitleMock.mockImplementation(async () => await new Promise((resolve) => {
      settlements.push(() => resolve({ ok: true, sessionId: 'session-1', metadata: {}, version: 1 }));
    }));
    const capabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.plugin',
        contributionId: 'action-a',
        immutableGenerationId: 'immutable-generation-a',
      },
      signal: caller.signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => null,
    })('session-1');

    const setDisplayTitle = capabilities.setDisplayTitle;
    if (!setDisplayTitle) throw new Error('Expected current Session title capability');
    const pending = setDisplayTitle('Renamed', { signal: operation.signal });
    await vi.waitFor(() => expect(setSessionTitleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials,
        idOrPrefix: 'session-1',
        title: 'Renamed',
        currentness: expect.objectContaining({
          assertCurrent: expect.any(Function),
        }),
      }),
    ));
    const titleRequest = setSessionTitleMock.mock.calls[0]?.[0] as Readonly<{
      currentness?: Readonly<{ signal?: AbortSignal; assertCurrent?: () => void }>;
    }>;
    const titleSignal = titleRequest.currentness?.signal;
    if (!titleSignal) throw new Error('expected composed title cancellation signal');
    operation.abort();
    expect(titleSignal.aborted).toBe(true);
    expect(() => titleRequest.currentness?.assertCurrent?.())
      .toThrowError(expect.objectContaining({ code: 'plugin_operation_aborted' }));
    settlements.shift()?.();
    await expect(pending).rejects.toMatchObject({ code: 'plugin_session_display_title_outcome_unknown' });

    const successorOperation = new AbortController();
    const successor = setDisplayTitle('Renamed again', {
      signal: successorOperation.signal,
    });
    await vi.waitFor(() => expect(setSessionTitleMock).toHaveBeenCalledTimes(2));
    const successorRequest = setSessionTitleMock.mock.calls[1]?.[0] as Readonly<{
      currentness?: Readonly<{ signal?: AbortSignal; assertCurrent?: () => void }>;
    }>;
    const successorSignal = successorRequest.currentness?.signal;
    if (!successorSignal) throw new Error('expected successor title cancellation signal');
    caller.abort();
    expect(successorSignal.aborted).toBe(true);
    expect(() => successorRequest.currentness?.assertCurrent?.())
      .toThrowError(expect.objectContaining({ code: 'plugin_operation_aborted' }));
    settlements.shift()?.();
    await expect(successor).rejects.toMatchObject({
      code: 'plugin_session_display_title_outcome_unknown',
    });
  });
  it('binds identity, live permission/MCP ownership, media, and subagents to one Session handle', async () => {
    const handleToolCall = vi.fn<PermissionHandlerBoundary['handleToolCall']>(async () => ({
      decision: 'approved' as const,
      answers: {
        single: ['one'],
        multiple: ['alpha', 'beta'],
      },
    }));
    const mediaSource = Object.freeze({ publishGenerated: vi.fn(), dispose: vi.fn() });
    const media = Object.freeze({
      registerSourceRoot: vi.fn(async () => mediaSource),
    }) satisfies SessionMediaService;
    const createCapabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.plugin',
        contributionId: 'action-a',
        immutableGenerationId: 'immutable-generation-a',
        runtimeId: 'runtime-a',
      },
      signal: new AbortController().signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: (sessionId) => sessionId === 'session-1' ? {
        scopeId: Symbol.for('live-session-1'),
        permissionHandler: { handleToolCall },
        readPermissionMode: () => 'default',
        media,
      } : null,
    });

    const capabilities = createCapabilities('session-1');

    await expect(capabilities.permissions?.requestDecision({
      requestId: 'permission-1',
      toolName: 'shell',
      input: { command: 'pwd' },
      source: 'test',
    })).resolves.toEqual({
      decision: 'approved',
      answers: {
        single: ['one'],
        multiple: ['alpha', 'beta'],
      },
    });
    expect(handleToolCall).toHaveBeenCalledWith(
      'permission-1',
      'shell',
      { command: 'pwd' },
      expect.objectContaining({
        owner: { kind: 'plugin', pluginId: 'acme.plugin', runtimeId: 'runtime-a' },
        source: 'test',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(capabilities.permissions?.getMode()).toBe('default');
    await expect(capabilities.media?.registerSourceRoot({ rootPath: '/workspace' }))
      .resolves.toMatchObject({ dispose: expect.any(Function) });
    expect(media.registerSourceRoot).toHaveBeenCalledWith(
      { rootPath: '/workspace' },
      { signal: expect.any(AbortSignal) },
    );
    expect(capabilities.subagents?.capabilities().list).toEqual({ status: 'available' });

    await expect(capabilities.mcp?.elicit({
      requestId: 'mcp-1',
      serverName: 'shell',
      toolName: 'run_command',
      input: { command: 'pwd' },
    })).resolves.toMatchObject({ status: 'accepted' });
    expect(handleToolCall).toHaveBeenLastCalledWith(
      'mcp-1',
      'mcp__shell__run_command',
      { command: 'pwd' },
      expect.objectContaining({
        owner: { kind: 'plugin', pluginId: 'acme.plugin', runtimeId: 'runtime-a' },
      }),
    );

    await Promise.all([
      capabilities.mcp?.elicit({ serverName: 'shell', toolName: 'run_command' }),
      capabilities.mcp?.elicit({ serverName: 'shell', toolName: 'run_command' }),
    ]);
    const idlessMcpRequestIds = handleToolCall.mock.calls.slice(-2).map(([requestId]) => requestId);
    expect(new Set(idlessMcpRequestIds).size).toBe(2);
    expect(idlessMcpRequestIds.every((requestId) => requestId.startsWith('mcp-elicitation:'))).toBe(true);
  });

  it('keeps one logical contribution owner stable across invocations while isolating siblings', async () => {
    const handleToolCall = vi.fn<PermissionHandlerBoundary['handleToolCall']>(
      async () => ({ decision: 'approved' as const }),
    );
    const live = {
      scopeId: Symbol('shared-live-session'),
      permissionHandler: { handleToolCall },
      readPermissionMode: () => 'default',
    };
    const createFor = (contributionId: string) => createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.plugin',
        contributionId,
        immutableGenerationId: 'immutable-generation-a',
        runtimeId: `acme.plugin/actions/${contributionId}`,
      },
      signal: new AbortController().signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => live,
    })('session-1');

    await createFor('first').permissions?.requestDecision({ toolName: 'shell' });
    await createFor('first').permissions?.requestDecision({ toolName: 'shell' });
    await createFor('second').permissions?.requestDecision({ toolName: 'shell' });

    expect(handleToolCall.mock.calls.map(([, , , context]) => context?.owner)).toEqual([
      { kind: 'plugin', pluginId: 'acme.plugin', runtimeId: 'acme.plugin/actions/first' },
      { kind: 'plugin', pluginId: 'acme.plugin', runtimeId: 'acme.plugin/actions/first' },
      { kind: 'plugin', pluginId: 'acme.plugin', runtimeId: 'acme.plugin/actions/second' },
    ]);
  });

  it('re-resolves a replacement live scope for each operation', async () => {
    const first = vi.fn<PermissionHandlerBoundary['handleToolCall']>(
      async () => ({ decision: 'denied' as const }),
    );
    const replacement = vi.fn<PermissionHandlerBoundary['handleToolCall']>(
      async () => ({ decision: 'approved' as const }),
    );
    const media = Object.freeze({ registerSourceRoot: vi.fn() }) satisfies SessionMediaService;
    let live = {
      scopeId: Symbol('first'),
      permissionHandler: { handleToolCall: first },
      readPermissionMode: () => 'plan',
      media,
    };
    const capabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.plugin',
        contributionId: 'action-a',
        immutableGenerationId: 'immutable-generation-a',
      },
      signal: new AbortController().signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => live,
    })('session-1');
    live = {
      scopeId: Symbol('replacement'),
      permissionHandler: { handleToolCall: replacement },
      readPermissionMode: () => 'default',
      media,
    };

    await Promise.all([
      capabilities.permissions?.requestDecision({ toolName: 'shell' }),
      capabilities.permissions?.requestDecision({ toolName: 'shell' }),
    ]);
    expect(first).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(2);
    const correlationIds = replacement.mock.calls.map(([requestId]) => requestId);
    expect(new Set(correlationIds).size).toBe(2);
    expect(correlationIds.every((requestId) => requestId.startsWith('plugin-session-permission:'))).toBe(true);
    expect(capabilities.permissions?.getMode()).toBe('default');
  });

  it('reports absent or retired live Session capabilities factually without invoking an owner', async () => {
    let current = true;
    const createCapabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.plugin',
        contributionId: 'action-a',
        immutableGenerationId: 'immutable-generation-a',
      },
      signal: new AbortController().signal,
      isCurrent: () => current,
      readAgentId: async () => null,
      resolveLiveCapabilities: () => null,
    });
    const capabilities = createCapabilities('session-remote');

    await expect(capabilities.permissions?.requestDecision({ toolName: 'shell' }))
      .rejects.toMatchObject({ code: 'plugin_session_permission_scope_unavailable' });
    expect(() => capabilities.permissions?.getMode())
      .toThrowError(expect.objectContaining({ code: 'plugin_session_permission_scope_unavailable' }));
    await expect(capabilities.mcp?.elicit({ toolName: 'shell' }))
      .resolves.toEqual({ status: 'unavailable', reason: 'mcp_elicitation_session_unavailable' });
    await expect(capabilities.auth?.services.refreshRuntimeAuth({ serviceId: 'openai-codex' }))
      .resolves.toEqual({ status: 'unavailable', reason: 'runtime_auth_target_unavailable' });

    current = false;
    expect(capabilities.subagents?.capabilities().list).toEqual({
      status: 'unavailable',
      code: 'plugin_generation_retired',
    });
  });

  it('does not report stale media success after the live Session scope changes during publication', async () => {
    let settlePublication!: () => void;
    const publication = new Promise<void>((resolve) => { settlePublication = resolve; });
    const source = Object.freeze({
      publishGenerated: vi.fn(async () => {
        await publication;
        return { status: 'published' as const };
      }),
      dispose: vi.fn(),
    });
    const media = Object.freeze({ registerSourceRoot: vi.fn(async () => source) }) satisfies SessionMediaService;
    let live = {
      scopeId: Symbol('media-first'),
      readPermissionMode: () => 'default',
      media,
    };
    const capabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.plugin',
        contributionId: 'action-a',
        immutableGenerationId: 'immutable-generation-a',
      },
      signal: new AbortController().signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => live,
    })('session-1');
    const registered = await capabilities.media?.registerSourceRoot({ rootPath: '/workspace' });
    const pending = registered!.publishGenerated({ localId: 'image-1', path: '/workspace/image.png' });

    live = { ...live, scopeId: Symbol('media-successor') };
    settlePublication();
    await expect(pending).rejects.toMatchObject({
      code: 'plugin_session_media_publication_outcome_unknown',
    });
  });

  it('fences schema elicitation when the caller or bound Session interaction scope retires', async () => {
    const pendingInteractions: Array<() => void> = [];
    let observedSignal: AbortSignal | undefined;
    const interactions: InteractionsService = Object.freeze({
      askQuestions: vi.fn(async (_request, options) => {
        observedSignal = options?.signal;
        await new Promise<void>((resolve) => { pendingInteractions.push(resolve); });
        return Object.freeze({
          requestId: 'questions-fixture',
          kind: 'questions' as const,
          status: 'answered' as const,
          answers: Object.freeze({
            approved: Object.freeze({
              kind: 'singleChoice' as const,
              answer: Object.freeze({ kind: 'choice' as const, choiceId: 'true' }),
            }),
          }),
        });
      }),
      requestApproval: vi.fn(async () => Object.freeze({
        requestId: 'approval-fixture',
        kind: 'approval' as const,
        status: 'declined' as const,
      })),
      confirm: vi.fn(async () => Object.freeze({
        requestId: 'confirmation-fixture',
        kind: 'confirmation' as const,
        status: 'declined' as const,
      })),
      approvals: Object.freeze({
        request: vi.fn(async () => Object.freeze({ approvalRequestId: 'unused' })),
        get: vi.fn(async () => null),
        list: vi.fn(async () => Object.freeze({ items: Object.freeze([]) })),
        watch: vi.fn(async () => Object.freeze({ dispose() {} })),
      }),
    });
    const permissionHandler = Object.freeze({
      handleToolCall: vi.fn<PermissionHandlerBoundary['handleToolCall']>(async () => ({ decision: 'denied' as const })),
    });
    const callerAbort = new AbortController();
    let live = {
      scopeId: Symbol('mcp-first'),
      permissionHandler,
      interactions,
      readPermissionMode: () => 'default',
    };
    const capabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.plugin',
        contributionId: 'action-a',
        immutableGenerationId: 'immutable-generation-a',
      },
      signal: new AbortController().signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => live,
    })('session-1');

    const pending = capabilities.mcp!.elicit({
      requestId: 'mcp-form-retired',
      toolName: 'configure',
      prompt: 'Configure',
      schema: {
        type: 'object',
        properties: { approved: { type: 'boolean', title: 'Approved' } },
      },
    }, { signal: callerAbort.signal });
    await Promise.resolve();
    expect(observedSignal).toBeDefined();
    callerAbort.abort(new Error('caller cancelled'));
    expect(observedSignal?.aborted).toBe(true);
    pendingInteractions.shift()?.();
    await expect(pending).rejects.toThrow('caller cancelled');

    const retired = capabilities.mcp!.elicit({
      requestId: 'mcp-form-retired-peer',
      toolName: 'configure',
      prompt: 'Configure',
      schema: {
        type: 'object',
        properties: { approved: { type: 'boolean', title: 'Approved' } },
      },
    });
    await Promise.resolve();
    live = { ...live, scopeId: Symbol('mcp-successor') };
    pendingInteractions.shift()?.();
    await expect(retired).resolves.toEqual({
      status: 'unavailable',
      reason: 'mcp_elicitation_session_retired',
    });
    expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
  });
});

describe('SessionHandle System Records capability', () => {
  beforeEach(() => {
    deleteSessionSystemRecordV1.mockReset();
    fetchAccountEncryptionCurrentness.mockReset();
    fetchServerFeaturesSnapshot.mockReset();
    fetchSessionById.mockReset();
    fetchSessionsPage.mockReset();
    listSessionSystemRecordsV1.mockReset();
    lookupSessionsByTags.mockReset();
    readSessionSystemRecordV1.mockReset();
    upsertSessionSystemRecordV1.mockReset();

    fetchServerFeaturesSnapshot.mockResolvedValue({
      status: 'ready',
      features: readySystemRecordsFeatures(),
    });
    fetchSessionById.mockResolvedValue({
      id: 'session-record-0001',
      active: true,
      activeAt: 1,
      encryptionMode: 'plain',
      metadata: {},
    });
    fetchAccountEncryptionCurrentness.mockResolvedValue(plainAccountEncryptionCurrentness);
    const record = storedPluginRecord();
    listSessionSystemRecordsV1.mockResolvedValue({ records: [record], nextCursor: null, hasNext: false });
    readSessionSystemRecordV1.mockResolvedValue(record);
    upsertSessionSystemRecordV1.mockResolvedValue(record);
    deleteSessionSystemRecordV1.mockResolvedValue(undefined);
  });

  it('binds opened records to the retained caller identity and seals plaintext exactly once', async () => {
    const caller = new AbortController();
    const capabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.notes',
        contributionId: 'notes',
        immutableGenerationId: 'generation-g',
      },
      signal: caller.signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => Object.freeze({
        scopeId: Symbol('ordinary-successor-h'),
        readPermissionMode: () => 'default',
        isCurrent: () => false,
      }),
    })('session-record-0001') as Partial<SessionHandle>;
    const list = capabilities.listSystemRecords;
    const read = capabilities.readSystemRecord;
    const upsert = capabilities.upsertSystemRecord;
    const remove = capabilities.deleteSystemRecord;

    expect(list).toEqual(expect.any(Function));
    expect(read).toEqual(expect.any(Function));
    expect(upsert).toEqual(expect.any(Function));
    expect(remove).toEqual(expect.any(Function));
    if (!list || !read || !upsert || !remove) return;

    await expect(list({ owner: 'plugin', namespace: 'acme.notes', limit: 25 }))
      .resolves.toEqual({
        records: [{
          id: 'record-1',
          address: { owner: 'plugin', namespace: 'acme.notes', kind: 'memo', localId: 'today' },
          content: { text: 'remember this' },
          revision: 'ssr1.AAAAAWkAAAAB',
          createdAt: '2026-05-19T00:00:00.000Z',
          updatedAt: '2026-05-19T00:00:01.000Z',
        }],
        nextCursor: null,
        hasNext: false,
      });
    await expect(read({
      address: { owner: 'plugin', namespace: 'acme.notes', kind: 'memo', localId: 'today' },
    })).resolves.toMatchObject({ content: { text: 'remember this' } });
    await expect(upsert({
      address: { owner: 'plugin', namespace: 'acme.notes', kind: 'memo', localId: 'today' },
      content: { text: 'replace this' },
    })).resolves.toMatchObject({ content: { text: 'remember this' } });
    await expect(remove({
      address: { owner: 'plugin', namespace: 'acme.notes', kind: 'memo', localId: 'today' },
    })).resolves.toBeUndefined();

    expect(fetchServerFeaturesSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      signal: caller.signal,
    }));
    expect(listSessionSystemRecordsV1).toHaveBeenCalledWith({
      token: 'account-token',
      sessionId: 'session-record-0001',
      pluginId: 'acme.notes',
      query: { owner: 'plugin', namespace: 'acme.notes', limit: 25 },
      signal: caller.signal,
    });
    expect(readSessionSystemRecordV1).toHaveBeenCalledWith(expect.objectContaining({
      token: 'account-token',
      sessionId: 'session-record-0001',
      pluginId: 'acme.notes',
      signal: caller.signal,
    }));
    expect(upsertSessionSystemRecordV1).toHaveBeenCalledWith({
      token: 'account-token',
      sessionId: 'session-record-0001',
      pluginId: 'acme.notes',
      request: {
        address: { owner: 'plugin', namespace: 'acme.notes', kind: 'memo', localId: 'today' },
        content: { t: 'plain', v: { text: 'replace this' } },
      },
      signal: caller.signal,
    });
    expect(deleteSessionSystemRecordV1).toHaveBeenCalledWith(expect.objectContaining({
      token: 'account-token',
      sessionId: 'session-record-0001',
      pluginId: 'acme.notes',
      signal: caller.signal,
    }));
  });

  it('fails locally before record dispatch when protocol version one is not advertised', async () => {
    fetchServerFeaturesSnapshot.mockResolvedValue({
      status: 'ready',
      features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }),
    });
    const capabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.notes',
        contributionId: 'notes',
        immutableGenerationId: 'generation-g',
      },
      signal: new AbortController().signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => null,
    })('session-record-0001') as Partial<SessionHandle>;
    const list = capabilities.listSystemRecords;

    expect(list).toEqual(expect.any(Function));
    if (!list) return;
    await expect(list({ owner: 'plugin', namespace: 'acme.notes', limit: 25 }))
      .rejects.toMatchObject({ code: 'plugin_session_records_unavailable' });
    expect(listSessionSystemRecordsV1).not.toHaveBeenCalled();
  });

  it('fences a late write settlement after caller cancellation', async () => {
    const caller = new AbortController();
    const operation = new AbortController();
    let settle!: () => void;
    let observedSignal: AbortSignal | undefined;
    upsertSessionSystemRecordV1.mockImplementation(async ({ signal }) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => { settle = resolve; });
      return storedPluginRecord();
    });
    const capabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.notes',
        contributionId: 'notes',
        immutableGenerationId: 'generation-g',
      },
      signal: caller.signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => null,
    })('session-record-0001') as Partial<SessionHandle>;
    const upsert = capabilities.upsertSystemRecord;

    expect(upsert).toEqual(expect.any(Function));
    if (!upsert) return;
    const pending = upsert({
      address: { owner: 'plugin', namespace: 'acme.notes', kind: 'memo', localId: 'today' },
      content: { text: 'replace this' },
    }, { signal: operation.signal });
    await vi.waitFor(() => expect(upsertSessionSystemRecordV1).toHaveBeenCalledTimes(1));
    operation.abort();
    expect(observedSignal?.aborted).toBe(true);
    settle();
    await expect(pending).rejects.toMatchObject({ code: 'plugin_session_record_outcome_unknown' });
  });

  it('fences an in-flight record read when the exact Session lifetime restarts', async () => {
    const lifetime = new AbortController();
    let settle!: () => void;
    let observedSignal: AbortSignal | undefined;
    readSessionSystemRecordV1.mockImplementation(async ({ signal }) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => { settle = resolve; });
      return storedPluginRecord();
    });
    const capabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.notes',
        contributionId: 'notes',
        immutableGenerationId: 'generation-g',
      },
      signal: lifetime.signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => null,
    })('session-record-0001') as Partial<SessionHandle>;
    const read = capabilities.readSystemRecord;

    expect(read).toEqual(expect.any(Function));
    if (!read) return;
    const pending = read({
      address: { owner: 'plugin', namespace: 'acme.notes', kind: 'memo', localId: 'today' },
    });
    await vi.waitFor(() => expect(readSessionSystemRecordV1).toHaveBeenCalledTimes(1));
    lifetime.abort();
    expect(observedSignal?.aborted).toBe(true);
    settle();

    await expect(pending).rejects.toMatchObject({ code: 'plugin_operation_aborted' });
  });

  it('does not revive a disabled record handle after a successor reuses its plugin id', async () => {
    let priorCurrent = true;
    const prior = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.notes',
        contributionId: 'notes',
        immutableGenerationId: 'generation-g',
      },
      signal: new AbortController().signal,
      isCurrent: () => priorCurrent,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => null,
    })('session-record-0001') as Partial<SessionHandle>;
    const successor = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.notes',
        contributionId: 'notes',
        immutableGenerationId: 'generation-h',
      },
      signal: new AbortController().signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => null,
    })('session-record-0001') as Partial<SessionHandle>;
    const priorList = prior.listSystemRecords;
    const successorList = successor.listSystemRecords;

    expect(priorList).toEqual(expect.any(Function));
    expect(successorList).toEqual(expect.any(Function));
    if (!priorList || !successorList) return;
    priorCurrent = false;

    await expect(priorList({ owner: 'plugin', namespace: 'acme.notes', limit: 25 }))
      .rejects.toMatchObject({ code: 'plugin_generation_retired' });
    expect(fetchServerFeaturesSnapshot).not.toHaveBeenCalled();
    expect(listSessionSystemRecordsV1).not.toHaveBeenCalled();

    await expect(successorList({ owner: 'plugin', namespace: 'acme.notes', limit: 25 }))
      .resolves.toMatchObject({ records: [expect.objectContaining({ id: 'record-1' })] });
    expect(listSessionSystemRecordsV1).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a plaintext Session receives an encrypted record envelope', async () => {
    readSessionSystemRecordV1.mockResolvedValue({
      ...storedPluginRecord(),
      content: { t: 'encrypted', c: 'not-a-plaintext-envelope' },
    });
    const capabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials,
      caller: {
        pluginId: 'acme.notes',
        contributionId: 'notes',
        immutableGenerationId: 'generation-g',
      },
      signal: new AbortController().signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => null,
    })('session-record-0001') as Partial<SessionHandle>;
    const read = capabilities.readSystemRecord;

    expect(read).toEqual(expect.any(Function));
    if (!read) return;
    await expect(read({
      address: { owner: 'plugin', namespace: 'acme.notes', kind: 'memo', localId: 'today' },
    })).rejects.toMatchObject({ code: 'plugin_session_record_encryption_mismatch' });
  });

  it('seals and opens E2EE record content through the canonical Session handle', async () => {
    const machineKey = new Uint8Array(32).fill(7);
    const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
    const sessionDataKey = new Uint8Array(32).fill(9);
    const encryptionContext = Object.freeze({
      encryptionKey: sessionDataKey,
      encryptionVariant: 'dataKey' as const,
    });
    const e2eeCredentials = {
      token: 'account-token',
      encryption: { type: 'dataKey' as const, publicKey, machineKey },
    } satisfies Credentials;
    const input = Object.freeze({ text: 'keep this private' });
    const encryptedReadContent = encryptSessionPayload({
      ctx: encryptionContext,
      payload: input,
    });

    fetchSessionById.mockResolvedValue({
      id: 'session-record-0001',
      active: true,
      activeAt: 1,
      encryptionMode: 'e2ee',
      dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
        dataKey: sessionDataKey,
        recipientPublicKey: publicKey,
        randomBytes: (length) => new Uint8Array(length).fill(3),
      }), 'base64'),
      metadata: {},
    });
    fetchAccountEncryptionCurrentness.mockResolvedValue({
      mode: 'e2ee',
      version: 1,
      signingKeyFingerprint: 'signing-key',
      contentKeyFingerprint: 'content-key',
      updatedAt: 1,
    });
    readSessionSystemRecordV1.mockResolvedValue({
      ...storedPluginRecord(),
      content: { t: 'encrypted', c: encryptedReadContent },
    });
    upsertSessionSystemRecordV1.mockImplementation(async ({ request }) => Object.freeze({
      ...storedPluginRecord(),
      content: request.content,
    }));

    const capabilities = createPluginSessionHandleCapabilitiesFactory({
      credentials: e2eeCredentials,
      caller: {
        pluginId: 'acme.notes',
        contributionId: 'notes',
        immutableGenerationId: 'generation-g',
      },
      signal: new AbortController().signal,
      isCurrent: () => true,
      readAgentId: async () => 'codex',
      resolveLiveCapabilities: () => null,
    })('session-record-0001') as Partial<SessionHandle>;
    const read = capabilities.readSystemRecord;
    const upsert = capabilities.upsertSystemRecord;

    expect(read).toEqual(expect.any(Function));
    expect(upsert).toEqual(expect.any(Function));
    if (!read || !upsert) return;

    await expect(read({
      address: { owner: 'plugin', namespace: 'acme.notes', kind: 'memo', localId: 'today' },
    })).resolves.toMatchObject({ content: input });
    await expect(upsert({
      address: { owner: 'plugin', namespace: 'acme.notes', kind: 'memo', localId: 'today' },
      content: input,
    })).resolves.toMatchObject({ content: input });

    const transportRequest = upsertSessionSystemRecordV1.mock.calls[0]?.[0]?.request;
    if (!transportRequest || transportRequest.content.t !== 'encrypted') {
      throw new Error('Expected an encrypted Session-record transport request');
    }
    expect(decryptSessionPayload({
      ctx: encryptionContext,
      ciphertextBase64: transportRequest.content.c,
    })).toEqual(input);
  });
});
