import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { wrapApiTokenEncryptionAccessV1 } from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import {
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2,
  ExternalActionRequestEnvelopeV2Schema,
  createActionExecutor,
  isApprovalRequiredByActionsSettings,
  type ActionExecutorDeps,
  getActionSpec,
  openExternalActionRequestV2,
  prepareExternalActionResponseV2,
} from '@happier-dev/protocol/actions';

type MockUndiciRequestOptions = RequestInit & Readonly<{
  dispatcher?: unknown;
  headersTimeout?: number;
}>;

type MockUndiciResponse = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array> & Readonly<{
    destroy?: (error?: Error) => unknown;
  }>;
}>;

const undiciRequest = vi.hoisted(() => vi.fn(async (
  url: URL | RequestInfo,
  options?: MockUndiciRequestOptions,
): Promise<MockUndiciResponse> => {
  const response = await fetch(url, options);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    statusCode: response.status,
    headers,
    body: {
      destroy: vi.fn(),
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield bytes;
      },
    },
  };
}));

const undiciAgent = vi.hoisted(() => {
  const destroy = vi.fn(async () => undefined);
  const instances: Array<Readonly<{ destroy: typeof destroy }>> = [];
  const Agent = vi.fn(() => {
    const dispatcher = { destroy };
    instances.push(dispatcher);
    return dispatcher;
  });
  return { Agent, destroy, instances };
});

vi.mock('undici', () => ({ request: undiciRequest, Agent: undiciAgent.Agent }));

// These cases replace HTTP itself with finite responses at non-routable fixture
// origins. Replace only the sibling Socket.IO network boundary; the shared
// socket adapter, connection supervisor and transcript owner remain real.
const notificationNetwork = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const sockets: Array<{ connected: boolean; disconnect: () => void }> = [];
  const io = vi.fn(() => {
    const listeners = new Map<string, Set<Listener>>();
    const deliver = (event: string, ...args: unknown[]) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    };
    const socket = {
      connected: false,
      active: false,
      io: { timeout: vi.fn(), on: vi.fn(), off: vi.fn() },
      on(event: string, listener: Listener) {
        const entries = listeners.get(event) ?? new Set<Listener>();
        entries.add(listener); listeners.set(event, entries);
      },
      off(event: string, listener: Listener) { listeners.get(event)?.delete(listener); },
      connect() { socket.connected = true; socket.active = true; deliver('connect'); },
      disconnect() {
        const wasConnected = socket.connected;
        socket.connected = false; socket.active = false;
        if (wasConnected) deliver('disconnect', 'io client disconnect');
      },
      removeAllListeners() { listeners.clear(); },
      offAny() {},
    };
    sockets.push(socket);
    return socket;
  });
  return { io, sockets };
});
vi.mock('socket.io-client', () => ({ io: notificationNetwork.io }));

import {
  HappierActionError,
  HappierAgentUnavailableError,
  HappierClientClosedError,
  type HappierExecutionRunStream,
  HappierSessionInitialInputError,
  type HappierMachineClient,
  HappierSessionSpawnError,
  type HappierSessionSpawnInput,
  HappierTransportError,
  type HappierTranscriptItem,
  type PublicActionInputById,
  type PublicActionResultById,
  connect,
  isHappierActionApprovalRequestCreated,
} from './index.js';

const TEST_API_TOKEN = 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// Results that satisfy the Actions' own declared output schemas. The SDK
// presents a typed result only when the response really is one, so a stub that
// stands in for a successful execution has to be a real result of that Action.
const MESSAGE_SEND_RESULT = { status: 'accepted', localId: 'input-1' } as const;
const RUN_RESULT = {
  runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'review',
  backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default',
  retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
  status: 'running', startedAtMs: 1,
} as const;
const TRANSCRIPT_RESULT = {
  ok: true, sessionId: 'session-1', items: [], nextCursor: null, hasMore: false,
  diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 1 },
} as const;
const WAIT_IDLE_RESULT = { ok: true, sessionId: 'session-1', idle: true, observedAt: 1 } as const;

function resultFor(actionId: string): unknown {
  switch (actionId) {
    case 'session.message.send': return MESSAGE_SEND_RESULT;
    case 'execution.run.get': return { run: RUN_RESULT };
    case 'execution.run.wait': return {
      ok: true, status: 'succeeded', result: { run: { ...RUN_RESULT, status: 'succeeded' } },
    };
    case 'execution.run.stop': return { ok: true };
    case 'session.transcript.get': return TRANSCRIPT_RESULT;
    case 'session.wait.idle': return WAIT_IDLE_RESULT;
    case 'session.stop': return { ok: true };
    default: return {};
  }
}

/** The ABI call-through tests are about the request that reaches transport; a
 * real Action result is proven by the tests that consume one. */
const RESULT_NOT_UNDER_TEST = 'result_not_under_test';
async function callsTransport(call: Promise<unknown>): Promise<void> {
  await expect(call).rejects.toMatchObject({
    name: 'HappierActionError', code: RESULT_NOT_UNDER_TEST,
  });
}

const TEST_ALT_API_TOKEN = 'hap_v1_223e4567-e89b-42d3-a456-426614174001_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function responseForRequest(init: RequestInit | undefined, body: Record<string, unknown>, status = 200): Response {
  const request = init?.body === undefined
    ? undefined
    : JSON.parse(String(init.body)) as Readonly<{ requestId?: unknown }>;
  return response({
    ...body,
    ...(typeof request?.requestId === 'string' ? { requestId: request.requestId } : {}),
  }, status);
}

function failingResponseBody(error: unknown, beforeThrow?: () => void): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      beforeThrow?.();
      throw error;
    },
  };
}

function isHappierSessionInitialInputError(
  error: unknown,
): error is HappierSessionInitialInputError {
  return error instanceof HappierSessionInitialInputError;
}

