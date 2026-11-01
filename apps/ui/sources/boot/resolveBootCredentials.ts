import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { parseAuthCredentials, TokenStorage } from '@/auth/storage/tokenStorage';
import { isTerminalConnectWebPathname, parseTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';
import { TERMINAL_CONNECT_WEB_BOOTSTRAP_STORAGE_KEY } from '@/utils/path/terminalConnectWebBootstrap';
import {
    bootstrapActiveServerFromWebLocation,
    readWebDestinationServerIdFromLocation,
    readWebServerUrlOverrideFromLocation,
} from '@/sync/domains/server/url/bootstrapActiveServerFromWebLocation';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { getServerProfileById, resolveUniqueServerProfileByUrl } from '@/sync/domains/server/serverProfiles';
import {
    getActiveServerSnapshot,
    setActiveServer,
} from '@/sync/domains/server/serverRuntime';
import { activateStackRuntimeServer, readStackRuntimeServerUrl } from '@/sync/domains/server/stackRuntimeServer';
import { invokeDesktopHost, isDesktopHost } from '@/utils/platform/desktopHost';
import { guardAccountEncryptionFirstKeyCredentialMutation } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';

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

/**
 * The only decoder for the CLI's `servers/<id>/access.key` JSON, which both desktop hosts pass
 * through unread. Keys the CLI marked historical are not active E2EE material on this device, so
 * they, like a missing or invalid file, settle to ordinary sign-in.
 */
function parseDesktopBootCredentials(value: unknown): AuthCredentials | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { secret, encryption, ...record } = value as Record<string, unknown>;
    if (record.custody === 'historical') return null;
    // Released CLIs write `null` for absent material (0.2 token-only: `encryption: null`).
    return parseAuthCredentials({
        ...record,
        ...(secret !== null && secret !== undefined ? { secret } : {}),
        ...(encryption !== null && encryption !== undefined ? { encryption } : {}),
    });
}

function canUseStackDesktopBootCredentials(bootServerUrl?: string | null): boolean {
    if (!isDesktopHost()) return false;
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
        const credentials = await invokeDesktopHost<unknown>('desktop_read_stack_boot_credentials');
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

async function canAdoptBootServerCredentials(serverUrl: string, serverId?: string): Promise<boolean> {
    const currentGuard =
        await guardAccountEncryptionFirstKeyCredentialMutation();
    if (currentGuard.kind !== 'allowed') return false;

    const targetGuard =
        await guardAccountEncryptionFirstKeyCredentialMutation({
            serverUrl,
            ...(serverId ? { serverId } : {}),
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
    const routineSelectionScope = resolveRoutineServerSelectionScope(platformOs, isDesktopHost());
    const webServerOverride = platformOs === 'web'
        ? readWebServerUrlOverrideFromLocation()
        : null;
    const stackRuntimeServerUrl = platformOs === 'web' ? readStackRuntimeServerUrl() : null;

    const explicitBootServerUrl = webServerOverride?.serverUrl
        ?? (platformOs === 'web' ? resolveBootServerUrlFromTerminalConnectHash() : null);
    const destinationServerId = platformOs === 'web' && !explicitBootServerUrl
        ? readWebDestinationServerIdFromLocation()
        : null;
    const destinationServer = destinationServerId ? getServerProfileById(destinationServerId) : null;
    // An explicit destination cannot borrow an unrelated Home's credential or create a profile.
    if (destinationServerId && !destinationServer) return null;
    const bootServerUrl = explicitBootServerUrl
        ?? destinationServer?.canonicalServerUrl
        ?? destinationServer?.serverUrl;

    if (bootServerUrl) {
        const savedBootServer = destinationServer ?? resolveUniqueServerProfileByUrl(bootServerUrl);
        if (!savedBootServer) {
            // The URL remains intact for the mounted Home connect flow. Boot has no
            // modal owner with which to confirm and prove a new address before saving.
            return webServerOverride || destinationServerId ? null : await readRetainedBootCredentials();
        }
        if (!await canAdoptBootServerCredentials(bootServerUrl, savedBootServer.id)) {
            return webServerOverride || destinationServerId ? null : await readRetainedBootCredentials();
        }
        if (webServerOverride) {
            await bootstrapActiveServerFromWebLocation({
                scope: routineSelectionScope,
            });
        }
        await setActiveServer({ serverId: savedBootServer.id, scope: routineSelectionScope });
        const credentials = await TokenStorage.getCredentialsForServerUrl(bootServerUrl, {
            serverId: savedBootServer.id,
        });
        if (credentials) {
            return await resolveBootCredentialAdoption(
                credentials,
                {
                    serverUrl: bootServerUrl,
                    serverId: savedBootServer.id,
                },
            );
        }
        return await resolveAndPersistStackDesktopBootCredentials({
            serverUrl: bootServerUrl,
            serverId: savedBootServer.id,
        });
    }

    if (stackRuntimeServerUrl) {
        if (
            !await canAdoptBootServerCredentials(
                stackRuntimeServerUrl,
            )
        ) {
            return await readRetainedBootCredentials();
        }
        const stackRuntimeServerProfile = await activateStackRuntimeServer({
            scope: routineSelectionScope,
        });
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
        if (!canUseStackDesktopBootCredentials(stackRuntimeServerUrl)) return null;
        return await resolveAndPersistStackDesktopBootCredentials(
            {
                serverUrl: stackRuntimeServerUrl,
                ...(stackRuntimeServerProfile?.id
                    ? {
                        serverId:
                            stackRuntimeServerProfile.id,
                    }
                    : {}),
            },
        );
    }

    const credentials = await readRetainedBootCredentials();
    if (credentials) return credentials;
    return await resolveAndPersistStackDesktopBootCredentials(
        undefined,
    );
}
