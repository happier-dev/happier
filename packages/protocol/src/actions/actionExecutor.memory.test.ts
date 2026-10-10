import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { MemorySettingsV1Schema } from '../memory/memorySettings.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';

function createDeps(): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({})),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    detachedExecutionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),

    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),

    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),

    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),

    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),

    resetGlobalVoiceAgent: vi.fn(),

    daemonMemorySearch: vi.fn(async () => ({ v: 1, ok: true, hits: [] })),
    daemonMemoryGetWindow: vi.fn(async () => ({ v: 1, snippets: [], citations: [] })),
    daemonMemoryEnsureUpToDate: vi.fn(async () => ({ ok: true })),
  };
}

describe('createActionExecutor (memory)', () => {
  it.each(['agent', 'mcp', 'cli', 'ui'] as const)('opens a native memory window through the %s Action without fabricating Session seqs', async surface => {
    const deps = createDeps();
    const source = { type: 'external_transcript' as const, agentId: 'pi', sourceKey: 'local', nativeSessionId: 'native' };
    const result = { v: 1, snippets: [], citations: [], externalSnippets: [{ source, sourceItemId: 'message', createdAtMs: 10, text: 'quartz' }] };
    deps.daemonMemoryGetWindow = async args => {
      expect(args).toEqual({ machineId: 'm1', source, sourceItemId: 'message', cursor: 'older', serverId: 'home' });
      return result;
    };
    expect(await createActionExecutor(deps).execute('memory.get_window', {
      machineId: 'm1', source, sourceItemId: 'message', cursor: 'older',
    }, { surface, serverId: 'home' })).toEqual({ ok: true, result });
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

  it('relays conversation search to the existing mounted-client Action boundary', async () => {
    const deps = createDeps();
    const input = { query: { v: 1, query: 'needle', scope: { type: 'global' }, mode: 'deep' }, mode: 'auto' };
    deps.clientActionExecute = async ({ actionId, input: admitted }) => ({ ok: true, result: { actionId, input: admitted } });
    expect(getActionSpec('search.conversations').executionPlacement).toBe('client');
    expect(await createActionExecutor(deps).execute('search.conversations', input, { surface: 'agent' })).toEqual({
      ok: true, result: { actionId: 'search.conversations', input },
    });
  });

  it.each(['cli', 'mcp'] as const)('searches both corpora through the existing %s Action surface', async (surface) => {
    const deps = createDeps();
    const result = { v: 1, ok: true, hits: [{
      type: 'artifact', ref: { kind: 'doc', serverId: 'home-1', artifactId: 'doc-1' },
      revision: { headerVersion: 2, bodyVersion: 3 }, factId: 'fact-1', location: 'archive',
      summary: 'Remembered decision', score: 1,
    }], documents: { state: 'ready' } };
    deps.daemonMemorySearch = vi.fn(async () => result);
    const query = { v: 1, query: 'decision', scope: { type: 'global' }, mode: 'deep', corpora: ['sessions', 'documents'] };
    const res = await createActionExecutor(deps).execute('memory.search', { machineId: 'm1', query }, {
      surface, serverId: 'home-1',
    });
    expect(res).toEqual({ ok: true, result });
    expect(deps.daemonMemorySearch).toHaveBeenCalledWith({ machineId: 'm1', query, serverId: 'home-1' });
  });

  it('routes memory.search to deps.daemonMemorySearch', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);

    const res = await executor.execute('memory.search', {
      machineId: 'm1',
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
    }, { surface: 'ui' });
    expect(res.ok).toBe(true);
    expect(deps.daemonMemorySearch).toHaveBeenCalledWith({
      machineId: 'm1',
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
      serverId: null,
    });
  });

  it('threads Action cancellation into the authorized memory-search dependency', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    const controller = new AbortController();

    await executor.execute('memory.search', {
      machineId: 'm1',
      query: { v: 1, query: 'openclaw', scope: { type: 'global' }, mode: 'hints' },
    }, { surface: 'agent', signal: controller.signal });

    expect(deps.daemonMemorySearch).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
  });

  it('threads Action cancellation into the authorized memory-window dependency', async () => {
    const deps = createDeps();
    const executor = createActionExecutor(deps);
    const controller = new AbortController();

    await executor.execute('memory.get_window', {
      machineId: 'm1',
      sessionId: 'session-1',
      seqFrom: 1,
      seqTo: 2,
    }, { surface: 'agent', signal: controller.signal });

    expect(deps.daemonMemoryGetWindow).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
  });
});
