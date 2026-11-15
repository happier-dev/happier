import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LayoutChangeEvent } from 'react-native';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { useDesktopMainWindowContentReady } from './useDesktopMainWindowContentReady';

describe('main content readiness', () => {
    afterEach(() => vi.unstubAllGlobals());

    const layout = (width: number, height: number): LayoutChangeEvent => ({
        nativeEvent: { layout: { x: 0, y: 0, width, height } },
    } as LayoutChangeEvent);

    it('waits for a nonempty content layout and acknowledges it once', async () => {
        // The host bridge is the OS IPC boundary; the real host adapter runs underneath the hook.
        const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => false);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke, metadata: { currentWindow: { label: 'main' } } });
        const hook = await renderHook(useDesktopMainWindowContentReady);
        expect(invoke).not.toHaveBeenCalled();
        hook.getCurrent().onLayout(layout(0, 500));
        expect(invoke).not.toHaveBeenCalled();
        hook.getCurrent().onLayout(layout(800, 600));
        hook.getCurrent().onLayout(layout(900, 700));
        expect(invoke.mock.calls.map(([command]) => command)).toEqual(['desktop_main_window_content_rendered']);
    });

    it('leaves secondary windows with their own readiness owner', async () => {
        const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => false);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke, metadata: { currentWindow: { label: 'destination_session' } } });
        const hook = await renderHook(useDesktopMainWindowContentReady);
        hook.getCurrent().onLayout(layout(800, 600));
        expect(invoke).not.toHaveBeenCalled();
    });

    it('acknowledges content that already has a size when it is committed, without waiting for a layout event', async () => {
        // WebKit throttles rendering updates (ResizeObserver) and timers in a hidden window, so the
        // first onLayout may never arrive while main waits hidden for it. The committed node is the DOM
        // boundary here (the test DOM has no layout engine), so its measured size is supplied.
        const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => true);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke, metadata: { currentWindow: { label: 'main' } } });
        const hook = await renderHook(useDesktopMainWindowContentReady);
        hook.getCurrent().ref({ offsetWidth: 0, offsetHeight: 0 });
        expect(invoke).not.toHaveBeenCalled();
        hook.getCurrent().ref({ offsetWidth: 1280, offsetHeight: 800 });
        hook.getCurrent().onLayout(layout(1280, 800));
        expect(invoke.mock.calls.map(([command]) => command)).toEqual(['desktop_main_window_content_rendered']);
    });
});
