import { TokenStorage, subscribeHomeCredentialMutations, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    areAccountSettingsScopesEqual,
    type AccountEncryptionMigrationScope,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createServerFetchAtEndpoint, isIdempotentServerRead, type ServerFetch } from '@/sync/http/client';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';

export type CapturedAccountSettingsRequest = AccountEncryptionMigrationScope & Readonly<{
    endpointUrl: string;
    request: ServerFetch;
    target: Readonly<{
        serverUrl: string;
        serverId: string;
        runtimeOrigin?: string | null;
        homeCarrier?: HomeCarrier;
    }>;
    prepareCredentialAdoption(credentials: AuthCredentials): void;
    isCurrent(): boolean;
    dispose(): void;
}>;

/** Capture the endpoint and lifetime of a rendered Account Settings intent. */
export async function captureAccountSettingsRequest(params: Readonly<{
    credentials: AuthCredentials;
    settingsScope: AccountSettingsScope;
    signal?: AbortSignal;
}>): Promise<CapturedAccountSettingsRequest | null> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || !areAccountSettingsScopesEqual(lifetime.scope, params.settingsScope) || !lifetime.isCurrent()) return null;
    const activeServer = getActiveServerSnapshot();
    if (activeServer.serverId !== params.settingsScope.serverId || params.signal?.aborted) return null;
    const abortController = new AbortController();
    let adoptionCredentials: AuthCredentials | null = null;
    const abort = () => abortController.abort('account-settings-scope-retired');
    const retirement = lifetime.onRetire(abort);
    const credentialMutation = subscribeHomeCredentialMutations((event) => {
        if (event.serverId !== params.settingsScope.serverId) return;
        if (
            adoptionCredentials
            && event.credentials
            && event.credentials.token === adoptionCredentials.token
        ) {
            adoptionCredentials = null;
            return;
        }
        adoptionCredentials = null;
        abort();
    });
    params.signal?.addEventListener('abort', abort, { once: true });
    const homeCarrier = getActiveServerHomeCarrier();
    const isCurrent = (): boolean => lifetime.isCurrent() && !abortController.signal.aborted;
    const dispose = (): void => {
        retirement.dispose();
        credentialMutation();
        params.signal?.removeEventListener('abort', abort);
        abortController.abort('account-settings-request-settled');
    };
    // Settings can mount for the next Home before AuthContext publishes its
    // credentials. Validate the supplied bearer against its captured endpoint.
    const endpointCredentials = await TokenStorage.getCredentialsForServerUrl(
        activeServer.serverUrl,
        { serverId: params.settingsScope.serverId },
    ).catch(() => null);
    if (!isCurrent() || endpointCredentials?.token !== params.credentials.token) {
        dispose();
        return null;
    }
    const request: ServerFetch = async (path, init, options) => {
        if (!isCurrent()) throw new Error('Account Settings request scope changed');
        const readOnly = isIdempotentServerRead(init?.method ?? 'GET', path);
        const capturedRequest = createServerFetchAtEndpoint({
            endpointUrl: activeServer.serverUrl,
            ...(activeServer.runtimeOrigin ? { runtimeOrigin: activeServer.runtimeOrigin } : {}),
            ...(homeCarrier ? { homeCarrier } : {}),
            credentials: params.credentials,
            serverId: params.settingsScope.serverId,
            ...(readOnly ? { signal: abortController.signal } : {}),
        });
        // Retirement cancels reads, but an admitted write may already have committed.
        // Keep its acknowledgement observable on the original endpoint and bearer.
        const response = await capturedRequest(path, init, options);
        // A received mutation acknowledgement remains an external fact after
        // retirement. The one-shot writer parses it and keeps projection scoped;
        // read responses still fail closed before their content reaches callers.
        if (readOnly && !isCurrent()) {
            throw new Error('Account Settings request scope changed');
        }
        return response;
    };
    return {
        scope: params.settingsScope,
        endpointUrl: activeServer.serverUrl,
        request,
        target: {
            serverUrl: activeServer.serverUrl,
            serverId: params.settingsScope.serverId,
            ...(activeServer.runtimeOrigin ? { runtimeOrigin: activeServer.runtimeOrigin } : {}),
            ...(homeCarrier ? { homeCarrier } : {}),
        },
        prepareCredentialAdoption(credentials: AuthCredentials): void {
            adoptionCredentials = credentials;
        },
        isCurrent,
        dispose,
    };
}
