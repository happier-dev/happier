import * as React from 'react';

import { useSetting, useSettingMutable } from '@/sync/domains/state/storage';
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
    const mobileWorkspaceExperience = useSetting('mobileWorkspaceExperienceV1');
    const [, setMobileWorkspaceExperience] = useSettingMutable('mobileWorkspaceExperienceV1');

    return React.useMemo(() => ({
        deviceType,
        mobileWorkspaceExperience: mobileWorkspaceExperience === 'classic' ? 'classic' : 'cockpit',
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
