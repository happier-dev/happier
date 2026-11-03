import { type BrowserViewportV1 } from '@happier-dev/protocol';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { BROWSER_VIEWPORT_PRESETS, type BrowserViewportEmulationV1 } from '@happier-dev/protocol/browser/control/v1';

import type { BrowserSidecarCdpCommandScope, BrowserSidecarContextCaptureSurface } from './controlAdapter';

type View = Readonly<{ browserSessionId: string; viewId: string }>;
type Viewport = BrowserViewportV1;

export type BrowserViewportOwner = Readonly<{
    setViewport(view: View, viewport: Viewport, scope?: BrowserSidecarCdpCommandScope): Promise<void>;
    setEmulation(view: View, emulation: BrowserViewportEmulationV1, scope?: BrowserSidecarCdpCommandScope): Promise<void>;
    getViewport(view: View): Viewport | undefined;
    subscribe(listener: (view: View) => void): () => void;
    dispose(): void;
}>;

/** The admitted controlling viewer sets one page's metrics; passive viewers fit its picture. */
export function createBrowserViewportOwner(context: BrowserSidecarContextCaptureSurface): BrowserViewportOwner {
    const applied = new Map<string, Viewport>();
    const viewers = new Map<string, Viewport>();
    const emulations = new Map<string, BrowserViewportEmulationV1>();
    const chromeVersions = new Map<string, string>();
    const listeners = new Set<(view: View) => void>();
    const unsubscribe = context.subscribeViewLifecycle?.(event => {
        const key = browserViewKey(event);
        applied.delete(key); viewers.delete(key); emulations.delete(key); chromeVersions.delete(key);
    });
    const publish = (view: View, viewport: Viewport) => {
        applied.set(browserViewKey(view), viewport);
        for (const listener of listeners) listener(view);
    };
    async function apply(view: View, viewport: Viewport, emulation: BrowserViewportEmulationV1 | undefined, scope?: BrowserSidecarCdpCommandScope) {
        const handle = context.resolvePageHandle(view);
        if (!handle) throw new Error('capture_source_unavailable');
        const preset = emulation?.kind === 'preset' ? BROWSER_VIEWPORT_PRESETS[emulation.presetId] : undefined;
        const geometry = { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor };
        await context.transport.dispatchPageCommand({ ...handle, ...scope,
            method: 'Emulation.setDeviceMetricsOverride', params: { ...geometry, mobile: preset?.mobile ?? false } });
        publish(view, { ...geometry, ...(emulation ? { emulation } : {}) });
    }
    return {
        getViewport: view => applied.get(browserViewKey(view)),
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async setViewport(view, viewport, scope) {
            const key = browserViewKey(view);
            viewers.set(key, { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor });
            const emulation = emulations.get(key);
            if (emulation?.kind === 'preset') return;
            const previous = applied.get(key);
            if (previous?.width === viewport.width && previous.height === viewport.height
                && previous.deviceScaleFactor === viewport.deviceScaleFactor) return;
            await apply(view, viewport, emulation, scope);
        },
        async setEmulation(view, emulation, scope) {
            const handle = context.resolvePageHandle(view);
            if (!handle) throw new Error('capture_source_unavailable');
            const key = browserViewKey(view);
            // An explicit selection reapplies the whole policy: a failed prior transition may
            // have changed UA or touch before metrics failed. Resize deduplication stays above.
            const preset = emulation.kind === 'preset' ? BROWSER_VIEWPORT_PRESETS[emulation.presetId] : undefined;
            if (preset && 'model' in preset) {
                let version = chromeVersions.get(key);
                if (!version) {
                    const response = await context.transport.dispatchPageCommand({ ...handle, ...scope,
                        method: 'Runtime.evaluate', params: { expression: 'navigator.userAgent', returnByValue: true } });
                    const result = response && typeof response === 'object' && 'result' in response ? response.result : null;
                    const ua = result && typeof result === 'object' && 'value' in result ? result.value : null;
                    version = typeof ua === 'string' ? /(?:HeadlessChrome|Chrome)\/([\d.]+)/.exec(ua)?.[1] : undefined;
                    if (!version) throw new Error('capture_source_unavailable');
                    chromeVersions.set(key, version);
                }
                const major = version.split('.')[0];
                const brands = [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }];
                await context.transport.dispatchPageCommand({ ...handle, ...scope, method: 'Emulation.setUserAgentOverride', params: {
                    userAgent: `Mozilla/5.0 (Linux; Android ${preset.androidVersion}; ${preset.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}${preset.mobileUserAgent ? ' Mobile' : ''} Safari/537.36`,
                    platform: 'Linux armv8l', userAgentMetadata: { brands,
                        fullVersionList: brands.map(brand => ({ ...brand, version })), fullVersion: version,
                        platform: 'Android', platformVersion: preset.androidVersion, architecture: '', model: preset.model,
                        mobile: preset.mobileUserAgent, bitness: '', wow64: false },
                } });
            } else {
                // An empty UA clears CDP's override, restoring the engine's ordinary UA and client hints.
                await context.transport.dispatchPageCommand({ ...handle, ...scope,
                    method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } });
            }
            await context.transport.dispatchPageCommand({ ...handle, ...scope,
                method: 'Emulation.setTouchEmulationEnabled', params: preset?.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false } });
            const viewport = preset ?? viewers.get(key);
            if (viewport) await apply(view, viewport, emulation, scope);
            else {
                await context.transport.dispatchPageCommand({ ...handle, ...scope, method: 'Emulation.clearDeviceMetricsOverride' });
                applied.delete(key);
                for (const listener of listeners) listener(view);
            }
            emulations.set(key, emulation);
        },
        dispose() { unsubscribe?.(); applied.clear(); viewers.clear(); emulations.clear(); chromeVersions.clear(); listeners.clear(); },
    };
}
