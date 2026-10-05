import { invokeDesktopHost, isDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';

export interface DesktopGlassState {
    supported: boolean;
    materialLive: boolean;
    reduceTransparency: boolean;
    highContrast: boolean;
    windowActive: boolean;
}

export interface DesktopGlassMaterialRequest {
    enabled: boolean;
    blur: 'off' | 'light' | 'regular' | 'strong';
}

const unavailable: DesktopGlassState = {
    supported: false,
    materialLive: false,
    reduceTransparency: false,
    highContrast: false,
    windowActive: true,
};

function normalizeState(value: unknown): DesktopGlassState {
    if (typeof value !== 'object' || value === null) return unavailable;
    const data = value as Record<string, unknown>;
    if (['supported', 'materialLive', 'reduceTransparency', 'highContrast', 'windowActive'].some((key) => typeof data[key] !== 'boolean')) return unavailable;
    return {
        supported: data.supported === true,
        materialLive: data.materialLive === true && data.supported === true && data.reduceTransparency === false && data.windowActive === true,
        reduceTransparency: data.reduceTransparency === true,
        highContrast: data.highContrast === true,
        windowActive: data.windowActive === true,
    };
}

export async function readDesktopGlassState(): Promise<DesktopGlassState> {
    if (!isDesktopHost()) return unavailable;
    try {
        return normalizeState(await invokeDesktopHost<unknown>('desktop_get_glass_state'));
    } catch {
        return unavailable;
    }
}

export async function applyDesktopGlassMaterial(request: DesktopGlassMaterialRequest): Promise<DesktopGlassState> {
    if (!isDesktopHost()) return unavailable;
    try {
        return normalizeState(await invokeDesktopHost<unknown>('desktop_apply_glass_material', { ...request }));
    } catch {
        return unavailable;
    }
}

export async function subscribeDesktopGlassState(listener: (state: DesktopGlassState) => void): Promise<() => void> {
    if (!isDesktopHost()) {
        listener(unavailable);
        return () => {};
    }
    let dispose = () => {};
    try {
        // Listen before reading so an OS/focus transition during setup remains observable.
        dispose = await listenDesktopHostEvent<unknown>('desktopGlass://state', (value) => listener(normalizeState(value)));
    } catch {
        // Older or unavailable desktop hosts remain solid.
    }
    listener(await readDesktopGlassState());
    return dispose;
}

export async function openDesktopReduceTransparencySettings(): Promise<boolean> {
    if (!isDesktopHost()) return false;
    try {
        return (await invokeDesktopHost<unknown>('desktop_open_reduce_transparency_settings')) === true;
    } catch {
        return false;
    }
}
