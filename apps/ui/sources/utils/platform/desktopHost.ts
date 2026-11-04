/**
 * Canonical JS -> native seam for every desktop shell that hosts this renderer.
 *
 * Two desktop targets ship the same bundle: the Tauri target (`apps/ui/src-tauri`) and the
 * Electron target (`apps/desktop`). Both expose the same `__TAURI_INTERNALS__`-shaped bridge —
 * Electron's preload mirrors that shape deliberately — so command invocation and event
 * subscription stay a single implementation here instead of one path per shell.
 *
 * Host identity is the one thing the shells do not share, and {@link desktopHostKind} is the only
 * place that decides it. A caller that must diverge asks here rather than re-sniffing globals.
 */

import { useEffect, useSyncExternalStore } from 'react';

export type DesktopHostKind = 'tauri' | 'electron';

export type DesktopHostRole = 'activity' | 'pet' | 'windows';
export type DesktopHostRoleAvailability =
    | Readonly<{ kind: 'available' }>
    | Readonly<{ kind: 'unavailable'; reason: string }>;
export type DesktopHostAvailability = Readonly<Record<DesktopHostRole, DesktopHostRoleAvailability>>;

type DesktopHostInvoke = (command: string, args?: Record<string, unknown>) => unknown;

function readHostGlobal(key: string): unknown {
    return (
        (globalThis as Record<string, unknown>)[key]
        ?? (typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>)[key] : undefined)
    );
}

/** The native host's identity for this renderer, shared by auxiliary-window transports. */
export function getDesktopHostWindowLabel(): string | null {
    const internals = readHostGlobal('__TAURI_INTERNALS__') as {
        metadata?: { currentWindow?: { label?: unknown } };
    } | undefined;
    const label = internals?.metadata?.currentWindow?.label;
    return typeof label === 'string' ? label : null;
}

/**
 * Reads the host's command bridge. Both shells publish it under the same globals, so this is the
 * shared transport rather than a Tauri-only one.
 */
function readHostInvoke(): DesktopHostInvoke | undefined {
    const internals = readHostGlobal('__TAURI_INTERNALS__') as { invoke?: unknown } | null | undefined;
    if (typeof internals?.invoke === 'function') {
        return internals.invoke as DesktopHostInvoke;
    }

    const hostApi = readHostGlobal('__TAURI__') as { core?: { invoke?: unknown } } | null | undefined;
    const coreInvoke = hostApi?.core?.invoke;
    return typeof coreInvoke === 'function' ? (coreInvoke as DesktopHostInvoke) : undefined;
}

function readUserAgent(): string {
    return typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent.toLowerCase()
        : '';
}

/** Which desktop shell is hosting this renderer, or `null` in a browser/native runtime. */
export function desktopHostKind(): DesktopHostKind | null {
    const userAgent = readUserAgent();

    // Electron is settled first: its preload installs a Tauri-shaped bridge on purpose, so the
    // bridge globals cannot separate the two shells. The renderer user agent can.
    if (userAgent.includes('electron/')) {
        return 'electron';
    }

    if (readHostInvoke() !== undefined) {
        return 'tauri';
    }

    if (readHostGlobal('isTauri') === true) {
        return 'tauri';
    }

    // In some desktop boot phases the global invoke bridge is not yet ready, but the WebView is
    // already identifiable as a desktop host. This keeps desktop-only UI (settings/overlay) stable
    // during early navigation and native-e2e capture.
    return userAgent.includes('tauri') ? 'tauri' : null;
}

/** Whether this renderer is hosted by a desktop shell at all, whichever one it is. */
export function isDesktopHost(): boolean {
    return desktopHostKind() !== null;
}

export async function invokeDesktopHost<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const invoke = readHostInvoke();
    if (invoke !== undefined) {
        return invoke(command, args) as T;
    }

    const mod = await import('@tauri-apps/api/core');
    return mod.invoke<T>(command, args);
}

/**
 * Subscribes to a host event. The event plugin commands this drives (`plugin:event|listen` and
 * `plugin:event|unlisten`) are implemented by both shells, so one path serves both.
 * Bind to this renderer's label: an Any subscription also receives events addressed to other
 * windows. Native broadcasts still reach label-bound listeners.
 */
