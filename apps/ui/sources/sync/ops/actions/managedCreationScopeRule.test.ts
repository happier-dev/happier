import { describe, expect, it } from 'vitest';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

import { readManagedCreationScopeRule } from './managedCreationScopeBinding';

const machine = { homeId: 'home-1', id: 'managed-1' };

/** The exact FIN set the creation binder writes for "Stop after 1 h idle when this session is archived". */
function scopeSet(
  overrides: Readonly<{
    managedId?: string;
    actionId?: 'machines.managed.power.set' | 'machines.managed.delete';
    afterMs?: number;
    enabled?: boolean;
    triggerEnabled?: boolean;
    status?: Readonly<{ state: string; runId: string | null }>;
    events?: string[];
  }> = {},
) {
  const actionId = overrides.actionId ?? 'machines.managed.power.set';
  const intent = actionId === 'machines.managed.delete' ? 'delete' : 'stop';
  return WorkflowTriggerSetV1Schema.parse({
    automationId: 'automation-1',
    revision: 1,
    enabled: overrides.enabled ?? true,
    scopeSessionId: 'session-1',
    health: 'available',
    target: {
      kind: 'inline',
      definition: {
        version: 1,
        defaults: {},
        inputs: [],
        blocks: [
          {
            kind: 'action',
            id: 'managed-scope-end',
            actionId,
            input: {
              homeId: { kind: 'literal', value: machine.homeId },
              managedId: {
                kind: 'literal',
                value: overrides.managedId ?? machine.id,
              },
              when: { kind: 'literal', value: 'after-idle' },
              intent: { kind: 'literal', value: intent },
              ...(overrides.afterMs === undefined
                ? {}
                : { afterMs: { kind: 'literal', value: overrides.afterMs } }),
              ...(intent === 'delete'
                ? { reviewedDependencies: { kind: 'literal', value: true } }
                : {}),
            },
          },
        ],
      },
    },
    triggers: [
      {
        id: 'trigger-1',
        revision: 1,
        enabled: overrides.triggerEnabled ?? true,
        createdAt: 1,
        updatedAt: 1,
        kind: 'sessionLifecycle',
        sourceSessionId: 'session-1',
        events: overrides.events ?? ['sessionArchived'],
        policy: { kind: 'everyMatch' },
        remainingOccurrences: null,
        status: overrides.status ?? { state: 'waiting', runId: null },
        triggerDefinitionEnvelope: null,
      },
    ],
  });
}

describe('readManagedCreationScopeRule', () => {
  it('reads the session-archived Stop rule FIN holds for this exact managed machine', () => {
    expect(
      readManagedCreationScopeRule([scopeSet({ afterMs: 3_600_000 })], machine),
    ).toEqual({
      binding: {
        automationId: 'automation-1',
        triggerId: 'trigger-1',
        source: { kind: 'session', sessionId: 'session-1' },
      },
      effect: 'stop',
      afterMs: 3_600_000,
      waiting: false,
    });
  });

  it('says the rule is waiting while its run waits for work to finish, and reads Delete', () => {
    const rule = readManagedCreationScopeRule(
      [
        scopeSet({
          actionId: 'machines.managed.delete',
          status: { state: 'running', runId: 'run-1' },
        }),
      ],
      machine,
    );
    expect(rule).toMatchObject({ effect: 'delete', waiting: true });
    expect(rule).not.toHaveProperty('afterMs');
  });

  it('ignores another machine, a disabled set or trigger, and a trigger that is not the archive event', () => {
    expect(
      readManagedCreationScopeRule(
        [
          scopeSet({ managedId: 'other-machine' }),
          scopeSet({ enabled: false }),
          scopeSet({ triggerEnabled: false }),
          scopeSet({ events: ['sessionStarted'] }),
        ],
        machine,
      ),
    ).toBeNull();
  });
});
