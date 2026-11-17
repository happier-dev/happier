import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { createSessionMembershipReadFixture } from '../sessions/read/sessionReadBatchV1.testkit.js';
import { SessionManagerSetResultV1Schema } from '../sessions/follow/sessionManagerV1.js';
import type {
  SessionManagerSetActionInputV1,
  SessionManagerSetResultV1,
} from '../sessions/follow/sessionManagerV1.js';

// These ports replace authenticated server HTTP adapters, not internal tree or admission logic.
function createTransportExecutor(overrides: Partial<ActionExecutorDeps>) {
  return createActionExecutor({
    executionRunStart: async () => ({}), executionRunList: async () => ({}), executionRunGet: async () => ({}),
    detachedExecutionRunSend: async () => ({}), executionRunStop: async () => ({}),
    executionRunAction: async () => ({}), executionRunWait: async () => ({}),
    sessionOpen: async () => ({}), sessionFork: async () => ({}), sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}), pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }), serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }), agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }), sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}), sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}), sessionModesList: async () => ({ items: [] }),
    sessionList: async () => ({ sessions: [] }), sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}), resetGlobalVoiceAgent: async () => {},
    ...overrides,
  });
}

const input = { sessionId: 'worker', managerSessionId: 'lead', expectedManagerSessionId: null };
const context = { surface: 'cli', authority: 'present_user', serverId: 'home', bypassApprovals: true } as const;

describe('session.update.post', () => {
  it('admits a caller-bound report with references and preserves typed producer refusals', async () => {
    const reports: unknown[] = [];
    const deliverables = [{ kind: 'workspace_file', sessionId: 'worker', path: 'result.md' }, { kind: 'artifact', artifactId: 'report' }];
    const executor = createTransportExecutor({
      sessionUpdatePost: async ({ context: _context, ...report }) => {
        reports.push(report);
        return report.summary === 'allowed'
        ? { sessionId: 'worker', localId: 'report-1', persisted: true }
        : { ok: false, errorCode: 'session_update_not_committed', error: 'session_update_not_committed' };
      },
    });
    const agent = { surface: 'agent', authority: 'account_automation', defaultSessionId: 'worker' } as const;
    await expect(executor.execute('session.update.post', { summary: 'allowed', deliverables }, agent)).resolves.toMatchObject({
      ok: true, result: { sessionId: 'worker', localId: 'report-1', persisted: true },
    });
    expect(reports).toEqual([{ summary: 'allowed', deliverables }]);
    await expect(executor.execute('session.update.post', { summary: 'allowed', sessionId: 'forged' }, agent)).resolves.toMatchObject({ ok: false });
    await expect(executor.execute('session.update.post', { summary: 'refused' }, agent)).resolves.toMatchObject({ ok: false, errorCode: 'session_update_not_committed' });
    expect(getActionSpec('session.update.post').surfaces).toMatchObject({ ui: true, voice: true, agent: true, mcp: true, cli: true });
  });
});

