import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createBrowserViewState, openBrowserTarget } from '@/sync/domains/browser/store';
import { resolveBrowserTargetOpenOptions } from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import { createLocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { useDesktopWebViewNativeAvailability } from './useDesktopWebViewNativeAvailability';

// Native host document-start payload and invocation are the actual process boundary.
const nativeAvailability = {
    available: true, platform: 'macos', primitive: 'macosNsViewWebKit',
    renderEngine: 'desktopWebView', producer: 'tauriWryNativeChildView', privilegedIpc: false,
    supports: { navigation: true, goBackForward: true, reload: true, stop: true,
        pageInfoDiagnostics: true, nativeDevtools: true, capture: true, recording: false, automation: true },
    disabledReasons: [],
};

afterEach(async () => {
    await standardCleanup();
    vi.unstubAllGlobals();
});

describe('desktop browser launch availability', () => {
    it.each([false, true])('admits a Services preview natively through the real open resolver (snapshot: %s) without a probe', async (withSnapshot) => {
        const invoke = vi.fn(() => new Promise(() => {}));
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        vi.stubGlobal('__HAPPIER_DESKTOP_BROWSER_AVAILABILITY__', nativeAvailability);
        const engines: string[] = [];
        const hook = await renderHook(() => {
            const availability = useDesktopWebViewNativeAvailability({ platform: 'desktop' });
            const target = {
                kind: 'localServicePreview', targetId: 'plugin-service', machineId: 'machine',
                display: { title: 'Plugin service' },
            } as const;
            const state = openBrowserTarget(createBrowserViewState(), target, resolveBrowserTargetOpenOptions({
                target, browserSessionId: 'services', platform: 'desktop', desktopWebViewAvailability: availability,
                ...(withSnapshot ? { localServicePreviewState: createLocalServicePreviewState() } : {}),
            }));
            engines.push(Object.values(state.viewsById)[0]!.engineKind);
            return availability;
        });
        expect(engines).toEqual(['desktopWebView']);
        expect(hook.getCurrent()?.available).toBe(true);
        await hook.rerender();
        expect(engines.every(engine => engine === 'desktopWebView')).toBe(true);
        expect(invoke).not.toHaveBeenCalled();
    });

    it('keeps an explicit native-unavailable launch fact final without probing', async () => {
        const { unavailableDesktopWebViewNativeAvailability } = await import('./desktopWebView');
        const unavailable = unavailableDesktopWebViewNativeAvailability('desktop_webview_wayland_gtk_unimplemented');
        const invoke = vi.fn(async () => nativeAvailability);
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        vi.stubGlobal('__HAPPIER_DESKTOP_BROWSER_AVAILABILITY__', unavailable);
        const values: unknown[] = [];
        await renderHook(() => {
            const value = useDesktopWebViewNativeAvailability({ platform: 'desktop' });
            values.push(value);
            return value;
        });
        expect(values).toHaveLength(1);
        expect(values[0]).toEqual(unavailable);
        expect(invoke).not.toHaveBeenCalled();
    });
});
