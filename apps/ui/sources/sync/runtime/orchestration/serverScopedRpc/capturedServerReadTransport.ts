import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import { createServerFetchAtEndpoint, type ServerFetchOptions, type ServerResponseRequest } from '@/sync/http/client';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { readHomeAccountReadRevision } from '@/sync/runtime/orchestration/homeAccountChange';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import type { AccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';

import { resolveServerScopedTransport } from './resolveServerScopedTransport';

/** Physical read binding only. Every borrower still admits its own authority and result. */
export type CapturedServerReadTransport = Readonly<{
    /** Existing prepared configuration lifetime; not a borrower or an authorization verdict. */
    scope?: object;
    /** Snapshot once per acquisition; a Home wake separates later demand from incumbent reads. */
    key: string;
    read<T>(path: string, init: RequestInit | undefined, options: ServerFetchOptions | undefined,
        consumeResponse: (response: Response) => Promise<T>): Promise<T>;
}>;

/**
 * Use the captured request owner's exact profile/credential inputs, but not one
 * borrower's cancellation closure. The pending owner supplies the shared signal
 * and owns it until the last borrower leaves. Response consumption retains the
 * acquired carrier; returning a raw Response here would release it too early.
 */
type CapturedProfile = Parameters<typeof resolveServerScopedTransport>[0]['profile'];
export type CapturedServerRequestPreparation = (path: string, init: RequestInit | undefined) => Promise<RequestInit | undefined>;
type PreparedReadTransport = Readonly<{
    endpointUrl: string;
    runtimeOrigin?: string;
    carrier?: 'https' | 'iroh';
    homeCarrier?: HomeCarrier | null;
    generation: number;
    request: ServerResponseRequest;
    scope?: object;
}>;

export function createCapturedServerReadTransport(params: Readonly<{
    serverId: string;
    credentials: AuthCredentials;
    accountEncryptionObservation?: AccountEncryptionObservationBinding;
    superviseReachability?: boolean;
    /** An admitted finite invocation retains its own HTTP proof and read scope. */
    prepareRequest?: CapturedServerRequestPreparation;
} & ({ profile: CapturedProfile; prepared?: never } | { prepared: PreparedReadTransport; profile?: CapturedProfile })>): CapturedServerReadTransport {
    if (params.prepared) {
        const prepared = params.prepared;
        // The prepared request already owns the incumbent carrier and its
        // configuration retirement fence. Never resolve a staged profile here.
        const bindingKey = createCanonicalJsonSigningInput([
            'prepared', resolveServerProfileScopeIdForIdentifier(params.serverId),
            canonicalizeServerUrl(prepared.endpointUrl), prepared.runtimeOrigin ?? null,
            prepared.carrier ?? null, prepared.homeCarrier?.endpointId ?? null,
            prepared.generation, resolveAuthCredentialsScopeKey(params.credentials),
        ]);
        return {
            ...(params.prepareRequest ? { scope: params } : prepared.scope ? { scope: prepared.scope } : {}),
            get key() { return JSON.stringify([bindingKey, readHomeAccountReadRevision(params.serverId)]); },
            async read(path, init, options, consumeResponse) {
                throwIfAborted(init?.signal ?? undefined);
                const requestInit = params.prepareRequest ? await params.prepareRequest(path, init) : init;
                return await prepared.request(path, requestInit, { recoveryRead: 'unbounded', ...options }, consumeResponse);
            },
        };
    }
    const profile = {
        serverUrl: params.profile.serverUrl,
        canonicalServerUrl: params.profile.canonicalServerUrl,
        homeConnectionDescriptor: params.profile.homeConnectionDescriptor,
    };
    const bindingKey = createCanonicalJsonSigningInput([
        resolveServerProfileScopeIdForIdentifier(params.serverId),
        canonicalizeServerUrl(profile.canonicalServerUrl ?? profile.serverUrl),
        profile.homeConnectionDescriptor ?? null,
        resolveAuthCredentialsScopeKey(params.credentials),
    ]);
    return {
        ...(params.prepareRequest ? { scope: params } : {}),
        get key() {
            return JSON.stringify([bindingKey, readHomeAccountReadRevision(params.serverId)]);
        },
        async read(path, init, options, consumeResponse) {
            throwIfAborted(init?.signal ?? undefined);
            const requestInit = params.prepareRequest ? await params.prepareRequest(path, init) : init;
            const transport = await resolveServerScopedTransport({ profile, credentials: params.credentials });
            try {
                throwIfAborted(init?.signal ?? undefined);
                return await createServerFetchAtEndpoint({
                    endpointUrl: transport.canonicalServerUrl,
                    runtimeOrigin: transport.runtimeOrigin,
                    serverId: params.serverId,
                    credentials: params.credentials,
                    accountEncryptionObservation: params.accountEncryptionObservation,
                    recoverStoredCredentials: true,
                    superviseReachability: params.superviseReachability,
                    ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
                })(path, requestInit, { recoveryRead: 'unbounded', ...options }, consumeResponse);
            } finally {
                await transport.release();
            }
        },
    };
}