describe('session.manager.set', () => {
  it('keeps a committed relation successful while source-key preparation waits', async () => {
    const committed = { ok: true, sessionId: 'worker', managerSessionId: 'lead', attachedAt: 1,
      sourceKeyPreparation: { kind: 'waiting', reason: 'source_key_unavailable' } } as const;
    const executor = createTransportExecutor({ sessionManagerSet: async () => committed });
    const result = await executor.execute('session.manager.set', input, context);
    expect(result).toEqual({ ok: true, result: committed });
    if (!result.ok) throw new Error('Committed relation was reported failed');
    expect(SessionManagerSetResultV1Schema.parse(result.result)).toEqual(committed);
    expect(getActionSpec('session.manager.set').outputSchema!.parse(result.result)).toEqual(committed);
    expect(SessionManagerSetResultV1Schema.safeParse({ ...committed,
      sourceKeyPreparation: { ...committed.sourceKeyPreparation, secret: 'invalid' },
    }).success).toBe(false);
  });

  it.each([true, false])('edits an exact server-proved child (active=%s) and refuses an unapproved outside-subtree mutation', async active => {
    const submittedAttachments: SessionManagerSetActionInputV1[] = [];
    const sessionManagerSet = async (request: SessionManagerSetActionInputV1): Promise<SessionManagerSetResultV1> => {
      submittedAttachments.push({
        sessionId: request.sessionId,
        managerSessionId: request.managerSessionId,
        expectedManagerSessionId: request.expectedManagerSessionId,
      });
      return { ok: true, sessionId: request.sessionId, managerSessionId: request.managerSessionId, attachedAt: 1 };
    };
    const sessionRead = vi.fn<NonNullable<ActionExecutorDeps['sessionRead']>>(async ({ sessionIds }) => {
      const response = createSessionMembershipReadFixture(sessionIds, ['worker']);
      for (const result of response.results) if (result.detail?.status === 200) result.detail.body.session.active = active;
      return response;
    });
    const sessionList = vi.fn(async () => { throw new Error('Exact membership must not scan list projections'); });
    const executor = createTransportExecutor({ sessionManagerSet, sessionRead, sessionList });
    const agent = { surface: 'agent', authority: 'account_automation', defaultSessionId: 'lead' } as const;
    await expect(executor.execute('session.manager.set', input, agent)).resolves.toMatchObject({ ok: true });
    await expect(executor.execute('session.manager.set', { ...input, sessionId: 'unrelated' }, agent)).resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(submittedAttachments).toEqual([input]);
    expect(sessionRead).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: ['worker'], underSessionId: 'lead' }));
    expect(sessionList).not.toHaveBeenCalled();
  });

  it('honors explicit require inside the subtree and waiver outside without granting input authority', async () => {
    const submittedAttachments: string[] = [];
    const executor = createTransportExecutor({
      sessionList: async () => ({ sessions: [], nextCursor: null, hasNext: false, queryVersion: 1, attentionNextCursor: null, attentionHasNext: false }),
      sessionManagerSet: async ({ sessionId }) => {
        submittedAttachments.push(sessionId);
        return { ok: false, error: 'manager_forbidden', reason: 'input' };
      },
    });
    const agent = { surface: 'agent', authority: 'account_automation', defaultSessionId: 'lead' } as const;
    await expect(executor.execute('session.manager.set', { ...input, sessionId: 'lead' }, {
      ...agent,
      actionsSettings: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: { 'session.manager.set': { approvalRequiredSurfaces: ['agent'] } },
      }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    await expect(executor.execute('session.manager.set', input, {
      ...agent,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: { 'session.manager.set': ['agent'] } }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'manager_forbidden', details: { reason: 'input' } });
    expect(submittedAttachments).toEqual(['worker']);
  });

  it('requires explicit compare-and-set facts and preserves typed service failures', async () => {
    const spec = getActionSpec('session.manager.set');
    expect(spec.inputSchema.safeParse({ sessionId: 'worker', managerSessionId: 'lead' }).success).toBe(false);
    const sessionManagerSet = vi.fn(async () => ({ ok: false as const, error: 'manager_forbidden' as const, reason: 'pairwise' as const }));
    const executor = createTransportExecutor({ sessionManagerSet });
    await expect(executor.execute('session.manager.set', input, context)).resolves.toMatchObject({
      ok: false, errorCode: 'manager_forbidden', details: { reason: 'pairwise' },
    });
    expect(sessionManagerSet).toHaveBeenCalledWith(expect.objectContaining({ ...input, context: expect.objectContaining(context), serverId: 'home' }));
  });

  it('refuses a response that belongs to a different attachment', async () => {
    const executor = createTransportExecutor({
      sessionManagerSet: async () => ({ ok: true, sessionId: 'other-worker', managerSessionId: 'lead', attachedAt: 1 }),
    });
    await expect(executor.execute('session.manager.set', input, context)).resolves.toMatchObject({ ok: false });
  });
});
