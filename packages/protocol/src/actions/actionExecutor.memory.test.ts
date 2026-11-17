import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { createActionExecuteFailureError } from './actionExecutionResult.js';
import { getActionSpec, SearchConversationsResultV1Schema } from './actionSpecs.js';
import { MemorySettingsV1Schema } from '../memory/memorySettings.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { MemorySearchQueryV1Schema, MemorySearchResultV1Schema, negotiateMemorySearchV1 } from '../memory/memorySearch.js';
import { MemoryWindowV1Schema } from '../memory/memoryWindow.js';

function createDeps(): ActionExecutorDeps {
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected Action dependency'); };
  return {
    executionRunStart: unavailable,
    executionRunList: unavailable,
    executionRunGet: unavailable,
    detachedExecutionRunSend: unavailable,
    executionRunStop: unavailable,
    executionRunAction: unavailable,
    executionRunWait: unavailable,

    sessionOpen: unavailable,
    sessionFork: unavailable,
    sessionRollback: unavailable,
    sessionSpawnNew: unavailable,

    pathsListRecent: unavailable,
    machinesList: unavailable,
    serversList: unavailable,
    reviewEnginesList: unavailable,
    agentsBackendsList: unavailable,
    agentsModelsList: unavailable,

    sessionSendMessage: unavailable,
    sessionPermissionRespond: unavailable,
    sessionUserActionAnswer: unavailable,

    sessionTargetPrimarySet: unavailable,
    sessionTargetTrackedSet: unavailable,
    sessionList: unavailable,
    sessionActivityGet: unavailable,
    sessionRecentMessagesGet: unavailable,

    resetGlobalVoiceAgent: unavailable,

    daemonMemorySearch: unavailable,
    daemonMemoryGetWindow: unavailable,
    daemonMemoryEnsureUpToDate: unavailable,
  };
}

