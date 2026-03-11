import { isStackContext } from './serverContext';
import { readWebRuntimeConfigServerUrl } from '@/sync/runtime/webRuntimeConfig';

function readFirstNonEmptyEnv(...values: Array<string | undefined>): string {
    for (const value of values) {
        const trimmed = String(value ?? '').trim();
        if (trimmed) return trimmed;
    }
    return '';
}

export function readConfiguredServerUrlEnvRaw(): string {
    return readFirstNonEmptyEnv(
        readWebRuntimeConfigServerUrl(),
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL,
        process.env.EXPO_PUBLIC_HAPPY_SERVER_URL,
        process.env.EXPO_PUBLIC_SERVER_URL,
    );
}

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function isLoopbackHostname(rawHost: string): boolean {
    const host = String(rawHost ?? '').trim().toLowerCase();
    return (
        host === 'localhost'
        || host === '127.0.0.1'
        || host === '::1'
        || host === '[::1]'
        || host.endsWith('.localhost')
    );
}

function isPrivateIpv4Hostname(rawHost: string): boolean {
    const host = String(rawHost ?? '').trim();
    const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return false;
    const parts = match.slice(1).map((p) => Number(p));
    if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
}

function maybeRewriteStackServerUrlToLoopbackHostname(rawUrl: string): string {
    const value = String(rawUrl ?? '').trim();
    if (!value) return '';
    if (!isWebRuntime()) return value;
    if (!isStackContext()) return value;

    const webHost = String(window.location?.hostname ?? '').trim();
    if (!isLoopbackHostname(webHost)) return value;

    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
    let parsed: URL;
    try {
        parsed = new URL(hasScheme ? value : `https://${value}`);
    } catch {
        return value;
    }

    if (!isPrivateIpv4Hostname(parsed.hostname)) return value;
    parsed.hostname = webHost;
    return parsed.toString();
}

export function readConfiguredServerUrlEnv(): string {
    return maybeRewriteStackServerUrlToLoopbackHostname(
        readConfiguredServerUrlEnvRaw(),
    );
}
