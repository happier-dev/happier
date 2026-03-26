import { TransferEndpointCandidateSchema, type TransferEndpointCandidate } from '@happier-dev/protocol';

function normalizeTransferEndpointCandidate(candidate: TransferEndpointCandidate): string | null {
    const parsedCandidate = TransferEndpointCandidateSchema.safeParse(candidate);
    if (!parsedCandidate.success) {
        return null;
    }
    try {
        const parsedUrl = new URL(parsedCandidate.data.url);
        // Endpoint URLs are untrusted and may contain legacy/accidental secrets in userinfo/query/hash.
        // Strip them so cache fingerprints don't leak tokens and don't churn unnecessarily.
        parsedUrl.username = '';
        parsedUrl.password = '';
        parsedUrl.search = '';
        parsedUrl.hash = '';
        return `${parsedCandidate.data.kind}:${parsedUrl.toString()}`;
    } catch {
        return `${parsedCandidate.data.kind}:${parsedCandidate.data.url}`;
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
