import { describe, expect, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';
import { isHomeDomainActionIdV1 } from './homeDomainActionFamily.js';
import { bindHomeDomainHttpRequestV1 } from './homeDomainHttpBinding.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { encodeV2SessionListCursorV2 } from '../sessions/listing/cursor.js';

const context = { surface: 'agent', authority: 'account_automation', defaultSessionId: 'lead' } as const;

describe('session.reports_to.set contract', () => {
  it('executes in-subtree reparenting through the Session relation port after server-proved paginated membership', async () => {
    let page = 0;
    const executor = createActionExecutor({
      sessionList: async () => ({
        sessions: page++ === 0
          ? [{ id: 'worker', active: false, presence: 'offline', updatedAt: 10 }]
          : [{ id: 'sublead', active: false, presence: 'offline', updatedAt: 10 }],
        nextCursor: page === 1 ? encodeV2SessionListCursorV2({ sessionId: 'worker', meaningfulActivityAt: 10 }) : null, hasNext: page === 1,
        queryVersion: 1, attentionNextCursor: null, attentionHasNext: false,
      }),
      sessionReportsToSet: async () => ({ ok: true, sessionId: 'worker', leadSessionId: 'sublead', attachedAt: 10 }),
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.reports_to.set', {
      sessionId: 'worker', leadSessionId: 'sublead', expectedLeadSessionId: 'lead',
    }, context)).resolves.toEqual({ ok: true, result: { ok: true, sessionId: 'worker', leadSessionId: 'sublead', attachedAt: 10 } });
  });

  it('does not waive danger confirmation for an outside child or an unproved subtree result', async () => {
    for (const marked of [true, false]) {
      let mutated = false;
      const executor = createActionExecutor({
        sessionList: async () => ({ sessions: [], nextCursor: null, hasNext: false,
          ...(marked ? { queryVersion: 1, attentionNextCursor: null, attentionHasNext: false } : {}),
        }),
        sessionReportsToSet: async () => { mutated = true; return { ok: true, sessionId: 'outside', leadSessionId: 'lead', attachedAt: 10 }; },
      } as unknown as ActionExecutorDeps);
      const result = await executor.execute('session.reports_to.set', {
        sessionId: 'outside', leadSessionId: 'lead', expectedLeadSessionId: null,
      }, context);
      expect(result.ok).toBe(false);
      expect(mutated).toBe(false);
    }
  });
  it('declares a strict CAS mutation on its dedicated Session relation transport', () => {
    expect(isHomeDomainActionIdV1('session.reports_to.set')).toBe(false);
    const spec = getActionSpec('session.reports_to.set');
    const input = { sessionId: 'worker/1', leadSessionId: 'lead', expectedLeadSessionId: null };
    expect(spec.inputSchema.parse(input)).toEqual(input);
    expect(spec.inputSchema.safeParse({ ...input, expectedLeadSessionId: undefined }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, accountId: 'fabricated' }).success).toBe(false);
    expect(bindHomeDomainHttpRequestV1({ transport: spec.serverTransport!, inputSchema: spec.inputSchema, input })).toEqual({
      method: 'POST', path: '/v1/sessions/worker%2F1/reports-to',
      body: { leadSessionId: 'lead', expectedLeadSessionId: null },
    });
    expect(spec.surfaces).toMatchObject({ ui: true, cli: true, voice: true, agent: true, mcp: true });
    expect(spec.outputSchema.safeParse({ ok: true, sessionId: 'worker', leadSessionId: 'lead', attachedAt: 1 }).success).toBe(true);
    expect(spec.outputSchema.safeParse({ ok: true, sessionId: 'worker', leadSessionId: null, attachedAt: null }).success).toBe(true);
    expect(spec.outputSchema.safeParse({ ok: true, sessionId: 'worker', leadSessionId: 'lead', attachedAt: -1 }).success).toBe(false);
  });

  it('preserves closed graph refusals from the Session relation port', async () => {
    for (const error of ['reports_to_cycle', 'reports_to_cas_conflict'] as const) {
      const executor = createActionExecutor({ sessionReportsToSet: async () => ({ ok: false, error }) } as unknown as ActionExecutorDeps);
      expect(await executor.execute('session.reports_to.set', {
        sessionId: 'worker', leadSessionId: 'lead', expectedLeadSessionId: null,
      }, { surface: 'ui', authority: 'present_user', bypassApprovals: true })).toMatchObject({ ok: false, errorCode: error });
    }
  });
});
