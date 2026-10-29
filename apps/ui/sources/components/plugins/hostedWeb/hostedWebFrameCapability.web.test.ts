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
        // Each case represents a fresh physical host, including unavailable hosts.
        vi.resetModules();
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

    it('detects once for 66 plugins across 148 Machines and subsequent projection reads', async () => {
        const appendChild = vi.fn();
        const removeChild = vi.fn();
        const createElement = vi.fn(() => ({ nodeName: 'IFRAME', contentWindow: {}, setAttribute: vi.fn() }));
        Object.defineProperty(globalThis, 'document', { configurable: true, value: {
            body: { appendChild, removeChild }, createElement,
        } });
        const { resolveHostedWebFrameCapability } = await import('./hostedWebFrameCapability.web');
        const startup = await Promise.all(Array.from({ length: 148 * 66 }, () => resolveHostedWebFrameCapability()));
        const current = startup[0];
        expect(current).toEqual({ platform: 'web', adapter: 'domIframe' });
        const rereads = [];
        for (let render = 0; render < 157; render++) rereads.push(await resolveHostedWebFrameCapability());
        expect.soft(createElement).toHaveBeenCalledTimes(1);
        expect.soft(appendChild).toHaveBeenCalledTimes(1);
        expect.soft(removeChild).toHaveBeenCalledTimes(1);
        expect([...startup, ...rereads].every(value => value === current)).toBe(true);
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

        vi.resetModules();
        const unavailableHost = await import('./hostedWebFrameCapability.web');
        hostedArtifactNativeCapability.invoke.mockResolvedValueOnce({
            kind: 'unavailable',
            code: 'desktop_hosted_artifact_wayland_gtk_container_unimplemented',
        });
        expect(await unavailableHost.resolveHostedWebFrameCapability()).toBeNull();

        vi.resetModules();
        const malformedHost = await import('./hostedWebFrameCapability.web');
        hostedArtifactNativeCapability.invoke.mockResolvedValueOnce({
            kind: 'available',
            capability: { platform: 'desktop', adapter: 'wry', unexpected: true },
        });
        expect(await malformedHost.resolveHostedWebFrameCapability()).toBeNull();

        vi.resetModules();
        const missingHost = await import('./hostedWebFrameCapability.web');
        hostedArtifactNativeCapability.invoke.mockRejectedValueOnce(new Error('native command unavailable'));
        expect(await missingHost.resolveHostedWebFrameCapability()).toBeNull();
        expect(createElement).not.toHaveBeenCalled();
    });

    it.each([true, false])('shares one in-flight desktop probe including an available=%s answer', async (available) => {
        hostRuntime.tauriDesktop = true;
        hostedArtifactNativeCapability.invoke.mockResolvedValue(available
            ? { kind: 'available', capability: { platform: 'desktop', adapter: 'wry' } }
            : { kind: 'unavailable', code: 'desktop_hosted_artifact_wayland_gtk_container_unimplemented' });
        const { resolveHostedWebFrameCapability } = await import('./hostedWebFrameCapability.web');
        const values = await Promise.all(Array.from({ length: 148 }, () => resolveHostedWebFrameCapability()));
        expect(values[0]).toEqual(available ? { platform: 'desktop', adapter: 'wry' } : null);
        expect(values.every(value => value === values[0])).toBe(true);
        expect(await resolveHostedWebFrameCapability()).toBe(values[0]);
        expect(hostedArtifactNativeCapability.invoke).toHaveBeenCalledTimes(available ? 1 : 2);
    });

    it('rechecks a failed desktop probe on the next demand, sharing recovery and retaining success', async () => {
        hostRuntime.tauriDesktop = true;
        hostedArtifactNativeCapability.invoke.mockRejectedValueOnce(new Error('IPC temporarily unavailable'));
        const { resolveHostedWebFrameCapability } = await import('./hostedWebFrameCapability.web');
        const unavailable = await Promise.all(Array.from({ length: 148 }, () => resolveHostedWebFrameCapability()));
        expect(unavailable.every(value => value === null)).toBe(true);
        expect(hostedArtifactNativeCapability.invoke).toHaveBeenCalledTimes(1);

        hostedArtifactNativeCapability.invoke.mockResolvedValue({
            kind: 'available', capability: { platform: 'desktop', adapter: 'wry' },
        });
        const recovered = await Promise.all(Array.from({ length: 148 }, () => resolveHostedWebFrameCapability()));
        expect(recovered[0]).toEqual({ platform: 'desktop', adapter: 'wry' });
        expect(recovered.every(value => value === recovered[0])).toBe(true);
        expect(await resolveHostedWebFrameCapability()).toBe(recovered[0]);
        expect(hostedArtifactNativeCapability.invoke).toHaveBeenCalledTimes(2);
    });

    it('waits for a physical DOM before detecting the host', async () => {
        Reflect.deleteProperty(globalThis, 'document');
        const { resolveHostedWebFrameCapability } = await import('./hostedWebFrameCapability.web');
        expect(await resolveHostedWebFrameCapability()).toBeNull();
        const appendChild = vi.fn();
        Object.defineProperty(globalThis, 'document', { configurable: true, value: {
            body: { appendChild, removeChild: vi.fn() },
            createElement: () => ({ nodeName: 'IFRAME', contentWindow: {}, setAttribute: vi.fn() }),
        } });
        expect(await resolveHostedWebFrameCapability()).toEqual({ platform: 'web', adapter: 'domIframe' });
        expect(appendChild).toHaveBeenCalledTimes(1);
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
