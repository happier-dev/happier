import { describe, expect, it, vi } from 'vitest';

import type { AnnotationCropClip } from './annotationCropGeometry';
import type { BrowserAnnotationCaptureRequest } from './types';

const dispatchBrowserContextActionViaMachineRpc = vi.hoisted(() => vi.fn());

vi.mock('./machineRpc', () => ({
    dispatchBrowserContextActionViaMachineRpc,
}));

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
    it('sends viewport crop geometry so the daemon CDP producer can apply live scroll/DPR', async () => {
        const { createManagedChromiumBrowserAnnotationCaptureProvider } = await import('./managedChromiumAnnotationProvider');
        dispatchBrowserContextActionViaMachineRpc.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
        const provider = createManagedChromiumBrowserAnnotationCaptureProvider({ machineId: 'machine_1', serverId: 'server_1' });

        const cropClip = {
            status: 'clip',
            cssViewportRect: { x: 40, y: 60, width: 100, height: 80 },
            cssPageRect: { x: 40, y: 560, width: 100, height: 80 },
            devicePageRect: { x: 80, y: 1_120, width: 200, height: 160 },
            scale: 2,
        } as unknown as AnnotationCropClip;
        await provider.captureAnnotation({ ...request, cropClip });

        expect(dispatchBrowserContextActionViaMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
            serverId: 'server_1',
            actionId: 'browser.context.annotation.captureRegion',
            input: expect.objectContaining({
                rect: {
                    x: 40,
                    y: 60,
                    width: 100,
                    height: 80,
                    coordinateSpace: 'viewport',
                },
            }),
        }));
    });
});
