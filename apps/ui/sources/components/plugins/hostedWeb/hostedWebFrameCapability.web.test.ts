import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hostRuntime = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android',
    tauriDesktop: false,
}));
const hostedArtifactNativeCapability = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return hostRuntime.platform;
        },
    },
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => hostRuntime.tauriDesktop,
    invokeDesktopHost: (command: string, args?: Record<string, unknown>) => args === undefined
        ? hostedArtifactNativeCapability.invoke(command)
        : hostedArtifactNativeCapability.invoke(command, args),
}));

describe('hosted web frame capability', () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

    beforeEach(() => {
        hostRuntime.platform = 'web';
        hostRuntime.tauriDesktop = false;
        hostedArtifactNativeCapability.invoke.mockReset();
    });

    afterEach(() => {
        if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
        else Reflect.deleteProperty(globalThis, 'document');
    });

    it('reports the exact capability only after the active browser DOM creates an iframe', async () => {
        const appendChild = vi.fn();
        const removeChild = vi.fn();
        const setAttribute = vi.fn();
        const frame = {
            nodeName: 'IFRAME',
            contentWindow: {},
            setAttribute,
        };
        const createElement = vi.fn(() => frame);
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: {
                body: { appendChild, removeChild },
                createElement,
            },
        });
        const { resolveHostedWebFrameCapability } = await import('./hostedWebFrameCapability.web');

        expect(await resolveHostedWebFrameCapability()).toEqual({
            platform: 'web',
            adapter: 'domIframe',
        });
        expect(createElement).toHaveBeenCalledWith('iframe');
        expect(setAttribute).toHaveBeenCalledWith('sandbox', '');
        expect(appendChild).toHaveBeenCalledWith(frame);
        expect(removeChild).toHaveBeenCalledWith(frame);
    });

    it('reports direct Wry only when the native hosted-Artifact owner confirms its exact adapter', async () => {
        const { resolveHostedWebFrameCapability } = await import('./hostedWebFrameCapability.web');
        Reflect.deleteProperty(globalThis, 'document');

        const createElement = vi.fn();
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: {
                body: {},
                createElement,
            },
        });
        hostRuntime.tauriDesktop = true;

        // The command is the native hosted-Artifact transport's fact. It
        // intentionally contains no UI-side OS policy, so the same strict
        // capability represents an exact Windows or Linux/X11 direct-Wry row
        // once that native owner has admitted it.
        hostedArtifactNativeCapability.invoke.mockResolvedValueOnce({
            kind: 'available',
            capability: { platform: 'desktop', adapter: 'wry' },
        });
        expect(await resolveHostedWebFrameCapability()).toEqual({
            platform: 'desktop',
            adapter: 'wry',
        });
        expect(hostedArtifactNativeCapability.invoke).toHaveBeenCalledExactlyOnceWith(
            'desktop_hosted_artifact_get_frame_capability',
        );

        hostedArtifactNativeCapability.invoke.mockResolvedValueOnce({
            kind: 'unavailable',
            code: 'desktop_hosted_artifact_platform_frame_unproved',
        });
        expect(await resolveHostedWebFrameCapability()).toBeNull();

        hostedArtifactNativeCapability.invoke.mockResolvedValueOnce({
            kind: 'available',
            capability: { platform: 'desktop', adapter: 'wry', unexpected: true },
        });
        expect(await resolveHostedWebFrameCapability()).toBeNull();

        hostedArtifactNativeCapability.invoke.mockRejectedValueOnce(new Error('native command unavailable'));
        expect(await resolveHostedWebFrameCapability()).toBeNull();
        expect(createElement).not.toHaveBeenCalled();
    });

    it('does not infer readiness from DOM source presence or a non-web platform', async () => {
        const appendChild = vi.fn();
        const removeChild = vi.fn();
        const createElement = vi.fn(() => ({
            nodeName: 'IFRAME',
            contentWindow: null,
            setAttribute: vi.fn(),
        }));
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: {
                body: { appendChild, removeChild },
                createElement,
            },
        });
        const { resolveHostedWebFrameCapability } = await import('./hostedWebFrameCapability.web');

        expect(await resolveHostedWebFrameCapability()).toBeNull();
        expect(appendChild).toHaveBeenCalledTimes(1);
        expect(removeChild).toHaveBeenCalledTimes(1);

        createElement.mockClear();
        hostRuntime.platform = 'ios';
        expect(await resolveHostedWebFrameCapability()).toBeNull();
        expect(createElement).not.toHaveBeenCalled();
    });
});
