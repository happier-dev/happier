import { BrowserEditableTargetV1Schema, type BrowserEditableTargetV1, type BrowserInputEventV1, type BrowserViewportV1 } from '@happier-dev/protocol';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { BROWSER_VIEWPORT_PRESETS, type BrowserViewportEmulationV1 } from '@happier-dev/protocol/browser/control/v1';

import type { BrowserSidecarCdpCommandScope, BrowserSidecarContextCaptureSurface } from './controlAdapter';

type View = Readonly<{ browserSessionId: string; viewId: string }>;
type Viewport = BrowserViewportV1;
type Point = Pick<Extract<BrowserInputEventV1, { kind: 'editableProbe' }>, 'x' | 'y'>;

export type BrowserViewportOwner = Readonly<{
    setViewport(view: View, viewport: Viewport, scope?: BrowserSidecarCdpCommandScope): Promise<void>;
    setEmulation(view: View, emulation: BrowserViewportEmulationV1, scope?: BrowserSidecarCdpCommandScope): Promise<void>;
    getViewport(view: View): Viewport | undefined;
    subscribe(listener: (view: View) => void): () => void;
    probeEditableAtPoint(view: View, point: Point, scope?: BrowserSidecarCdpCommandScope): Promise<BrowserEditableTargetV1>;
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
        async probeEditableAtPoint(view, point, scope) {
            const handle = context.resolvePageHandle(view);
            if (!handle) throw new Error('capture_source_unavailable');
            const response = await context.transport.dispatchPageCommand({ ...handle, ...scope,
                method: 'Runtime.evaluate', params: { returnByValue: true, expression: `(() => {
                    let el = document.elementFromPoint(${JSON.stringify(point.x)} * innerWidth, ${JSON.stringify(point.y)} * innerHeight);
                    while (el && el.shadowRoot && el.shadowRoot.elementFromPoint) {
                        const inner = el.shadowRoot.elementFromPoint(${JSON.stringify(point.x)} * innerWidth, ${JSON.stringify(point.y)} * innerHeight);
                        if (!inner || inner === el) break;
                        el = inner;
                    }
                    if (!el) return { editable: false };
                    const input = el instanceof HTMLInputElement;
                    const textarea = el instanceof HTMLTextAreaElement;
                    if (el.matches(':disabled') || el.readOnly) return { editable: false };
                    if (!textarea && !el.isContentEditable && !(input && ['text', 'search', 'tel', 'url', 'email', 'password', 'number'].includes(el.type))) {
                        return { editable: false };
                    }
                    const mode = el.inputMode;
                    const inputMode = ['none', 'text', 'tel', 'url', 'email', 'numeric', 'decimal', 'search'].includes(mode) ? mode
                        : input && ['tel', 'url', 'email', 'search'].includes(el.type) ? el.type
                        : input && el.type === 'number' ? 'decimal' : 'text';
                    const security = getComputedStyle(el).getPropertyValue('-webkit-text-security');
                    return { editable: true, inputMode, multiline: textarea || !!el.isContentEditable,
                        secret: input && el.type === 'password' || !!security && security !== 'none' };
                })()` } });
            const value = response && typeof response === 'object' && 'result' in response ? response.result : undefined;
            const result = value && typeof value === 'object' && 'value' in value ? value.value : undefined;
            return BrowserEditableTargetV1Schema.parse(result);
        },
        dispose() { unsubscribe?.(); applied.clear(); viewers.clear(); emulations.clear(); chromeVersions.clear(); listeners.clear(); },
    };
}
