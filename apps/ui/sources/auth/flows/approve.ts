import { createServerFetchAtEndpoint } from '@/sync/http/client';
import type { HomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';

interface AuthRequestStatus {
    status: 'not_found' | 'pending' | 'authorized';
    supportsV2: boolean;
}

export type AuthApproveResult = 'approved' | 'already_authorized' | 'not_found';

type AuthRequestFetcher = (
    path: string,
    init?: RequestInit,
    options?: { includeAuth: boolean },
) => Promise<Response>;

async function readAuthRequestStatus(fetchAt: AuthRequestFetcher, publicKeyBase64: string, signal?: AbortSignal): Promise<AuthRequestStatus> {
    const statusResponse = await fetchAt(`/v1/auth/request/status?publicKey=${encodeURIComponent(publicKeyBase64)}`, {
        method: 'GET',
        signal,
    }, { includeAuth: false });
    if (!statusResponse.ok) {
        throw new Error(`Failed to check auth status: ${statusResponse.status}`);
    }
    return await statusResponse.json() as AuthRequestStatus;
}

type AuthApprovePayload = Readonly<{
    /** Bearer for the target Home only; it authorizes the POST and is never sent as payload. */
    token: string;
    publicKeyBase64: string;
    /** Opaque sealed response prepared by the pairing requester (carries no credential). */
    responseBase64: string;
    /** Canonical provisioning discriminant; must match the sealed v3 payload bytes. */
    responseKind: 'tokenOnly' | 'dataKey';
    signal?: AbortSignal;
}>;

export type AuthApproveAtEndpointParams = AuthApprovePayload & Readonly<{
    /** Explicit local/native target endpoint; never resolved from the focused Home. */
    endpointUrl: string;
    serverId?: string;
}>;

export type AuthApproveWithTransportParams = AuthApprovePayload & Readonly<{
    transport: HomeEnrollmentTransport;
}>;

async function authApproveWithRequest(
    fetchAt: AuthRequestFetcher,
    params: AuthApprovePayload,
): Promise<AuthApproveResult> {
    params.signal?.throwIfAborted();
    const publicKeyBase64 = params.publicKeyBase64.trim();
    if (!publicKeyBase64) {
        throw new Error('Failed to approve auth request: missing public key');
    }

    const statusData = await readAuthRequestStatus(fetchAt, publicKeyBase64, params.signal);
    params.signal?.throwIfAborted();
    if (statusData.status === 'not_found') {
        return 'not_found';
    }
    if (statusData.status === 'authorized') {
        return 'already_authorized';
    }

    const response = await fetchAt('/v1/auth/response', {
        method: 'POST',
        signal: params.signal,
        headers: {
            'Authorization': `Bearer ${params.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            publicKey: publicKeyBase64,
            response: params.responseBase64,
            responseKind: params.responseKind,
            // Approving this terminal is the explicit unattended-use decision;
            // ordinary device pairing/recovery use their separate endpoints.
            authorizeUnattendedTeamAccess: true,
        }),
    }, { includeAuth: false });
    if (!response.ok) {
        throw new Error(`Failed to approve auth request: ${response.status}`);
    }
    return 'approved';
}

/** Approve through the already-resolved canonical Home transport. */
export async function authApproveWithTransport(
    params: AuthApproveWithTransportParams,
): Promise<AuthApproveResult> {
    return await authApproveWithRequest(
        params.transport.createRequest({ credentials: null }),
        params,
    );
}

/**
 * Thin explicit-endpoint adapter for genuine local/native setup targets that do not own a
 * persisted Home descriptor. Ordinary terminal and remote-SSH pairing resolve the canonical
 * Home transport and use `authApproveWithTransport` instead. Both paths share the protocol
 * owner above and never consult or switch the focused Home.
 */
export async function authApproveAtEndpoint(params: AuthApproveAtEndpointParams): Promise<AuthApproveResult> {
    const fetchAt = createServerFetchAtEndpoint({
        endpointUrl: params.endpointUrl,
        ...(params.serverId ? { serverId: params.serverId } : {}),
        credentials: null,
    });
    return await authApproveWithRequest(fetchAt, params);
}
