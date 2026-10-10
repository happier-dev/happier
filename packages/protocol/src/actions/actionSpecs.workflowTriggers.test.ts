import { describe, expect, it } from 'vitest';
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
  it('classifies scoped trigger removal as danger at the Action metadata owner', () => {
    expect(getActionSpec('session.trigger.remove')).toMatchObject({ safety: 'danger', sideEffectClass: 'danger' });
  });
});