export async function listenDesktopHostEvent<T>(
    event: string,
    handler: (payload: T) => void,
): Promise<() => void> {
    const windowLabel = getDesktopHostWindowLabel();
    const mod = await import('@tauri-apps/api/event');
    return mod.listen<T>(event, (hostEvent) => {
        handler(hostEvent.payload);
    }, windowLabel === null ? undefined : { target: windowLabel });
}

let availability: DesktopHostAvailability | null = null;
let availabilityAcquisition: Promise<DesktopHostAvailability> | null = null;
const availabilitySubscribers = new Set<() => void>();

function unavailableHost(reason: string): DesktopHostAvailability {
    const role = { kind: 'unavailable', reason } as const;
    return { activity: role, pet: role, windows: role };
}

export function getDesktopHostAvailabilitySnapshot(): DesktopHostAvailability | null {
    if (availability === null) {
        const kind = desktopHostKind();
        if (kind !== 'tauri') availability = unavailableHost(kind === 'electron' ? 'electron_overlay_unavailable' : 'not_desktop');
    }
    return availability;
}

function sameRole(left: DesktopHostRoleAvailability, right: DesktopHostRoleAvailability): boolean {
    return left.kind === right.kind
        && (left.kind !== 'unavailable' || (right.kind === 'unavailable' && left.reason === right.reason));
}

function publishHostAvailability(update: Partial<DesktopHostAvailability>, initial?: DesktopHostAvailability): void {
    const previous = getDesktopHostAvailabilitySnapshot();
    if (!previous) {
        if (!initial) return; // The following native read includes failures emitted while loading.
        availability = initial;
        for (const subscriber of availabilitySubscribers) subscriber();
        return;
    }
    const next = { ...previous };
    let changed = false;
    for (const role of ['activity', 'pet', 'windows'] as const) {
        const value = update[role];
        if (value && !sameRole(previous[role], value)) {
            next[role] = value;
            changed = true;
        }
    }
    if (!changed) return;
    availability = next;
    for (const subscriber of availabilitySubscribers) subscriber();
}

/** One acquisition per renderer realm; runtime failures update the same role leaves. */
export function getDesktopHostAvailability(): Promise<DesktopHostAvailability> {
    const current = getDesktopHostAvailabilitySnapshot();
    if (current && availabilityAcquisition === null) {
        return Promise.resolve(current);
    }
    if (availabilityAcquisition === null) {
        availabilityAcquisition = (async () => {
            try {
                // Listen before reading: the native read includes any already-settled panel failure.
                for (const event of ['activityOverlay://state', 'desktop_pet_overlay_window_state_changed']) {
                    await listenDesktopHostEvent<{ availability?: Partial<DesktopHostAvailability> }>(event, payload => {
                        if (payload.availability) publishHostAvailability(payload.availability);
                    });
                }
                const result = await invokeDesktopHost<DesktopHostAvailability>('desktop_host_get_availability');
                publishHostAvailability(result, result);
                return result;
            } catch {
                const result = unavailableHost('host_availability_unavailable');
                publishHostAvailability(result, result);
                return result;
            }
        })();
    }
    return availabilityAcquisition.then(result => availability ?? result);
}

function subscribeHostAvailability(subscriber: () => void): () => void {
    availabilitySubscribers.add(subscriber);
    return () => { availabilitySubscribers.delete(subscriber); };
}

export function useDesktopHostAvailability(): DesktopHostAvailability | null {
    const result = useSyncExternalStore(subscribeHostAvailability, getDesktopHostAvailabilitySnapshot, getDesktopHostAvailabilitySnapshot);
    useEffect(() => { void getDesktopHostAvailability(); }, []);
    return result;
}

export function useDesktopHostRoleAvailability(role: DesktopHostRole): DesktopHostRoleAvailability | null {
    const result = useSyncExternalStore(subscribeHostAvailability, () => getDesktopHostAvailabilitySnapshot()?.[role] ?? null, () => getDesktopHostAvailabilitySnapshot()?.[role] ?? null);
    useEffect(() => { void getDesktopHostAvailability(); }, []);
    return result;
}

export class DesktopHostUnavailableError extends Error {
    readonly code = 'desktop_host_unavailable';
    constructor(readonly role: DesktopHostRole, readonly reason: string) {
        super(reason);
        this.name = 'DesktopHostUnavailableError';
    }
}

export async function requireDesktopHostRole(role: DesktopHostRole): Promise<void> {
    const result = (await getDesktopHostAvailability())[role];
    if (result.kind !== 'available') {
        throw new DesktopHostUnavailableError(role, result.reason);
    }
}
