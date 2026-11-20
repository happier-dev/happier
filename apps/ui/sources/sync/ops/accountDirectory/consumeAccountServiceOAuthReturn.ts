import { accountDirectoryAuthClient, acquireAccountServiceAuthTransport, createVerifiedAccountServiceAuthority, type AccountDirectoryAuthTransport } from '@/auth/accountDirectory/accountDirectoryAuthClient';
import { parseAccountServiceRouteInput } from '@/auth/accountDirectory/accountDirectoryNavigation';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { isExplicitlyRetryableError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { isServerFeaturesProbeRetryable } from '@/sync/api/capabilities/serverFeaturesClient';
import { completeAccountServicePostAuth, completeAccountServiceHomeAuthentication, type AccountPostAuthInput, type AccountPostAuthResult } from './completeAccountServicePostAuth';

export type AccountServiceOAuthReturnResult =
    | Readonly<{ kind: 'consumed'; input: AccountPostAuthInput; result: AccountPostAuthResult }>
    | Readonly<{ kind: 'absent' | 'invalid' | 'retryable' }>;

export async function consumeAccountServiceOAuthReturn(
    params: Readonly<Record<string, unknown>>,
    options: Readonly<{ invokingSurface: string; signal: AbortSignal; transport?: AccountDirectoryAuthTransport }>,
): Promise<AccountServiceOAuthReturnResult> {
    if (params.accountServiceReturn !== '1') return { kind: 'absent' };
    const route = parseAccountServiceRouteInput(params);
    if (!route || options.signal.aborted) return { kind: 'invalid' };
    if (params.accountEntryReturnTo !== undefined && typeof params.accountEntryReturnTo !== 'string') return { kind: 'invalid' };
    const expected = { ...route, invokingSurface: options.invokingSurface,
        ...(typeof params.accountEntryReturnTo === 'string' ? { accountEntryReturnTo: params.accountEntryReturnTo } : {}) };
    const custody = TokenStorage.readAccountDirectoryOAuthReturn(expected);
    if (!custody) return { kind: 'invalid' };
    let close = async () => {};
    let adoptedInput: AccountPostAuthInput | null = null;
    const release = () => {
        adoptedInput?.session.takeKeyAuthSecret()?.fill(0);
        void close().catch(() => {});
    };
    try {
        const acquired = await acquireAccountServiceAuthTransport(custody, options.transport);
        close = acquired.close;
        options.signal.throwIfAborted();
        const discovery = await accountDirectoryAuthClient.discoverAuthenticationMethods({
            endpointUrl: custody.endpoint, expectedServerIdentityId: custody.serverIdentityId,
            signal: options.signal, ...acquired.transport,
        });
        if (discovery.kind !== 'supported_account_service' || discovery.canonicalServerUrl !== custody.canonicalServerUrl) {
            await close();
            if (discovery.kind === 'endpoint_unavailable' && discovery.reason === 'probe_failed'
                && isServerFeaturesProbeRetryable(discovery.snapshot)) return { kind: 'retryable' };
            return { kind: 'invalid' };
        }
        options.signal.throwIfAborted();
        const claim = await TokenStorage.claimAccountDirectoryOAuthReturn(expected);
        if (!claim || claim.returnCustody !== custody) {
            await close();
            return { kind: 'invalid' };
        }
        let session: AccountDirectorySession;
        try {
            session = new AccountDirectorySession(custody, {
                capability: discovery.capability,
                transport: acquired.transport,
                keyAuthSecret: custody.keyAuthSecret,
                credentialCustody: claim.credentialCustody,
            });
        } finally {
            custody.keyAuthSecret?.fill(0);
        }
        const providerId = custody.signInProviderId;
        const providerPresentation = discovery.authenticationCatalog.methods.find((method) => method.id === providerId)?.presentation;
        const input: AccountPostAuthInput = { service: createVerifiedAccountServiceAuthority(discovery), session,
            credentialTokenDigest: claim.returnCustody.credentialTokenDigest,
            intent: custody.entryIntent, signal: options.signal,
            ...(providerId ? { signInProvider: { id: providerId, presentation: providerPresentation } } : {}),
        };
        adoptedInput = input;
        options.signal.addEventListener('abort', release, { once: true });
        const homeAuthentication = custody.authenticatedHome ?? custody.homeAuthenticationFailure;
        const result = homeAuthentication
            ? await completeAccountServiceHomeAuthentication(input, homeAuthentication)
            : await completeAccountServicePostAuth(input);
        return { kind: 'consumed', input, result };
    } catch (error) {
        options.signal.removeEventListener('abort', release);
        await close().catch(() => {});
        if (adoptedInput) throw error;
        if (!options.signal.aborted && isExplicitlyRetryableError(error)) return { kind: 'retryable' };
        return { kind: 'invalid' };
    }
}
