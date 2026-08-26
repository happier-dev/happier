import { describe, expect, it } from 'vitest';

import {
    applyFakeTauriDesktopCommand,
    createFakeTauriDesktopState,
} from './fakeTauriDesktop';

describe('fakeTauriDesktop', () => {
    it('returns the canonical window chrome policy for the active Tauri window', async () => {
        const initial = createFakeTauriDesktopState({
            isMaximized: false,
            platform: 'windows',
            strategy: 'custom-controls',
        });

        const mainWindowPolicy = await applyFakeTauriDesktopCommand(
            initial,
            'desktop_get_window_chrome_policy',
        );

        const overlayWindowPolicy = await applyFakeTauriDesktopCommand(
            {
                ...initial,
                currentWindowLabel: 'activity_overlay',
            },
            'desktop_get_window_chrome_policy',
        );

        expect(mainWindowPolicy.result).toEqual({
            strategy: 'custom-controls',
        });
        expect(overlayWindowPolicy.result).toEqual({
            strategy: 'none',
        });
    });

    it('tracks the canonical desktop window bridge commands and maximize state', async () => {
        const initial = createFakeTauriDesktopState({
            isMaximized: false,
            platform: 'windows',
            strategy: 'custom-controls',
        });

        const minimizeResult = await applyFakeTauriDesktopCommand(
            initial,
            'desktop_minimize_window',
        );
        const maximizeResult = await applyFakeTauriDesktopCommand(
            minimizeResult.state,
            'desktop_toggle_window_maximize',
        );
        const dragResult = await applyFakeTauriDesktopCommand(
            maximizeResult.state,
            'desktop_start_window_dragging',
        );
        const closeResult = await applyFakeTauriDesktopCommand(
            dragResult.state,
            'desktop_close_window',
        );
        const maximizedState = await applyFakeTauriDesktopCommand(
            closeResult.state,
            'desktop_get_window_state',
        );

        expect(minimizeResult.result).toBe(true);
        expect(maximizeResult.result).toBe(true);
        expect(dragResult.result).toBe(true);
        expect(closeResult.result).toBe(true);
        expect(maximizedState.result).toEqual({
            isMaximized: true,
        });
        expect(maximizedState.state.controls).toEqual({
            closeCount: 1,
            dragCount: 1,
            minimizeCount: 1,
            toggleMaximizeCount: 1,
        });
        expect(maximizedState.state.invokeLog.map((entry) => entry.command)).toEqual([
            'desktop_minimize_window',
            'desktop_toggle_window_maximize',
            'desktop_start_window_dragging',
            'desktop_close_window',
            'desktop_get_window_state',
        ]);
    });

    it('persists autostart settings and desktop update install state', async () => {
        const initial = createFakeTauriDesktopState({
            autostartEnabled: false,
            updateAvailable: {
                version: '1.2.3',
            },
        });

        const autostartEnabled = await applyFakeTauriDesktopCommand(
            initial,
            'desktop_set_autostart_enabled',
            { enabled: true },
        );
        const autostartState = await applyFakeTauriDesktopCommand(
            autostartEnabled.state,
            'desktop_get_autostart_enabled',
        );
        const installResult = await applyFakeTauriDesktopCommand(
            autostartState.state,
            'desktop_install_update',
        );
        const updateState = await applyFakeTauriDesktopCommand(
            installResult.state,
            'desktop_fetch_update',
        );

        expect(autostartEnabled.result).toBe(true);
        expect(autostartState.result).toBe(true);
        expect(installResult.result).toBe(true);
        expect(updateState.result).toEqual({
            installed: true,
            version: '1.2.3',
        });
    });

    it('stores and returns desktop activity overlay window state', async () => {
        const initial = createFakeTauriDesktopState({
            currentWindowLabel: 'activity_overlay',
            desktopActivityOverlayState: null,
        });
        const payload = {
            visible: true,
            expanded: false,
            model: {
                companion: {
                    enabled: true,
                    state: 'idle',
                },
            },
        };

        const synced = await applyFakeTauriDesktopCommand(
            initial,
            'desktop_activity_overlay_sync',
            { payload },
        );
        const state = await applyFakeTauriDesktopCommand(
            synced.state,
            'desktop_activity_overlay_get_window_state',
        );

        expect(synced.result).toBeNull();
        expect(state.result).toEqual(payload);
        expect(state.state.invokeLog.map((entry) => entry.command)).toEqual([
            'desktop_activity_overlay_sync',
            'desktop_activity_overlay_get_window_state',
        ]);
    });

    it('admits synthetic pet overlay window state through the canonical desktop bridge', async () => {
        const windowState = {
            activity: {
                state: 'running',
                reason: 'running',
                sessionId: 'pets-overlay-synthetic-session',
                trayItems: [],
            },
        };
        const initial = createFakeTauriDesktopState({
            currentWindowLabel: 'pet_overlay',
            desktopPetOverlayState: windowState,
        });

        const read = await applyFakeTauriDesktopCommand(
            initial,
            'desktop_pet_overlay_read_window_state',
        );

        expect(read.result).toEqual(windowState);
        expect(read.state.invokeLog.at(-1)?.command).toBe('desktop_pet_overlay_read_window_state');
    });
});
