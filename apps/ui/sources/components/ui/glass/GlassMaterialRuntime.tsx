import * as React from 'react';
import { Platform } from 'react-native';

import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { isDesktopOverlayWindowContext } from '@/desktop/window/isDesktopOverlayWindowContext';
import { applyDesktopGlassMaterial, subscribeDesktopGlassState, type DesktopGlassState } from '@/utils/platform/desktopGlassMaterial';
import { useWebRootCanvasPresentation } from '@/theme/useWebRootCanvasPresentation';

import { GLASS_SURFACE_GROUPS, readGlassMaterials } from './glassMaterial';
import { useGlassMaterialSettings } from './useGlassMaterialSettings';
import { applyGlassDocumentPresentation, shouldRevealNativeGlassCanvas } from './glassDocumentPresentation';
import { GlassRuntimeEnvironmentProvider } from './glassRuntimeEnvironment';
export { useGlassRuntimeEnvironment } from './glassRuntimeEnvironment';

/** One narrow settings subscriber owns desktop application and web presentation variables. */
export function GlassMaterialRuntime(props: Readonly<{ children: React.ReactNode }>) {
    const settings = useGlassMaterialSettings();
    const reduceTransparency = useReduceTransparency();
    const desktopWindow = Platform.OS === 'web' && isDesktopHost() && !isDesktopOverlayWindowContext();
    const [nativeState, setNativeState] = React.useState<DesktopGlassState | null>(null);
    const environment = React.useMemo(() => ({
        desktopWindow,
        nativeWindowMaterialLive: nativeState?.materialLive === true,
        reduceTransparency: reduceTransparency || nativeState?.reduceTransparency === true,
        windowActive: nativeState?.windowActive ?? true,
    }), [desktopWindow, nativeState?.materialLive, nativeState?.reduceTransparency, nativeState?.windowActive, reduceTransparency]);
    useWebRootCanvasPresentation(shouldRevealNativeGlassCanvas(environment));

    React.useEffect(() => {
        if (!desktopWindow) return;
        let current = true;
        let unsubscribe: (() => void) | undefined;
        void subscribeDesktopGlassState(state => { if (current) setNativeState(state); }).then(stop => {
            if (current) unsubscribe = stop; else stop();
        }).catch(() => { if (current) setNativeState(null); });
        return () => { current = false; unsubscribe?.(); };
    }, [desktopWindow]);

    React.useEffect(() => {
        if (!desktopWindow) return;
        const materials = readGlassMaterials(settings);
        // macOS/Windows expose one window material, owned by chrome. Other
        // groups retain their renderer filters; floating never changes the backing.
        const enabled = GLASS_SURFACE_GROUPS.some(group => group !== 'floating'
            && (materials[group].blur !== 'off' || materials[group].opacity < 1));
        let current = true;
        void applyDesktopGlassMaterial({ enabled, blur: materials.chrome.blur }).then(state => {
            if (current) setNativeState(state);
        }).catch(() => { if (current) setNativeState(null); });
        return () => { current = false; };
    }, [desktopWindow, settings]);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || typeof document === 'undefined') return;
        return applyGlassDocumentPresentation(document, settings, environment);
    }, [environment, settings]);

    return <GlassRuntimeEnvironmentProvider value={environment}>{props.children}</GlassRuntimeEnvironmentProvider>;
}
