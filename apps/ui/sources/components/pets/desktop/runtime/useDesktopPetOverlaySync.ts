import * as React from 'react';

import { fireAndForget } from '@/utils/system/fireAndForget';

import { syncDesktopPetOverlayState } from '../bridge/desktopPetOverlayBridge';
import type { DesktopPetOverlayPolicy } from '../policy/resolveDesktopPetOverlayPolicy';
import type { PetCompanionActivityModel } from '@/components/pets/activity';

export type DesktopPetOverlaySyncWindow = Readonly<{
    width: number;
    height: number;
}>;

export type DesktopPetOverlaySyncInput = Readonly<{
    visible: boolean;
    expanded: boolean;
    window: DesktopPetOverlaySyncWindow;
    nativeMouseTrackingEnabled: boolean;
    activity: PetCompanionActivityModel;
    policy: DesktopPetOverlayPolicy;
}>;

export function useDesktopPetOverlaySync(input: DesktopPetOverlaySyncInput): void {
    const latestInput = React.useRef(input);
    latestInput.current = input;
    React.useEffect(() => () => {
        fireAndForget(syncDesktopPetOverlayState({
            ...latestInput.current,
            visible: false,
            expanded: false,
            nativeMouseTrackingEnabled: false,
        }), { tag: 'DesktopPetOverlayRuntime.hideOnUnmount' });
    }, []);
    React.useEffect(() => {
        fireAndForget(syncDesktopPetOverlayState({
            visible: input.visible && input.policy.enabled,
            expanded: input.expanded,
            window: input.window,
            nativeMouseTrackingEnabled: input.nativeMouseTrackingEnabled,
            activity: input.activity,
            policy: {
                enabled: input.policy.enabled,
                alwaysOnTop: input.policy.alwaysOnTop,
                inputLocked: input.policy.inputLocked,
                anchor: input.policy.anchor,
            },
        }), {
            tag: 'DesktopPetOverlayRuntime.sync',
        });
    }, [
        input.expanded,
        input.activity,
        input.nativeMouseTrackingEnabled,
        input.policy.alwaysOnTop,
        input.policy.anchor,
        input.policy.enabled,
        input.policy.inputLocked,
        input.visible,
        input.window.height,
        input.window.width,
    ]);
}
