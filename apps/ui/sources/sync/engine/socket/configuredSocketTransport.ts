import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { bindCurrentAccountEncryptionObservation, readAccountEncryptionObservationBinding, type AccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';
import { StaleServerGenerationError, type ServerFetch, type ServerFetchOptions } from '@/sync/http/client';

type ConfiguredTransportRequest = (path: string, init?: RequestInit, options?: ServerFetchOptions) => Promise<Response>;

/**
 * Sync's ambient request travels over whichever transport is configured when it
 * is called. One selection decides both where it sends and whose Account
 * encryption observation it may borrow, so the two can never diverge.
 */
export function createConfiguredSocketRequest(params: Readonly<{
    /** The embed Session scope's request, when one is bound. */
    readEmbedRequest: () => ConfiguredTransportRequest | null;
    /** An embed window without its scope has no transport. */
    isEmbedWindow: () => boolean;
    socket: Readonly<{
        request: ConfiguredTransportRequest;
        getAccountEncryptionObservationBinding: (credentials: AuthCredentials) => AccountEncryptionObservationBinding | null;
    }>;
}>): ServerFetch {
    const select = () => {
        const embedRequest = params.readEmbedRequest();
        if (embedRequest) return {
            request: embedRequest,
            readBinding: (credentials: AuthCredentials) => readAccountEncryptionObservationBinding(embedRequest, credentials),
        };
        if (params.isEmbedWindow()) return null;
        return {
            request: params.socket.request,
            readBinding: params.socket.getAccountEncryptionObservationBinding,
        };
    };
    const request: ServerFetch = async (path, init, options) => {
        const transport = select();
        if (!transport) throw new StaleServerGenerationError();
        return await transport.request(path, init, options);
    };
    return bindCurrentAccountEncryptionObservation(request, credentials => select()?.readBinding(credentials) ?? null);
}
