import { afterEach, describe, expect, it, vi } from 'vitest';

// Desktop IPC is the external system boundary; the adapter and its normalization stay real.
const host = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), isDesktop: vi.fn() }));
vi.mock('@/utils/platform/desktopHost', () => ({
    invokeDesktopHost: host.invoke,
    listenDesktopHostEvent: host.listen,
    isDesktopHost: host.isDesktop,
}));

const live = { supported: true, materialLive: true, reduceTransparency: false, highContrast: false, windowActive: true };

describe('desktop glass material', () => {
    afterEach(() => {
        vi.resetAllMocks();
        vi.resetModules();
    });

    it('reports the native effect outcome and retains high contrast as a diagnostic', async () => {
        host.isDesktop.mockReturnValue(true);
        host.invoke.mockResolvedValue({ ...live, highContrast: true });
        const { applyDesktopGlassMaterial } = await import('./desktopGlassMaterial');
        await expect(applyDesktopGlassMaterial({ enabled: true, blur: 'strong' })).resolves.toEqual({ ...live, highContrast: true });
        expect(host.invoke).toHaveBeenCalledWith('desktop_apply_glass_material', { enabled: true, blur: 'strong' });
    });

    it('never treats refused, malformed, reduced-transparency or inactive effects as live', async () => {
        host.isDesktop.mockReturnValue(true);
        const { readDesktopGlassState } = await import('./desktopGlassMaterial');
        for (const payload of [
            { ...live, materialLive: false },
            { ...live, reduceTransparency: true },
            { ...live, windowActive: false },
            { ...live, supported: false },
            { ...live, materialLive: 'true' },
        ]) {
            host.invoke.mockResolvedValue(payload);
            expect((await readDesktopGlassState()).materialLive).toBe(false);
        }
    });

    it('keeps solid when desktop IPC is unavailable and never invokes native material in a browser', async () => {
        const { readDesktopGlassState, applyDesktopGlassMaterial } = await import('./desktopGlassMaterial');
        host.isDesktop.mockReturnValue(false);
        expect((await applyDesktopGlassMaterial({ enabled: true, blur: 'regular' })).materialLive).toBe(false);
        expect(host.invoke).not.toHaveBeenCalled();
        host.isDesktop.mockReturnValue(true);
        host.invoke.mockRejectedValue(new Error('older host has no command'));
        expect((await readDesktopGlassState()).materialLive).toBe(false);
    });

    it('delivers current native state and accessibility/focus changes until disposed', async () => {
        host.isDesktop.mockReturnValue(true);
        host.invoke.mockResolvedValue(live);
        let deliver: ((value: unknown) => void) | undefined;
        const unlisten = vi.fn();
        host.listen.mockImplementation(async (_name: string, listener: (value: unknown) => void) => {
            deliver = listener;
            return unlisten;
        });
        const { subscribeDesktopGlassState } = await import('./desktopGlassMaterial');
        const listener = vi.fn();
        const dispose = await subscribeDesktopGlassState(listener);
        expect(listener).toHaveBeenLastCalledWith(live);
        deliver?.({ ...live, reduceTransparency: true });
        expect(listener).toHaveBeenLastCalledWith({ ...live, materialLive: false, reduceTransparency: true });
        dispose();
        expect(unlisten).toHaveBeenCalledOnce();
    });

    it('reports whether the host opened the OS transparency settings, including failure and browser fallback', async () => {
        const { openDesktopReduceTransparencySettings } = await import('./desktopGlassMaterial');
        host.isDesktop.mockReturnValue(true);
        host.invoke.mockResolvedValue(true);
        await expect(openDesktopReduceTransparencySettings()).resolves.toBe(true);
        host.invoke.mockRejectedValue(new Error('OS settings unavailable'));
        await expect(openDesktopReduceTransparencySettings()).resolves.toBe(false);
        host.invoke.mockClear();
        host.isDesktop.mockReturnValue(false);
        await expect(openDesktopReduceTransparencySettings()).resolves.toBe(false);
        expect(host.invoke).not.toHaveBeenCalled();
    });
});
