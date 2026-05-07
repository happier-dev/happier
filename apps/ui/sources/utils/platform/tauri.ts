type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === 'object' ? value as UnknownRecord : null;
}

function readGlobalValue(key: string): unknown {
    const globalRecord = globalThis as unknown as UnknownRecord;
    const globalValue = globalRecord[key];
    if (globalValue !== undefined) {
        return globalValue;
    }
    if (typeof window === 'undefined') {
        return undefined;
    }
    return (window as unknown as UnknownRecord)[key];
}

function readTauriInternals(): UnknownRecord | null {
    return asRecord(readGlobalValue('__TAURI_INTERNALS__'));
}

function readTauriApi(): UnknownRecord | null {
    return asRecord(readGlobalValue('__TAURI__'));
}

function readTauriInvoke(): unknown {
    const internals = readTauriInternals();
    if (typeof internals?.invoke === 'function') {
        return internals.invoke;
    }

    const tauriApi = readTauriApi();
    return asRecord(tauriApi?.core)?.invoke;
}

function readTauriEventApi(): UnknownRecord | null {
    return asRecord(readTauriApi()?.event);
}

function canImportTauriEventModule(): boolean {
    return typeof readTauriInternals()?.transformCallback === 'function';
}

export function isTauriDesktop(): boolean {
    if (typeof readTauriInvoke() === 'function') {
        return true;
    }

    // During early desktop boot the invoke bridge may lag the WebView identity.
    const userAgent =
        typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
            ? navigator.userAgent
            : '';
    return userAgent.toLowerCase().includes('tauri');
}

export async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const invoke = readTauriInvoke();
    if (typeof invoke === 'function') {
        return invoke(command, args) as T;
    }

    const mod = await import('@tauri-apps/api/core');
    return mod.invoke<T>(command, args);
}

export async function listenTauriEvent<T>(
    event: string,
    handler: (payload: T) => void,
): Promise<() => void> {
    const globalEventApi = readTauriEventApi();
    if (typeof globalEventApi?.listen === 'function') {
        const unlisten = await globalEventApi.listen.call(globalEventApi, event, (tauriEvent: { payload: T }) => {
            handler(tauriEvent.payload);
        });
        return typeof unlisten === 'function' ? unlisten : () => undefined;
    }

    if (!canImportTauriEventModule()) {
        return () => undefined;
    }

    const mod = await import('@tauri-apps/api/event');
    return mod.listen<T>(event, (tauriEvent) => {
        handler(tauriEvent.payload);
    });
}
