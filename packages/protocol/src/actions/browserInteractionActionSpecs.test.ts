import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';

describe('browser interaction Action contracts', () => {
  it('admits deliberate preset and Fit viewer intents while rejecting caller-defined device tuples', () => {
    const spec = getActionSpec('browser.view.setViewport');
    const command = { kind: 'setViewport', browserSessionId: 'browser', viewId: 'view', commandId: 'emulate' };
    expect(spec.inputSchema.parse({ ...command, emulation: { kind: 'preset', presetId: 'phone' } }))
      .toMatchObject({ emulation: { kind: 'preset', presetId: 'phone' } });
    expect(spec.inputSchema.parse({ ...command, emulation: { kind: 'fitViewer' } }))
      .toMatchObject({ emulation: { kind: 'fitViewer' } });
    for (const emulation of [{ kind: 'preset', presetId: 'invented' },
      { kind: 'preset', presetId: 'phone', width: 500 }, { kind: 'fitViewer', mobile: true }]) {
      expect(spec.inputSchema.safeParse({ ...command, emulation }).success).toBe(false);
    }
    expect(resolveActionApprovalRouting({ actionId: 'browser.view.setViewport', spec,
      context: { surface: 'ui', authority: 'present_user' } }).required).toBe(false);
  });
});
