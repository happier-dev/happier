import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';

const request = {
  serverId: 'home', sessionId: 'session', machineId: 'machine', purpose: 'Sign in',
  sourceId: 'source', target: { kind: 'window', displayId: 'display', pid: 1, windowId: 2 },
  captureId: 'capture', geometry: { captureWidth: 100, captureHeight: 100, nativeWidth: 100, nativeHeight: 100,
    originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 100, height: 100 } },
  field: { fieldId: 'password', focusId: 'focus' },
} as const;
const context = { surface: 'agent', authority: 'account_automation', serverId: 'home',
  defaultSessionId: 'session', defaultSessionMachineId: 'machine', actionRequestId: 'request',
  actionCaller: { kind: 'host' } } as const;

function harness(overrides: Partial<ActionExecutorDeps> = {}) {
  const records = new Map<string, ApprovalRequest>();
  let rawEffects = 0;
  // The Artifact port is a storage boundary. The executor and all admission/schema logic remain real.
  const executor = createActionExecutor({
    approvalsCreate: async ({ request }) => { records.set('approval', request); return { artifactId: 'approval' }; },
    approvalsGet: async ({ artifactId }) => records.get(artifactId) ?? null,
    approvalsUpdate: async ({ artifactId, request }) => { records.set(artifactId, request); return { ok: true }; },
    isApprovalExecutionOriginCurrent: async () => true,
    isActionApprovalRequired: () => false,
    runtimeActionExecute: async () => { rawEffects += 1; return { status: 'filled', code: 'filled' }; },
    ...overrides,
  } as ActionExecutorDeps);
  return { executor, records, rawEffects: () => rawEffects };
}

const privateInput = { v: 1, artifactId: 'approval', requestId: 'request', actionId: 'computer.secret.fill',
  request, accountEncryptionMode: 'plain', choice: { kind: 'once', value: 'RECOGNIZABLE-D26-CREDENTIAL' }, submit: false } as const;

