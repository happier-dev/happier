import { describe, expect, it } from 'vitest';

import type { ActionsSettingsV1 } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';

describe('isApprovalRequiredByActionsSettings', () => {
  it('returns true when the action override requires approvals for the given surface', () => {
    const settings: ActionsSettingsV1 = {
      v: 1,
      actions: {
        'review.start': {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['cli'],
        },
      } as any,
    };

    expect(isApprovalRequiredByActionsSettings('review.start' as any, settings, { surface: 'cli' } as any)).toBe(true);
    expect(isApprovalRequiredByActionsSettings('review.start' as any, settings, { surface: 'mcp' } as any)).toBe(false);
  });

  it('never requires approvals for session.title.set even when configured', () => {
    const settings: ActionsSettingsV1 = {
      v: 1,
      actions: {
        'session.title.set': {
          enabledPlacements: [],
          disabledSurfaces: [],
          disabledPlacements: [],
          approvalRequiredSurfaces: ['cli', 'mcp'],
        },
      } as any,
    };

    expect(isApprovalRequiredByActionsSettings('session.title.set' as any, settings, { surface: 'cli' } as any)).toBe(false);
    expect(isApprovalRequiredByActionsSettings('session.title.set' as any, settings, { surface: 'mcp' } as any)).toBe(false);
  });
});
