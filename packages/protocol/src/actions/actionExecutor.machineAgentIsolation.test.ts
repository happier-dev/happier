import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

describe('Agent isolation Action admission', () => {
  it('makes preview a safe target read and set a configurable dangerous target operation', () => {
    const preview = ActionIdSchema.parse('machines.agentIsolation.preview');
    const set = ActionIdSchema.parse('machines.agentIsolation.set');
    expect(getActionSpec(preview)).toMatchObject({ executionPlacement: 'machine', safety: 'safe' });
    expect(getActionSpec(set)).toMatchObject({ executionPlacement: 'machine', safety: 'danger' });
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    expect(isApprovalRequiredByActionsSettings(preview, settings, { surface: 'agent' })).toBe(false);
    expect(isApprovalRequiredByActionsSettings(set, settings, { surface: 'agent' })).toBe(true);
  });
});