describe('createActionExecutor (memory)', () => {
  it('admits Project memory search across Action surfaces while keeping conversation fanout Session-only', async () => {
    const query = { v: 1, query: 'decision', scope: { type: 'project',
      projectRef: { serverId: 'home', projectKey: 'payments' } }, mode: 'auto' };
    expect(getActionSpec('search.conversations').inputSchema.safeParse({ query }).success).toBe(false);
    for (const surface of ['ui', 'voice', 'agent', 'mcp', 'cli'] as const) {
      const deps = createDeps();
      deps.daemonMemorySearch = async request => {
        expect(request.query).toEqual(query);
        return { v: 1, ok: true, hits: [], project: { state: 'partial' } };
      };
      expect(await createActionExecutor(deps).execute('memory.search', { machineId: 'machine', query },
        { surface, serverId: 'home', authority: 'account_automation' })).toMatchObject({
        ok: true, result: { project: { state: 'partial' } },
      });
    }
  });
  it.each(['agent', 'mcp', 'cli', 'ui'] as const)('opens a native memory window through the %s Action without fabricating Session seqs', async surface => {
    const deps = createDeps();
    const source = { type: 'external_transcript' as const, agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native' };
    const result = { v: 1, snippets: [], citations: [], externalSnippets: [{ source, sourceItemId: 'message', createdAtMs: 10, text: 'quartz' }] };
    deps.daemonMemoryGetWindow = async args => {
      expect(args).toEqual({ machineId: 'm1', source, sourceItemId: 'message', cursor: 'older', serverId: 'home' });
      return result;
    };
    const response = await createActionExecutor(deps).execute('memory.get_window', {
      machineId: 'm1', source, sourceItemId: 'message', cursor: 'older',
    }, { surface, serverId: 'home' });
    expect(response).toEqual({ ok: true, result });
    if (!response.ok) throw new Error('Expected native transcript window');
    expect(MemoryWindowV1Schema.parse(response.result)).toEqual(result);
    expect(getActionSpec('memory.get_window').inputSchema.safeParse({
      machineId: 'm1', source, sourceItemId: 'message', seqFrom: 1, seqTo: 2,
    }).success).toBe(false);
  });
  it('reads and saves per-machine Search settings through the canonical settings dependency', async () => {
    const settings = MemorySettingsV1Schema.parse({ v: 1, conversationSearch: { standardSearch: { enabled: false } } });
    const deps = createDeps();
    let persisted = MemorySettingsV1Schema.parse({ v: 1 });
    deps.daemonMemorySettingsGet = async () => persisted;
    deps.daemonMemorySettingsSet = async ({ settings: next }) => { persisted = next; return persisted; };
    const executor = createActionExecutor(deps);
    const context = { surface: 'ui', authority: 'present_user', serverId: 'home-1' } as const;
    expect(await executor.execute('search.settings.get', { machineId: 'm1' }, context)).toMatchObject({
      ok: true, result: { conversationSearch: { standardSearch: { enabled: true } } },
    });
    expect(await executor.execute('search.settings.set', { machineId: 'm1', settings }, context)).toEqual({ ok: true, result: settings });
    expect(await executor.execute('search.settings.get', { machineId: 'm1' }, context)).toEqual({ ok: true, result: settings });
  });

  it('keeps agent clear-index pending until the present user approves', async () => {
    const deps = createDeps();
    let approval: ApprovalRequest | null = null;
    let cleared = false;
    deps.daemonMemoryClearIndex = async () => { cleared = true; return { ok: true }; };
    deps.approvalsCreate = async ({ request }) => { approval = request; return { artifactId: 'approval' }; };
    deps.approvalsGet = async () => approval;
    deps.approvalsUpdate = async ({ request }) => { approval = request; return { ok: true }; };
    deps.isApprovalExecutionOriginCurrent = async () => true;
    const executor = createActionExecutor(deps);
    expect(getActionSpec('memory.clear_index').safety).toBe('danger');
    expect(await executor.execute('memory.clear_index', { machineId: 'm1' }, {
      surface: 'agent', defaultSessionId: 'worker', serverId: 'home', actionRequestId: 'clear-proposal',
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(cleared).toBe(false);
    await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', serverId: 'home',
    });
    expect(cleared).toBe(true);
  });

  it('returns mounted conversation search coverage and rejects malformed client replies', async () => {
    const deps = createDeps();
    const input = { query: { v: 1, query: 'needle', scope: { type: 'global' }, mode: 'deep' }, mode: 'auto' };
    const result = SearchConversationsResultV1Schema.parse({ hits: [], machines: [
      { machineId: 'offline-machine', status: 'offline', standardSearchEnabled: true },
      { machineId: 'unread-machine', status: 'partial' },
    ] });
    // The remote mounted-client transport is the boundary; Protocol admission and result validation stay real.
    deps.clientActionExecute = async ({ actionId, input: admitted }) => {
      expect(actionId).toBe('search.conversations');
      expect(admitted).toEqual(input);
      return { ok: true, result };
    };
    expect(getActionSpec('search.conversations').executionPlacement).toBe('client');
    expect(await createActionExecutor(deps).execute('search.conversations', input, { surface: 'agent' })).toEqual({
      ok: true, result,
    });
    deps.clientActionExecute = async ({ actionId, input: admitted }) => ({ ok: true, result: { actionId, input: admitted } });
    expect(await createActionExecutor(deps).execute('search.conversations', input, { surface: 'agent' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it.each(['cli', 'mcp'] as const)('searches both corpora through the existing %s Action surface', async (surface) => {
    const deps = createDeps();
    const result = { v: 1, ok: true, hits: [{
      type: 'artifact', ref: { kind: 'doc', serverId: 'home-1', artifactId: 'doc-1' },
      revision: { headerVersion: 2, bodyVersion: 3 }, factId: 'fact-1', location: 'archive',
      summary: 'Remembered decision', score: 1,
    }], documents: { state: 'ready' } };
    // Only the daemon transport is substituted; corpus negotiation and result admission stay real.
    deps.daemonMemorySearch = async args => {
      expect(args).toEqual({ machineId: 'm1', query, serverId: 'home-1' });
      return negotiateMemorySearchV1({ query: args.query,
        readDocumentSearchSupport: async () => true, search: async () => result });
    };
    const query = MemorySearchQueryV1Schema.parse({ v: 1, query: 'decision', scope: { type: 'global' }, mode: 'deep', corpora: ['sessions', 'documents'] });
    const res = await createActionExecutor(deps).execute('memory.search', { machineId: 'm1', query }, {
      surface, serverId: 'home-1',
    });
    expect(res).toEqual({ ok: true, result });
    if (!res.ok) throw new Error('Expected admitted document search');
    expect(MemorySearchResultV1Schema.parse(res.result)).toEqual(result);
  });

  it('retains legacy Session results when the daemon cannot search documents and no Home is supplied', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    const query = MemorySearchQueryV1Schema.parse({ v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints',
      corpora: ['sessions', 'documents'] });
    const legacy = { v: 1, ok: true, hits: [{ sessionId: 'session-1', seqFrom: 1, seqTo: 2,
      createdAtFromMs: 10, createdAtToMs: 20, summary: 'Retained conversation', score: 1 }] };
    deps.daemonMemorySearch = async args => {
      expect(args).toEqual({ machineId: 'm1', query, serverId: null });
      return negotiateMemorySearchV1({ query: args.query, readDocumentSearchSupport: async () => false,
        search: async admitted => {
          expect(admitted).toEqual({ v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' });
          return legacy;
        } });
    };
    const res = await executor.execute('memory.search', {
      machineId: 'm1', query,
    }, { surface: 'ui' });
    expect(res).toEqual({ ok: true, result: { ...legacy, documents: { state: 'unavailable' } } });
    if (!res.ok) throw new Error('Expected legacy Session search');
    expect(MemorySearchResultV1Schema.parse(res.result)).toEqual({ ...legacy, documents: { state: 'unavailable' } });
  });

  it('keeps an arbitrary cancellation code private when the Action signal is active', async () => {
    const deps = createDeps();
    const controller = new AbortController();
    deps.daemonMemorySearch = async ({ signal }) => {
      expect(signal).toBe(controller.signal);
      throw Object.assign(new Error('private transport failure'), { code: 'cancelled' });
    };
    const result = await createActionExecutor(deps).execute('memory.search', {
      machineId: 'm1', query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
    }, { surface: 'agent', signal: controller.signal });
    expect(result).toMatchObject({ ok: false, errorCode: 'action_failed' });
  });

  it('preserves a typed unknown effect outcome when cancellation arrives after dispatch', async () => {
    const deps = createDeps();
    const controller = new AbortController();
    const failureCause = { phase: 'dispatch', errorClass: 'HttpStatusError', errorCode: 'outcome_unknown', httpStatus: 503 } as const;
    deps.daemonMemorySearch = async () => {
      controller.abort();
      throw createActionExecuteFailureError({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown', failureCause });
    };
    const result = await createActionExecutor(deps).execute('memory.search', {
      machineId: 'm1', query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
    }, { surface: 'agent', signal: controller.signal });
    expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown', failureCause });
  });

  it('threads Action cancellation into the authorized memory-search dependency', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    const controller = new AbortController();

    deps.daemonMemorySearch = async ({ signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      signal?.throwIfAborted();
      return { v: 1, ok: true, hits: [] };
    };
    const result = await executor.execute('memory.search', {
      machineId: 'm1',
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
    }, { surface: 'agent', signal: controller.signal });

    expect(result).toMatchObject({ ok: false, errorCode: 'cancelled' });
  });

  it('threads Action cancellation into the authorized memory-window dependency', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    const controller = new AbortController();

    deps.daemonMemoryGetWindow = async ({ signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      signal?.throwIfAborted();
      return { v: 1, snippets: [], citations: [] };
    };
    const result = await executor.execute('memory.get_window', {
      machineId: 'm1',
      sessionId: 'session-1',
      seqFrom: 1,
      seqTo: 2,
    }, { surface: 'agent', signal: controller.signal });

    expect(result).toMatchObject({ ok: false, errorCode: 'cancelled' });
  });
});
