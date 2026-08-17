import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeRuntime = vi.hoisted(() => ({
    platform: 'ios' as 'ios' | 'android' | 'web',
    adapterAvailable: true,
}));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return nativeRuntime.platform;
        },
    },
}));

vi.mock('./HostedArtifactFrame.native', () => ({
    isHostedArtifactFrameNativeAdapterAvailable: () => nativeRuntime.adapterAvailable,
}));

describe('native hosted web frame capability', () => {
    beforeEach(() => {
        nativeRuntime.platform = 'ios';
        nativeRuntime.adapterAvailable = true;
    });

    it('reports only the exact physical native adapter confirmed by the incumbent Artifact frame', async () => {
        const { resolveHostedWebFrameCapability } = await import('./hostedWebFrameCapability.native');

        expect(resolveHostedWebFrameCapability()).toEqual({
            platform: 'ios',
            adapter: 'WKWebView',
        });

        nativeRuntime.platform = 'android';
        expect(resolveHostedWebFrameCapability()).toEqual({
            platform: 'android',
            adapter: 'WebViewAssetLoader',
        });

        nativeRuntime.adapterAvailable = false;
        expect(resolveHostedWebFrameCapability()).toBeNull();

        nativeRuntime.platform = 'web';
        nativeRuntime.adapterAvailable = true;
        expect(resolveHostedWebFrameCapability()).toBeNull();
    });
});
