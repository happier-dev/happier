import { getActiveServerUrl } from './serverProfiles';
import { getResetToDefaultServerId } from './serverProfiles';
import { setActiveServer, upsertAndActivateServer } from './serverRuntime';
import { CLOUD_SERVER_URL } from './serverIdentity';

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function isStackContext(): boolean {
    const raw = String(process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT ?? '').trim().toLowerCase();
    return raw === 'stack';
}

function normalizeUrl(raw: string): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
}

function getDefaultServerUrl(): string {
    if (isStackContext()) {
        const envUrl = normalizeUrl(String(process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ?? ''));
        if (envUrl) return envUrl;

        if (isWebRuntime()) {
            const origin = normalizeUrl(String(window.location?.origin ?? ''));
            if (origin && origin !== 'null') return origin;
        }
    }

    return CLOUD_SERVER_URL;
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
    
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'Server URL must use HTTP or HTTPS protocol' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}
