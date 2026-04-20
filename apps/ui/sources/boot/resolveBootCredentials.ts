import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { isTerminalConnectWebPathname, parseTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';
import { TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY } from '@/utils/path/terminalConnectWebBootstrap';
import { bootstrapActiveServerFromWebLocation } from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { activateStackRuntimeServer, readStackRuntimeServerUrl } from '@/sync/domains/server/stackRuntimeServer';
import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';

function resolveBootServerUrlFromTerminalConnectHash(): string | null {
    if (typeof window === 'undefined') return null;
    if (typeof window.location?.href !== 'string') return null;

    const direct = parseTerminalConnectUrl(window.location.href);
    if (direct?.serverUrl) return direct.serverUrl;

    try {
        const locationUrl = new URL(window.location.href);
        if (!isTerminalConnectWebPathname(locationUrl.pathname)) {
            globalThis.sessionStorage?.removeItem?.(TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY);
            return null;
        }

        const storedHash = globalThis.sessionStorage?.getItem?.(TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY);
        if (!storedHash) return null;
        const suffix = storedHash.startsWith('#') ? storedHash : `#${storedHash}`;
        return parseTerminalConnectUrl(`${window.location.href}${suffix}`)?.serverUrl ?? null;
    } catch {
        return null;
    }
}

function isDesktopBootCredentials(value: unknown): value is AuthCredentials {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    if (typeof record.token !== 'string' || record.token.trim().length === 0) return false;
    if (typeof record.secret === 'string' && record.secret.trim().length > 0) return true;
    const encryption = record.encryption;
    if (!encryption || typeof encryption !== 'object') return false;
    const encryptionRecord = encryption as Record<string, unknown>;
    return (
        typeof encryptionRecord.publicKey === 'string'
        && encryptionRecord.publicKey.trim().length > 0
        && typeof encryptionRecord.machineKey === 'string'
        && encryptionRecord.machineKey.trim().length > 0
    );
}

function canUseStackDesktopBootCredentials(bootServerUrl?: string | null): boolean {
    if (!isTauriDesktop()) return false;
    const stackRuntimeServerUrl = readStackRuntimeServerUrl();
    if (!stackRuntimeServerUrl) return false;
    if (!bootServerUrl) return true;

    const runtimeServerComparableKey = createServerUrlComparableKey(stackRuntimeServerUrl);
    const bootServerComparableKey = createServerUrlComparableKey(bootServerUrl);
    if (!runtimeServerComparableKey || !bootServerComparableKey) {
        return false;
    }

    return runtimeServerComparableKey === bootServerComparableKey;
}

async function resolveStackDesktopBootCredentials(bootServerUrl?: string | null): Promise<AuthCredentials | null> {
    if (!canUseStackDesktopBootCredentials(bootServerUrl)) return null;

    try {
        const credentials = await invokeTauri<unknown>('desktop_read_stack_boot_credentials');
        return isDesktopBootCredentials(credentials) ? credentials : null;
    } catch {
        return null;
    }
}

async function resolveAndPersistStackDesktopBootCredentials(bootServerUrl?: string | null): Promise<AuthCredentials | null> {
    const credentials = await resolveStackDesktopBootCredentials(bootServerUrl);
    if (!credentials) return null;
    if (bootServerUrl) {
        upsertAndActivateServer({
            serverUrl: bootServerUrl,
            source: 'stack-env',
            scope: 'device',
        });
    }
    await TokenStorage.setCredentials(credentials).catch(() => false);
    return credentials;
}

export async function resolveBootCredentials(platformOs: string): Promise<AuthCredentials | null> {
    const webServerOverride = platformOs === 'web'
        ? bootstrapActiveServerFromWebLocation({ scope: 'device' })
        : null;
    const stackRuntimeServerUrl = platformOs === 'web' ? readStackRuntimeServerUrl() : null;

    const bootServerUrl = webServerOverride?.serverUrl
        ?? (platformOs === 'web' ? resolveBootServerUrlFromTerminalConnectHash() : null);

    if (bootServerUrl) {
        const bootServerProfile = upsertAndActivateServer({
            serverUrl: bootServerUrl,
            source: 'url',
            scope: 'device',
        });
        const credentials = await TokenStorage.getCredentialsForServerUrl(bootServerUrl, {
            serverId: bootServerProfile.id,
        });
        if (credentials) return credentials;
        return await resolveAndPersistStackDesktopBootCredentials(bootServerUrl);
    }

    if (canUseStackDesktopBootCredentials(stackRuntimeServerUrl)) {
        const stackRuntimeServerProfile = activateStackRuntimeServer({ scope: 'device' });
        if (stackRuntimeServerUrl) {
            const credentials = await TokenStorage.getCredentialsForServerUrl(stackRuntimeServerUrl, {
                serverId: stackRuntimeServerProfile?.id,
            });
            if (credentials) return credentials;
        }
        return await resolveAndPersistStackDesktopBootCredentials(stackRuntimeServerUrl);
    }

    const credentials = await TokenStorage.getCredentials();
    if (credentials) return credentials;
    return await resolveAndPersistStackDesktopBootCredentials(stackRuntimeServerUrl);
}
