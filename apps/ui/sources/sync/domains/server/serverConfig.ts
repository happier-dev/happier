import { getActiveServerUrl } from './serverProfiles';
import { getResetToDefaultServerId } from './serverProfiles';
import { setActiveServer, upsertAndActivateServer } from './serverRuntime';
import { isStackContext } from './serverContext';
import { canonicalizeServerUrl } from './url/serverUrlCanonical';

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizeUrl(raw: string): string {
    return canonicalizeServerUrl(raw);
}

function getDefaultServerUrl(): string {
    const envUrl = normalizeUrl(String(process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ?? ''));
    if (envUrl) return envUrl;

    if (isStackContext()) {
        if (isWebRuntime()) {
            const origin = normalizeUrl(String(window.location?.origin ?? ''));
            if (origin && origin !== 'null') return origin;
        }
    }

    return '';
}

export function getServerUrl(): string {
    return getActiveServerUrl();
}

export function setServerUrl(url: string | null): void {
    const normalized = normalizeUrl(String(url ?? ''));
    if (!normalized) {
        setActiveServer({ serverId: getResetToDefaultServerId(), scope: 'device' });
        return;
    }

    upsertAndActivateServer({ serverUrl: normalized, scope: 'device' });
}

export function isUsingCustomServer(): boolean {
    return getServerUrl() !== getDefaultServerUrl();
}

export function getServerInfo(): { hostname: string; port?: number; isCustom: boolean } {
    const url = getServerUrl();
    const isCustom = isUsingCustomServer();
    
    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port) : undefined;
        return {
            hostname: parsed.hostname,
            port,
            isCustom
        };
    } catch {
        // Fallback if URL parsing fails
        return {
            hostname: url,
            port: undefined,
            isCustom
        };
    }
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
        return { valid: false, error: 'Server URL cannot be empty' };
    }

    const normalized = normalizeUrl(url);
    if (!normalized) {
        return { valid: false, error: 'Invalid URL format' };
    }
    return { valid: true };
}
