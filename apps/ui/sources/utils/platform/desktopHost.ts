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

export type DesktopHostKind = 'tauri' | 'electron';

type DesktopHostInvoke = (command: string, args?: Record<string, unknown>) => unknown;

function readHostGlobal(key: string): unknown {
    return (
        (globalThis as Record<string, unknown>)[key]
        ?? (typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>)[key] : undefined)
    );
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
 */
export async function listenDesktopHostEvent<T>(
    event: string,
    handler: (payload: T) => void,
): Promise<() => void> {
    const mod = await import('@tauri-apps/api/event');
    return mod.listen<T>(event, (hostEvent) => {
        handler(hostEvent.payload);
    });
}
