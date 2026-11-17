import { describe, expect, it } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from './actionSettings.js';

import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';

const input = { sourceId: 'host-screen', sourceOccurrenceId: 'screen-occurrence-1' };
const caller = (pluginId: string) => ({
  kind: 'plugin' as const, pluginId, contributionLocalId: 'viewer',
  sourceCustody: { kind: 'development' as const, registeredRootId: `${pluginId}-root` },
  materialization: { machineId: 'machine-1', materializationId: `${pluginId}-mounted`, pluginId },
});

function executor(settings: unknown = { v: 1 }) {
  let request: ApprovalRequest | undefined;
  let requests = 0;
  const instance = createActionExecutor({
    // Artifact storage and the present user's decision are external boundaries.
    approvalsCreate: async (args) => { request = args.request; requests++; return { artifactId: `approval-${requests}` }; },
    approvalsGet: async () => request ?? null,
    approvalsUpdate: async (args) => { request = args.request; return { ok: true }; },
    isApprovalExecutionOriginCurrent: async () => true,
    readActionsSettings: () => normalizeActionsSettingsV1(settings),
  } as ActionExecutorDeps);
  return {
    invoke: (pluginId = 'acme.viewer') => instance.execute('capture.view', input, {
      surface: 'plugin', actionCaller: caller(pluginId), serverId: 'home-1', defaultSessionMachineId: 'machine-1',
      actionRequestId: `view-${requests}`, runtimeAccountId: 'account-1',
    }),
    decide: (decision: 'approve' | 'reject') => instance.execute('approval.request.decide', {
      artifactId: `approval-${requests}`, decision,
    }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'home-1', runtimeAccountId: 'account-1' }),
    requests: () => requests,
    request: () => request,
  };
}

describe('host capture viewing Action admission', () => {
  it('keeps each viewing occurrence private until its deferred Action approval is rejected', async () => {
    const owner = executor();
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      expect(await owner.invoke()).toEqual({ ok: true, result: {
        kind: 'approval_request_created', artifactId: `approval-${occurrence + 1}`, actionId: 'capture.view' } });
      expect(owner.request()).toMatchObject({ status: 'open', approval: { flow: 'deferred' } });
      expect(owner.request()?.execution).toBeUndefined();
      expect(await owner.decide('reject')).toMatchObject({ ok: true, result: { status: 'rejected' } });
    }
    expect(owner.requests()).toBe(2);
  });

  it('returns the exact source occurrence once to the deciding person and stores only its admitted receipt', async () => {
    const owner = executor();
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      expect(await owner.invoke()).toEqual({ ok: true, result: {
        kind: 'approval_request_created', artifactId: `approval-${occurrence + 1}`, actionId: 'capture.view' } });
      expect(await owner.decide('approve')).toMatchObject({ ok: true, result: { status: 'executed',
        liveExecution: { ok: true, result: { admitted: true, ...input } } } });
      expect(owner.request()?.execution?.result).toEqual({ admitted: true });
      const repeated = await owner.decide('approve');
      expect(repeated).toMatchObject({ ok: true, result: { status: 'executed' } });
      if (repeated.ok) expect(repeated.result).not.toHaveProperty('liveExecution');
    }
    expect(owner.requests()).toBe(2);
  });

  it('keeps a persisted per-plugin waiver isolated from foreign plugins', async () => {
    const owner = executor({ v: 1, pluginHostCaptureApprovalWaived: ['acme.viewer'] });
    expect(await owner.invoke()).toEqual({ ok: true, result: { admitted: true, ...input } });
    expect(owner.requests()).toBe(0);
    expect(await owner.invoke('acme.other')).toEqual({ ok: true, result: {
      kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'capture.view' } });
    expect(await owner.decide('reject')).toMatchObject({ ok: true, result: { status: 'rejected' } });
    expect(owner.requests()).toBe(1);
  });

  it('does not let a global plugin-surface waiver disclose host captures to every plugin', async () => {
    const owner = executor({ v: 1, approvalWaivedSurfaces: { 'capture.view': ['plugin'] } });
    expect(await owner.invoke()).toEqual({ ok: true, result: {
      kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'capture.view' } });
    expect(await owner.decide('reject')).toMatchObject({ ok: true, result: { status: 'rejected' } });
  });

  it('requires host-stamped plugin provenance even when approval is waived', async () => {
    const instance = createActionExecutor({  } as ActionExecutorDeps);
    expect(await instance.execute('capture.view', input, {
      surface: 'plugin', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: false, errorCode: 'plugin_action_caller_required' });
  });

  it('preserves the plugin waiver across unrelated malformed policy rows and approval edits', () => {
    const settings = normalizeActionsSettingsV1({ v: 1, actions: { 'session.stop': { enabled: 'invalid' } },
      pluginHostCaptureApprovalWaived: ['acme.viewer'],
    });
    expect(settings.actions['session.stop']?.enabled).toBe(false);
    expect(setActionApprovalOverride({ settings, actionId: 'session.stop', surface: 'ui', approvalRequired: true })
      .pluginHostCaptureApprovalWaived).toEqual(['acme.viewer']);
  });
});
