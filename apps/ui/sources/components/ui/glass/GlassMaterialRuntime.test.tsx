import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// Desktop IPC is the native window boundary; runtime, adapter and Account store stay real.
const host = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async (_name: string, _listener: (value: unknown) => void) => () => {}) }));
vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => true,
    invokeDesktopHost: host.invoke,
    listenDesktopHostEvent: host.listen,
}));

// Which webview this is comes from the host's window location, an environment boundary.
const windowContext = vi.hoisted(() => ({ panel: false }));
vi.mock('@/desktop/window/isDesktopAuxiliaryWindowContext', () => ({
    resolveDesktopWindowContext: () => ({ role: windowContext.panel ? 'presenter' : 'primary', chrome: windowContext.panel ? 'destination' : 'full' }),
    isDesktopGlassPanelWindowContext: () => windowContext.panel,
}));

afterEach(() => { standardCleanup(); vi.clearAllMocks(); windowContext.panel = false; });

describe('desktop window material projection', () => {
    it('lets a capture panel follow the main window: its native backing, and the projected settings live', async () => {
        windowContext.panel = true;
        const { GlassMaterialRuntime } = await import('./GlassMaterialRuntime');
        const { useGlassRuntimeEnvironment } = await import('./glassRuntimeEnvironment');
        const { useGlassMaterialSettings } = await import('./useGlassMaterialSettings');
        const { resolveGlassSurfaceMaterial } = await import('./glassMaterial');
        const glassOn = { glassBlurEnabled: true, glassBlurIntensity: 'regular' as const, glassTintIntensity: 12, glassSurfaceMaterials: null };
        let deliver: ((value: unknown) => void) | undefined;
        host.listen.mockImplementation(async (_name: string, listener: (value: unknown) => void) => { deliver = listener; return () => {}; });
        host.invoke.mockResolvedValue({ supported: true, materialLive: true, reduceTransparency: false, highContrast: false, windowActive: true, settings: glassOn });
        function Probe() {
            const environment = useGlassRuntimeEnvironment();
            const settings = useGlassMaterialSettings();
            return React.createElement('Probe', { testID: 'panel-probe', environment, settings,
                card: resolveGlassSurfaceMaterial(settings, 'content', environment) });
        }
        const screen = await renderScreen(<GlassMaterialRuntime><Probe /></GlassMaterialRuntime>);
        const probe = () => screen.findHostByTestId('panel-probe')!;
        await act(async () => {});
        expect(host.listen).toHaveBeenCalledWith('desktopGlass://state/capture', expect.any(Function));
        // The panel never decides the window material; the main window does.
        expect(host.invoke.mock.calls.filter(([name]) => name === 'desktop_apply_glass_material')).toEqual([]);
        expect(probe().props.environment).toMatchObject({ desktopWindow: true, nativeWindowMaterialLive: true });
        expect(probe().props.card).toMatchObject({ reason: null, material: { blur: 'regular' } });
        expect(probe().props.card.material.opacity).toBeLessThan(1);
        // Glass off in the main window while the panel is open: the projection and the backing both follow.
        await act(async () => deliver?.({ supported: true, materialLive: false, reduceTransparency: false, highContrast: false, windowActive: true,
            settings: { ...glassOn, glassBlurEnabled: false } }));
        expect(probe().props.settings.glassBlurEnabled).toBe(false);
        expect(probe().props.card).toMatchObject({ material: { blur: 'off', opacity: 1 } });
        // Reduce Transparency keeps the stored choice and paints the opaque surface.
        await act(async () => deliver?.({ supported: true, materialLive: false, reduceTransparency: true, highContrast: false, windowActive: true, settings: glassOn }));
        expect(probe().props.card).toMatchObject({ reason: 'reduceTransparency', material: { opacity: 1 } });
    });
    it('propagates the one atmosphere setter through runtime paint without changing native window material', async () => {
        const { GlassMaterialRuntime } = await import('./GlassMaterialRuntime');
        const { useGlassRuntimeEnvironment, useSetGlassAtmosphereBehind } = await import('./glassRuntimeEnvironment');
        const { resolveGlassPresentationVariables } = await import('./glassDocumentPresentation');
        const { useGlassMaterialSettings } = await import('./useGlassMaterialSettings');
        host.invoke.mockResolvedValue({ supported: true, materialLive: true, reduceTransparency: false, highContrast: false, windowActive: true });
        function Probe() {
            const environment = useGlassRuntimeEnvironment();
            const setAtmosphere = useSetGlassAtmosphereBehind();
            const settings = useGlassMaterialSettings();
            return React.createElement('Probe', { testID: 'atmosphere-probe', environment, setAtmosphere,
                variables: resolveGlassPresentationVariables(settings, environment) });
        }
        const screen = await renderScreen(<GlassMaterialRuntime><Probe /></GlassMaterialRuntime>);
        const probe = () => screen.findHostByTestId('atmosphere-probe')!;
        expect(probe().props.environment.atmosphereBehind).toBe('none');
        host.invoke.mockClear();
        for (const atmosphereBehind of ['band', 'wallpaper', 'none'] as const) {
            await act(async () => probe().props.setAtmosphere(atmosphereBehind));
            expect(probe().props.environment.atmosphereBehind).toBe(atmosphereBehind);
            if (atmosphereBehind !== 'none') expect(probe().props.variables['--happier-glass-content-plane-opacity']).toBe('0%');
            expect(host.invoke.mock.calls.filter(([name]) => name === 'desktop_apply_glass_material')).toEqual([]);
        }
    });
    it('uses chrome for the single window material and preserves floating changes in their own group', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { GlassMaterialRuntime } = await import('./GlassMaterialRuntime');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const before = storage.getState();
        host.invoke.mockResolvedValue({ supported: true, materialLive: true, reduceTransparency: false, highContrast: false, windowActive: true });
        const materials = { ...glassPresetMaterials('everywhere'), chrome: { blur: 'off' as const, opacity: 0 }, sidebar: { blur: 'light' as const, opacity: 0.2 }, content: { blur: 'regular' as const, opacity: 0.4 }, floating: { blur: 'strong' as const, opacity: 0.6 } };
        try {
            act(() => storage.setState({ settings: { ...before.settings, glassBlurEnabled: true, glassSurfaceMaterials: materials } }));
            await renderScreen(<GlassMaterialRuntime><React.Fragment /></GlassMaterialRuntime>);
            expect(host.invoke).toHaveBeenCalledWith('desktop_apply_glass_material', expect.objectContaining({ enabled: true, blur: 'off',
                settings: expect.objectContaining({ glassBlurEnabled: true, glassSurfaceMaterials: materials }) }));
            host.invoke.mockClear();
            act(() => storage.setState({ settings: { ...storage.getState().settings, glassSurfaceMaterials: { ...materials, floating: { blur: 'light', opacity: 0 } } } }));
            await act(async () => {});
            expect(host.invoke.mock.calls.filter(([name]) => name === 'desktop_apply_glass_material').every(([, request]) => request.blur === 'off')).toBe(true);
            act(() => storage.setState({ settings: { ...storage.getState().settings, glassSurfaceMaterials: { ...materials, chrome: { blur: 'light', opacity: 0 } } } }));
            await act(async () => {});
            expect(host.invoke).toHaveBeenLastCalledWith('desktop_apply_glass_material', expect.objectContaining({ enabled: true, blur: 'light' }));
        } finally { standardCleanup(); act(() => storage.setState(before, true)); }
    });
});
