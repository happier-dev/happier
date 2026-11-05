import * as React from 'react';
import { Platform } from 'react-native';

import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { resolveDesktopWindowContext, resolveDesktopGlassPanelLabel } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { applyDesktopGlassMaterial, subscribeDesktopGlassState, type DesktopGlassState } from '@/utils/platform/desktopGlassMaterial';
import { useWebRootCanvasPresentation } from '@/theme/useWebRootCanvasPresentation';

import { GLASS_SURFACE_GROUPS, readGlassMaterials, type GlassAtmosphereTone, type GlassMaterialEnvironment, type GlassMaterialSettings } from './glassMaterial';
import { GlassMaterialSettingsProvider, useGlassMaterialSettings } from './useGlassMaterialSettings';
import { applyGlassDocumentPresentation, shouldRevealNativeGlassCanvas } from './glassDocumentPresentation';
import { GlassRuntimeEnvironmentProvider, GlassAtmosphereBehindSetterProvider, GlassAtmosphereToneSetterProvider } from './glassRuntimeEnvironment';
export { useGlassRuntimeEnvironment } from './glassRuntimeEnvironment';

/**
 * The one window material request, owned by chrome: macOS/Windows expose one window material. Other
 * groups retain their renderer filters; floating and Elements never change the backing.
 */
export function resolveDesktopGlassMaterialRequest(settings: GlassMaterialSettings) {
    const materials = readGlassMaterials(settings);
    const enabled = GLASS_SURFACE_GROUPS.some(group => group !== 'floating' && group !== 'card'
        && (materials[group].blur !== 'off' || materials[group].opacity < 1));
    return { enabled, blur: materials.chrome.blur };
}

/**
 * One narrow settings subscriber owns desktop application and web presentation variables. A glass
 * panel (the Capture window, the notch) cannot read the Account: it follows the main window's projected settings
 * and native backing, and never requests material itself.
 */
export function GlassMaterialRuntime(props: Readonly<{ children: React.ReactNode }>) {
    const storedSettings = useGlassMaterialSettings();
    const reduceTransparency = useReduceTransparency();
    const panelLabel = Platform.OS === 'web' && isDesktopHost() ? resolveDesktopGlassPanelLabel() : null;
    const panelWindow = panelLabel !== null;
    const mainWindow = Platform.OS === 'web' && isDesktopHost() && resolveDesktopWindowContext().role !== 'presenter';
    const desktopWindow = mainWindow || panelWindow;
    const [nativeState, setNativeState] = React.useState<DesktopGlassState | null>(null);
    const projected = panelWindow ? nativeState?.settings ?? null : null;
    const settings = projected ?? storedSettings;
    const [atmosphereBehind, setAtmosphereBehind] = React.useState<NonNullable<GlassMaterialEnvironment['atmosphereBehind']>>('none');
    const [measuredTone, setAtmosphereTone] = React.useState<GlassAtmosphereTone | undefined>(undefined);
    // A tone only describes a picture that is covering an area.
    const atmosphereTone = atmosphereBehind === 'none' ? undefined : measuredTone;
    const environment = React.useMemo(() => ({
        desktopWindow,
        nativeWindowMaterialLive: nativeState?.materialLive === true,
        reduceTransparency: reduceTransparency || nativeState?.reduceTransparency === true,
        windowActive: nativeState?.windowActive ?? true,
        atmosphereBehind,
        atmosphereTone,
        nativeRenderer: Platform.OS !== 'web',
    }), [desktopWindow, nativeState?.materialLive, nativeState?.reduceTransparency, nativeState?.windowActive, reduceTransparency, atmosphereBehind, atmosphereTone]);
    useWebRootCanvasPresentation(shouldRevealNativeGlassCanvas(environment));

    React.useEffect(() => {
        if (!desktopWindow) return;
        let current = true;
        let unsubscribe: (() => void) | undefined;
        void subscribeDesktopGlassState(state => { if (current) setNativeState(state); }, panelLabel ?? undefined).then(stop => {
            if (current) unsubscribe = stop; else stop();
        }).catch(() => { if (current) setNativeState(null); });
        return () => { current = false; unsubscribe?.(); };
    }, [desktopWindow, panelLabel]);

    React.useEffect(() => {
        if (!mainWindow) return;
        let current = true;
        // Native relays the settings to the panels that follow this window.
        void applyDesktopGlassMaterial({ ...resolveDesktopGlassMaterialRequest(storedSettings), settings: storedSettings }).then(state => {
            if (current) setNativeState(state);
        }).catch(() => { if (current) setNativeState(null); });
        return () => { current = false; };
    }, [mainWindow, storedSettings]);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || typeof document === 'undefined') return;
        return applyGlassDocumentPresentation(document, settings, environment);
    }, [environment, settings]);

    const content = <GlassAtmosphereBehindSetterProvider value={setAtmosphereBehind}>
        <GlassAtmosphereToneSetterProvider value={setAtmosphereTone}>
            <GlassRuntimeEnvironmentProvider value={environment}>{props.children}</GlassRuntimeEnvironmentProvider>
        </GlassAtmosphereToneSetterProvider>
    </GlassAtmosphereBehindSetterProvider>;
    // Keep one tree shape: the provider stays mounted, null falls back to the panel's own store.
    return panelWindow ? <GlassMaterialSettingsProvider value={projected}>{content}</GlassMaterialSettingsProvider> : content;
}
