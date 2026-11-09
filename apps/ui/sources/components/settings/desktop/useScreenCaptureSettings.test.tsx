import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { useScreenCaptureSettings } from './useScreenCaptureSettings';

const events = new Map<string, (event: { payload: unknown }) => void>();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); events.clear(); });

it('reads bindings once and consumes permission and folder pushes without rereading on unrelated events', async () => {
    const callbacks = new Map<number, (event: { payload: unknown }) => void>();
    const bindings = { backend: 'native', availability: 'ready', configureSupported: false, editing: false,
        bindings: [{ key: 'captureShortcut', requested: 'CmdOrCtrl+Shift+2', active: 'CmdOrCtrl+Shift+2', failure: null }] };
    let rejectShortcuts: (reason: unknown) => void = () => {};
    const shortcutRead = new Promise<unknown>((_resolve, reject) => { rejectShortcuts = reject; });
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === 'plugin:event|listen') {
            events.set(String(args?.event), callbacks.get(Number(args?.handler))!);
            return args?.handler;
        }
        if (command === 'plugin:event|unlisten') { events.delete(String(args?.event)); return; }
        if (command === 'desktop_capture_shortcuts') return shortcutRead;
        if (command === 'desktop_capture_preference') return null;
        if (command === 'desktop_capture_window_shadow') return { enabled: false, supported: true };
        if (command === 'desktop_capture_permissions_watch') return args?.consumed ? { screen: 'denied', windowText: 'request_required' } : null;
        throw new Error('unexpected capture settings IPC');
    });
    const internals = { invoke, transformCallback: (callback: (event: { payload: unknown }) => void) => {
        const id = callbacks.size + 1; callbacks.set(id, callback); return id;
    } };
    // Only the webview's OS IPC/callback boundary is substituted; Tauri's event client stays real.
    vi.stubGlobal('window', { __TAURI_INTERNALS__: internals, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
    vi.stubGlobal('__TAURI_INTERNALS__', internals);
    const hook = await renderHook(useScreenCaptureSettings);
    await act(async () => { await vi.waitFor(() => expect(invoke.mock.calls.filter(([command]) => !command.startsWith('plugin:'))).toHaveLength(4)); });
    expect(hook.getCurrent().shortcuts).toEqual({ status: 'loading' });
    await act(async () => { rejectShortcuts('unsupported_platform'); });
    expect(hook.getCurrent().shortcuts).toEqual({ status: 'failed', reason: 'unsupported_platform' });
    await act(async () => { events.get('desktopCapture://shortcuts')?.({ payload: bindings }); });
    expect(hook.getCurrent()).toMatchObject({ shortcuts: { status: 'ready', value: bindings },
        permissions: { status: 'ready', value: { screen: 'denied' } }, folder: { status: 'ready', value: null } });
    expect(invoke.mock.calls.map(([command]) => command).filter(command => !command.startsWith('plugin:')).sort()).toEqual([
        'desktop_capture_permissions_watch', 'desktop_capture_preference', 'desktop_capture_shortcuts', 'desktop_capture_window_shadow',
    ]);
    const before = hook.getCurrent();
    await act(async () => {
        for (let i = 0; i < 20; i++) events.get('desktopCapture://preference/recordingShortcut')?.({ payload: 'Alt+R' });
    });
    expect(hook.getCurrent()).toBe(before);
    const reads = () => invoke.mock.calls.filter(([command]) => !command.startsWith('plugin:'));
    expect(reads()).toHaveLength(4);
    await act(async () => {
        events.get('desktopCapture://permissions')?.({ payload: { screen: 'granted', windowText: 'request_required' } });
        events.get('desktopCapture://preference/libraryFolder')?.({ payload: '/Pictures/Captures' });
        events.get('desktopCapture://preference/includeWindowShadow')?.({ payload: { enabled: true, supported: true } });
        events.get('desktopCapture://shortcuts')?.({ payload: { ...bindings, availability: 'unavailable',
            bindings: [{ ...bindings.bindings[0], failure: 'conflict' }] } });
    });
    expect(hook.getCurrent()).toMatchObject({ permissions: { value: { screen: 'granted' } },
        folder: { value: '/Pictures/Captures' }, windowShadow: { value: { enabled: true, supported: true } },
        shortcuts: { value: { availability: 'unavailable', bindings: [{ failure: 'conflict' }] } } });
    expect(reads()).toHaveLength(4);
    await hook.unmount();
    expect(events.size).toBe(0);
    expect(invoke.mock.calls.filter(([command, args]) => command === 'desktop_capture_permissions_watch' && args?.consumed === false)).toHaveLength(1);
});

it('does no native work outside the Tauri desktop host', async () => {
    const hook = await renderHook(useScreenCaptureSettings);
    expect(hook.getCurrent().supported).toBe(false);
    expect(events.size).toBe(0);
    await hook.unmount();
});
