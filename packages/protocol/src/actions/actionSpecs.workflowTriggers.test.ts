import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';

describe('workflow trigger Action metadata', () => {
  it('exposes retained manual occurrence admission with its existing danger contract and configurable Ask-first', () => {
    const actionId = 'workflow.trigger.run_now';
    const spec = getActionSpec(actionId);
    expect(spec).toMatchObject({ safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation',
      approval: { flow: 'deferred', result: 'optional' }, surfaces: { ui: true, agent: true, mcp: true, cli: true, voice: true } });
    const context = { surface: 'cli', authority: 'present_user' } as const;
    const required = ActionsSettingsV1Schema.parse({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } });
    const waived = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: ['cli'] } });
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: required })).toMatchObject({ required: true, flow: 'deferred' });
    expect(resolveActionApprovalRouting({ actionId, spec, context, settings: waived }).required).toBe(false);
    for (const id of ['workflow.definition.import', 'workflow.definition.export'] as const) {
      expect(getActionSpec(id)).toMatchObject({ safety: 'safe', sideEffectClass: 'read', surfaces: { ui: true, agent: true, mcp: true, cli: true } });
    }
  });
  it('uses only the generic workflow trigger family for Session lifetimes', () => {
    for (const id of ['session.trigger.list', 'session.trigger.add', 'session.trigger.update', 'session.trigger.remove']) {
      expect(ActionIdSchema.safeParse(id).success).toBe(false);
    }
    expect(getActionSpec('workflow.trigger.remove')).toMatchObject({ safety: 'danger', sideEffectClass: 'danger' });
  });
});