describe('Happier SDK client', () => {
  it('executes advertised Machine terminal business methods through the canonical Action ingress', async () => {
    const target = { serverId: 'home', machineId: 'machine' };
    const workspace = { ...target, workspaceId: 'accepted', rootPath: '/repo' };
    const settings = { v: 1 as const, actions: {}, approvalWaivedSurfaces: {
      'machines.terminal.open': ['api' as const], 'machines.terminal.write': ['api' as const],
      'machines.terminal.close': ['api' as const], 'machines.terminal.restart': ['api' as const],
    } };
    const physicalEffects: Array<Readonly<{ actionId: string; input: unknown }>> = [];
    const results = {
      'machines.terminal.open': { ok: true, terminalId: 'pty', reused: false },
      'machines.terminal.list': { ok: true, terminals: [] },
      'machines.terminal.read': { ok: true, terminalId: 'pty', frames: [], nextByteOffset: 0,
        availableByteOffset: 0, droppedBeforeByteOffset: 0, done: false },
      'machines.terminal.write': { ok: true },
      'machines.terminal.close': { ok: true },
      'machines.terminal.restart': { ok: true, terminalId: 'restarted', reused: false },
    } as const;
    const executor = createActionExecutor({
      // HTTP and the receiving PTY transport are the genuine boundaries; the
      // generated business method, schema ingress and approval policy stay real.
      machineTerminalAction: async ({ actionId, input }) => {
        physicalEffects.push({ actionId, input });
        return results[actionId];
      },
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context, getActionSpec(actionId).safety),
    } as Pick<ActionExecutorDeps, 'machineTerminalAction' | 'isActionApprovalRequired'> as ActionExecutorDeps);
    vi.stubGlobal('fetch', vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { input: unknown };
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1)!);
      return responseForRequest(init, { v: 1, actionId,
        execution: await executor.execute(actionId, request.input, { surface: 'api', serverId: target.serverId }) });
    }));
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const open = { ...target, terminalKey: 'member', workspace };
    const terminal = { ...target, terminalId: 'pty' };
    const read = { ...terminal, byteOffset: 0 };
    const write = { ...terminal, event: { t: 'text', text: 'pwd\r' } } as const;
    try {
      await expect(client.actions.machines.terminal.open(open)).resolves.toEqual(results['machines.terminal.open']);
      await expect(client.actions.machines.terminal.list(target)).resolves.toEqual(results['machines.terminal.list']);
      await expect(client.actions.machines.terminal.read(read)).resolves.toEqual(results['machines.terminal.read']);
      await expect(client.actions.machines.terminal.write(write)).resolves.toEqual(results['machines.terminal.write']);
      await expect(client.actions.machines.terminal.close(terminal)).resolves.toEqual(results['machines.terminal.close']);
      await expect(client.actions.machines.terminal.restart(open)).resolves.toEqual(results['machines.terminal.restart']);
      await expect(client.actions.machines.terminal.open({ ...open,
        // @ts-expect-error A business Action cannot mint requester custody.
        requesterAccountId: 'forged',
      })).rejects.toMatchObject({ name: 'HappierActionError', code: 'invalid_parameters' });
      expect(physicalEffects).toEqual([
        { actionId: 'machines.terminal.open', input: open }, { actionId: 'machines.terminal.list', input: target },
        { actionId: 'machines.terminal.read', input: read }, { actionId: 'machines.terminal.write', input: write },
        { actionId: 'machines.terminal.close', input: terminal }, { actionId: 'machines.terminal.restart', input: open },
      ]);
    } finally { await client.close(); }
  });
  it('executes generated qualified Machine sharing methods while the canonical host rejects public physical grant authority', async () => {
    const target = { serverId: 'home', machineId: 'machine' };
    const principal = { kind: 'account', accountId: 'bob' } as const;
    const grant = { machineId: 'machine', principal, level: 'view' } as const;
    const access = { machineId: 'machine', custodian: { accountId: 'alice', displayName: 'Alice' },
      access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
      canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] } as const;
    const requests: Array<Readonly<{ actionId: string; input: unknown }>> = [];
    let permissionWrites = 0;
    const settings = { v: 1 as const, actions: {}, approvalWaivedSurfaces: { 'machines.access.grant.set': ['api' as const] } };
    // The SDK's HTTP boundary serves the real strict Action ingress. Only the
    // authenticated permission transport beneath it returns fixture results.
    const executor = createActionExecutor({
      machineAccessAction: async ({ actionId }) => {
        if (actionId === 'machines.access.grants.list') return access;
        permissionWrites++;
        return { kind: 'saved', grant, readiness: 'ready' };
      },
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
    } as Pick<ActionExecutorDeps, 'machineAccessAction' | 'isActionApprovalRequired'> as ActionExecutorDeps);
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { input: unknown };
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1)!);
      requests.push({ actionId, input: request.input });
      const execution = await executor.execute(actionId, request.input, { surface: 'api', serverId: target.serverId });
      return responseForRequest(init, { v: 1, actionId, execution });
    });
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    try {
      await expect(client.actions.machines.access.grants.list(target)).resolves.toEqual(access);
      const input = { ...target, principal, level: 'view' } satisfies PublicActionInputById['machines.access.grant.set'];
      await expect(client.actions.machines.access.grant.set(input)).resolves.toEqual({ kind: 'saved', grant, readiness: 'ready' });
      await expect(client.actions.machines.access.grant.set({ ...input,
        // @ts-expect-error Raw recipient ciphertext is not public grant authority.
        recipientKeyEnvelopes: [],
      })).rejects.toMatchObject({ name: 'HappierActionError', code: 'invalid_parameters' });
      await expect(client.actions.machines.access.grants.list({ ...target,
        // @ts-expect-error Callers cannot manufacture admission evidence.
        admission: { role: 'manage' },
      })).rejects.toMatchObject({ name: 'HappierActionError', code: 'invalid_parameters' });
      expect(requests).toEqual([
        { actionId: 'machines.access.grants.list', input: target },
        { actionId: 'machines.access.grant.set', input },
        { actionId: 'machines.access.grant.set', input: { ...input, recipientKeyEnvelopes: [] } },
        { actionId: 'machines.access.grants.list', input: { ...target, admission: { role: 'manage' } } },
      ]);
      expect(permissionWrites).toBe(1);
    } finally { await client.close(); }
  });
  it('executes an explicitly Plain shared target with a valid bearer but unavailable Account crypto', async () => {
    const context = { serverIdentityId: 'srv_sdk', accountId: 'bob',
      tokenId: '123e4567-e89b-42d3-a456-426614174000',
      contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=' };
    const bearer = `hap_v1_${context.tokenId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
    const token = formatAccountApiTokenCredentialV1({ bearer,
      wrappingSecret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
      serverIdentityId: context.serverIdentityId, accountId: context.accountId,
      contentPublicKey: context.contentPublicKey });
    const result = { sessions: [], nextCursor: null, hasNext: false, queryVersion: 1,
      attentionNextCursor: null, attentionHasNext: false };
    let accountBootstrapReads = 0;
    let refused = false;
    // HTTP is the only replaced boundary; credential, mode selection and Action preparation remain real.
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${bearer}`);
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/encryption-access')) {
        accountBootstrapReads += 1;
        return response({ error: 'auth_unavailable' }, 503);
      }
      if (path === '/v1/machines') return response([{
        id: 'alice-machine', kind: 'persistent', active: true, installationId: 'alice-installation',
        revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
        access: { custodian: { accountId: 'alice', displayName: 'Alice' },
          role: 'use', resourceMode: 'plain', accessState: 'ready' },
      }]);
      const request = JSON.parse(String(init?.body)) as { v: number; target: unknown };
      expect(request.v).toBe(1);
      expect(request.target).toEqual({ kind: 'machine', machineId: 'alice-machine' });
      if (refused) return response({ error: 'invalid_request', code: 'target_not_local' }, 400);
      return responseForRequest(init, { v: 1, actionId: 'session.list', execution: { ok: true, result } });
    });
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://home.invalid', token });
    try {
      await expect(client.machine('alice-machine').actions.session.list({})).resolves.toEqual(result);
      refused = true;
      await expect(client.machine('alice-machine').actions.session.list({})).rejects.toMatchObject({
        name: 'HappierTransportError', code: 'target_not_local', status: 400,
      });
      expect(accountBootstrapReads).toBe(0);
    } finally { await client.close(); }
  });
  it('round trips fluent sessions.list folder and tag selectors through the strict Action query', async () => {
    const result = { sessions: [], nextCursor: null, hasNext: false, queryVersion: 1,
      attentionNextCursor: null, attentionHasNext: false };
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { input: unknown };
      expect(request.input).toEqual({ query: {
        v: 1, storage: 'archived', includeInactive: false, scope: 'all_accessible', attention: 'any',
        audiences: [], folderIds: ['folder-a', 'folder-b'], tagIds: ['tag-a', 'tag-b'], limit: 17,
      } });
      return responseForRequest(init, { v: 1, actionId: 'session.list', execution: { ok: true, result } });
    });
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    try {
      await expect(client.sessions.list({ folderIds: ['folder-b', 'folder-a'], tagIds: ['tag-b', 'tag-a'],
        storage: 'archived', includeInactive: false, limit: 17 })).resolves.toEqual(result);
    } finally {
      await client.close();
    }
  });

  it('protects a later session.list query and opens its marked awareness result', async () => {
    const material = { type: 'dataKey' as const, machineKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
    const context = { serverIdentityId: 'srv_sdk', accountId: 'account-1',
      tokenId: '123e4567-e89b-42d3-a456-426614174000',
      contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=' };
    const wrappingSecret = new Uint8Array(32).fill(7);
    const bearer = `hap_v1_${context.tokenId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
    const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context, wrappingSecret,
      contentPrivateKey: material.machineKey, randomBytes: (length) => new Uint8Array(length).fill(3) });
    const token = formatAccountApiTokenCredentialV1({ bearer,
      wrappingSecret: encodeBase64(wrappingSecret, 'base64url'), serverIdentityId: context.serverIdentityId,
      accountId: context.accountId, contentPublicKey: context.contentPublicKey });
    const input = {
      query: {
        v: 1 as const,
        storage: 'active' as const,
        includeInactive: false,
        scope: 'assigned_to_me' as const,
        attention: 'needs_my_attention' as const,
        includeAttention: true,
        audiences: [{ kind: 'team' as const, teamId: 'private-team-sentinel' }],
        tagIds: ['private-tag-sentinel'],
        attentionCursor: 'cursor_v1_private-later-page-sentinel',
        limit: 17,
      },
      view: 'awareness' as const,
    };
    expect(getActionSpec('session.list').inputSchema.safeParse({
      ...input,
      queryVersion: 1,
    }).success).toBe(false);
    const result = {
      view: 'awareness',
      projectionVersion: 1,
      sessions: [{
        v: 1,
        sessionId: 'private-result-sentinel',
        lifecycle: 'active',
        runtime: 'working',
        freshness: 'live',
        operational: { primary: 'working', reasons: ['working'] },
        encryption: 'plain',
        availability: 'complete',
      }],
      nextCursor: null,
      hasNext: false,
      attentionNextCursor: null,
      attentionHasNext: false,
    };
    const protectedBodies: string[] = [];
    let expectedInput: unknown = input;
    let expectedResult: unknown = result;
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${bearer}`);
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/encryption-access')) {
        return response({ v: 1, accountId: context.accountId, tokenId: context.tokenId, encryptionAccess });
      }
      // The exact target Machine decides what a protected request seals
      // against; an ordinary daemon keeps the Account material.
      if (path === '/v1/machines') return response([]);
      const body = String(init?.body ?? '');
      protectedBodies.push(body);
      const request = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(body));
      const binding = { serverIdentityId: context.serverIdentityId, accountId: context.accountId,
        credentialId: context.tokenId, actionId: 'session.list', requestId: request.requestId,
        target: { kind: 'machine' as const, machineId: 'machine-1' } };
      expect(openExternalActionRequestV2({ envelope: request, binding, material })?.input).toEqual(expectedInput);
      const prepared = prepareExternalActionResponseV2({ binding, request, material,
        randomBytes: (length) => new Uint8Array(length).fill(4), executedMachineId: 'machine-1',
        execution: { ok: true, result: expectedResult } });
      protectedBodies.push(prepared.body);
      return response(prepared.response);
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token });
    try {
      await expect(client.machine('machine-1').actions.session.list(input)).resolves.toEqual(result);
      const fluentResult = { sessions: [], nextCursor: null, hasNext: false, queryVersion: 1,
        attentionNextCursor: null, attentionHasNext: false };
      expectedResult = fluentResult;
      const defaultQuery = { v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible',
        attention: 'any', audiences: [], tagIds: [] };
      expectedInput = { query: defaultQuery };
      await expect(client.machine('machine-1').sessions.list()).resolves.toEqual(fluentResult);
      await expect(client.sessions.list({ folderIds: undefined, tagIds: undefined, cursor: undefined,
        limit: undefined, storage: undefined, includeInactive: undefined },
        { target: { kind: 'machine', machineId: 'machine-1' } })).resolves.toEqual(fluentResult);
      expectedInput = { query: { ...defaultQuery, limit: 100 } };
      await expect(client.machine('machine-1').sessions.list({ includeInactive: true, limit: 100 }))
        .resolves.toEqual(fluentResult);
      expectedInput = { query: { ...defaultQuery, folderIds: [] } };
      await expect(client.machine('machine-1').sessions.list({ folderIds: [] })).resolves.toEqual(fluentResult);
      expect(protectedBodies.join('')).not.toContain('sentinel');
      expect(protectedBodies.join('')).not.toContain(token);
    } finally {
      await client.close();
    }
  });

  it('rejects an unmarked predecessor session.list query success without consuming its rows', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.list',
      execution: {
        ok: true,
        result: {
          sessions: [{ id: 'unfiltered-predecessor-row' }],
          nextCursor: null,
          hasNext: false,
        },
      },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    try {
      await expect(client.actions.session.list({
        query: {
          v: 1, storage: 'active', includeInactive: false, scope: 'my_work', attention: 'any',
          audiences: [], tagIds: [],
        },
      })).rejects.toMatchObject({ code: 'session_list_query_update_required' });
    } finally {
      await client.close();
    }
  });

  it('rejects a successful Action result that does not satisfy its declared output schema', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.list',
      execution: { ok: true, result: { sessions: 'not-an-array', nextCursor: null, hasNext: false } },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    try {
      await expect(client.actions.session.list({})).rejects.toMatchObject({
        name: 'HappierTransportError',
        code: 'invalid_action_output',
      });
    } finally {
      await client.close();
    }
  });

  it('keeps strict session.list proof bound to the query sent before transport settles', async () => {
    let settleResponse: (() => void) | undefined;
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => await new Promise<Response>((resolve) => {
      settleResponse = () => resolve(responseForRequest(init, {
        v: 1,
        actionId: 'session.list',
        execution: {
          ok: true,
          result: {
            sessions: [{ id: 'unfiltered-predecessor-row' }],
            nextCursor: null,
            hasNext: false,
          },
        },
      }));
    }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const input: PublicActionInputById['session.list'] = {
      query: {
        v: 1, storage: 'active', includeInactive: false, scope: 'my_work', attention: 'any',
        audiences: [], tagIds: [],
      },
    };
    try {
      const execution = client.actions.session.list(input);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      delete input.query;
      settleResponse?.();
      await expect(execution).rejects.toMatchObject({ code: 'session_list_query_update_required' });
    } finally {
      await client.close();
    }
  });

  it('rejects a marker-only strict-query summary without consuming its rows', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.list',
      execution: {
        ok: true,
        result: {
          sessions: [{ id: 'pairless-query-row' }],
          nextCursor: null,
          hasNext: false,
          queryVersion: 1,
        },
      },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    try {
      await expect(client.actions.session.list({
        query: {
          v: 1, storage: 'active', includeInactive: false, scope: 'my_work', attention: 'any',
          audiences: [], tagIds: [],
        },
      })).rejects.toMatchObject({ code: 'session_list_query_update_required' });
    } finally {
      await client.close();
    }
  });

  it('preserves the strict filtered-listing unavailable result as a typed Action error', async () => {
    const details = {
      error: 'not_found' as const,
      code: 'filtered_session_listing_unavailable' as const,
      reason: 'following' as const,
    };
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.list',
      execution: {
        ok: false,
        errorCode: details.code,
        error: details.code,
        details,
      },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    try {
      await expect(client.actions.session.list({
        query: {
          v: 1, storage: 'active', includeInactive: false, scope: 'following', attention: 'any',
          audiences: [], tagIds: [],
        },
      })).rejects.toMatchObject({
        code: 'filtered_session_listing_unavailable',
        message: 'filtered_session_listing_unavailable',
        details,
      });
    } finally {
      await client.close();
    }
  });

  it('accepts a marked awareness result with both continuation families intact', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.list',
      execution: {
        ok: true,
        result: {
          view: 'awareness',
          projectionVersion: 1,
          sessions: [],
          nextCursor: null,
          hasNext: false,
          attentionNextCursor: 'cursor_v1_attention_next',
          attentionHasNext: true,
        },
      },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    try {
      await expect(client.actions.session.list({
        query: {
          v: 1, storage: 'active', includeInactive: false, scope: 'my_work', attention: 'any',
          audiences: [], tagIds: [],
        },
      })).resolves.toMatchObject({
        view: 'awareness',
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: 'cursor_v1_attention_next',
        attentionHasNext: true,
      });
    } finally {
      await client.close();
    }
  });

  it('rejects a marked awareness result with an orphaned attention continuation', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.list',
      execution: {
        ok: true,
        result: {
          view: 'awareness', projectionVersion: 1, sessions: [], nextCursor: null, hasNext: false,
          attentionHasNext: true,
        },
      },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    try {
      await expect(client.actions.session.list({
        query: {
          v: 1, storage: 'active', includeInactive: false, scope: 'my_work', attention: 'any',
          audiences: [], tagIds: [],
        },
      })).rejects.toMatchObject({ code: 'session_list_query_update_required' });
    } finally {
      await client.close();
    }
  });

  it('keeps an unmarked predecessor session.list success valid when no query was requested', async () => {
    const result = {
      sessions: [{ id: 'legacy-visible-row', active: false, presence: 'offline', updatedAt: 1 }],
      nextCursor: null,
    };
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.list',
      execution: { ok: true, result },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    try {
      await expect(client.actions.session.list({})).resolves.toEqual(result);
    } finally {
      await client.close();
    }
  });

  it('treats an explicitly undefined session.list query as the legacy no-query request', async () => {
    const result = {
      sessions: [{ id: 'legacy-visible-row', active: false, presence: 'offline', updatedAt: 1 }],
      nextCursor: null,
    };
    const transmittedInputs: unknown[] = [];
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Readonly<{ input?: unknown }>;
      transmittedInputs.push(request.input);
      return responseForRequest(init, {
        v: 1,
        actionId: 'session.list',
        execution: { ok: true, result },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    try {
      await expect(client.actions.session.list({ query: undefined })).resolves.toEqual(result);
      expect(transmittedInputs).toEqual([{}]);
    } finally {
      await client.close();
    }
  });

  it('protects child Action input and complete errors while keeping metadata bearer-only', async () => {
    const material = { type: 'dataKey' as const, machineKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
    const context = { serverIdentityId: 'srv_sdk', accountId: 'account-1',
      tokenId: '123e4567-e89b-42d3-a456-426614174000',
      contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=' };
    const wrappingSecret = new Uint8Array(32).fill(7);
    const bearer = `hap_v1_${context.tokenId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
    const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context, wrappingSecret,
      contentPrivateKey: material.machineKey, randomBytes: (length) => new Uint8Array(length).fill(3) });
    const token = formatAccountApiTokenCredentialV1({ bearer,
      wrappingSecret: encodeBase64(wrappingSecret, 'base64url'), serverIdentityId: context.serverIdentityId,
      accountId: context.accountId, contentPublicKey: context.contentPublicKey });
    const captured: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${bearer}`);
      captured.push(String(init?.body ?? ''));
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/encryption-access')) return response({ v: 1, accountId: context.accountId,
        tokenId: context.tokenId, encryptionAccess });
      if (path === '/v1/machines') return response([]);
      const request = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(String(init?.body)));
      const binding = { serverIdentityId: context.serverIdentityId, accountId: context.accountId,
        credentialId: context.tokenId, actionId: 'session.message.send',
        requestId: request.requestId, target: { kind: 'machine' as const, machineId: 'machine-1' } };
      expect(openExternalActionRequestV2({ envelope: request, binding, material })?.input)
        .toMatchObject({ message: 'private-input-sentinel' });
      const prepared = prepareExternalActionResponseV2({ binding, request, material,
        randomBytes: (length) => new Uint8Array(length).fill(4), executedMachineId: 'machine-1',
        execution: { ok: false, errorCode: 'conflict', error: 'private-error-sentinel',
          details: { document: 'private-document-sentinel' } } });
      captured.push(prepared.body);
      return response(prepared.response);
    });
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token });
    try {
      await expect(client.machine('machine-1').sessions.get('session-1').send('private-input-sentinel'))
        .rejects.toMatchObject({ code: 'conflict', message: 'private-error-sentinel',
          details: { document: 'private-document-sentinel' } });
      expect(captured.join('')).not.toContain('sentinel');
      expect(captured.join('')).not.toContain(token);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally { await client.close(); }
  });

  it('reports the protected response ceiling without exposing an unauthenticated response body', async () => {
    const material = { type: 'dataKey' as const, machineKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
    const context = { serverIdentityId: 'srv_sdk', accountId: 'account-1',
      tokenId: '123e4567-e89b-42d3-a456-426614174000',
      contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=' };
    const wrappingSecret = new Uint8Array(32).fill(7);
    const bearer = `hap_v1_${context.tokenId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
    const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context, wrappingSecret,
      contentPrivateKey: material.machineKey, randomBytes: (length) => new Uint8Array(length).fill(3) });
    const token = formatAccountApiTokenCredentialV1({ bearer,
      wrappingSecret: encodeBase64(wrappingSecret, 'base64url'), serverIdentityId: context.serverIdentityId,
      accountId: context.accountId, contentPublicKey: context.contentPublicKey });
    const fetch = vi.fn(async (url: URL | RequestInfo) => {
      if (new URL(String(url)).pathname.endsWith('/encryption-access')) {
        return response({ v: 1, accountId: context.accountId, tokenId: context.tokenId, encryptionAccess });
      }
      if (new URL(String(url)).pathname === '/v1/machines') return response([]);
      return new Response('{"private":"plaintext-sentinel"}', {
        headers: { 'content-length': String(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2 + 1) },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token });
    try {
      await expect(client.machine('machine-1').actions.execute(
        'action.spec.get',
        { id: 'session.message.send' },
      )).rejects.toMatchObject({
        code: 'response_too_large',
        details: { maxSerializedBytes: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2 },
      });
    } finally { await client.close(); }
  });

  it('keeps one caller out of another caller\'s shared Machine bootstrap cancellation', async () => {
    const material = { type: 'dataKey' as const, machineKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
    const context = { serverIdentityId: 'srv_sdk', accountId: 'account-1',
      tokenId: '123e4567-e89b-42d3-a456-426614174000',
      contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=' };
    const wrappingSecret = new Uint8Array(32).fill(7);
    const bearer = `hap_v1_${context.tokenId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
    const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context, wrappingSecret,
      contentPrivateKey: material.machineKey, randomBytes: (length) => new Uint8Array(length).fill(3) });
    const token = formatAccountApiTokenCredentialV1({ bearer,
      wrappingSecret: encodeBase64(wrappingSecret, 'base64url'), serverIdentityId: context.serverIdentityId,
      accountId: context.accountId, contentPublicKey: context.contentPublicKey });
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    let machineReads = 0;
    let releaseMachines = (): void => undefined;
    const machinesHeld = new Promise<void>((resolve) => { releaseMachines = resolve; });
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/encryption-access')) {
        return response({ v: 1, accountId: context.accountId, tokenId: context.tokenId, encryptionAccess });
      }
      if (path === '/v1/machines') {
        machineReads += 1;
        const signal = init?.signal ?? null;
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) { reject(signal.reason as Error); return; }
          signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
          void machinesHeld.then(resolve);
        });
        return response([]);
      }
      const request = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(String(init?.body)));
      const binding = { serverIdentityId: context.serverIdentityId, accountId: context.accountId,
        credentialId: context.tokenId, actionId: 'action.spec.get', requestId: request.requestId, target };
      return response(prepareExternalActionResponseV2({ binding, request, material,
        randomBytes: (length) => new Uint8Array(length).fill(4), executedMachineId: target.machineId,
        execution: { ok: true, result: { kind: 'approval_request_created',
          artifactId: 'artifact-1', actionId: binding.actionId } } }).response);
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token });
    try {
      const initiator = new AbortController();
      const follower = new AbortController();
      const machine = client.machine('machine-1');
      const first = machine.actions.execute('action.spec.get', { id: 'session.message.send' },
        { signal: initiator.signal });
      const second = machine.actions.execute('action.spec.get', { id: 'session.message.send' },
        { signal: follower.signal });
      const settled: string[] = [];
      void first.then(() => settled.push('first:fulfilled'), () => settled.push('first:rejected'));
      void second.then(() => settled.push('second:fulfilled'), () => settled.push('second:rejected'));
      while (machineReads === 0) await new Promise<void>((resolve) => setTimeout(resolve, 1));
      await new Promise<void>((resolve) => setTimeout(resolve, 5));

      initiator.abort(new Error('cancel one caller'));
      await expect(first).rejects.toThrow('cancel one caller');
      expect(settled).toEqual(['first:rejected']);

      releaseMachines();
      await expect(second).resolves.toEqual({ kind: 'approval_request_created',
        artifactId: 'artifact-1', actionId: 'action.spec.get' });
      expect(machineReads).toBe(1);
    } finally { await client.close(); }
  });

  it('preserves a complete encrypted approval outcome at the public SDK boundary', async () => {
    const material = { type: 'dataKey' as const, machineKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
    const context = { serverIdentityId: 'srv_sdk', accountId: 'account-1',
      tokenId: '123e4567-e89b-42d3-a456-426614174000',
      contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=' };
    const wrappingSecret = new Uint8Array(32).fill(7);
    const bearer = `hap_v1_${context.tokenId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
    const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context, wrappingSecret,
      contentPrivateKey: material.machineKey, randomBytes: (length) => new Uint8Array(length).fill(3) });
    const token = formatAccountApiTokenCredentialV1({ bearer,
      wrappingSecret: encodeBase64(wrappingSecret, 'base64url'), serverIdentityId: context.serverIdentityId,
      accountId: context.accountId, contentPublicKey: context.contentPublicKey });
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      if (new URL(String(url)).pathname.endsWith('/encryption-access')) {
        return response({ v: 1, accountId: context.accountId, tokenId: context.tokenId, encryptionAccess });
      }
      if (new URL(String(url)).pathname === '/v1/machines') return response([]);
      const request = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(String(init?.body)));
      const binding = { serverIdentityId: context.serverIdentityId, accountId: context.accountId,
        credentialId: context.tokenId, actionId: 'action.spec.get', requestId: request.requestId, target };
      return response(prepareExternalActionResponseV2({ binding, request, material,
        randomBytes: (length) => new Uint8Array(length).fill(4), executedMachineId: target.machineId,
        execution: { ok: true, result: { kind: 'approval_request_created',
          artifactId: 'private-approval-artifact', actionId: binding.actionId } } }).response);
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token });
    try {
      await expect(client.actions.execute('action.spec.get', { id: 'session.message.send' }, {
        target, requestId: 'approval-request-id',
      })).resolves.toEqual({ kind: 'approval_request_created',
        artifactId: 'private-approval-artifact', actionId: 'action.spec.get' });
    } finally { await client.close(); }
  });

  it('binds run sends and exact sidechain history through canonical Actions', async () => {
    const calls: Array<{ actionId: string; input: unknown; target: unknown; requestId?: string }> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body));
      calls.push({ actionId, input: body.input, target: body.target, requestId: body.requestId });
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: resultFor(actionId) } });
    });
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const run = client.sessions.get('session-1').runs.get('run-1');
    await expect(run.sendAndWait('hello', { localId: 'input-1' })).resolves.toEqual(MESSAGE_SEND_RESULT);
    await run.history({ limit: 5 }, { requestId: 'history-1', target: { kind: 'machine', machineId: 'machine-1' } });
    expect(calls.map(({ actionId }) => actionId)).toEqual([
      'session.message.send', 'execution.run.get', 'session.transcript.get',
    ]);
    expect(calls[0]).toMatchObject({ input: { sessionId: 'session-1', message: 'hello', localId: 'input-1',
      recipient: { kind: 'execution_run', runId: 'run-1' }, wait: true }, target: { kind: 'session', sessionId: 'session-1' } });
    expect(calls[1]).toEqual({ actionId: 'execution.run.get', input: { sessionId: 'session-1', runId: 'run-1' },
      target: { kind: 'machine', machineId: 'machine-1' }, requestId: undefined });
    expect(calls[2]).toEqual({ actionId: 'session.transcript.get', input: {
      sessionId: 'session-1', scope: 'sidechain', sidechainId: 'sidechain-1', limit: 5,
    }, target: { kind: 'machine', machineId: 'machine-1' }, requestId: 'history-1' });
    await client.close();
  });

  it('projects run send, terminal wait and stop onto their canonical Actions without extra reads', async () => {
    const calls: Array<{ actionId: string; input: unknown }> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      calls.push({ actionId, input: JSON.parse(String(init?.body)).input });
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: resultFor(actionId) } });
    });
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const run = client.sessions.get('session-1').runs.get('run-1');

    await run.send('hello');
    await run.wait({ timeoutSeconds: 30 });
    await run.stop();

    expect(calls).toEqual([
      { actionId: 'session.message.send', input: {
        sessionId: 'session-1', message: 'hello',
        recipient: { kind: 'execution_run', runId: 'run-1' }, wait: false,
      } },
      { actionId: 'execution.run.wait', input: { sessionId: 'session-1', runId: 'run-1', timeoutSeconds: 30 } },
      { actionId: 'execution.run.stop', input: { sessionId: 'session-1', runId: 'run-1' } },
    ]);
    // The bound Session handle never reaches the retained detached-run Action.
    expect(calls.some(({ actionId }) => actionId === 'execution.run.send')).toBe(false);
    await client.close();
  });

  it('preserves the operation-scoped target update requirement without falling back to detached run send', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      calls.push(actionId);
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: {
          ok: false,
          errorCode: 'session_input_target_update_required',
          error: 'session_input_target_update_required',
        },
      });
    });
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });

    await expect(client.sessions.get('session-1').runs.get('run-1').send('hello'))
      .rejects.toMatchObject({
        name: 'HappierActionError',
        code: 'session_input_target_update_required',
      });
    expect(calls).toEqual(['session.message.send']);
    await client.close();
  });

  it('keeps the handle identity even when an untyped caller supplies conflicting fields', async () => {
    const calls: Array<{ actionId: string; input: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      calls.push({ actionId, input: JSON.parse(String(init?.body)).input });
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: resultFor(actionId) } });
    });
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const run = client.sessions.get('session-1').runs.get('run-1');

    await run.send('hello', {
      sessionId: 'other-session', recipient: { kind: 'execution_run', runId: 'other-run' }, wait: true,
    } as never);

    expect(calls[0]?.input).toMatchObject({
      sessionId: 'session-1', recipient: { kind: 'execution_run', runId: 'run-1' }, wait: false,
    });
    await client.close();
  });

  it('rejects host-only and unknown fields before a bound run send reaches transport', async () => {
    const fetch = vi.fn(async () => response({ v: 1, actionId: 'session.message.send', execution: { ok: true, result: MESSAGE_SEND_RESULT } }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const run = client.sessions.get('session-1').runs.get('run-1');

    // Type-level omission cannot constrain plain JavaScript, so the canonical
    // public schema — not the wire — is what refuses a smuggled field.
    for (const smuggled of [
      { source: { sourceRef: 'plugin-owned' } },
      { attachments: [] },
      { idempotencyKey: 'plugin-owned-identity' },
      { authority: 'present_user' },
      { unknownField: true },
    ]) {
      await expect(run.send('hello', smuggled as never)).rejects.toMatchObject({
        name: 'HappierActionError', code: 'invalid_parameters',
      });
    }
    expect(fetch).not.toHaveBeenCalled();
    await client.close();
  });

  it('rejects unknown bound run wait fields before transport', async () => {
    const fetch = vi.fn(async () => response({ v: 1, actionId: 'execution.run.wait', execution: { ok: true, result: {} } }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });

    await expect(client.sessions.get('session-1').runs.get('run-1')
      .wait({ unknownField: true } as never))
      .rejects.toMatchObject({ name: 'HappierActionError', code: 'invalid_parameters' });
    expect(fetch).not.toHaveBeenCalled();
    await client.close();
  });

  it('rejects host-only and unknown parent Session fields before transport', async () => {
    const fetch = vi.fn(async () => response({
      v: 1,
      actionId: 'session.message.send',
      execution: { ok: true, result: MESSAGE_SEND_RESULT },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const session = client.sessions.get('session-1');

    for (const input of [
      { source: { sourceRef: 'plugin-owned' } },
      { attachments: [] },
      { idempotencyKey: 'plugin-owned-identity' },
      { unknownField: true },
    ]) {
      await expect(session.sendAndWait('hello', input as never))
        .rejects.toMatchObject({ name: 'HappierActionError', code: 'invalid_parameters' });
    }
    await expect(session.waitForIdle({ unknownField: true } as never))
      .rejects.toMatchObject({ name: 'HappierActionError', code: 'invalid_parameters' });
    await expect(session.history({ unknownField: true } as never))
      .rejects.toMatchObject({ name: 'HappierActionError', code: 'invalid_parameters' });
    expect(fetch).not.toHaveBeenCalled();
    await client.close();
  });

  it('refuses a transcript projection on a bound run history read without selecting one silently', async () => {
    const fetch = vi.fn(async () => response({ v: 1, actionId: 'execution.run.get', execution: { ok: true, result: { run: RUN_RESULT } } }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });

    await expect(client.sessions.get('session-1').runs.get('run-1')
      .history({ projection: 'externalShareableV1' } as never))
      .rejects.toMatchObject({ name: 'HappierActionError', code: 'invalid_parameters' });
    expect(fetch).not.toHaveBeenCalled();
    await client.close();
  });

  it('never reads a transcript for a run correspondence the Action did not really return', async () => {
    const actionIds: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      // A run that names no transcript sidechain is not a result this Action
      // can return, so the correspondence read fails at the typed boundary and
      // no sidechain transcript request follows it.
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true,
        result: { run: { ...RUN_RESULT, sidechainId: '' } } } });
    });
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });

    // Plan 05.06 §5.6: one typed SDK/Action-domain failure, never a generic
    // transport error, and never a transcript request.
    await expect(client.sessions.get('session-1').runs.get('run-1').history())
      .rejects.toMatchObject({
        name: 'HappierActionError', code: 'execution_run_correspondence_unavailable',
      });
    expect(actionIds).toEqual(['execution.run.get']);
    await client.close();
  });

  it('never falls back to a main-scope transcript read when run correspondence fails', async () => {
    const actionIds: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      return responseForRequest(init, { v: 1, actionId, execution: actionId === 'execution.run.get'
        ? { ok: false, errorCode: 'not_found', error: 'no such run' }
        : { ok: true, result: { items: [] } } });
    });
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });

    await expect(client.sessions.get('session-1').runs.get('run-1').history())
      .rejects.toMatchObject({ code: 'not_found' });
    expect(actionIds).toEqual(['execution.run.get']);
    await client.close();
  });

  afterEach(() => {
    for (const socket of notificationNetwork.sockets) socket.disconnect();
    notificationNetwork.sockets.length = 0;
    notificationNetwork.io.mockClear();
    vi.unstubAllGlobals();
    undiciRequest.mockClear();
    undiciAgent.Agent.mockClear();
    undiciAgent.destroy.mockReset();
    undiciAgent.destroy.mockResolvedValue(undefined);
    undiciAgent.instances.length = 0;
  });

  it('rejects padded or over-limit machine and Session identities without normalizing them', () => {
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });

    expect(() => client.machine(' machine-1 ')).toThrow(TypeError);
    expect(() => client.machine('m'.repeat(257))).toThrow(TypeError);
    expect(() => client.sessions.get(' session-1 ')).toThrow(TypeError);
    expect(() => client.sessions.get('s'.repeat(192))).toThrow(TypeError);
  });

  it('rejects padded API Tokens without normalizing credential bytes', () => {
    expect(() => connect({ endpoint: 'http://daemon', token: ' hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ' })).toThrow(TypeError);
  });

  it('owns one dispatcher per root client, shares it with bound clients, and closes it once', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => response({
      v: 1,
      actionId: 'machines.list',
      execution: { ok: true, result: [] },
    }));
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const machine = client.machine('machine-1');
    await client.actions.execute('machines.list', {});
    await machine.actions.execute('machines.list', {});

    expect(undiciAgent.Agent).toHaveBeenCalledTimes(1);
    expect(undiciAgent.instances).toHaveLength(1);
    const dispatcher = undiciAgent.instances[0];
    expect(undiciRequest.mock.calls.map(([, options]) => options?.dispatcher)).toEqual([
      dispatcher,
      dispatcher,
    ]);

    const firstClose = client.close();
    const secondClose = machine.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(undiciAgent.destroy).toHaveBeenCalledTimes(1);
  });

  it('finishes active transcript and execution-run cleanup before disposing its dispatcher', async () => {
    const order: string[] = [];
    undiciAgent.destroy.mockImplementation(async () => {
      order.push('dispatcher.destroy');
    });
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      order.push(actionId);
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      if (actionId === 'transcript.follow') {
        return response({
          v: 1,
          actionId,
          execution: { ok: true, result: { items: [{ role: 'assistant' }], nextCursor: '1', truncated: false } },
        });
      }
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    await client.runs.startStream({ runId: 'run-1', message: 'Continue.' });
    const iterator = client.sessions.get('session-1').followTranscript()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { role: 'assistant' } });

    await client.close();

    const destroyIndex = order.indexOf('dispatcher.destroy');
    expect(notificationNetwork.sockets.every((socket) => !socket.connected)).toBe(true);
    expect(order).toContain('execution.run.stream.cancel');
    expect(order).toContain('transcript.unfollow');
    expect(destroyIndex).toBeGreaterThan(order.indexOf('execution.run.stream.cancel'));
    expect(destroyIndex).toBeGreaterThan(order.indexOf('transcript.unfollow'));
  });

  it('does not start an unconsumed transcript lifecycle after its client closes', async () => {
    const actionIds: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL | RequestInfo) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      return response({ v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    }));

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const transcript = client.sessions.get('session-1').followTranscript();
    await client.close();

    await expect(transcript[Symbol.asyncIterator]().next()).resolves.toEqual({ done: true, value: undefined });
    expect(actionIds).toEqual([]);
    expect(notificationNetwork.io).not.toHaveBeenCalled();
  });

  it('executes one raw typed Action through the frozen HTTP envelope', async () => {
    const fetch = vi.fn(async () => response({
      v: 1,
      actionId: 'machines.list',
      execution: { ok: true, result: [{ id: 'machine-1' }] },
    }));
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://127.0.0.1:3000/', token: TEST_ALT_API_TOKEN });
    await expect(client.actions.execute('machines.list', {})).resolves.toEqual([{ id: 'machine-1' }]);

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3000/v1/actions/machines.list'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer ' + TEST_ALT_API_TOKEN }),
        body: JSON.stringify({ v: 1, input: {} }),
      }),
    );
  });

  it('executes the generated Lane 01 Team client through the canonical public Action route', async () => {
    const archivedTeam = {
      id: 'team-1',
      name: 'Platform',
      description: null,
      logo: null,
      archivedAt: 10,
      recovery: null,
      policy: {
        v: 1,
        sessionCreationPolicy: 'private_default',
        externalSharingPolicy: 'allowed',
        defaultSessionHistoryAccess: 'from_membership',
        admissionMode: 'invite_only',
        authenticationPolicy: null,
        authenticationPolicyStatus: 'available',
      },
      viewerRole: 'owner',
      capabilities: {
        viewTeam: true, viewRoster: true, manageSettings: true, managePolicy: true, manageMembers: true,
        manageGroups: true, manageInvitations: true, manageOwners: true,
        manageAuthentication: true, archiveTeam: true, restoreTeam: true,
      },
      admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
      counts: null,
    };
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'teams.archive',
      execution: { ok: true, result: archivedTeam },
    }));
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://home.test', token: TEST_API_TOKEN });
    await expect(client.actions.teams.archive({ v: 1, teamId: 'team-1' }, {
      requestId: 'lane01-archive-1',
      target: { kind: 'machine', machineId: 'machine-1' },
    })).resolves.toEqual(archivedTeam);

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://home.test/v1/actions/teams.archive'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: `Bearer ${TEST_API_TOKEN}` }),
        body: JSON.stringify({
          v: 1,
          requestId: 'lane01-archive-1',
          target: { kind: 'machine', machineId: 'machine-1' },
          input: { v: 1, teamId: 'team-1' },
        }),
      }),
    );
  });

  it('rejects a response whose echoed request id does not match the request', async () => {
    const fetch = vi.fn(async () => response({
      v: 1,
      actionId: 'session.stop',
      requestId: 'different-request',
      execution: { ok: true, result: { stopped: true } },
    }));
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    await expect(client.actions.execute(
      'session.stop',
      { sessionId: 'session-1' },
      { requestId: 'request-1' },
    )).rejects.toMatchObject({
      name: 'HappierTransportError',
      message: 'The Happier Action API returned an invalid response envelope.',
    });
  });

  it('rejects a missing or unsolicited request-id echo', async () => {
    const responses = [
      {
        v: 1,
        actionId: 'session.stop',
        execution: { ok: true, result: { stopped: true } },
      },
      {
        v: 1,
        actionId: 'machines.list',
        requestId: 'unsolicited-request',
        execution: { ok: true, result: [] },
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => response(responses.shift())));

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    await expect(client.actions.execute(
      'session.stop',
      { sessionId: 'session-1' },
      { requestId: 'request-1' },
    )).rejects.toBeInstanceOf(HappierTransportError);
    await expect(client.actions.execute('machines.list', {})).rejects.toBeInstanceOf(HappierTransportError);
  });

  it('validates caller request ids through the Protocol request-id schema without rewriting them', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.stop',
      execution: { ok: true, result: { stopped: true } },
    }));
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });

    // The original value is sent unchanged, including Unicode.
    await expect(client.actions.execute(
      'session.stop',
      { sessionId: 'session-1' },
      { requestId: 'corrélation-☃' },
    )).resolves.toEqual({ stopped: true });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ requestId: 'corrélation-☃' });

    // The full 128-code-unit bound is admitted; 129 is a local TypeError.
    await expect(client.actions.execute(
      'session.stop',
      { sessionId: 'session-1' },
      { requestId: 'r'.repeat(128) },
    )).resolves.toEqual({ stopped: true });
    await expect(client.actions.execute(
      'session.stop',
      { sessionId: 'session-1' },
      { requestId: 'r'.repeat(129) },
    )).rejects.toThrow(new TypeError('requestId must be 1-128 code units with no outer whitespace'));

    // Outer whitespace is rejected, never trimmed into a different identity.
    await expect(client.actions.execute(
      'session.stop',
      { sessionId: 'session-1' },
      { requestId: ' padded ' },
    )).rejects.toBeInstanceOf(TypeError);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('still generates a UUID request id for a mutation when none is supplied', async () => {
    let requestId: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      requestId = JSON.parse(String(init?.body)).requestId;
      return responseForRequest(init, {
        v: 1,
        actionId: 'session.message.send',
        execution: { ok: true, result: MESSAGE_SEND_RESULT },
      });
    }));

    await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .actions.execute('session.message.send', { sessionId: 'session-1', message: 'Continue.', localId: 'input-1' });

    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  });

  it('preserves the effective generated request id on Action errors', async () => {
    let requestId: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      requestId = JSON.parse(String(init?.body)).requestId;
      return response({
        v: 1,
        actionId: 'session.message.send',
        requestId,
        execution: { ok: false, errorCode: 'action_failed', error: 'Could not stop Session.' },
      });
    }));

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const error = await client.actions.execute('session.message.send', {
      sessionId: 'session-1',
      message: 'Continue.',
      localId: 'input-1',
    }).catch((cause) => cause);

    expect(requestId).toEqual(expect.any(String));
    expect(error).toMatchObject({
      name: 'HappierActionError',
      code: 'action_failed',
      requestId,
    });
  });

  it('preserves the effective generated request id on transport errors', async () => {
    let requestId: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      requestId = JSON.parse(String(init?.body)).requestId;
      return response({ error: 'invalid_token' }, 401);
    }));

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const error = await client.actions.execute('session.message.send', {
      sessionId: 'session-1',
      message: 'Continue.',
      localId: 'input-1',
    }).catch((cause) => cause);

    expect(requestId).toEqual(expect.any(String));
    expect(error).toMatchObject({
      name: 'HappierTransportError',
      code: 'invalid_token',
      status: 401,
      requestId,
    });
  });

  it('sends and waits through the correlated session Action', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.message.send',
      execution: { ok: true, result: MESSAGE_SEND_RESULT },
    }));
    vi.stubGlobal('fetch', fetch);

    await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .machine('machine-7')
      .sessions
      .get('session-1')
      .sendAndWait(
        'Inspect the failure, then report back.',
        { localId: 'input-1', timeoutSeconds: 3600 },
        { requestId: 'request-1' },
      );

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://daemon/v1/actions/session.message.send'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      requestId: 'request-1',
      target: { kind: 'machine', machineId: 'machine-7' },
      input: {
        sessionId: 'session-1',
        message: 'Inspect the failure, then report back.',
        localId: 'input-1',
        timeoutSeconds: 3600,
        wait: true,
      },
    });
    expect(undiciRequest).toHaveBeenCalledWith(
      new URL('http://daemon/v1/actions/session.message.send'),
      expect.objectContaining({ headersTimeout: 0 }),
    );
  });

  it('defaults root fluent Session operations to their canonical Session target', async () => {
    const requests: Array<Readonly<{ actionId: string; body: Record<string, unknown> }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ actionId, body });
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: {
          ok: true,
          result: resultFor(actionId),
        },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const session = connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN })
      .sessions.get('session-1');
    await session.send('Continue.');
    await session.sendAndWait('Continue and wait.');
    await session.waitForIdle();
    await session.history();
    await session.stop();

    expect(requests.map(({ actionId }) => actionId)).toEqual([
      'session.message.send',
      'session.message.send',
      'session.wait.idle',
      'session.transcript.get',
      'session.stop',
    ]);
    for (const { body } of requests) {
      expect(body.target).toEqual({ kind: 'session', sessionId: 'session-1' });
    }
  });

  it('lets an explicit root fluent Session target override Session routing metadata', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.message.send',
      execution: { ok: true, result: MESSAGE_SEND_RESULT },
    }));
    vi.stubGlobal('fetch', fetch);

    await connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN })
      .sessions.get('session-1')
      .send('Continue.', { target: { kind: 'machine', machineId: 'machine-7' } });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      target: { kind: 'machine', machineId: 'machine-7' },
    });
  });

  it('seals every machine-bound raw Action to its selected machine', async () => {
    const requests: unknown[] = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return response({
        v: 1,
        actionId: 'machines.list',
        execution: { ok: true, result: [{ id: 'machine-8' }] },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const machine = client.machine('machine-7');
    const otherMachine = { kind: 'machine', machineId: 'machine-8' } as const;

    if (false) {
      // @ts-expect-error A machine-bound Action cannot replace its selected target.
      machine.actions.execute('machines.list', {}, { target: otherMachine });
      // @ts-expect-error Generated Action methods share the machine-bound option contract.
      machine.actions.machines.list({}, { target: otherMachine });
      // @ts-expect-error Action discovery is also sealed when accessed from a machine client.
      machine.actions.search({ query: 'machine' }, { target: otherMachine });
      // @ts-expect-error Action-definition lookup is also sealed when accessed from a machine client.
      machine.actions.get({ id: 'session.status.get' }, { target: otherMachine });
      // @ts-expect-error Contributed Action invocation is also sealed when accessed from a machine client.
      machine.actions.invoke({ pluginId: 'acme.notes', localId: 'save' }, {}, { target: otherMachine });
    }

    await expect(machine.actions.execute('machines.list', {}, {
      // @ts-expect-error Runtime callers cannot redirect a machine-bound client either.
      target: otherMachine,
      requestId: 'conflicting-request',
    })).rejects.toMatchObject({
      code: 'machine_target_conflict',
      requestId: 'conflicting-request',
    });
    await expect(machine.actions.machines.list({}, {
      // @ts-expect-error Generated methods also reject an attempted runtime redirect.
      target: otherMachine,
    })).rejects.toMatchObject({ code: 'machine_target_conflict' });
    await expect(machine.actions.search({ query: 'machine' }, {
      // @ts-expect-error The search convenience method also rejects an attempted runtime redirect.
      target: otherMachine,
    })).rejects.toMatchObject({ code: 'machine_target_conflict' });
    await expect(machine.actions.get({ id: 'session.status.get' }, {
      // @ts-expect-error The definition convenience method also rejects an attempted runtime redirect.
      target: otherMachine,
    })).rejects.toMatchObject({ code: 'machine_target_conflict' });
    await expect(machine.actions.invoke({ pluginId: 'acme.notes', localId: 'save' }, {}, {
      // @ts-expect-error The invoke convenience method also rejects an attempted runtime redirect.
      target: otherMachine,
    })).rejects.toMatchObject({ code: 'machine_target_conflict' });
    expect(fetch).not.toHaveBeenCalled();

    await client.actions.execute('machines.list', {}, { target: otherMachine });
    expect(requests).toEqual([{
      v: 1,
      target: otherMachine,
      input: {},
    }]);
  });

  it('lists narrow machine bootstrap rows through the authenticated server route', async () => {
    const fetch = vi.fn(async () => response([{
      id: 'machine-1',
      active: true,
      revokedAt: null,
      replacedByMachineId: null,
    }]));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;

    const client = connect({ endpoint: 'https://api.example.test/root/', token: TEST_ALT_API_TOKEN });
    await expect(client.machines.list({ signal })).resolves.toEqual([{
      id: 'machine-1',
      kind: 'persistent',
      active: true,
      revokedAt: null,
      replacedByMachineId: null,
    }]);
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://api.example.test/root/v1/machines'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer ' + TEST_ALT_API_TOKEN }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects legacy full machine rows at the external bootstrap boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([{
      id: 'machine-1',
      active: true,
      revokedAt: null,
      replacedByMachineId: null,
      metadata: '{"host":"workstation"}',
    }])));

    await expect(
      connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN }).machines.list(),
    ).rejects.toBeInstanceOf(HappierTransportError);
  });

  it('makes generated methods zero-logic call-throughs and binds machine targets', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => response({
      v: 1,
      actionId: 'session.spawn_new',
      execution: { ok: true, result: {
        type: 'success', disposition: 'created', sessionId: 'session-1',
        executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' },
      } },
      requestId: JSON.parse(String(init?.body)).requestId,
    }));
    vi.stubGlobal('fetch', fetch);

    const machine = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).machine('machine-7');
    const spawnInput = {
      directory: { kind: 'path', path: '/repo' },
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
    } as const;
    await machine.actions.session.spawnNew(spawnInput, { requestId: 'request-1' });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      requestId: 'request-1',
      target: { kind: 'machine', machineId: 'machine-7' },
      input: spawnInput,
    });
  });

  it('adds a same-Machine project to machine-bound Workflow start transport', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'workflow.run.start',
      execution: { ok: true, result: {
        run: {
          id: 'run-1', origin: { kind: 'automation', automationId: 'automation-1' },
          sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
          state: 'queued', revision: 1, machineId: 'machine-1',
          workflowCustodyState: null, originDeliveryAckRevision: null,
          availability: {
            pause: false, resumeBoundary: false, restoreWorkspace: false,
            cancel: false, inspectExecution: false, disabledReasons: [],
          },
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
        admission: 'created',
      } },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const input = {
      runId: '11111111-1111-4111-8111-111111111111',
      source: { kind: 'inline' as const, definition: { blocks: ['work'] } },
    };

    await client.machine('machine-1').actions.workflow.run.start(input, {
      project: { machineId: 'machine-1', directory: '/repo' },
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      target: {
        kind: 'machine',
        machineId: 'machine-1',
        project: { machineId: 'machine-1', directory: '/repo' },
      },
      input,
    });

    fetch.mockClear();
    await expect(client.machine('machine-1').actions.workflow.run.start(input, {
      project: { machineId: 'machine-2', directory: '/repo' },
    })).rejects.toMatchObject({ code: 'machine_target_conflict' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('publishes all six Machine Pool methods without changing caller-owned retry identities', async () => {
    const calls: Array<{ actionId: string; input: unknown }> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const input = JSON.parse(String(init?.body)).input;
      calls.push({ actionId, input });
      return responseForRequest(init, { v: 1, actionId, execution: { ok: false, errorCode: RESULT_NOT_UNDER_TEST, error: RESULT_NOT_UNDER_TEST } });
    });
    vi.stubGlobal('fetch', fetch);

    const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
    const create = { poolId, name: 'Fast', description: 'Home-readable', members: [] };
    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    await callsTransport(client.actions.machines.pools.list({}));
    await callsTransport(client.actions.machines.pools.get({ poolId }));
    await callsTransport(client.actions.machines.pools.create(create));
    await callsTransport(client.actions.machines.pools.create(create));
    await callsTransport(client.actions.machines.pools.update({ ...create, expectedRevision: 4 }));
    await callsTransport(client.actions.machines.pools.delete({ poolId, expectedRevision: 4 }));
    await callsTransport(client.actions.machines.pools.resolve({ poolId, requestKey: 'selection-1' }));

    expect(calls).toEqual([
      { actionId: 'machines.pools.list', input: {} },
      { actionId: 'machines.pools.get', input: { poolId } },
      { actionId: 'machines.pools.create', input: create },
      { actionId: 'machines.pools.create', input: create },
      { actionId: 'machines.pools.update', input: { ...create, expectedRevision: 4 } },
      { actionId: 'machines.pools.delete', input: { poolId, expectedRevision: 4 } },
      { actionId: 'machines.pools.resolve', input: { poolId, requestKey: 'selection-1' } },
    ]);
  });

  it('publishes both directory removal preview and the approved removal execution leaf', async () => {
    const calls: Array<{ actionId: string; input: unknown }> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const input = JSON.parse(String(init?.body)).input;
      calls.push({ actionId, input });
      return responseForRequest(init, { v: 1, actionId, execution: { ok: false, errorCode: RESULT_NOT_UNDER_TEST, error: RESULT_NOT_UNDER_TEST } });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    await callsTransport(client.actions.identity.providers.remove.preview({
      owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 1,
    }));
    await callsTransport(client.actions.teams.identity.connections.remove.preview({
      v: 1, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 1,
    }));
    await callsTransport(client.actions.teams.directory.sources.remove.preview({
      v: 1, teamId: 'team-1', sourceId: 'source-1',
    }));
    await callsTransport(client.actions.teams.directory.sources.remove.execute({
      v: 1, teamId: 'team-1', sourceId: 'source-1',
    }));

    expect(calls).toEqual([
      { actionId: 'identity.providers.remove.preview', input: {
        owner: { kind: 'home' }, id: 'provider-1', expectedRevision: 1,
      } },
      { actionId: 'teams.identity.connections.remove.preview', input: {
        v: 1, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 1,
      } },
      { actionId: 'teams.directory.sources.remove.preview', input: {
        v: 1, teamId: 'team-1', sourceId: 'source-1',
      } },
      { actionId: 'teams.directory.sources.remove', input: {
        v: 1, teamId: 'team-1', sourceId: 'source-1',
      } },
    ]);
    await client.close();
  });

  it('publishes every bounded Lane 03 identity handoff through the generated public Action ABI', async () => {
    const calls: Array<{ actionId: string; input: unknown }> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const input = JSON.parse(String(init?.body)).input;
      calls.push({ actionId, input });
      return responseForRequest(init, { v: 1, actionId, execution: { ok: false, errorCode: RESULT_NOT_UNDER_TEST, error: RESULT_NOT_UNDER_TEST } });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const providerOwner = { kind: 'team' as const, teamId: 'team-1' };
    await callsTransport(client.actions.identity.providers.test.start({
      owner: providerOwner, id: 'provider-1', expectedRevision: 3, expectedSecurityRevision: 2,
    }));
    await callsTransport(client.actions.identity.providers.test.consume({
      owner: providerOwner, id: 'provider-1', resultHandle: 'provider-result',
    }));
    await callsTransport(client.actions.teams.identity.connections.test.start({
      v: 1, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 3,
    }));
    await callsTransport(client.actions.teams.identity.connections.test.consume({
      v: 1, teamId: 'team-1', connectionId: 'connection-1', resultHandle: 'connection-result',
    }));
    await callsTransport(client.actions.teams.identity.workos.adminPortalLink.create({
      v: 1, teamId: 'team-1', connectionId: 'connection-1', intent: 'sso',
    }));

    expect(calls).toEqual([
      { actionId: 'identity.providers.test.start', input: {
        owner: providerOwner, id: 'provider-1', expectedRevision: 3, expectedSecurityRevision: 2,
      } },
      { actionId: 'identity.providers.test.consume', input: {
        owner: providerOwner, id: 'provider-1', resultHandle: 'provider-result',
      } },
      { actionId: 'teams.identity.connections.test.start', input: {
        v: 1, teamId: 'team-1', connectionId: 'connection-1', expectedRevision: 3,
      } },
      { actionId: 'teams.identity.connections.test.consume', input: {
        v: 1, teamId: 'team-1', connectionId: 'connection-1', resultHandle: 'connection-result',
      } },
      { actionId: 'teams.identity.workos.adminPortalLink.create', input: {
        v: 1, teamId: 'team-1', connectionId: 'connection-1', intent: 'sso',
      } },
    ]);
    await client.close();
  });

  it('maps compact machine-bound session creation and accepts already-admitted input', async () => {
    const requests: Array<Readonly<{ actionId: string; body: unknown }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body));
      requests.push({ actionId, body });
      if (actionId === 'agents.backends.list') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: [{
                targetKey: 'backend:happier.agent.codex',
                label: 'Codex',
                enabled: true,
                agentId: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              }],
            },
          },
        });
      }
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: {
          ok: true,
          result: {
            type: 'success',
            disposition: 'created',
            sessionId: 'session-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'alreadyAccepted', localId: 'initial-input-1' },
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const machine = client.machine('machine-7');
    const otherMachine = { kind: 'machine', machineId: 'machine-8' } as const;
    expectTypeOf(machine).toEqualTypeOf<HappierMachineClient>();
    expectTypeOf<HappierSessionSpawnInput['modelSelection']>().toEqualTypeOf<
      PublicActionInputById['session.spawn_new']['modelSelection']
    >();
    expectTypeOf<HappierSessionSpawnInput['agentModeId']>().toEqualTypeOf<
      PublicActionInputById['session.spawn_new']['agentModeId']
    >();
    expectTypeOf<HappierSessionSpawnInput['agent']>().toEqualTypeOf<string>();
    // Raw launch environment reaches the daemon verbatim on this direct-to-daemon path; the
    // browser-safe server-start draft is where `sessionSpawnNewInputV2.ts` omits it instead.
    expectTypeOf<HappierSessionSpawnInput['environmentVariables']>().toEqualTypeOf<
      PublicActionInputById['session.spawn_new']['environmentVariables']
    >();

    const input = {
      directory: { kind: 'path', path: '/repo' },
      agent: 'codex',
      initialMessage: 'Inspect the failing tests.',
      agentModeId: 'review',
      title: 'External agent session',
    } as const satisfies HappierSessionSpawnInput;

    // @ts-expect-error The target is supplied only by machine(machineId).
    const targetConflict: HappierSessionSpawnInput = { ...input, executionTarget: { serverId: 'wrong', machineId: 'other' } };
    const agentTargetConflict: HappierSessionSpawnInput = {
      ...input,
      // @ts-expect-error Fluent input accepts one Agent routing id, never a raw target.
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
    };
    void targetConflict;
    void agentTargetConflict;

    if (false) {
      const rootSession = client.sessions.get('session-1');
      rootSession.send('Inspect the failing tests.', { target: otherMachine });
      client.sessions.spawn(input, { target: otherMachine });
      // @ts-expect-error A machine-bound Session spawn cannot replace its selected target.
      machine.sessions.spawn(input, { target: otherMachine });
      const machineSession = machine.sessions.get('session-1');
      // @ts-expect-error A machine-bound Session handle cannot replace its selected target.
      machineSession.send('Inspect the failing tests.', { target: otherMachine });
      // @ts-expect-error Every machine-bound Session handle call stays on its selected target.
      machineSession.waitForIdle({}, { target: otherMachine });
    }

    const session = await machine.sessions.spawn(input, { requestId: 'request-1' });
    expect(session.id).toBe('session-1');
    expect(requests).toEqual([
      {
        actionId: 'agents.backends.list',
        body: {
          v: 1,
          target: { kind: 'machine', machineId: 'machine-7' },
          input: { includeDisabled: true },
        },
      },
      {
        actionId: 'session.spawn_new',
        body: {
          v: 1,
          requestId: 'request-1',
          target: { kind: 'machine', machineId: 'machine-7' },
          input: {
            directory: { kind: 'path', path: '/repo' },
            agentTarget: {
              kind: 'agent',
              identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
            initialInput: { text: 'Inspect the failing tests.' },
            agentModeId: 'review',
            title: 'External agent session',
          },
        },
      },
    ]);

  });

  it('surfaces deferred Session-creation approval as a typed Action error', async () => {
    const approval = {
      kind: 'approval_request_created',
      artifactId: 'approval-1',
      actionId: 'session.spawn_new',
    } as const;
    const requests: Array<Readonly<{ actionId: string; requestId?: string }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const requestId = JSON.parse(String(init?.body)).requestId;
      requests.push({ actionId, ...(typeof requestId === 'string' ? { requestId } : {}) });
      if (actionId === 'agents.backends.list') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: [{
                targetKey: 'backend:happier.agent.codex',
                label: 'Codex',
                enabled: true,
                agentId: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              }],
            },
          },
        });
      }
      const actionApproval = { ...approval, actionId };
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: { ok: true, result: actionApproval },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const rawApproval = await client.actions.execute('session.stop', { sessionId: 'session-1' });
    expect(isHappierActionApprovalRequestCreated(rawApproval)).toBe(true);
    expect(rawApproval).toEqual({ ...approval, actionId: 'session.stop' });

    const failure = client
      .machine('machine-7')
      .sessions.spawn({ directory: { kind: 'path', path: '/repo' }, agent: 'codex' });

    await expect(failure).rejects.toBeInstanceOf(HappierActionError);
    await expect(failure).rejects.toMatchObject({
      code: 'approval_required',
      details: approval,
      requestId: expect.any(String),
    });
    await expect(failure).rejects.not.toBeInstanceOf(HappierSessionSpawnError);
    const rejection = await failure.catch((error) => error);
    expect(requests).toEqual([
      { actionId: 'session.stop' },
      { actionId: 'agents.backends.list' },
      { actionId: 'session.spawn_new', requestId: expect.any(String) },
    ]);
    expect(rejection.requestId).toBe(requests[2]?.requestId);
  });

  it.each([
    ['missing artifact identity', { kind: 'approval_request_created', actionId: 'session.stop' }],
    ['mismatched Action identity', { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'machines.list' }],
  ] as const)('rejects a malformed raw approval result with %s', async (_case, approval) => {
    vi.stubGlobal('fetch', vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.stop',
      execution: { ok: true, result: approval },
    })));

    await expect(
      connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
        .actions.execute('session.stop', { sessionId: 'session-1' }),
    ).rejects.toMatchObject({
      name: 'HappierTransportError',
      message: 'The Happier Action API returned an invalid approval result.',
    });
  });

  it('maps compact daemon-local session creation without a target', async () => {
    const requests: Array<Readonly<{ actionId: string; body: unknown }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body));
      requests.push({ actionId, body });
      if (actionId === 'agents.backends.list') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: [{
                targetKey: 'backend:happier.agent.codex',
                label: 'Codex',
                enabled: true,
                agentId: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              }],
            },
          },
        });
      }
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: {
          ok: true,
          result: {
            type: 'success',
            disposition: 'created',
            sessionId: 'session-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'accepted', localId: 'initial-input-1' },
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const session = await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).sessions.spawn({
      directory: { kind: 'path', path: '/repo' },
      agent: 'codex',
    }, { requestId: 'request-1' });

    expect(session.id).toBe('session-1');
    expect(requests).toEqual([
      {
        actionId: 'agents.backends.list',
        body: {
          v: 1,
          input: { includeDisabled: true },
        },
      },
      {
        actionId: 'session.spawn_new',
        body: {
          v: 1,
          requestId: 'request-1',
          input: {
            directory: { kind: 'path', path: '/repo' },
            agentTarget: {
              kind: 'agent',
              identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
          },
        },
      },
    ]);
  });

  it('forwards an unbound fluent spawn target to inventory but keeps request identity on the mutation', async () => {
    const requests: Array<Readonly<{ actionId: string; body: unknown }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body));
      requests.push({ actionId, body });
      if (actionId === 'agents.backends.list') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: [{
                targetKey: 'backend:happier.agent.codex',
                label: 'Codex',
                enabled: true,
                agentId: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              }],
            },
          },
        });
      }
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: {
          ok: true,
          result: {
            type: 'success',
            disposition: 'created',
            sessionId: 'session-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'notRequested' },
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const target = { kind: 'machine', machineId: 'machine-7' } as const;
    await connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN }).sessions.spawn({
      directory: { kind: 'path', path: '/repo' },
      agent: 'codex',
    }, { target, requestId: 'spawn-request-1' });

    expect(requests).toEqual([
      {
        actionId: 'agents.backends.list',
        body: {
          v: 1,
          target,
          input: { includeDisabled: true },
        },
      },
      {
        actionId: 'session.spawn_new',
        body: {
          v: 1,
          requestId: 'spawn-request-1',
          target,
          input: {
            directory: { kind: 'path', path: '/repo' },
            agentTarget: {
              kind: 'agent',
              identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            },
          },
        },
      },
    ]);
  });

  it('reports the exact unavailable Agent outcome before attempting a spawn', async () => {
    const cases = [
      {
        reason: 'not_installed' as const,
        items: [{
          targetKey: 'backend:happier.agent.claude',
          label: 'codex',
          enabled: true,
          agentId: 'claude',
          identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
        }],
      },
      {
        reason: 'disabled' as const,
        items: [{
          targetKey: 'backend:happier.agent.codex',
          label: 'Codex',
          enabled: false,
          agentId: 'codex',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        }],
      },
      {
        reason: 'identity_unavailable' as const,
        items: [{
          targetKey: 'acpBackend:codex',
          label: 'Codex',
          enabled: true,
          agentId: 'codex',
        }],
      },
    ];

    for (const testCase of cases) {
      const fetch = vi.fn(async (url: URL | RequestInfo, _init?: RequestInit) => response({
        v: 1,
        actionId: decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? ''),
        execution: { ok: true, result: { items: testCase.items } },
      }));
      vi.stubGlobal('fetch', fetch);

      const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
        .machine('machine-7')
        .sessions.spawn({ directory: { kind: 'path', path: '/repo' }, agent: 'codex' });
      await expect(failure).rejects.toBeInstanceOf(HappierAgentUnavailableError);
      await expect(failure).rejects.toMatchObject({ agentId: 'codex', reason: testCase.reason });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
        v: 1,
        target: { kind: 'machine', machineId: 'machine-7' },
        input: { includeDisabled: true },
      });
    }
  });

  it.each([
    ['rejected', { status: 'rejected', code: 'session_input_target_update_required' }],
    ['outcome unknown', {
      status: 'outcomeUnknown',
      localId: 'initial-input-1',
      code: 'machine_admission_acknowledgement_failed',
    }],
    ['not requested', { status: 'notRequested' }],
  ] as const)(
    'preserves the committed Session when requested initial input is %s',
    async (_label, initialInput) => {
      const actionIds: string[] = [];
      const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
        const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
        actionIds.push(actionId);
        if (actionId === 'agents.backends.list') {
          return responseForRequest(init, {
            v: 1,
            actionId,
            execution: {
              ok: true,
              result: {
                items: [{
                  targetKey: 'backend:happier.agent.codex',
                  label: 'Codex',
                  enabled: true,
                  agentId: 'codex',
                  identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                }],
              },
            },
          });
        }
        if (actionId === 'session.spawn_new') {
          return responseForRequest(init, {
            v: 1,
            actionId,
            execution: {
              ok: true,
              result: {
                type: 'success',
                disposition: 'created',
                sessionId: 'session-1',
                executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput,
              },
            },
          });
        }
        return responseForRequest(init, {
          v: 1,
          actionId,
          execution: { ok: true, result: MESSAGE_SEND_RESULT },
        });
      });
      vi.stubGlobal('fetch', fetch);

      const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
        .machine('machine-7')
        .sessions.spawn({
          directory: { kind: 'path', path: '/repo' },
          agent: 'codex',
          initialMessage: 'This must be admitted or reported.',
        });

      await expect(failure).rejects.toMatchObject({
        name: 'HappierSessionInitialInputError',
        session: { id: 'session-1' },
        result: {
          type: 'success',
          sessionId: 'session-1',
          initialInput,
        },
      });
      expect(actionIds).toEqual(['agents.backends.list', 'session.spawn_new']);

      let partial: unknown;
      await failure.catch((error: unknown) => {
        partial = error;
      });
      if (!isHappierSessionInitialInputError(partial)) {
        throw new Error('Expected a recoverable initial-input error.');
      }
      await partial.session.send('Recover through the committed Session handle.');
      expect(actionIds).toEqual([
        'agents.backends.list',
        'session.spawn_new',
        'session.message.send',
      ]);
    },
  );

  it('keeps initial-input partial success raw for callers that use the Action layer', async () => {
    const partialResult = {
      type: 'success',
      disposition: 'created',
      sessionId: 'session-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'rejected', code: 'session_input_target_update_required' },
    } as const;
    vi.stubGlobal('fetch', vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'session.spawn_new',
      execution: { ok: true, result: partialResult },
    })));

    const result = await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .machine('machine-7')
      .actions.session.spawnNew({
        directory: { kind: 'path', path: '/repo' },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      });
    expect(result).toEqual(partialResult);
  });

  it('forwards AbortSignal and close aborts pending work and rejects later calls', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const pending = client.actions.execute('machines.list', {});
    await client.close();

    await expect(pending).rejects.toBeInstanceOf(HappierClientClosedError);
    expect(requestSignal?.aborted).toBe(true);
    await expect(client.actions.execute('machines.list', {})).rejects.toBeInstanceOf(HappierClientClosedError);
  });

  it('preserves a caller abort that occurs while reading an HTTP response body', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped reading');
    undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: failingResponseBody(reason, () => controller.abort(reason)),
    });

    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .actions.execute('machines.list', {}, { signal: controller.signal });

    await expect(failure).rejects.toBe(reason);
  });

  it('preserves client closure that occurs while reading an HTTP response body', async () => {
    let client: ReturnType<typeof connect>;
    undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: failingResponseBody(new Error('response body was interrupted'), () => {
        void client.close();
      }),
    });
    client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });

    await expect(client.actions.execute('machines.list', {})).rejects.toBeInstanceOf(HappierClientClosedError);
  });

  it('normalizes an uninterrupted response-body failure as a transport error', async () => {
    const invalidJson = new SyntaxError('invalid JSON');
    undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: failingResponseBody(invalidJson),
    });

    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions.execute('machines.list', {});

    await expect(failure).rejects.toMatchObject({
      name: 'HappierTransportError',
      message: 'The Happier API returned invalid JSON.',
      status: 200,
      cause: invalidJson,
    });
  });

  it('rejects a response whose declared body exceeds the Protocol external Action ceiling', async () => {
    const destroy = vi.fn();
    undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: { 'content-length': '24000001' },
      body: {
        destroy,
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
          throw new Error('The SDK must reject the declared oversized body before consuming it.');
        },
      },
    });

    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .actions.execute('machines.list', {});

    await expect(failure).rejects.toMatchObject({
      name: 'HappierTransportError',
      code: 'response_too_large',
      status: 200,
      details: { maxSerializedBytes: 24_000_000 },
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('destroys a streamed response body as soon as it crosses the Protocol ceiling', async () => {
    const destroy = vi.fn();
    undiciRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: {
        destroy,
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
          yield new Uint8Array(24_000_000);
          yield new Uint8Array(1);
          throw new Error('The SDK must stop after the first byte over the limit.');
        },
      },
    });

    await expect(
      connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions.execute('machines.list', {}),
    ).rejects.toMatchObject({ code: 'response_too_large' });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('surfaces a non-JSON proxy outage without exposing its response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Server unavailable: retry later.', {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-happier-retry-reason': 'server_unavailable',
      },
    })));

    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions.execute('machines.list', {});

    await expect(failure).rejects.toMatchObject({
      name: 'HappierTransportError',
      message: 'The Happier API is unavailable.',
      code: 'server_unavailable',
      status: 503,
      details: undefined,
    });
  });

  it('normalizes fetch disconnections as a typed transport failure', async () => {
    const disconnection = new TypeError('fetch failed');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw disconnection;
    }));

    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions.execute('machines.list', {});

    await expect(failure).rejects.toBeInstanceOf(HappierTransportError);
    await expect(failure).rejects.toMatchObject({
      name: 'HappierTransportError',
      cause: disconnection,
    });
  });

  it('preserves Action failures as typed SDK errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => responseForRequest(init, {
      v: 1,
      actionId: 'account.security.get',
      execution: {
        ok: false,
        errorCode: 'action_failed',
        error: 'Account security is unavailable',
      },
    })));

    const client = connect({ endpoint: 'http://server', token: TEST_API_TOKEN });
    const failure = client.actions.execute('account.security.get', {});
    await expect(failure).rejects.toMatchObject({
      code: 'action_failed',
      message: 'Account security is unavailable',
    });
  });

  it('exposes canonical Action discovery and contributed invocation as call-throughs', async () => {
    const requests: Array<Readonly<{ actionId: string; input: unknown; requestId?: string }>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const envelope = JSON.parse(String(init?.body));
      requests.push({
        actionId,
        input: envelope.input,
        ...(typeof envelope.requestId === 'string' ? { requestId: envelope.requestId } : {}),
      });
      return responseForRequest(init, { v: 1, actionId, execution: { ok: false, errorCode: RESULT_NOT_UNDER_TEST, error: RESULT_NOT_UNDER_TEST } });
    }));

    const actions = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions;
    await callsTransport(actions.search({ query: 'session' }));
    await callsTransport(actions.invoke({ pluginId: 'acme.notes', localId: 'save' }, { note: 'Remember' }));

    expect(requests).toEqual([
      { actionId: 'action.spec.search', input: { query: 'session' } },
      {
        actionId: 'action.invoke',
        input: { action: { pluginId: 'acme.notes', localId: 'save' }, input: { note: 'Remember' } },
        requestId: expect.any(String),
      },
    ]);
  });

  it('exposes canonical Action-definition lookup on root and machine-bound clients', async () => {
    const requests: Array<Readonly<{ actionId: string; body: Record<string, unknown> }>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ actionId, body });
      return response({ v: 1, actionId, execution: { ok: false, errorCode: RESULT_NOT_UNDER_TEST, error: RESULT_NOT_UNDER_TEST } });
    }));

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    await callsTransport(client.actions.get({ id: 'session.status.get' }));
    await callsTransport(client.machine('machine-7').actions.get({ id: 'session.status.get' }));

    expect(requests).toEqual([
      {
        actionId: 'action.spec.get',
        body: { v: 1, input: { id: 'session.status.get' } },
      },
      {
        actionId: 'action.spec.get',
        body: {
          v: 1,
          target: { kind: 'machine', machineId: 'machine-7' },
          input: { id: 'session.status.get' },
        },
      },
    ]);
  });

  it('invokes the canonical qualified contributed Action id returned by discovery', async () => {
    const requests: Array<Readonly<{ actionId: string; input: unknown }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const envelope = JSON.parse(String(init?.body));
      requests.push({ actionId, input: envelope.input });
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { status: 'executed', value: null } } });
    });
    vi.stubGlobal('fetch', fetch);

    const actions = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions;
    const invokeDiscoveredId = (discoveredId: PublicActionResultById[
        'action.spec.search'
      ]['actionSpecs'][number]['id']) => actions.invoke(discoveredId, {});
    void invokeDiscoveredId;
    await actions.invoke(
      'happier.channels/actions/provider/connections-list-v1',
      { accountId: 'account-1' },
    );

    expect(requests).toEqual([{
      actionId: 'action.invoke',
      input: {
        action: {
          pluginId: 'happier.channels',
          localId: 'provider/connections-list-v1',
        },
        input: { accountId: 'account-1' },
      },
    }]);

    await expect(actions.invoke('happier.channels/provider/connections-list-v1', {})).rejects.toThrow(
      new TypeError('Contributed Action id must use the canonical <pluginId>/actions/<localId> spelling.'),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces HTTP authentication failures with their protocol code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'invalid_token' }, 401)));
    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions.execute('machines.list', {});
    await expect(failure).rejects.toBeInstanceOf(HappierTransportError);
    await expect(failure).rejects.toMatchObject({
      code: 'invalid_token',
      status: 401,
    });
  });

  it.each([
    ['invalid_action', 400],
    ['invalid_envelope', 400],
    ['request_too_large', 413],
  ] as const)('uses the protocol HTTP discriminator %s as the transport code', async (code, status) => {
    const details = { error: 'invalid_request' as const, code };
    vi.stubGlobal('fetch', vi.fn(async () => response(details, status)));

    const failure = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).actions.execute('machines.list', {});

    await expect(failure).rejects.toBeInstanceOf(HappierTransportError);
    await expect(failure).rejects.toMatchObject({
      code,
      status,
      details,
    });
  });

  it('does not fetch a second transcript page before the consumer asks for it', async () => {
    let followCalls = 0;
    let releaseSecondPage: ((value: Response) => void) | undefined;
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      if (actionId === 'transcript.follow') {
        followCalls += 1;
        if (followCalls === 1) {
          return response({
            v: 1,
            actionId,
            execution: {
              ok: true,
              result: {
                items: [{ role: 'assistant', text: 'first' }],
                nextCursor: '1',
                truncated: false,
              },
            },
          });
        }
        return await new Promise<Response>((resolve) => {
          releaseSecondPage = resolve;
        });
      }
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: { ok: true, result: { ok: true, released: true } },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const iterator = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .sessions.get('session-1').followTranscript()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { role: 'assistant', text: 'first' },
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(followCalls).toBe(1);

    const second = iterator.next();
    await vi.waitFor(() => expect(followCalls).toBe(2));
    releaseSecondPage?.(response({
      v: 1,
      actionId: 'transcript.follow',
      execution: {
        ok: true,
        result: {
          items: [{ role: 'assistant', text: 'second' }],
          nextCursor: '2',
          truncated: false,
        },
      },
    }));
    await expect(second).resolves.toEqual({
      done: false,
      value: { role: 'assistant', text: 'second' },
    });
    await iterator.return?.();
  });

  it('waits until every buffered transcript item is consumed before fetching another page', async () => {
    let followCalls = 0;
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      if (actionId === 'transcript.follow') {
        followCalls += 1;
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: followCalls === 1
                ? [
                    { role: 'assistant', text: 'first' },
                    { role: 'assistant', text: 'second' },
                    { role: 'assistant', text: 'third' },
                  ]
                : [{ role: 'assistant', text: 'fourth' }],
              nextCursor: String(followCalls),
              truncated: false,
            },
          },
        });
      }
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: { ok: true, result: { ok: true, released: true } },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const iterator = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN })
      .sessions.get('session-1').followTranscript()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { text: 'first' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { text: 'second' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { text: 'third' } });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(followCalls).toBe(1);

    const fourth = iterator.next();
    await vi.waitFor(() => expect(followCalls).toBe(2));
    await expect(fourth).resolves.toMatchObject({ value: { text: 'fourth' } });
    await iterator.return?.();
  });

  it('releases a transcript follow lease when an iterator is returned early', async () => {
    const requests: Array<Readonly<{ actionId: string; body: Record<string, unknown> }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      requests.push({ actionId, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (actionId === 'transcript.follow') {
        return response({
          v: 1,
          actionId,
          execution: { ok: true, result: { items: [{ role: 'assistant' }], nextCursor: '1', truncated: false } },
        });
      }
      return response({
        v: 1,
        actionId,
        execution: { ok: true, result: { ok: true, released: true } },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const transcript = client.sessions.get('session-1').followTranscript();
    expectTypeOf(transcript).toEqualTypeOf<AsyncIterable<HappierTranscriptItem>>();
    expectTypeOf(null as HappierTranscriptItem).toEqualTypeOf<
      PublicActionResultById['transcript.follow']['items'][number]
    >();
    const iterator = transcript[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { role: 'assistant' } });
    await iterator.return?.();

    expect(requests.some(({ actionId }) => actionId === 'transcript.follow')).toBe(true);
    expect(requests.at(-1)?.actionId).toBe('transcript.unfollow');
    expect(requests.filter(({ actionId }) => actionId === 'transcript.unfollow')).toHaveLength(1);

    const closingClient = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    const closingIterator = closingClient.sessions.get('session-2').followTranscript()[Symbol.asyncIterator]();
    await closingIterator.next();
    await closingClient.close();
    expect(requests.filter(({ actionId }) => actionId === 'transcript.unfollow')).toHaveLength(2);
    for (const { body } of requests) {
      expect(body.target).toEqual({ kind: 'session', sessionId: (body.input as { sessionId: string }).sessionId });
    }
  });

  it('reads a typed execution-run stream and cancels it when the stream ends', async () => {
    const requests: Array<Readonly<{ actionId: string; body: Record<string, unknown> }>> = [];
    let reads = 0;
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ actionId, body });
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      if (actionId === 'execution.run.stream.read') {
        reads += 1;
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: reads === 1
              ? { streamId: 'stream-1', events: [{ t: 'delta', textDelta: 'hello' }], nextCursor: 1, done: false }
              : { streamId: 'stream-1', events: [{ t: 'done', assistantText: 'hello' }], nextCursor: 2, done: true },
          },
        });
      }
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN });
    const stream = await client.runs.startStream({
      sessionId: 'session-1',
      runId: 'run-1',
      message: 'Continue.',
    });
    expectTypeOf(stream).toEqualTypeOf<HappierExecutionRunStream>();
    expect(stream).toMatchObject({ runId: 'run-1', streamId: 'stream-1' });

    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { t: 'delta', textDelta: 'hello' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { t: 'done', assistantText: 'hello' },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });

    expect(requests.map(({ actionId }) => actionId)).toEqual([
      'execution.run.stream.start',
      'execution.run.stream.read',
      'execution.run.stream.read',
      'execution.run.stream.cancel',
    ]);
    for (const { body } of requests.filter(({ actionId }) => actionId === 'execution.run.stream.read')) {
      expect(body.input).toMatchObject({ waitForEvents: true });
    }
    for (const { body } of requests) {
      expect(body.target).toEqual({ kind: 'session', sessionId: 'session-1' });
    }
  });

  it('cancels an execution-run stream as soon as its terminal page is delivered', async () => {
    const actionIds: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      if (actionId === 'execution.run.stream.read') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              streamId: 'stream-1',
              events: [{ t: 'done', assistantText: 'complete' }],
              nextCursor: 1,
              done: true,
            },
          },
        });
      }
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    });
    vi.stubGlobal('fetch', fetch);

    const stream = await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).runs.startStream({
      runId: 'run-1',
      message: 'Continue.',
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { t: 'done', assistantText: 'complete' },
    });

    await vi.waitFor(() => expect(actionIds).toEqual([
      'execution.run.stream.start',
      'execution.run.stream.read',
      'execution.run.stream.cancel',
    ]));
  });

  it('delivers a terminal execution-run event before surfacing its cleanup failure', async () => {
    const actionIds: string[] = [];
    const cancellationFailure = new TypeError('connection reset');
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      if (actionId === 'execution.run.stream.read') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              streamId: 'stream-1',
              events: [{ t: 'done', assistantText: 'complete' }],
              nextCursor: 1,
              done: true,
            },
          },
        });
      }
      throw cancellationFailure;
    });
    vi.stubGlobal('fetch', fetch);

    const stream = await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).runs.startStream({
      runId: 'run-1',
      message: 'Continue.',
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { t: 'done', assistantText: 'complete' },
    });
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'HappierTransportError',
      cause: cancellationFailure,
    });
    expect(actionIds).toEqual([
      'execution.run.stream.start',
      'execution.run.stream.read',
      'execution.run.stream.cancel',
    ]);
  });

  it('cancels an execution-run stream when its iterator returns early', async () => {
    const actionIds: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      if (actionId === 'execution.run.stream.read') {
        return response({
          v: 1,
          actionId,
          execution: { ok: true, result: { streamId: 'stream-1', events: [{ t: 'delta', textDelta: 'hello' }], nextCursor: 1, done: false } },
        });
      }
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    });
    vi.stubGlobal('fetch', fetch);

    const stream = await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).runs.startStream({
      runId: 'run-1',
      message: 'Continue.',
    });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    expect(actionIds).toEqual([
      'execution.run.stream.start',
      'execution.run.stream.read',
      'execution.run.stream.cancel',
    ]);
  });

  it('cancels an execution-run stream when its caller aborts', async () => {
    const actionIds: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    });
    vi.stubGlobal('fetch', fetch);

    const controller = new AbortController();
    await connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN }).runs.startStream({
      runId: 'run-1',
      message: 'Continue.',
    }, { signal: controller.signal });
    controller.abort(new Error('caller stopped reading'));

    await vi.waitFor(() => expect(actionIds).toEqual([
      'execution.run.stream.start',
      'execution.run.stream.cancel',
    ]));
  });

  it('cancels an execution-run stream when its client closes', async () => {
    const actionIds: string[] = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      actionIds.push(actionId);
      if (actionId === 'execution.run.stream.start') {
        return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { streamId: 'stream-1' } } });
      }
      return responseForRequest(init, { v: 1, actionId, execution: { ok: true, result: { ok: true } } });
    });
    vi.stubGlobal('fetch', fetch);

    const client = connect({ endpoint: 'http://daemon', token: TEST_API_TOKEN });
    await client.runs.startStream({ runId: 'run-1', message: 'Continue.' });
    await client.close();

    expect(actionIds).toEqual([
      'execution.run.stream.start',
      'execution.run.stream.cancel',
    ]);
  });

  it('binds the complete transcript lifecycle for a spawned machine Session', async () => {
    const requests: Array<Readonly<{ actionId: string; body: Record<string, unknown> }>> = [];
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const actionId = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ actionId, body });

      if (actionId === 'agents.backends.list') {
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: [{
                targetKey: 'backend:happier.agent.codex',
                label: 'Codex',
                enabled: true,
                agentId: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              }],
            },
          },
        });
      }
      if (actionId === 'session.spawn_new') {
        return responseForRequest(init, {
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              type: 'success',
              disposition: 'created',
              sessionId: 'session-1',
              executionTarget: { serverId: 'server-1', machineId: 'machine-7' },
              organizationPlacement: { folderId: null, tagIds: [] },
              initialInput: { status: 'notRequested' },
            },
          },
        });
      }
      if (actionId === 'transcript.follow') {
        const input = body.input as Readonly<{ sessionId?: unknown }>;
        return response({
          v: 1,
          actionId,
          execution: {
            ok: true,
            result: {
              items: input.sessionId === 'session-2' ? [{ role: 'assistant' }] : [],
              nextCursor: '1',
              truncated: false,
            },
          },
        });
      }
      if (actionId === 'session.status.get') {
        return response({
          v: 1,
          actionId,
          execution: { ok: true, result: { session: { active: false } } },
        });
      }
      return responseForRequest(init, {
        v: 1,
        actionId,
        execution: { ok: true, result: { ok: true, released: true } },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const session = await connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN })
      .machine('machine-7')
      .sessions.spawn({ directory: { kind: 'path', path: '/repo' }, agent: 'codex' });
    const iterator = session.followTranscript()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    await iterator.return?.();

    const transcriptRequests = requests.filter(({ actionId }) => (
      actionId === 'transcript.follow'
      || actionId === 'session.status.get'
      || actionId === 'transcript.unfollow'
    ));
    expect(transcriptRequests.some(({ actionId }) => actionId === 'session.status.get')).toBe(true);
    expect(transcriptRequests.filter(({ actionId }) => actionId === 'transcript.follow')
      .every(({ body }) => (body.input as { waitForChanges?: boolean }).waitForChanges === false)).toBe(true);
    for (const { body } of transcriptRequests) {
      expect(body.target).toEqual({ kind: 'machine', machineId: 'machine-7' });
    }
    expect(transcriptRequests.filter(({ actionId }) => actionId === 'transcript.unfollow')).toHaveLength(1);

    const machine = connect({ endpoint: 'https://api.example.test', token: TEST_API_TOKEN }).machine('machine-7');
    const closingIterator = machine.sessions.get('session-2').followTranscript()[Symbol.asyncIterator]();
    await expect(closingIterator.next()).resolves.toEqual({ done: false, value: { role: 'assistant' } });
    await machine.close();
    expect(requests.filter(({ actionId }) => actionId === 'transcript.unfollow')).toHaveLength(2);

    const allTranscriptRequests = requests.filter(({ actionId }) => (
      actionId === 'transcript.follow'
      || actionId === 'session.status.get'
      || actionId === 'transcript.unfollow'
    ));
    for (const { body } of allTranscriptRequests) {
      expect(body.target).toEqual({ kind: 'machine', machineId: 'machine-7' });
    }
    expect(allTranscriptRequests.filter(({ actionId }) => actionId === 'transcript.unfollow')).toHaveLength(2);
  });
});
