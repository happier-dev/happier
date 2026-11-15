import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from './actionExecutor.js';
import { resolveActionSurfaceAvailability } from './actionSurfaceAvailability.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { SessionInputAdmissionResultV1Schema } from '../sessions/messages/sessionInputAdmission.js';

describe('Account plugin data erase automation approval (owner A4, 2026-11-15)', () => {
  it.each(['agent', 'mcp'] as const)('requires approval on %s and erases only after the person approves', async surface => {
    expect(resolveActionSurfaceAvailability({ actionId: 'account.plugins.data.erase', surface, requireToolBinding: true }))
      .toMatchObject({ available: true, reason: 'available' });
    let stored: ApprovalRequest | null = null;
    const erased: string[] = [];
    let executor: ReturnType<typeof createActionExecutor>;
    // Artifact persistence, Session transport and Account erasure are host boundaries.
    // Surface admission, default policy, approval transitions and replay remain real.
    const deps: Partial<ActionExecutorDeps> = {
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'erase-review' };
      },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        return { ok: true };
      },
      sessionSendMessage: async args => SessionInputAdmissionResultV1Schema.parse({ status: 'accepted', localId: args.localId }),
      isApprovalExecutionOriginCurrent: async () => true,
      approvalRequestApprovedReplay: async ({ artifactId, context, signal }) => executor.replayApprovedApprovalRequest({
        artifactId, ...(signal ? { signal } : {}), callerAuthority: context.authority ?? 'account_automation',
        currentAccount: { accountId: 'account', serverId: 'home', serverIdentityId: 'home' },
      }),
      accountPluginDataEraseAction: async ({ input }) => {
        erased.push(input.pluginId);
        return { status: 'completed', settings: { status: 'completed', changed: true }, data: { status: 'completed', changed: true } };
      },
    };
    executor = createActionExecutor(deps);
    const context: ActionExecutorContext = {
      surface, authority: 'account_automation', serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'account',
      defaultSessionId: 'session', defaultSessionMachineId: 'machine', actionRequestId: 'erase-request',
      actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 },
    };
    expect(await executor.execute('account.plugins.data.erase', { pluginId: 'com.example.retained-data' }, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'erase-review' } });
    expect(erased).toEqual([]);
    expect(stored).toMatchObject({ status: 'open', actionId: 'account.plugins.data.erase',
      actionArgs: { pluginId: 'com.example.retained-data' } });
    expect(await executor.execute('approval.request.decide', { artifactId: 'erase-review', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
      serverIdentityId: 'home', runtimeAccountId: 'account',
    })).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(erased).toEqual(['com.example.retained-data']);
    expect(stored).toMatchObject({ status: 'executed' });
  });
});
