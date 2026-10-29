import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeRuntime = vi.hoisted(() => ({
    platform: 'ios' as 'ios' | 'android' | 'web',
    adapterAvailable: true,
    adapterProbes: 0,
}));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return nativeRuntime.platform;
        },
    },
}));

vi.mock('./HostedArtifactFrame.native', () => ({
    // Physical native-module/view availability is the platform boundary.
    isHostedArtifactFrameNativeAdapterAvailable: () => {
        nativeRuntime.adapterProbes++;
        return nativeRuntime.adapterAvailable;
    },
}));

describe('native hosted web frame capability', () => {
    beforeEach(() => {
        vi.resetModules();
        nativeRuntime.platform = 'ios';
        nativeRuntime.adapterAvailable = true;
        nativeRuntime.adapterProbes = 0;
    });

    it('reports only the exact physical native adapter confirmed by the incumbent Artifact frame', async () => {
        const { resolveHostedWebFrameCapability } = await import('./hostedWebFrameCapability.native');

        expect(resolveHostedWebFrameCapability()).toEqual({
            platform: 'ios',
            adapter: 'WKWebView',
        });

        nativeRuntime.platform = 'android';
        vi.resetModules();
        const android = await import('./hostedWebFrameCapability.native');
        expect(android.resolveHostedWebFrameCapability()).toEqual({
            platform: 'android',
            adapter: 'WebViewAssetLoader',
        });

        nativeRuntime.adapterAvailable = false;
        vi.resetModules();
        const unavailable = await import('./hostedWebFrameCapability.native');
        expect(unavailable.resolveHostedWebFrameCapability()).toBeNull();

        nativeRuntime.platform = 'web';
        nativeRuntime.adapterAvailable = true;
        expect(resolveHostedWebFrameCapability()).toBeNull();
    });

    it.each(['ios', 'android'] as const)('detects the %s host once across fleet projection reads', async (platform) => {
        nativeRuntime.platform = platform;
        const { resolveHostedWebFrameCapability } = await import('./hostedWebFrameCapability.native');
        const initial = resolveHostedWebFrameCapability();
        for (let read = 0; read < 148 * 66; read++) resolveHostedWebFrameCapability();
        expect.soft(nativeRuntime.adapterProbes).toBe(1);
        expect(resolveHostedWebFrameCapability()).toBe(initial);
    });
});
