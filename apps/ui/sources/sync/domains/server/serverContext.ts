function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalize(raw: unknown): string {
    return String(raw ?? '').trim().toLowerCase();
}

function readExpoPublicServerContextEnv(): string {
    // In Expo/React Native, `process.env` can be polyfilled; keep access guarded.
    if (typeof process === 'undefined') return '';
    return normalize(process.env?.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT);
}

function inferStackContextFromWebOrigin(): boolean {
    if (!isWebRuntime()) return false;
    const host = normalize(window.location.hostname);
    // Stack-served UIs use a `happier-<stack>.localhost` origin.
    return host.startsWith('happier-') && host.endsWith('.localhost');
}

export function isStackContext(): boolean {
    const fromEnv = readExpoPublicServerContextEnv();
    if (fromEnv === 'stack') return true;
    return inferStackContextFromWebOrigin();
}
