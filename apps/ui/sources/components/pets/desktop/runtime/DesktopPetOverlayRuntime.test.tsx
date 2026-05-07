import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const isTauriDesktopState = vi.hoisted(() => ({ value: true }));
const syncDesktopPetOverlayState = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/utils/platform/tauri', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/tauri')>('@/utils/platform/tauri');
    return {
        ...actual,
        isTauriDesktop: () => isTauriDesktopState.value,
    };
});

vi.mock('../bridge/desktopPetOverlayBridge', () => ({
    syncDesktopPetOverlayState,
}));

describe('DesktopPetOverlayRuntime', () => {
    afterEach(() => {
        isTauriDesktopState.value = true;
        syncDesktopPetOverlayState.mockClear();
    });

    it('syncs a disabled policy as hidden even when the source model is visible', async () => {
        const { DesktopPetOverlayRuntime } = await import('./DesktopPetOverlayRuntime');

        await renderScreen(
            <DesktopPetOverlayRuntime
                visible={true}
                expanded={false}
                window={{ width: 192, height: 208 }}
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
            policy: {
                enabled: false,
                alwaysOnTop: true,
                inputLocked: false,
                anchor: 'bottomRight',
            },
        });
    });

    it('does not sync outside the Tauri desktop shell', async () => {
        isTauriDesktopState.value = false;
        const { DesktopPetOverlayRuntime } = await import('./DesktopPetOverlayRuntime');

        await renderScreen(
            <DesktopPetOverlayRuntime
                visible={true}
                expanded={false}
                window={{ width: 192, height: 208 }}
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
