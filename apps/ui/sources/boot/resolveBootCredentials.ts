import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { isTerminalConnectWebPathname, parseTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';
import { TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY } from '@/utils/path/terminalConnectWebBootstrap';
import {
    bootstrapActiveServerFromWebLocation,
    readWebServerUrlOverrideFromLocation,
} from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import {
    getActiveServerSnapshot,
    upsertAndActivateServer,
} from '@/sync/domains/server/serverRuntime';
import { activateStackRuntimeServer, readStackRuntimeServerUrl } from '@/sync/domains/server/stackRuntimeServer';
import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';
import { guardAccountEncryptionFirstKeyCredentialMutation } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';

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

function parseDesktopBootCredentials(value: unknown): AuthCredentials | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (typeof record.token !== 'string' || record.token.trim().length === 0) return null;
    const token = record.token;
    if (Object.prototype.hasOwnProperty.call(record, 'secret')) {
        return typeof record.secret === 'string' && record.secret.trim().length > 0
            ? { token, secret: record.secret }
            : null;
    }
    const encryption = record.encryption;
    if (encryption == null) return { token };
    if (typeof encryption !== 'object') return null;
    const encryptionRecord = encryption as Record<string, unknown>;
    if (
        typeof encryptionRecord.publicKey === 'string'
        && encryptionRecord.publicKey.trim().length > 0
        && typeof encryptionRecord.machineKey === 'string'
        && encryptionRecord.machineKey.trim().length > 0
    ) {
        return {
            token,
            encryption: {
                publicKey: encryptionRecord.publicKey,
                machineKey: encryptionRecord.machineKey,
            },
        };
    }
    return null;
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
        return parseDesktopBootCredentials(credentials);
    } catch {
        return null;
    }
}

async function resolveBootCredentialAdoption(
    credentials: AuthCredentials,
    target: Readonly<{
        serverUrl: string;
        serverId?: string;
    }>,
): Promise<AuthCredentials | null> {
    const classification =
        await TokenStorage
            .classifyPendingExternalAuthFirstKeyRejectedCredential({
                serverUrl: target.serverUrl,
                ...(target.serverId
                    ? { serverId: target.serverId }
                    : {}),
                token: credentials.token,
            });
    return classification.kind === 'rejected'
        ? null
        : credentials;
}

async function readRetainedBootCredentials(): Promise<AuthCredentials | null> {
    const credentials =
        await TokenStorage.getCredentials().catch(() => null);
    if (!credentials) return null;
    const activeServer = getActiveServerSnapshot();
    if (!activeServer.serverUrl) return credentials;
    return await resolveBootCredentialAdoption(
        credentials,
        {
            serverUrl: activeServer.serverUrl,
            ...(activeServer.serverId
                ? { serverId: activeServer.serverId }
                : {}),
        },
    );
}

async function canAdoptBootServerCredentials(serverUrl: string): Promise<boolean> {
    const currentGuard =
        await guardAccountEncryptionFirstKeyCredentialMutation();
    if (currentGuard.kind !== 'allowed') return false;

    const targetGuard =
        await guardAccountEncryptionFirstKeyCredentialMutation({
            serverUrl,
        });
    return targetGuard.kind === 'allowed';
}

async function resolveAndPersistStackDesktopBootCredentials(
    target?: Readonly<{
        serverUrl: string;
        serverId?: string;
    }>,
): Promise<AuthCredentials | null> {
    const credentials =
        await resolveStackDesktopBootCredentials(target?.serverUrl);
    if (!credentials) return null;
    const guard =
        await guardAccountEncryptionFirstKeyCredentialMutation(
            target,
        );
    if (guard.kind !== 'allowed') {
        return await readRetainedBootCredentials();
    }

    const persisted =
        await TokenStorage.setCredentials(credentials).catch(() => false);
    return persisted
        ? credentials
        : await readRetainedBootCredentials();
}

export async function resolveBootCredentials(platformOs: string): Promise<AuthCredentials | null> {
    const webServerOverride = platformOs === 'web'
        ? readWebServerUrlOverrideFromLocation()
        : null;
    const stackRuntimeServerUrl = platformOs === 'web' ? readStackRuntimeServerUrl() : null;

    const bootServerUrl = webServerOverride?.serverUrl
        ?? (platformOs === 'web' ? resolveBootServerUrlFromTerminalConnectHash() : null);

    if (bootServerUrl) {
        if (!await canAdoptBootServerCredentials(bootServerUrl)) {
            return await readRetainedBootCredentials();
        }
        if (webServerOverride) {
            bootstrapActiveServerFromWebLocation({
                scope: 'device',
            });
        }
        const bootServerProfile = upsertAndActivateServer({
            serverUrl: bootServerUrl,
            source: 'url',
            scope: 'device',
        });
        const credentials = await TokenStorage.getCredentialsForServerUrl(bootServerUrl, {
            serverId: bootServerProfile.id,
        });
        if (credentials) {
            return await resolveBootCredentialAdoption(
                credentials,
                {
                    serverUrl: bootServerUrl,
                    serverId: bootServerProfile.id,
                },
            );
        }
        return await resolveAndPersistStackDesktopBootCredentials({
            serverUrl: bootServerUrl,
            serverId: bootServerProfile.id,
        });
    }

    if (canUseStackDesktopBootCredentials(stackRuntimeServerUrl)) {
        if (
            stackRuntimeServerUrl
            && !await canAdoptBootServerCredentials(
                stackRuntimeServerUrl,
            )
        ) {
            return await readRetainedBootCredentials();
        }
        const stackRuntimeServerProfile = activateStackRuntimeServer({ scope: 'device' });
        if (stackRuntimeServerUrl) {
            const credentials = await TokenStorage.getCredentialsForServerUrl(stackRuntimeServerUrl, {
                serverId: stackRuntimeServerProfile?.id,
            });
            if (credentials) {
                return await resolveBootCredentialAdoption(
                    credentials,
                    {
                        serverUrl:
                            stackRuntimeServerUrl,
                        ...(stackRuntimeServerProfile?.id
                            ? {
                                serverId:
                                    stackRuntimeServerProfile.id,
                            }
                            : {}),
                    },
                );
            }
        }
        return await resolveAndPersistStackDesktopBootCredentials(
            stackRuntimeServerUrl
                ? {
                    serverUrl: stackRuntimeServerUrl,
                    ...(stackRuntimeServerProfile?.id
                        ? {
                            serverId:
                                stackRuntimeServerProfile.id,
                        }
                        : {}),
                }
                : undefined,
        );
    }

    const credentials = await readRetainedBootCredentials();
    if (credentials) return credentials;
    return await resolveAndPersistStackDesktopBootCredentials(
        stackRuntimeServerUrl
            ? { serverUrl: stackRuntimeServerUrl }
            : undefined,
    );
}
