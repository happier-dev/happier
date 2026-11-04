/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import type { NativeCaptureSnapshot } from '@/desktop/capture/nativeCapture';
import { formatKeybindingLabel, parseKeybindingRule } from '@/keyboard/bindings';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import { t } from '@/text';

const host = vi.hoisted(() => ({
    displayId: '1',
    listeners: new Set<(event: { payload: unknown }) => void>(),
    shortcuts: new Set<(event: { payload: unknown }) => void>(),
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return { ...createExpoRouterMock().module, useLocalSearchParams: () => {
        // Each mounted root represents a different webview with its own fixed URL.
        const [displayId] = React.useState(host.displayId);
        return { displayId };
    } };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Vitest's platform resolver otherwise selects the phone's deliberately empty layer.
vi.mock('./CaptureSelectionLayer', async () => import('./CaptureSelectionLayer.web'));
// Only the native event transport is substituted; adapter, route and selection UI stay real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async (event: string, listener: (event: { payload: unknown }) => void) => {
    const listeners = event === 'desktopCapture://shortcuts' ? host.shortcuts : host.listeners;
    listeners.add(listener);
    return () => { listeners.delete(listener); };
} }));

const { CaptureSelectionRoute } = await import('./CaptureSelectionRoute');
const display = (displayId: number) => ({ displayId, frame: { x: 0, y: 0, width: 1440, height: 900 },
    scale: 1, desktopScale: 1, storageKey: null, localizedName: null, safeAreaTop: 0, physicalNotchSize: null });
const selecting: NativeCaptureSnapshot = { status: 'selecting', operationRef: 7, mode: 'still',
    inventory: { displays: [display(1), display(2)], windows: [] } };
const screens: Awaited<ReturnType<typeof renderScreen>>[] = [];

afterEach(async () => {
    for (const screen of screens.splice(0)) await screen.unmount();
    host.listeners.clear();
    host.shortcuts.clear();
    vi.unstubAllGlobals();
});

it('acknowledges selection presentation only after geometry has rendered and a transparent frame has painted', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const invoke = vi.fn(async (command: string) => {
        if (command === 'desktop_capture_read_state') return selecting;
        if (command === 'desktop_capture_selection_facts') return { display: display(1), windows: [] };
        if (command === 'desktop_capture_shortcuts') return { bindings: [] };
        if (command === 'desktop_capture_window_ready') return true;
        return null;
    });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    host.displayId = '1';
    screens.push(await renderScreen(<CaptureSelectionRoute />));
    await flushHookEffects();
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_capture_window_ready')).toHaveLength(0);
    await act(async () => { for (const frame of frames.splice(0)) frame(0); });
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_capture_window_ready')).toHaveLength(0);
    await act(async () => { for (const frame of frames.splice(0)) frame(16); });
    expect(invoke).toHaveBeenCalledWith('desktop_capture_window_ready', { phase: 'paint' });
});

it('switches through the native operation and paints the pushed mode on every display without rereading geometry', async () => {
    let snapshot = selecting;
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === 'desktop_capture_read_state') return snapshot;
        if (command === 'desktop_capture_selection_facts') return { display: display(Number(args?.displayId)), windows: [] };
        if (command === 'desktop_capture_set_mode') return snapshot;
        if (command === 'desktop_capture_shortcuts') return { bindings: [] };
        if (command === 'desktop_capture_window_ready') return true;
        throw 'operation_unavailable';
    });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    host.displayId = '1';
    const first = await renderScreen(<CaptureSelectionRoute />);
    screens.push(first);
    await flushHookEffects();
    host.displayId = '2';
    const second = await renderScreen(<CaptureSelectionRoute />);
    screens.push(second);
    await flushHookEffects();
    const selectedMode = (screen: typeof first, mode: string) => screen.findHostByTestId(`capture-selection-mode:${mode}`)?.props.accessibilityState?.selected;
    expect(selectedMode(first, 'still')).toBe(true);
    expect(selectedMode(second, 'still')).toBe(true);

    await first.pressByTestIdAsync('capture-selection-mode:recording');
    expect(invoke).toHaveBeenCalledWith('desktop_capture_set_mode', { operationRef: 7, mode: 'recording' });
    expect(selectedMode(first, 'still')).toBe(true); // No renderer-owned optimistic mode.
    snapshot = { ...selecting, mode: 'recording' };
    await act(async () => { for (const listener of host.listeners) listener({ payload: snapshot }); });
    expect(selectedMode(first, 'recording')).toBe(true);
    expect(selectedMode(second, 'recording')).toBe(true);
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_capture_selection_facts')).toHaveLength(2);
});

it('starts under a stationary native pointer and shows the active rebound chord', async () => {
    const terminal = { windowId: 2, processId: 9, frame: { x: 700, y: 70, width: 700, height: 600 },
        appName: 'Terminal', title: null, zOrder: 0 };
    const shortcuts = (active: string | null) => ({ backend: 'native', availability: 'ready', editing: false,
        configureSupported: false, bindings: [{ key: 'captureShortcut', requested: 'Ctrl+Shift+2', active, failure: null }] });
    const invoke = vi.fn(async (command: string) => {
        if (command === 'desktop_capture_read_state') return selecting;
        if (command === 'desktop_capture_selection_facts') return { display: display(1), windows: [terminal], initialPointer: { x: 900, y: 300 } };
        if (command === 'desktop_capture_hit_test') return terminal;
        if (command === 'desktop_capture_shortcuts') return shortcuts('Ctrl+Alt+7');
        throw 'operation_unavailable';
    });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    host.displayId = '1';
    const screen = await renderScreen(<CaptureSelectionRoute />); screens.push(screen);
    await flushHookEffects();
    expect(invoke).toHaveBeenCalledWith('desktop_capture_hit_test', { operationRef: 7, displayId: 1, localX: 900, localY: 300 });
    const label = (rule: string) => formatKeybindingLabel(parseKeybindingRule(rule), resolveKeyboardPlatform());
    expect(JSON.stringify(screen.tree.toJSON())).toContain(label('Ctrl+Alt+7'));
    await act(async () => { for (const listener of host.shortcuts) listener({ payload: shortcuts('Ctrl+Alt+8') }); });
    expect(JSON.stringify(screen.tree.toJSON())).toContain(label('Ctrl+Alt+8'));
    expect(JSON.stringify(screen.tree.toJSON())).not.toContain(label('Ctrl+Alt+7'));
    await act(async () => { for (const listener of host.shortcuts) listener({ payload: shortcuts(null) }); });
    expect(JSON.stringify(screen.tree.toJSON())).not.toContain(label('Ctrl+Alt+8'));
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_capture_hit_test')).toHaveLength(1);
    const layer = screen.findHostByTestId('capture-selection-layer')!;
    await act(async () => { layer.props.onKeyDown(new KeyboardEvent('keydown', { key: 'r' })); });
    expect(JSON.stringify(screen.tree.toJSON())).toContain(t('screenCapture.selection.keyboardPosition'));
    await act(async () => { layer.props.onKeyDown(new KeyboardEvent('keydown', { key: 'Enter' })); });
    expect(JSON.stringify(screen.tree.toJSON())).toContain(t('screenCapture.selection.keyboardRegion'));
    await act(async () => { for (const listener of host.listeners) listener({ payload: { status: 'cancelled' } }); });
    expect(host.shortcuts.size).toBe(0);
});