describe('confidential secret-fill approval continuation', () => {
  it('keeps configured policy admission separate from the required confidential target/value choice', async () => {
    const { executor, records, rawEffects } = harness();
    expect(await executor.execute('computer.secret.fill', request, context)).toEqual({ ok: true, result: {
      kind: 'approval_request_created', artifactId: 'approval', actionId: 'computer.secret.fill',
    } });
    expect(rawEffects()).toBe(0);
    expect(JSON.stringify([...records.values()])).not.toContain(privateInput.choice.value);
    expect(await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' },
      { surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: false, errorCode: 'confidential_choice_required' });
    expect(rawEffects()).toBe(0);
  });

  it('accepts an exact human continuation once and stores only bounded settlement', async () => {
    let delivered = 0;
    const { executor, records, rawEffects } = harness({
      confidentialSecretFill: async (args) => {
        expect(await args.isCurrent()).toBe(true);
        expect(args.choice).toEqual(privateInput.choice);
        delivered += 1;
        return { status: 'filled', code: 'filled' };
      },
    });
    await executor.execute('computer.secret.fill', request, context);
    expect(await executor.continueConfidentialApprovalRequest(privateInput, { authority: 'account_automation' }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(delivered).toBe(0);
    expect(await executor.continueConfidentialApprovalRequest(privateInput, { authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result: { status: 'filled', code: 'filled' } });
    expect(delivered).toBe(1);
    expect(rawEffects()).toBe(0);
    expect(JSON.stringify([...records.values()])).not.toContain(privateInput.choice.value);
    expect(await executor.continueConfidentialApprovalRequest(privateInput, { authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result: { status: 'filled', code: 'filled' } });
    expect(delivered).toBe(1);
  });

  it('refuses a changed target and never replays an issued uncertain fill or submit', async () => {
    let delivered = 0;
    const { executor, records } = harness({ confidentialSecretFill: async () => {
      delivered += 1;
      throw new Error(privateInput.choice.value);
    } });
    await executor.execute('computer.secret.fill', request, context);
    expect(await executor.continueConfidentialApprovalRequest({ ...privateInput, request: { ...request, captureId: 'new' } },
      { authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(delivered).toBe(0);
    const unknown = await executor.continueConfidentialApprovalRequest(privateInput, { authority: 'present_user', serverId: 'home' });
    expect(unknown).toEqual({ ok: true, result: { status: 'unknown', code: 'delivery_unknown' } });
    expect(JSON.stringify([...records.values()])).not.toContain(privateInput.choice.value);
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'approval', callerAuthority: 'present_user' })).toMatchObject({
      ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'unknown', code: 'delivery_unknown' } } },
    });
    expect(delivered).toBe(1);
  });

  it('records known fill separately from unknown submit and never repeats either effect', async () => {
    let delivered = 0;
    const settlement = { status: 'filled', code: 'filled', submit: { status: 'unknown', code: 'submit_unknown' } } as const;
    const { executor, records } = harness({ confidentialSecretFill: async () => {
      delivered += 1;
      return settlement;
    } });
    const reviewed = { ...request, submit: { controlId: 'sign-in', label: 'Sign in', consequence: 'Sign in to the reviewed account' } };
    const choice = { ...privateInput, request: reviewed, submit: true };
    await executor.execute('computer.secret.fill', reviewed, context);
    const human = { authority: 'present_user', serverId: 'home' } as const;
    expect(await executor.continueConfidentialApprovalRequest(choice, human)).toEqual({ ok: true, result: settlement });
    expect(await executor.continueConfidentialApprovalRequest(choice, human)).toEqual({ ok: true, result: settlement });
    expect(await executor.replayApprovedApprovalRequest({ artifactId: 'approval', callerAuthority: 'present_user' }))
      .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: settlement } } });
    expect(delivered).toBe(1);
    expect(JSON.stringify([...records.values()])).not.toContain(privateInput.choice.value);
  });

  it('rechecks the deciding human Machine admission after preparation rather than only the original requester', async () => {
    let admitted = false;
    let delivered = 0;
    const { executor, records } = harness({ confidentialSecretFill: async ({ isCurrent }) => {
      // The host callback is the external Home admission boundary; the original owner origin stays current.
      admitted = false;
      if (!await isCurrent()) return { status: 'refused', code: 'approval_changed' };
      delivered += 1;
      return { status: 'filled', code: 'filled' };
    } });
    await executor.execute('computer.secret.fill', request, context);
    const humanContext = {
      authority: 'present_user' as const, serverId: 'home', verifyMachineAdmissionCurrent: async () => admitted,
    };
    expect(await executor.continueConfidentialApprovalRequest(privateInput, humanContext))
      .toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(records.get('approval')?.status).toBe('open');
    expect(delivered).toBe(0);
    admitted = true;
    expect(await executor.continueConfidentialApprovalRequest(privateInput, {
      ...humanContext,
    })).toEqual({ ok: true, result: { status: 'refused', code: 'approval_changed' } });
    expect(delivered).toBe(0);
  });

  it('binds a continuation through the host Home identity when its local profile alias differs', async () => {
    let delivered = 0;
    const { executor } = harness({ confidentialSecretFill: async () => {
      delivered += 1; return { status: 'filled', code: 'filled' };
    } });
    await executor.execute('computer.secret.fill', request, { ...context, serverIdentityId: 'verified-home' });
    expect(await executor.continueConfidentialApprovalRequest(privateInput, {
      authority: 'present_user', serverId: 'local-home', serverIdentityId: 'different-home',
    })).toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(delivered).toBe(0);
    expect(await executor.continueConfidentialApprovalRequest(privateInput, {
      authority: 'present_user', serverId: 'local-home', serverIdentityId: 'verified-home',
    })).toEqual({ ok: true, result: { status: 'filled', code: 'filled' } });
    expect(delivered).toBe(1);
  });
});
