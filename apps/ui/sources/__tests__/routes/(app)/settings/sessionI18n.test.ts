import { describe, expect, it } from 'vitest';

import { getPermissionApplyTimingSubtitleKey } from './sessionI18n';

describe('getPermissionApplyTimingSubtitleKey', () => {
    it('returns immediate subtitle key when apply timing is immediate', () => {
        expect(getPermissionApplyTimingSubtitleKey('immediate')).toBe('settingsSession.defaultPermissions.applyPermissionChangesImmediateSubtitle');
    });

    it('returns next-prompt subtitle key for next_prompt and unknown values', () => {
        expect(getPermissionApplyTimingSubtitleKey('next_prompt')).toBe('settingsSession.defaultPermissions.applyPermissionChangesNextPromptSubtitle');
        expect(getPermissionApplyTimingSubtitleKey('unexpected' as any)).toBe('settingsSession.defaultPermissions.applyPermissionChangesNextPromptSubtitle');
    });
});
