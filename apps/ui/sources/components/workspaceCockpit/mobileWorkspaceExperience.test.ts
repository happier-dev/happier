import { describe, expect, it } from 'vitest';

import {
    isMobileWorkspaceCockpitEnabled,
    normalizeMobileWorkspaceExperience,
    resolveMobileWorkspaceExperienceToggleActionId,
    resolveMobileWorkspaceExperienceToggleLabelKey,
    resolveNextMobileWorkspaceExperience,
} from './mobileWorkspaceExperience';

describe('mobileWorkspaceExperience', () => {
    it('defaults missing or unknown values to cockpit while preserving explicit classic', () => {
        expect(normalizeMobileWorkspaceExperience(undefined)).toBe('cockpit');
        expect(normalizeMobileWorkspaceExperience(null)).toBe('cockpit');
        expect(normalizeMobileWorkspaceExperience('legacy')).toBe('cockpit');
        expect(normalizeMobileWorkspaceExperience('classic')).toBe('classic');
    });

    it('treats an unset phone preference as cockpit-enabled', () => {
        expect(isMobileWorkspaceCockpitEnabled({
            deviceType: 'phone',
            mobileWorkspaceExperience: undefined,
        })).toBe(true);
    });

    it('toggles an unset preference back to classic', () => {
        expect(resolveNextMobileWorkspaceExperience(undefined)).toBe('classic');
        expect(resolveMobileWorkspaceExperienceToggleActionId(undefined)).toBe('header.openMobileWorkspaceClassic');
        expect(resolveMobileWorkspaceExperienceToggleLabelKey(undefined)).toBe('workspaceCockpit.openClassicView');
    });
});
