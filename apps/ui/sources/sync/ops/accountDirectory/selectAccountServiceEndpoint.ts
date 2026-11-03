import {
    accountDirectoryAuthClient,
    type AccountDirectoryAuthMethodDiscoveryResult,
    type AccountDirectoryAuthMethodDiscovery,
    type AccountDirectoryAuthTransport,
} from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { normalizeAccountDirectoryEndpoint } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';
import {
    DEFAULT_ACCOUNT_SERVICE_ENDPOINT,
    setAccountServiceEndpoint,
    type AccountServiceEndpointV1,
} from '@/sync/domains/server/serverProfiles';

export type CheckAccountServiceEndpointResult =
    | Extract<AccountDirectoryAuthMethodDiscoveryResult, { kind: 'organization_policy_locked' | 'organization_policy_invalid' }>
    | Readonly<{
        kind: 'verified';
        /** The selection to persist on "use": the observed address, identity and name. */
        endpoint: AccountServiceEndpointV1;
        discovery: AccountDirectoryAuthMethodDiscovery;
    }>
    | Readonly<{
        kind: 'home_endpoint';
        homeServerIdentityId: string;
        homeUrl: string;
    }>
    | Readonly<{ kind: 'invalid' | 'unsupported' | 'unavailable' }>;

export type SelectAccountServiceEndpointResult =
    | Readonly<{ kind: 'selected' }>
    | Extract<CheckAccountServiceEndpointResult, { kind: 'home_endpoint' | 'organization_policy_locked' | 'organization_policy_invalid' }>
    | Readonly<{ kind: 'invalid' | 'unsupported' | 'unavailable' }>;

/**
 * Checks what an entered sign-in service offers, without saving anything. Only a service that can
 * find Homes verifies; its observed address, identity and presented name become the selection a
 * later `applyCheckedAccountServiceEndpoint` persists.
 */
export async function checkAccountServiceEndpoint(
    entered: string,
    options: AccountDirectoryAuthTransport & Readonly<{ signal: AbortSignal }>,
): Promise<CheckAccountServiceEndpointResult> {
    const endpointUrl = normalizeAccountDirectoryEndpoint(entered);
    if (!endpointUrl) return { kind: 'invalid' };
    const { signal, ...transport } = options;

    try {
        const discovery = await accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl,
            ...transport,
            signal,
        });
        if (discovery.kind === 'organization_policy_locked' || discovery.kind === 'organization_policy_invalid') return discovery;
        if (discovery.kind === 'not_account_service') {
            const homeServerIdentityId = discovery.serverIdentityId?.trim() ?? '';
            const homeUrl = normalizeAccountDirectoryEndpoint(
                discovery.snapshot.features.capabilities.server.canonicalServerUrl ?? '',
            );
            if (homeServerIdentityId && homeUrl && !signal.aborted) {
                return { kind: 'home_endpoint', homeServerIdentityId, homeUrl };
            }
            return { kind: 'unsupported' };
        }
        if (discovery.kind !== 'supported_account_service') {
            return { kind: 'unavailable' };
        }
        if (signal.aborted) return { kind: 'unavailable' };
        // The default service keeps its own name and provenance; any other is the user's choice.
        const isDefault = normalizeAccountDirectoryEndpoint(DEFAULT_ACCOUNT_SERVICE_ENDPOINT.url) === discovery.endpointUrl;
        return {
            kind: 'verified',
            endpoint: isDefault
                ? { ...DEFAULT_ACCOUNT_SERVICE_ENDPOINT, serverIdentityId: discovery.serverIdentityId }
                : {
                    url: discovery.endpointUrl,
                    serverIdentityId: discovery.serverIdentityId,
                    // Only a name the service presents is saved; its address is never its name.
                    ...(discovery.accountServiceDisplayName?.trim()
                        ? { displayName: discovery.accountServiceDisplayName.trim() }
                        : {}),
                    source: 'user',
                },
            discovery,
        };
    } catch {
        return { kind: 'unavailable' };
    }
}

/** Makes a checked service the selected sign-in service. Stored sign-ins of other services stay. */
export async function applyCheckedAccountServiceEndpoint(
    checked: Extract<CheckAccountServiceEndpointResult, { kind: 'verified' }>,
): Promise<void> {
    await setAccountServiceEndpoint(checked.endpoint);
}

/** Checks and selects in one step (onboarding's form, which has no separate review step). */
export async function selectAccountServiceEndpoint(
    entered: string,
    options: AccountDirectoryAuthTransport & Readonly<{ signal: AbortSignal }>,
): Promise<SelectAccountServiceEndpointResult> {
    const checked = await checkAccountServiceEndpoint(entered, options);
    if (checked.kind !== 'verified') return checked;
    if (options.signal.aborted) return { kind: 'unavailable' };
    try {
        await applyCheckedAccountServiceEndpoint(checked);
        return { kind: 'selected' };
    } catch {
        return { kind: 'unavailable' };
    }
}
