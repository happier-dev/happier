import { describe, expect, it } from 'vitest';

import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';

describe('isApprovalRequiredByActionsSettings', () => {
  it('returns false when surface is omitted', () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {} });
    expect(isApprovalRequiredByActionsSettings('review.start' as any, settings, {})).toBe(false);
    expect(isApprovalRequiredByActionsSettings('review.start' as any, settings, { surface: null } as any)).toBe(false);
  });

  it('requires approvals only on the configured surfaces for that action', () => {
    const settings = ActionsSettingsV1Schema.parse({
      v: 1,
      actions: {
        'review.start': { approvalRequiredSurfaces: ['mcp'] },
      },
    });

    expect(isApprovalRequiredByActionsSettings('review.start' as any, settings, { surface: 'mcp' } as any)).toBe(true);
    expect(isApprovalRequiredByActionsSettings('review.start' as any, settings, { surface: 'cli' } as any)).toBe(false);
  });
});
