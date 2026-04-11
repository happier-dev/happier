import * as React from 'react';

import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';

import {
    isMobileWorkspaceCockpitEnabled,
    resolveMobileWorkspaceExperienceToggleLabelKey,
    resolveNextMobileWorkspaceExperience,
    shouldShowMobileWorkspaceExperienceToggle,
    type MobileWorkspaceExperience,
} from './mobileWorkspaceExperience';

export function useMobileWorkspaceExperienceState(): Readonly<{
    deviceType: string | null | undefined;
    mobileWorkspaceExperience: MobileWorkspaceExperience;
    cockpitEnabled: boolean;
    showWorkspaceExperienceToggle: boolean;
    workspaceExperienceToggleLabelKey: 'workspaceCockpit.openClassicView' | 'workspaceCockpit.openCockpit';
    toggleWorkspaceExperience: () => void;
}> {
    const deviceType = useDeviceType();
    const mobileWorkspaceExperience = useLocalSetting('mobileWorkspaceExperienceV1');
    const [, setMobileWorkspaceExperience] = useLocalSettingMutable('mobileWorkspaceExperienceV1');

    return React.useMemo(() => ({
        deviceType,
        mobileWorkspaceExperience: mobileWorkspaceExperience === 'cockpit' ? 'cockpit' : 'classic',
        cockpitEnabled: isMobileWorkspaceCockpitEnabled({
            deviceType,
            mobileWorkspaceExperience,
        }),
        showWorkspaceExperienceToggle: shouldShowMobileWorkspaceExperienceToggle({ deviceType }),
        workspaceExperienceToggleLabelKey: resolveMobileWorkspaceExperienceToggleLabelKey(mobileWorkspaceExperience),
        toggleWorkspaceExperience: () => {
            setMobileWorkspaceExperience(resolveNextMobileWorkspaceExperience(mobileWorkspaceExperience));
        },
    }), [deviceType, mobileWorkspaceExperience, setMobileWorkspaceExperience]);
}
