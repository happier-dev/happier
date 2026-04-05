import { TransferEndpointCandidateSchema, type TransferEndpointCandidate } from '@happier-dev/protocol';

function fingerprintTransferEndpointAuthorizationToken(token: string): string {
    // Derive a stable opaque token fingerprint without retaining the bearer token itself.
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < token.length; index += 1) {
        hash ^= BigInt(token.charCodeAt(index));
        hash = (hash * 0x100000001b3n) & 0xffff_ffff_ffff_ffffn;
    }
    return `te_${hash.toString(36)}_${token.length.toString(36)}`;
}

function normalizeTransferEndpointCandidate(candidate: TransferEndpointCandidate): string | null {
    const parsedCandidate = TransferEndpointCandidateSchema.safeParse(candidate);
    if (!parsedCandidate.success) {
        return null;
    }
    try {
        const parsedUrl = new URL(parsedCandidate.data.url);
        // Endpoint URLs are untrusted and may contain legacy/accidental secrets in userinfo/query/hash.
        // Strip them so cache fingerprints do not retain raw URL auth material.
        parsedUrl.username = '';
        parsedUrl.password = '';
        parsedUrl.search = '';
        parsedUrl.hash = '';
        const authorizationToken = typeof parsedCandidate.data.authorizationToken === 'string'
            ? parsedCandidate.data.authorizationToken.trim()
            : '';
        const authKey = authorizationToken
            ? `:${fingerprintTransferEndpointAuthorizationToken(authorizationToken)}`
            : '';
        return `${parsedCandidate.data.kind}:${parsedUrl.toString()}${authKey}`;
    } catch {
        const authorizationToken = typeof parsedCandidate.data.authorizationToken === 'string'
            ? parsedCandidate.data.authorizationToken.trim()
            : '';
        const authKey = authorizationToken
            ? `:${fingerprintTransferEndpointAuthorizationToken(authorizationToken)}`
            : '';
        return `${parsedCandidate.data.kind}:${parsedCandidate.data.url}${authKey}`;
    }
}

export function fingerprintTransferEndpoints(endpointCandidates: readonly TransferEndpointCandidate[]): string | null {
    const normalizedCandidates = endpointCandidates
        .map(normalizeTransferEndpointCandidate)
        .filter((value): value is string => value !== null)
        .sort();

    if (normalizedCandidates.length === 0) {
        return null;
    }

    return normalizedCandidates.join('\n');
}
