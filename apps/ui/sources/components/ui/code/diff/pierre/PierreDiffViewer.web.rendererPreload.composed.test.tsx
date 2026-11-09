// @vitest-environment jsdom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storageStore';
import { BrowserWorker } from './pierreWorkerTestHelpers';
import { DiffViewer } from '../DiffViewer.web';
import { usePierreDiffRendererPreload } from './pierreRendererLoader.web';
import { getPierreDiffWorkerPool } from './pierreWorkerPool.web';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

function List(props: Readonly<{ diff: string | null }>) {
    usePierreDiffRendererPreload(true);
    return props.diff === null ? null
        : <DiffViewer mode="unified" filePath="auth.txt" virtualized={false} unifiedDiff={props.diff} />;
}

it('draws a diff that arrives after its list mounted once, with Pierre, instead of every line through the fallback first', async () => {
    // The browser Worker is the boundary; the lazy chunk, pool, renderer selection and both renderers stay real.
    BrowserWorker.reset();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('Worker', BrowserWorker);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
    const replaceSync = Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, 'replaceSync');
    Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', { configurable: true, value() {} });
    const settings = storage.getState().settings;
    storage.setState({ settings: { ...settings, filesDiffPresentationStyle: 'unified', filesDiffRendererMode: 'pierre' } });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    // Every line the fallback draws lands in the light DOM; Pierre draws inside its shadow root.
    let fallbackLineDraws = 0;
    const observer = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
            if ((node.textContent ?? '').includes('newValue')) fallbackLineDraws += 1;
        }
    });
    observer.observe(host, { childList: true, subtree: true });
    try {
        // The list mounts while its rows (and their diffs) are still loading.
        await React.act(async () => root.render(<List diff={null} />));
        // The list itself started the renderer's worker (the probe plus the pool's worker); only then ask for the pool.
        await vi.waitFor(() => expect(BrowserWorker.instances.length, 'the list prepares the Pierre worker').toBeGreaterThan(1));
        await vi.waitFor(() => expect(getPierreDiffWorkerPool({ style: 'unified' })?.isInitialized()).toBe(true));
        await React.act(async () => root.render(<List diff={'--- a/auth.txt\n+++ b/auth.txt\n@@ -1 +1 @@\n-oldValue\n+newValue\n'} />));
        await vi.waitFor(() => expect(host.querySelector('diffs-container')?.shadowRoot?.textContent).toContain('newValue'));
        expect(fallbackLineDraws, 'the arriving diff draws once, with Pierre').toBe(0);
    } finally {
        observer.disconnect();
        await React.act(async () => root.unmount());
        getPierreDiffWorkerPool({ style: 'unified' })?.terminate();
        host.remove();
        storage.setState({ settings });
        if (replaceSync) Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', replaceSync);
        else Reflect.deleteProperty(CSSStyleSheet.prototype, 'replaceSync');
        BrowserWorker.reset();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    }
});
