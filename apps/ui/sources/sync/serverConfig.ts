import { getActiveServerUrl, setActiveServerId, upsertServerProfile } from './serverProfiles';

const DEFAULT_SERVER_URL = 'https://api.happier.dev';
const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';

export function getServerUrl(): string {
    return getActiveServerUrl();
}

export function setServerUrl(url: string | null): void {
    const normalized = String(url ?? '').trim().replace(/\/+$/, '');
    if (!normalized) {
        setActiveServerId('official', { scope: 'device' });
        if (isWebRuntime) {
            try {
                setActiveServerId('official', { scope: 'tab' });
            } catch {
                // ignore
            }
        }
        return;
    }

    const profile = upsertServerProfile({ serverUrl: normalized });
    setActiveServerId(profile.id, { scope: 'device' });
    if (isWebRuntime) {
        try {
            setActiveServerId(profile.id, { scope: 'tab' });
        } catch {
            // ignore
        }
    }
}

export function isUsingCustomServer(): boolean {
    return getServerUrl() !== DEFAULT_SERVER_URL;
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
