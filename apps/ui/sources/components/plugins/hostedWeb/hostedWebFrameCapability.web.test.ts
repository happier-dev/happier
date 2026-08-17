import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hostRuntime = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android',
    tauriDesktop: false,
}));
const desktopNativeAvailability = vi.hoisted(() => ({
    platform: 'macos' as 'macos' | 'windows' | 'linuxX11',
    available: true,
    read: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return hostRuntime.platform;
        },
    },
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => hostRuntime.tauriDesktop,
}));

vi.mock('@/sync/domains/browser/adapters/desktopWebViewBridge', () => ({
    readDesktopWebViewNativeAvailability: () => desktopNativeAvailability.read(),
}));

describe('hosted web frame capability', () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

    beforeEach(() => {
        hostRuntime.platform = 'web';
        hostRuntime.tauriDesktop = false;
        desktopNativeAvailability.platform = 'macos';
        desktopNativeAvailability.available = true;
        desktopNativeAvailability.read.mockReset();
        desktopNativeAvailability.read.mockImplementation(async () => ({
            platform: desktopNativeAvailability.platform,
            available: desktopNativeAvailability.available,
        }));
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

    it('reports direct Wry only when the incumbent native platform fact confirms macOS', async () => {
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

        desktopNativeAvailability.platform = 'windows';
        expect(await resolveHostedWebFrameCapability()).toBeNull();

        desktopNativeAvailability.platform = 'linuxX11';
        expect(await resolveHostedWebFrameCapability()).toBeNull();

        desktopNativeAvailability.platform = 'macos';
        desktopNativeAvailability.available = false;
        expect(await resolveHostedWebFrameCapability()).toEqual({
            platform: 'desktop',
            adapter: 'wry',
        });
        expect(desktopNativeAvailability.read).toHaveBeenCalledTimes(3);
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
