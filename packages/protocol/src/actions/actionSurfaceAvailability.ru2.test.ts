import { describe, expect, it } from 'vitest';

import { resolveActionSurfaceAvailability } from './actionSurfaceAvailability.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';

describe('RU2 external MCP parity', () => {
  it.each([
    'browser.view.open', 'browser.recording.start', 'browser.diagnostics.snapshot',
    'computer.input', 'localServices.launcher.openPreview', 'localServices.publicPreview.copyUrl',
    'localServices.actions.copyUrl', 'secrets.shared.create', 'secrets.shared.update', 'secrets.shared.delete',
  ] as const)('admits %s through external MCP availability just as through the Session agent', actionId => {
    for (const surface of ['agent', 'mcp'] as const) {
      expect(resolveActionSurfaceAvailability({ actionId, surface })).toMatchObject({ available: true, reason: 'available' });
    }
  });

  it.each(['computer.clipboard.read', 'computer.clipboard.write'] as const)(
    'offers %s with configurable Ask and private observations', actionId => {
      const spec = getActionSpec(actionId);
      expect(spec.requiredAuthority).toBe('account_automation');
      for (const surface of ['agent', 'mcp'] as const) {
        const context = { surface, authority: 'account_automation' } as const;
        expect(resolveActionSurfaceAvailability({ actionId, surface })).toMatchObject({ available: true });
        expect(resolveActionApprovalRouting({ actionId, spec, context,
          settings: normalizeActionsSettingsV1({ v: 1 }) }).required).toBe(true);
        expect(resolveActionApprovalRouting({ actionId, spec, context,
          settings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: [surface] } }) }).required).toBe(false);
      }
      expect(spec.approvalInputCustody).toBe('live_only');
      expect(spec.approvalResultCustody).toBe('live_only');
      expect(spec.projectObservationInput?.({ machineId: 'machine', text: 'private-fixture' })).toEqual({});
      expect(spec.projectObservationOutput?.({ status: 'copied', text: 'private-fixture' })).toEqual({});
    },
  );
});
