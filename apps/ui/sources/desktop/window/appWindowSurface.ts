import { invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';

/** Native focus paired with the Session actually presented by that renderer, never its restore address. */
export type DesktopAppWindowSurface = Readonly<{
    windowId: string;
    homeId: string;
    accountId: string;
    sessionId: string | null;
    focused: boolean;
    methods?: readonly string[];
}>;

let focusedSurface: DesktopAppWindowSurface | null = null;
const listeners = new Set<() => void>();
let mountedSurfaces: readonly DesktopAppWindowSurface[] = [];
const mountedListeners = new Set<() => void>();

export const getDesktopAppWindowMountedSurfaces = (): readonly DesktopAppWindowSurface[] => mountedSurfaces;
export function subscribeDesktopAppWindowMountedSurfaces(listener: () => void): () => void {
    mountedListeners.add(listener);
    return () => { mountedListeners.delete(listener); };
}

function acceptMountedSurfaces(next: readonly DesktopAppWindowSurface[]): void {
    const retained = next.filter(surface => surface.methods?.length).map(surface => {
        const previous = mountedSurfaces.find(candidate => candidate.windowId === surface.windowId);
        return previous?.homeId === surface.homeId && previous.accountId === surface.accountId
            && JSON.stringify(previous.methods) === JSON.stringify(surface.methods) ? previous : surface;
    });
    if (retained.length === mountedSurfaces.length && retained.every((surface, index) => surface === mountedSurfaces[index])) return;
    mountedSurfaces = retained;
    for (const listener of mountedListeners) listener();
}

export function getFocusedDesktopAppWindowSurface(): DesktopAppWindowSurface | null {
    return focusedSurface;
}

export function subscribeFocusedDesktopAppWindowSurface(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function acceptSurface(surface: DesktopAppWindowSurface | null): void {
    const next = surface?.focused ? surface : null;
    if (focusedSurface?.windowId === next?.windowId && focusedSurface?.homeId === next?.homeId
        && focusedSurface?.accountId === next?.accountId && focusedSurface?.sessionId === next?.sessionId) return;
    focusedSurface = next;
    for (const listener of listeners) listener();
}

/** Each data realm consumes native focus once; OS/app-window lifecycle remains the focus authority. */
export async function observeDesktopAppWindowSurfaces(): Promise<() => void> {
    let disposed = false;
    let published = false;
    const changedWindows = new Set<string>();
    const stop = await listenDesktopHostEvent<DesktopAppWindowSurface>('desktopAppWindow://surface', surface => {
        if (disposed) return;
        changedWindows.add(surface.windowId);
        acceptMountedSurfaces(mountedSurfaces.some(previous => previous.windowId === surface.windowId)
            ? mountedSurfaces.map(previous => previous.windowId === surface.windowId ? surface : previous)
            : [...mountedSurfaces, surface]);
        if (surface.focused || focusedSurface?.windowId === surface.windowId) {
            published = true;
            acceptSurface(surface);
        }
    });
    try {
        const snapshot = await invokeDesktopHost<readonly DesktopAppWindowSurface[]>('desktop_app_window_surfaces');
        if (!disposed) acceptMountedSurfaces([...snapshot.filter(surface => !changedWindows.has(surface.windowId)),
            ...mountedSurfaces.filter(surface => changedWindows.has(surface.windowId))]);
        if (!disposed && !published) acceptSurface(snapshot.find(surface => surface.focused) ?? null);
    } catch (error) {
        stop();
        throw error;
    }
    return () => { disposed = true; stop(); acceptSurface(null); acceptMountedSurfaces([]); };
}

/** Native attaches actual caller identity and focus; the renderer supplies only its local presented Session. */
export function publishDesktopAppWindowSurface(surface: Omit<DesktopAppWindowSurface, 'windowId' | 'focused'>): Promise<void> {
    return invokeDesktopHost('desktop_app_window_surface', surface);
}
