import * as React from 'react';

import { isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { syncDesktopPetOverlayState } from '../bridge/desktopPetOverlayBridge';
import type { DesktopPetOverlayPolicy } from '../policy/resolveDesktopPetOverlayPolicy';

export type DesktopPetOverlaySyncWindow = Readonly<{
    width: number;
    height: number;
}>;

export type DesktopPetOverlaySyncInput = Readonly<{
    visible: boolean;
    expanded: boolean;
    window: DesktopPetOverlaySyncWindow;
    policy: DesktopPetOverlayPolicy;
}>;

export function useDesktopPetOverlaySync(input: DesktopPetOverlaySyncInput): void {
    React.useEffect(() => {
        if (!isTauriDesktop()) {
            return;
        }

        fireAndForget(syncDesktopPetOverlayState({
            visible: input.visible && input.policy.enabled,
            expanded: input.expanded,
            window: input.window,
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
        input.policy.alwaysOnTop,
        input.policy.anchor,
        input.policy.enabled,
        input.policy.inputLocked,
        input.visible,
        input.window.height,
        input.window.width,
    ]);
}
