import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const nativeInvoke = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown) => undefined as unknown));
const nativeListen = vi.hoisted(() => vi.fn(async () => () => {}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: nativeListen }));
const idleActivity = {
    state: 'quiet',
    address: null,
    sessionId: null,
    trayItems: [],
} as const;

describe('DesktopPetOverlayRuntime', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.stubGlobal('isTauri', true);
        vi.stubGlobal('navigator', { userAgent: 'Tauri' });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: nativeInvoke });
        nativeInvoke.mockImplementation(async (command) => command === 'desktop_host_get_availability'
            ? { activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' } }
            : undefined);
        await (await import('@/utils/platform/desktopHost')).getDesktopHostAvailability();
        nativeInvoke.mockClear();
    });
    afterEach(() => {
        standardCleanup();
        vi.unstubAllGlobals();
        nativeInvoke.mockClear();
        nativeListen.mockClear();
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
                    alwaysOnTop: true,
                    inputLocked: false,
                    anchor: 'bottomRight',
                }}
            />,
        );

        expect(nativeInvoke).toHaveBeenCalledWith('sync_desktop_pet_overlay_state', { payload: {
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
        } });
    });

    it('hides once on source unmount, using latest geometry without hiding between updates', async () => {
        const { DesktopPetOverlayRuntime } = await import('./DesktopPetOverlayRuntime');

        const element = (width: number) => (
            <DesktopPetOverlayRuntime
                visible={true}
                expanded={false}
                window={{ width, height: 208 }}
                nativeMouseTrackingEnabled={false}
                activity={idleActivity}
                policy={{
                    enabled: true,
                    alwaysOnTop: true,
                    inputLocked: false,
                    anchor: 'bottomRight',
                }}
            />
        );
        const screen = await renderScreen(element(192));
        await act(async () => { screen.update(element(320)); });
        const payloads = () => nativeInvoke.mock.calls.filter(([command]) => command === 'sync_desktop_pet_overlay_state')
            .map(([, args]) => (args as { payload: { visible: boolean } }).payload);
        expect(payloads()).toHaveLength(2);
        expect(payloads().every(payload => payload.visible)).toBe(true);
        await act(async () => { screen.unmount(); });
        expect(payloads()).toHaveLength(3);
        expect(payloads().at(-1)).toMatchObject({ visible: false, expanded: false,
            nativeMouseTrackingEnabled: false, window: { width: 320, height: 208 } });
    });
});
