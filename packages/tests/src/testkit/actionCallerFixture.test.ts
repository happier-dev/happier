import { describe, expect, it } from 'vitest';

import {
  createAutomationRunCallerFixture,
  createPluginCallerFixture,
} from './actionCallerFixture';

describe('Action caller fixtures', () => {
  it('builds the host-stamped Automation result-delivery caller without mutable authority fields', () => {
    const caller = createAutomationRunCallerFixture({
      runId: 'run-001',
      automationId: 'automation-001',
      cause: {
        kind: 'conversation',
        occurrenceKey: 'A'.repeat(43),
        occurredAt: 1,
      },
    });

    expect(caller).toEqual({
      kind: 'automationRun',
      runId: 'run-001',
      automationId: 'automation-001',
      cause: {
        kind: 'conversation',
        occurrenceKey: 'A'.repeat(43),
        occurredAt: 1,
      },
    });
    expect(Object.isFrozen(caller)).toBe(true);
  });

  it('keeps ordinary plugin caller attribution distinct from an Automation Run cause', () => {
    const contribution = {
      id: 'automation/result-deliver-v1',
      qualifiedId: 'happier.channels/actions/automation/result-deliver-v1',
    };
    const caller = createPluginCallerFixture({
      pluginId: 'happier.channels',
      contribution,
      materialization: {
        pluginId: 'happier.channels',
        machineId: 'machine-1',
        materializationId: 'materialization-channels-current',
      },
      originSurface: 'background',
    });

    contribution.qualifiedId = 'forged/qualified-id';

    expect(caller).toEqual({
      kind: 'plugin',
      pluginId: 'happier.channels',
      contribution: {
        id: 'automation/result-deliver-v1',
        qualifiedId: 'happier.channels/actions/automation/result-deliver-v1',
      },
      materialization: {
        pluginId: 'happier.channels',
        machineId: 'machine-1',
        materializationId: 'materialization-channels-current',
      },
      originSurface: 'background',
    });
    expect(Object.isFrozen(caller.contribution)).toBe(true);
    expect(caller.kind).not.toBe('automationRun');
  });
});
