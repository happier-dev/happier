import type { GlassMaterialSettings } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
import { invokeDesktopHost, isDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';

export interface DesktopGlassState {
    supported: boolean;
    materialLive: boolean;
    reduceTransparency: boolean;
    highContrast: boolean;
    windowActive: boolean;
    /**
     * A glass panel's copy of the main window's settings (panels cannot read the Account); null when the
     * projection is malformed. Absent for the main window.
     */
    settings?: GlassMaterialSettings | null;
}

export interface DesktopGlassMaterialRequest {
    enabled: boolean;
    blur: 'off' | 'light' | 'regular' | 'strong';
    /** The main window's glass settings, which native relays to the panels that follow it. */
    settings?: GlassMaterialSettings;
}

/** Floating panel windows that show the main window's material behind their card (`window_chrome.rs`). */
export type DesktopGlassPanelLabel = 'capture' | 'activity_overlay';

const unavailable: DesktopGlassState = {
    supported: false,
    materialLive: false,
    reduceTransparency: false,
    highContrast: false,
    windowActive: true,
};

const BLUR_INTENSITIES: readonly unknown[] = ['light', 'regular', 'strong'];

/** The projection comes from the main webview through native; check its shape, not its policy. */
function normalizeSettings(value: unknown): GlassMaterialSettings | null {
    if (typeof value !== 'object' || value === null) return null;
    const data = value as Record<string, unknown>;
    if (typeof data.glassBlurEnabled !== 'boolean' || !BLUR_INTENSITIES.includes(data.glassBlurIntensity)
        || typeof data.glassTintIntensity !== 'number'
        || (data.glassSurfaceMaterials !== null && typeof data.glassSurfaceMaterials !== 'object')) return null;
    return value as GlassMaterialSettings;
}

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
        ...('settings' in data ? { settings: normalizeSettings(data.settings) } : {}),
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

/** A panel listens on its own event, so the main window's broadcast never reaches it. */
export async function subscribeDesktopGlassState(listener: (state: DesktopGlassState) => void, panel?: DesktopGlassPanelLabel): Promise<() => void> {
    if (!isDesktopHost()) {
        listener(unavailable);
        return () => {};
    }
    let dispose = () => {};
    try {
        // Listen before reading so an OS/focus transition during setup remains observable.
        dispose = await listenDesktopHostEvent<unknown>(panel ? `desktopGlass://state/${panel}` : 'desktopGlass://state', (value) => listener(normalizeState(value)));
    } catch {
        // Older or unavailable desktop hosts remain solid.
    }
    listener(await readDesktopGlassState());
    return dispose;
}

/**
 * A panel's card stops filling its window when it starts to move; its material clears until the next
 * resting frame (`presentCaptureWindow` carries that card's radius). `frame` places the material when it
 * does not fill the window (the notch's island); such a panel's material only hides while it moves.
 */
export async function setDesktopGlassPanelShape(
    radius: number | null,
    frame?: Readonly<{ x: number; y: number; width: number; height: number }>,
): Promise<void> {
    if (!isDesktopHost()) return;
    try {
        await invokeDesktopHost<unknown>('desktop_set_glass_panel_shape', { radius, frame });
    } catch {
        // Older hosts have no panel material; the card stays opaque.
    }
}

export async function openDesktopReduceTransparencySettings(): Promise<boolean> {
    if (!isDesktopHost()) return false;
    try {
        return (await invokeDesktopHost<unknown>('desktop_open_reduce_transparency_settings')) === true;
    } catch {
        return false;
    }
}
