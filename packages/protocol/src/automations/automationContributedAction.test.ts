import { describe, expect, it } from 'vitest';
import { AutomationDefinitionCreateRequestSchema } from './automationApiV3.js';
import { materializeAutomationRunExecutionRecipeV1 } from './automationRunExecutionRecipeV1.js';

const action = { pluginId: 'com.example.jobs', localId: 'refresh' };
const currentness = { mode: 'plain', version: 1, contentKeyFingerprint: null };
const recipe = {
  v: 1, templateVersion: 1, triggerEvidence: null,
  target: { kind: 'contributedAction', action },
  template: { t: 'plain', v: { v: 1, prompt: '', actionInput: { kind: 'literal', value: { project: 'demo' } } } },
};

describe('Automation contributed Action target', () => {
  it('admits an Action definition without a Workflow or a new queue', () => {
    const result = AutomationDefinitionCreateRequestSchema.safeParse({
      automationId: '7cb2fda1-1164-44dd-b337-29e91b024be8', name: 'Refresh', enabled: true,
      executionRecipe: recipe, assignments: [{ machineId: 'machine-1' }], triggers: [],
    });
    expect(result.success).toBe(true);
  });

  it('materializes the exact private JSON input for a scheduled Action', () => {
    expect(materializeAutomationRunExecutionRecipeV1({
      recipe: { ...recipe, assignmentMachineIds: ['machine-1'] },
      cause: { kind: 'manual', invokedAt: 100 }, accountCurrentness: currentness, runId: 'run-1',
    })).toEqual({ kind: 'available', target: { kind: 'contributedAction', action, input: { project: 'demo' } } });
  });

  it('rejects missing Action inputs and incompatible template semantics', () => {
    for (const template of [ { v: 1, prompt: '' },
      { v: 1, prompt: 'ignored text', actionInput: { kind: 'literal', value: null } },
      { v: 1, prompt: '', actionInput: { kind: 'eventPayload' } } ]) {
      expect(materializeAutomationRunExecutionRecipeV1({
        recipe: { ...recipe, assignmentMachineIds: ['machine-1'], template: { t: 'plain', v: template } },
        cause: { kind: 'manual', invokedAt: 100 }, accountCurrentness: currentness, runId: 'run-1',
      })).toEqual({ kind: 'contentInvalid' });
    }
  });
});
