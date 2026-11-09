import * as React from 'react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { BrowserWorker } from './pierreWorkerTestHelpers';

const WorkerErrorEvent = globalThis.Event;
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Only external DOM paint is replaced; the real pool, subscription, adapter and fallback run.
vi.mock('@pierre/diffs/react', async importOriginal => {
    const actual = await importOriginal<typeof import('@pierre/diffs/react')>();
    return { ...actual, FileDiff: (props: React.ComponentProps<typeof actual.FileDiff>) => React.createElement('pierre-file-diff', props) };
});

// Install the DOM boundary before collecting the real renderer graph. Cold
// module evaluation is setup, rather than part of the worker-failure deadline.
const browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
vi.stubGlobal('customElements', browser.window.customElements);
const { PierreDiffViewer } = await import('./PierreDiffViewer.web');
const { HappierUnifiedDiffViewer } = await import('../happier/HappierUnifiedDiffViewer');
afterAll(() => browser.restore());

describe('Pierre mounted worker recovery', () => {
    it('replaces a mounted failed-worker diff with the real Happier renderer', async () => {
        browser.activate();
        vi.stubGlobal('customElements', browser.window.customElements);
        BrowserWorker.reset();
        vi.stubGlobal('Worker', BrowserWorker);
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        try {
            const screen = await renderScreen(<PierreDiffViewer mode="unified" filePath="a.txt"
                unifiedDiff={'--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n'} />);
            expect(screen.findAllByType('pierre-file-diff')).toHaveLength(1);
            const worker = BrowserWorker.instances.find(instance => !instance.terminated);
            expect(worker).toBeTruthy();
            const { act } = await import('react-test-renderer');
            await act(async () => { worker!.dispatchEvent(new WorkerErrorEvent('error', { cancelable: true })); });
            expect(screen.findAllByType('pierre-file-diff')).toHaveLength(0);
            const fallbackType = Reflect.get(HappierUnifiedDiffViewer, 'type') ?? HappierUnifiedDiffViewer;
            expect(screen.findAllByType(fallbackType)).toHaveLength(1);
            expect(debug).toHaveBeenCalledTimes(1);
        } finally {
            standardCleanup();
            debug.mockRestore();
            vi.unstubAllGlobals();
        }
    });
});
