import * as React from 'react';
import '@tauri-apps/api/event';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { DesktopActivityOverlayRuntime } from './DesktopActivityOverlayRuntime.web';

const boundary = vi.hoisted(() => ({ commands: [] as string[], subscriptions: [] as string[] }));

vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event: string) => {
        boundary.subscriptions.push(event);
        return () => {};
    },
}));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative'))
    .createReactNativeWebMock({ Platform: { OS: 'web' } }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

afterEach(() => {
    standardCleanup();
    vi.unstubAllGlobals();
});

it('issues no activity IPC on Electron while retaining the auxiliary Action listener', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Happier Electron/40.0' });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
        boundary.commands.push(command);
        throw new Error(`Unexpected Electron IPC: ${command}`);
    } });
    vi.stubGlobal('window', { location: { href: 'https://app.example.test/' } });
    await renderScreen(<DesktopActivityOverlayRuntime />);
    await vi.waitFor(() => expect(boundary.subscriptions).toContain('desktopWindow://action'));
    expect(boundary.commands).toEqual([]);
    expect(boundary.subscriptions).not.toContain('activityOverlay://state');
});
