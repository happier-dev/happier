import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createProductionWorkflowSessionContextReader } from './workflowSessionContext';
import { SESSION_TRANSCRIPT_GET_MAX_LIMIT } from '@happier-dev/protocol/actions/actionSpecs';
import { evaluateWorkflowCondition } from './input';
import type { WorkflowCondition, WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import { createInMemoryWorkflowCoordinatorStore, createTestWorkflowCoordinator } from './workflowCoordinator.testkit';

const sessionId = 'c123456789012345678901234';
const credentials = { token: 'token', encryption: null } as const;
const tokens = { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 };
const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
let goal: Record<string, unknown>;

describe('production workflow session context', () => {
  it('reads each demanded source once per condition and observes new facts next evaluation', async () => {
    const reader = createProductionWorkflowSessionContextReader({ credentials, machineId: 'machine', originSessionId: sessionId });
    const runtime = { inputs: {}, resolveResult: async () => null,
      resolveWorkspace: async () => ({ directory: '/', checkoutRootPath: '/' }), ...reader };
    const usage = { kind: 'session_context_field', field: 'usage.tokensUsed' } as const;
    const budget = { kind: 'session_context_field', field: 'goal.tokenBudget' } as const;
    const condition: WorkflowCondition = { kind: 'all', conditions: [
      { kind: 'exists', value: usage }, { kind: 'exists', value: budget },
      { kind: 'compare', operator: 'gte', left: usage, right: budget },
    ] };
    expect(await evaluateWorkflowCondition(condition, runtime)).toBe(false);
    const sessionReads = () => vi.mocked(axios.get).mock.calls.filter(([url]) =>
      !String(url).endsWith('/currentness'));
    expect(sessionReads()).toHaveLength(1);
    expect(axios.post).toHaveBeenCalledTimes(1);
    goal.tokenBudget = 2;
    expect(await evaluateWorkflowCondition(condition, runtime)).toBe(true);
    expect(sessionReads()).toHaveLength(2);
    expect(axios.post).toHaveBeenCalledTimes(2);
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { v: 1,
      totals: { eventCount: 1, tokens: { ...tokens, total: 1 }, cost } } });
    expect(await evaluateWorkflowCondition(condition, runtime)).toBe(false);
    expect(sessionReads()).toHaveLength(3);
    expect(axios.post).toHaveBeenCalledTimes(3);
    vi.mocked(axios.post).mockClear();
    expect(await evaluateWorkflowCondition({ kind: 'exists', value: budget }, runtime)).toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
    vi.mocked(axios.get).mockClear();
    expect(await evaluateWorkflowCondition({ kind: 'any', conditions: [
      { kind: 'compare', operator: 'eq', left: { kind: 'literal', value: true }, right: { kind: 'literal', value: true } },
      condition,
    ] }, runtime)).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });
  it('shares demanded Session sources across stop arms through the coordinator', async () => {
    goal.tokenBudget = 2;
    const budget = { kind: 'session_context_field', field: 'goal.tokenBudget' } as const;
    const definition: WorkflowDefinitionV1 = { version: 1, inputs: [],
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
      blocks: [{ kind: 'loop', id: 'rounds', body: [{ kind: 'step', id: 'work',
        document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' },
        execution: { conversation: { kind: 'fresh' } } }], repetition: { kind: 'until', maxIterations: 2,
        stopWhen: { kind: 'any', conditions: [
          { kind: 'compare', operator: 'eq', left: budget, right: { kind: 'literal', value: 0 } },
          { kind: 'compare', operator: 'gte', left: { kind: 'session_context_field', field: 'usage.tokensUsed' }, right: budget },
        ] } } }],
    };
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createTestWorkflowCoordinator({ store,
      sessionContext: createProductionWorkflowSessionContextReader({ credentials, machineId: 'machine', originSessionId: sessionId }),
      executeStep: async params => { await params.beforeInputAdmission(); return { kind: 'completed', result: 'worked' }; },
      resolveWorkspace: async () => ({ ok: true, workspace: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } }),
    });
    await expect(coordinator.run({ runId: 'session-sources', definition, inputs: {}, originSessionId: sessionId,
      executionTarget: { kind: 'session' }, authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
    })).resolves.toEqual({ state: 'succeeded' });
    expect([...store.records.values()].find(row => row.blockId === 'rounds' && !row.frame)?.container?.closing)
      .toMatchObject({ outcome: { kind: 'stop_condition', arm: 1 } });
    expect(vi.mocked(axios.get).mock.calls.filter(([url]) => !String(url).endsWith('/currentness'))).toHaveLength(1);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.spyOn(axios, 'get');
    vi.spyOn(axios, 'post');
    goal = { id: 'goal', kind: 'goal', origin: 'happier', status: 'active', title: 'Ship', updatedAt: 10,
      tokenBudget: 50, tokensUsed: 9999, startedAt: 5, createdAt: 1 };
    vi.mocked(axios.get).mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (String(url).includes('/messages')) return { status: 200, data: { messages: [
        { id: 'new', seq: 3, createdAt: 3, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'new' } } } },
        { id: 'old', seq: 1, createdAt: 1, messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'old' } } } },
      ], hasMore: false } };
      if (String(url).endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 4, turns: [
        { turnId: 'turn-1', initiator: 'workflow', status: 'completed', startedAt: 1, updatedAt: 4,
          transcriptAnchors: { startSeqInclusive: 1, endSeqInclusive: 3 } },
      ] } };
      return { status: 200, data: { session: { id: sessionId, seq: 0, createdAt: 0, updatedAt: 0, active: true,
        activeAt: 0, metadataVersion: 0, agentStateVersion: 0, agentState: null, dataEncryptionKey: null,
        encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', sessionWorkStateV1: {
          v: 1, backendId: 'test', updatedAt: 10, primaryItemId: 'goal', items: [goal],
        } }) } } };
    });
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { v: 1, totals: { eventCount: 1, tokens, cost } } });
  });

  it('reads real owner metadata and transcript with persisted initiators and scoped accounted usage', async () => {
    const reader = createProductionWorkflowSessionContextReader({ credentials, machineId: 'machine', originSessionId: sessionId });
    const value = await reader.resolveSessionContext(1);
    expect(value).toMatchObject({ goal: { title: 'Ship', tokenBudget: 50 }, usage: { kind: 'accounted', tokensUsed: 3 },
      turns: [{ initiator: 'workflow', text: 'old\n\nnew' }], truncated: false });
    expect(value.goal).not.toHaveProperty('tokensUsed');
    expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toMatchObject({ filters: { sessionIds: [sessionId] }, dateRange: { startMs: 5 } });
    await expect(reader.resolveSessionContextField('goal.tokenBudget')).resolves.toBe(50);
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('usage unavailable'));
    await expect(reader.resolveSessionContextField('goal.tokenBudget')).resolves.toBe(50);
  });

  it('retains a committed tool-only turn without inventing transcript text', async () => {
    const get = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      if (String(url).includes('/messages')) return { status: 200, data: { messages: [], hasMore: false } };
      return get(url, config);
    });
    await expect(createProductionWorkflowSessionContextReader({ credentials, machineId: 'machine', originSessionId: sessionId })
      .resolveSessionContext(1)).resolves.toMatchObject({ turns: [{ initiator: 'workflow', text: '' }], truncated: false });
  });

  it('admits transport once for a context read spanning multiple transcript pages', async () => {
    const get = vi.mocked(axios.get).getMockImplementation()!;
    let pages = 0;
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      if (String(url).includes('/messages')) {
        pages++;
        const query = new URL(String(url)).searchParams;
        const before = Number(query.get('beforeSeq') ?? SESSION_TRANSCRIPT_GET_MAX_LIMIT + 2);
        const limit = Number(query.get('limit') ?? SESSION_TRANSCRIPT_GET_MAX_LIMIT);
        const seqs = Array.from({ length: Math.min(limit, before - 1) }, (_, i) => before - i - 1);
        const hasMore = seqs[seqs.length - 1] > 1;
        return { status: 200, data: { messages: seqs.map(seq => ({ id: `row-${seq}`, seq, createdAt: seq,
          messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: `text-${seq}` } } } })),
          hasMore, nextBeforeSeq: hasMore ? seqs[seqs.length - 1] : null } };
      }
      return get(url, config);
    });
    const reader = createProductionWorkflowSessionContextReader({ credentials, machineId: 'machine', originSessionId: sessionId });
    const context = await reader.resolveSessionContext(1);
    expect(pages).toBe(Math.ceil((SESSION_TRANSCRIPT_GET_MAX_LIMIT + 1) / 100));
    expect(context.turns).toEqual([{ initiator: 'workflow', text: 'text-1\n\ntext-2\n\ntext-3' }]);
    expect(vi.mocked(axios.get).mock.calls.filter(([url]) => String(url).endsWith('/v1/account/encryption/currentness'))).toHaveLength(1);
    expect(vi.mocked(axios.get).mock.calls.filter(([url]) => !String(url).includes('/messages')
      && !String(url).endsWith('/turns') && !String(url).endsWith('/currentness'))).toHaveLength(1);
  });

  it('joins the owner-selected recent committed turns in their published order', async () => {
    const get = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      if (String(url).endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 6, turns: [
        { turnId: 'old', initiator: 'user', status: 'completed', startedAt: 1, updatedAt: 2,
          transcriptAnchors: { startSeqInclusive: 1, endSeqInclusive: 1 } },
        { turnId: 'new', initiator: 'workflow', status: 'completed', startedAt: 3, updatedAt: 4,
          transcriptAnchors: { startSeqInclusive: 3, endSeqInclusive: 3 } },
      ].slice(-Number(config?.params?.recentCommittedTurns)) } };
      return get(url, config);
    });
    const reader = createProductionWorkflowSessionContextReader({ credentials, machineId: 'machine', originSessionId: sessionId });
    await expect(reader.resolveSessionContext(1)).resolves.toMatchObject({ turns: [{ initiator: 'workflow', text: 'new' }] });
    await expect(reader.resolveSessionContext(2)).resolves.toMatchObject({ turns: [
      { initiator: 'user', text: 'old' }, { initiator: 'workflow', text: 'new' },
    ] });
  });

  it.each([3, 300])('downloads only demanded recent committed turns from a %i-turn history', async historySize => {
    const get = vi.mocked(axios.get).getMockImplementation()!;
    let deliveredTurns = 0;
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      if (String(url).endsWith('/turns')) {
        const all = Array.from({ length: historySize }, (_, i) => ({ turnId: `turn-${i}`, initiator: 'workflow',
          status: 'completed', startedAt: i, updatedAt: i,
          transcriptAnchors: { startSeqInclusive: i + 1, endSeqInclusive: i + 1 } }));
        const demanded = config?.params?.recentCommittedTurns;
        const turns = typeof demanded === 'number' ? all.slice(-demanded) : all;
        deliveredTurns += turns.length;
        return { status: 200, data: { v: 1, sessionId, updatedAt: historySize, turns } };
      }
      if (String(url).includes('/messages')) return { status: 200, data: { messages: [historySize, historySize - 1].map(seq => ({
        id: `row-${seq}`, seq, createdAt: seq, messageRole: 'agent',
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: `text-${seq}` } } },
      })), hasMore: false } };
      return get(url, config);
    });
    const reader = createProductionWorkflowSessionContextReader({ credentials, machineId: 'machine', originSessionId: sessionId });
    const value = await reader.resolveSessionContext(2);
    expect(value.turns).toEqual([historySize - 1, historySize].map(seq => ({ initiator: 'workflow', text: `text-${seq}` })));
    expect(deliveredTurns).toBe(2);
    expect(vi.mocked(axios.get).mock.calls.filter(([url]) => String(url).endsWith('/turns'))).toHaveLength(1);
  });

  it('fails preparation for unknown committed turn facts or an origin on a different Machine', async () => {
    const otherMachine = createProductionWorkflowSessionContextReader({ credentials, machineId: 'other', originSessionId: sessionId });
    await expect(otherMachine.resolveSessionContext(0)).rejects.toMatchObject({ code: 'workflow_session_context_unavailable' });
    const get = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      const response = await get(url, config);
      if (String(url).endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 4, turns: [
        { turnId: 'legacy', status: 'completed', startedAt: 1, updatedAt: 4,
          transcriptAnchors: { startSeqInclusive: 1, endSeqInclusive: 3 } },
      ] } };
      return response;
    });
    await expect(createProductionWorkflowSessionContextReader({ credentials, machineId: 'machine', originSessionId: sessionId })
      .resolveSessionContext(2)).rejects.toMatchObject({ code: 'workflow_session_context_unavailable' });
  });

  it('distinguishes no usage and missing goal times from a failed usage read', async () => {
    const reader = createProductionWorkflowSessionContextReader({ credentials, machineId: 'machine', originSessionId: sessionId });
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 200, data: { v: 1, totals: { eventCount: 0, tokens: { ...tokens, total: 0 }, cost } } });
    await expect(reader.resolveSessionContext(0)).resolves.toMatchObject({ usage: { kind: 'unavailable' }, turns: [] });
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 200, data: { v: 1, totals: { eventCount: 1, tokens: { ...tokens, total: null }, cost } } });
    await expect(reader.resolveSessionContext(0)).resolves.toMatchObject({ usage: { kind: 'unavailable' }, turns: [] });
    delete goal.startedAt;
    delete goal.createdAt;
    await expect(reader.resolveSessionContextField('usage.tokensUsed')).rejects.toMatchObject({ code: 'missing_reference' });
    goal.createdAt = 1;
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('transport offline'));
    await expect(reader.resolveSessionContext(0)).rejects.toMatchObject({ code: 'workflow_session_context_unavailable' });
  });
});
