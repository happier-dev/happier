import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';
import { matchActionAutomationCompletionV1 } from './actionAutomationCompletion.js';
import { projectAutomationActionTriggerStructuralV1 } from '../../automations/automationActionTriggerV1.js';

describe('terminal Events matching one after Action row (R25)', () => {
  const subject = { kind: 'environment' as const, serverId: 'home', environmentId: 'environment' };
  const trigger = { kind: 'action' as const, phase: 'after' as const,
    actionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], subject };
  const observation = { eventRef: { pluginId: '@happier-dev/machine-services', localId: 'deployment-failed' },
    sourceInstanceId: 'source', occurrenceId: 'receipt', occurredAt: 100,
    subjectContexts: [{ role: 'operand' as const, subject }], machineId: 'machine',
    payload: { body: 'private native payload' } };

  it('matches each terminal outcome without expanding or changing the trigger identity', () => {
    for (const outcome of ['succeeded', 'failed', 'cancelled', 'outcome_unknown'] as const) {
      const declaration = { completesActionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], completionOutcome: outcome };
      const [evidence] = matchActionAutomationCompletionV1({ trigger, declaration, observation });
      expect(evidence).toMatchObject({ actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, phase: 'after', outcome,
        status: outcome === 'succeeded' ? 'succeeded' : 'failed', machineId: 'machine', occurredAt: 100 });
      expect(matchActionAutomationCompletionV1({ trigger, declaration,
        observation: { ...observation, occurredAt: 101 } })[0]?.requestId).toBe(evidence?.requestId);
      expect(matchActionAutomationCompletionV1({ trigger, declaration,
        observation: { ...observation, occurrenceId: 'other-receipt' } })[0]?.requestId).not.toBe(evidence?.requestId);
    }
  });

  it('uses the ordinary Only-when filter on safe outcome evidence', () => {
    const filtered = { ...trigger, filter: { v: 1 as const,
      all: [{ op: 'eq' as const, field: '/outcome', value: 'failed' }] } };
    const complete = (completionOutcome: 'failed' | 'succeeded') => matchActionAutomationCompletionV1({
      trigger: filtered, declaration: { completesActionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], completionOutcome }, observation,
    });
    expect(complete('failed')).toHaveLength(1);
    expect(complete('succeeded')).toEqual([]);
    expect(JSON.stringify(complete('failed'))).not.toContain('private native payload');
    expect(projectAutomationActionTriggerStructuralV1(filtered)).not.toHaveProperty('filter');
  });

  it('excludes before rows, unrelated subjects, and non-completion Actions', () => {
    const declaration = { completesActionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], completionOutcome: 'failed' as const };
    expect(matchActionAutomationCompletionV1({ trigger: { ...trigger, phase: 'before' }, declaration, observation })).toEqual([]);
    expect(matchActionAutomationCompletionV1({ trigger, declaration,
      observation: { ...observation, subjectContexts: [] } })).toEqual([]);
    expect(matchActionAutomationCompletionV1({ trigger: { ...trigger, actionIds: ['settings.set'] },
      declaration: { ...declaration, completesActionIds: ['settings.set'] }, observation })).toEqual([]);
    expect(matchActionAutomationCompletionV1({ trigger, declaration: {}, observation })).toEqual([]);
  });
});
