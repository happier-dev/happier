import { describe, expect, it, vi } from 'vitest';
import { BrowserContextItemV1Schema } from '@happier-dev/protocol/browser/context/v1';

import type { BrowserAnnotationCaptureRequest } from './types';

const machineRpc = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({ downloadDaemonWorkspaceFileToDestination: download }));

// Network facade only: the real browser RPC request and strict response owners remain in path.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpc,
}));

const screenshotFacts = {
    v: 1, contextId: 'captured_viewport', sourceViewId: 'view_1', sourceAdapterKind: 'chromiumSidecar',
    fidelity: 'cdp', navigationGeneration: 2, lifecycleState: 'available', redactionLevel: 'none',
} as const;

const request: BrowserAnnotationCaptureRequest = {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 2,
    capturedAtMs: 1_000,
    adapterKind: 'chromiumSidecar',
    browserTarget: { kind: 'externalUrl', url: 'https://example.test', targetId: 'target_1' },
    currentUrl: 'https://example.test/page',
    title: 'Example',
    securityOrigin: 'https://example.test',
};

describe('managed Chromium browser annotation capture provider', () => {
    it.each(['session', 'daemon'] as const)('reads a %s PNG once from its storage scope and releases its canvas-safe preview', async (storage) => {
        const { createManagedChromiumBrowserAnnotationCaptureProvider } = await import('./managedChromiumAnnotationProvider');
        machineRpc.mockClear();
        download.mockReset();
        machineRpc.mockResolvedValueOnce({ protocolVersion: 1, result: BrowserContextItemV1Schema.parse({ ...screenshotFacts,
            kind: 'browserScreenshot', capturedAtMs: 1000, media: { mediaId: 'original', mediaKind: 'image',
                width: 1200, height: 800, sizeBytes: 4, file: { sessionId: 'browser_session_1', storage,
                    path: '/captures/source.png', mimeType: 'image/png', sha256: 'a'.repeat(64) } },
            viewport: { width: 600, height: 400 },
        }) });
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:frozen-browser');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        download.mockImplementationOnce(async ({ destination }) => {
            await destination.writeBytes(new Uint8Array([137, 80, 78, 71]));
            await destination.close();
            return { ok: true };
        });
        const provider = createManagedChromiumBrowserAnnotationCaptureProvider({ machineId: 'machine_1', serverId: 'server_1',
            previewScope: { machineId: 'machine_1', serverId: 'server_1', rootPath: '/workspace' },
            machineHappyHomeDir: '/machine-home' });
        try {
            const result = await provider.captureViewport!(request);
            expect(result).toMatchObject({ status: 'captured', source: { uri: 'data:image/png;base64,iVBORw==', width: 1200, height: 800, scale: 2 } });
            expect(machineRpc).toHaveBeenCalledTimes(1);
            expect(download).toHaveBeenCalledTimes(1);
            expect(download).toHaveBeenCalledWith(expect.objectContaining({
                machineId: 'machine_1', serverId: 'server_1', rootPath: storage === 'daemon' ? '/machine-home' : '/workspace',
            }));
            expect(revokeObjectURL).toHaveBeenCalledWith('blob:frozen-browser');
        } finally { createObjectURL.mockRestore(); revokeObjectURL.mockRestore(); }
    });
    it('settles without recapturing when the invoking Session preview workspace is unavailable', async () => {
        const { createManagedChromiumBrowserAnnotationCaptureProvider } = await import('./managedChromiumAnnotationProvider');
        machineRpc.mockClear();
        machineRpc.mockResolvedValueOnce({ protocolVersion: 1, result: BrowserContextItemV1Schema.parse({ ...screenshotFacts,
            kind: 'browserScreenshot', capturedAtMs: 1000, media: { mediaId: 'original', mediaKind: 'image',
                width: 1200, height: 800, sizeBytes: 4, file: { sessionId: 'browser_session_1', storage: 'session',
                    path: '/captures/source.png', mimeType: 'image/png', sha256: 'a'.repeat(64) } },
            viewport: { width: 600, height: 400 },
        }) });
        const provider = createManagedChromiumBrowserAnnotationCaptureProvider({ machineId: 'machine_1', serverId: 'server_1' });
        // A screenshot without its invoking Session workspace settles visibly; it is never captured again.
        expect(await provider.captureViewport!(request)).toMatchObject({ status: 'unavailable', reason: {
            reasonCode: 'browser_context_annotation_capture_failed',
        } });
        expect(machineRpc).toHaveBeenCalledTimes(1);
        expect(machineRpc).toHaveBeenLastCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ actionId: 'browser.context.captureScreenshot' }),
        }));
    });
    it('does not acquire pixels when the capture producer omits its viewport geometry', async () => {
        const { createManagedChromiumBrowserAnnotationCaptureProvider } = await import('./managedChromiumAnnotationProvider');
        machineRpc.mockClear();
        download.mockClear();
        machineRpc.mockResolvedValueOnce({ protocolVersion: 1, result: BrowserContextItemV1Schema.parse({ ...screenshotFacts,
            kind: 'browserScreenshot', capturedAtMs: 1000, media: { mediaId: 'original', mediaKind: 'image',
                width: 1200, height: 800, sizeBytes: 4, file: { sessionId: 'browser_session_1', storage: 'session',
                    path: '/captures/source.png', mimeType: 'image/png', sha256: 'a'.repeat(64) } },
        }) });
        const provider = createManagedChromiumBrowserAnnotationCaptureProvider({ machineId: 'machine_1', serverId: 'server_1',
            previewScope: { machineId: 'machine_1', serverId: 'server_1', rootPath: '/workspace' } });
        expect(await provider.captureViewport!(request)).toMatchObject({ status: 'unavailable' });
        expect(machineRpc).toHaveBeenCalledTimes(1);
        expect(download).not.toHaveBeenCalled();
    });
    it('does not read daemon captures through the Session workspace when Machine home metadata is absent', async () => {
        const { createManagedChromiumBrowserAnnotationCaptureProvider } = await import('./managedChromiumAnnotationProvider');
        machineRpc.mockClear();
        download.mockClear();
        machineRpc.mockResolvedValueOnce({ protocolVersion: 1, result: BrowserContextItemV1Schema.parse({ ...screenshotFacts,
            kind: 'browserScreenshot', capturedAtMs: 1000, media: { mediaId: 'original', mediaKind: 'image',
                width: 1200, height: 800, sizeBytes: 4, file: { sessionId: 'browser_session_1', storage: 'daemon',
                    path: 'browser/captures/source.png', mimeType: 'image/png', sha256: 'a'.repeat(64) } },
            viewport: { width: 600, height: 400 },
        }) });
        download.mockImplementationOnce(async ({ destination }) => {
            await destination.writeBytes(new Uint8Array([137, 80, 78, 71]));
            await destination.close();
            return { ok: true };
        });
        const provider = createManagedChromiumBrowserAnnotationCaptureProvider({ machineId: 'machine_1', serverId: 'server_1',
            previewScope: { machineId: 'machine_1', serverId: 'server_1', rootPath: '/workspace' } });
        const result = await provider.captureViewport!(request);
        if (result.status === 'captured') await result.dispose?.();
        expect(result).toMatchObject({ status: 'unavailable' });
        expect(download).not.toHaveBeenCalled();
    });
});
