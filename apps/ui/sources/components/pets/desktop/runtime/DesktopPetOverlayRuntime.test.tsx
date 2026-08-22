import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const isDesktopHostState = vi.hoisted(() => ({ value: true }));
const syncDesktopPetOverlayState = vi.hoisted(() => vi.fn(async () => {}));
const idleActivity = {
    state: 'idle',
    reason: 'idle',
    sessionId: null,
    trayItems: [],
} as const;

vi.mock('@/utils/platform/desktopHost', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/desktopHost')>('@/utils/platform/desktopHost');
    return {
        ...actual,
        isDesktopHost: () => isDesktopHostState.value,
    };
});

vi.mock('../bridge/desktopPetOverlayBridge', () => ({
    syncDesktopPetOverlayState,
}));

describe('DesktopPetOverlayRuntime', () => {
    afterEach(() => {
        isDesktopHostState.value = true;
        syncDesktopPetOverlayState.mockClear();
    });

    it('syncs a disabled policy as hidden even when the source model is visible', async () => {
        const { DesktopPetOverlayRuntime } = await import('./DesktopPetOverlayRuntime');

        await renderScreen(
            <DesktopPetOverlayRuntime
                visible={true}
                expanded={false}
                window={{ width: 192, height: 208 }}
                nativeMouseTrackingEnabled={false}
                activity={idleActivity}
                policy={{
                    enabled: false,
                    visibilityMode: 'alwaysWhenEnabled',
                    alwaysOnTop: true,
                    inputLocked: false,
                    anchor: 'bottomRight',
                }}
            />,
        );

        expect(syncDesktopPetOverlayState).toHaveBeenCalledWith({
            visible: false,
            expanded: false,
            window: { width: 192, height: 208 },
            nativeMouseTrackingEnabled: false,
            activity: idleActivity,
            policy: {
                enabled: false,
                alwaysOnTop: true,
                inputLocked: false,
                anchor: 'bottomRight',
            },
        });
    });

    it('does not sync outside the Tauri desktop shell', async () => {
        isDesktopHostState.value = false;
        const { DesktopPetOverlayRuntime } = await import('./DesktopPetOverlayRuntime');

        await renderScreen(
            <DesktopPetOverlayRuntime
                visible={true}
                expanded={false}
                window={{ width: 192, height: 208 }}
                nativeMouseTrackingEnabled={false}
                activity={idleActivity}
                policy={{
                    enabled: true,
                    visibilityMode: 'alwaysWhenEnabled',
                    alwaysOnTop: true,
                    inputLocked: false,
                    anchor: 'bottomRight',
                }}
            />,
        );

        expect(syncDesktopPetOverlayState).not.toHaveBeenCalled();
    });
});
