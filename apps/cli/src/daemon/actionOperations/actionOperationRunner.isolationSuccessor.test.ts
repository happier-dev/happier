import { describe, expect, it } from 'vitest';
import { getActionSpec, MachineAgentIsolationReadyPreviewV1Schema } from '@happier-dev/protocol';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';

describe('reviewed isolation successor settlement', () => {
  it('settles only the matching idle review after a successful successor, preserving refusals and other scopes', async () => {
    const scope = { accountId: 'owner', machineId: 'machine' };
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.agentIsolation.set');
    let sequence = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `operation-${++sequence}`,
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation!, operationReentry: spec.operationReentry }) });
    const current = MachineAgentIsolationReadyPreviewV1Schema.parse({ kind: 'ready', policy: { enabled: false }, metadataVersion: 1,
      status: { kind: 'disabled' }, plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0, requiresAdmin: true, planDigest: 'review' } });
    const input = { machineId: scope.machineId, enabled: true, expectedPolicy: current.policy,
      expectedMetadataVersion: current.metadataVersion, expectedPlanDigest: current.plan.planDigest };
    for (const [requestId, reviewScope, review] of [
      ['original', scope, current],
      ['other-account', { ...scope, accountId: 'other' }, current],
      ['other-review', scope, { ...current, plan: { ...current.plan, planDigest: 'different' } }],
    ] as const) {
      await runner.observe({ actionId: spec.id, scope: reviewScope, requestId, input, execute: async operation => {
        operation.publishOwnerUpdate({ state: 'running', observation: { kind: 'review_required', code: 'agent_isolation_effect_changed',
          machineId: scope.machineId, enabled: true, current: review } });
        return { ok: true, result: { kind: 'plan_changed', operationId: operation.operationAcceptance!.operationId, current: review } };
      } });
    }
    await runner.observe({ actionId: spec.id, scope, requestId: 'refused', input,
      execute: async () => ({ ok: true, result: { kind: 'failed', code: 'denied' } }) });
    expect(store.get(scope, 'operation-1')).toMatchObject({ state: 'running', observation: { kind: 'review_required' } });
    const result = { kind: 'accepted', operationId: 'operation-5', metadataVersion: 2,
      status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } };
    await runner.observe({ actionId: spec.id, scope, requestId: 'successor', input, execute: async () => ({ ok: true, result }) });
    expect(store.get(scope, 'operation-1')).toMatchObject({ state: 'succeeded', result });
    expect(store.get(scope, 'operation-1')).not.toHaveProperty('observation');
    expect(store.get({ ...scope, accountId: 'other' }, 'operation-2')).toMatchObject({ state: 'running' });
    expect(store.get(scope, 'operation-3')).toMatchObject({ state: 'running' });
  });
});
