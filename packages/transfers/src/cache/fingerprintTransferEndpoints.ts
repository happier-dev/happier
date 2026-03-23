import { TransferEndpointCandidateSchema, type TransferEndpointCandidate } from '@happier-dev/protocol';

function normalizeTransferEndpointCandidate(candidate: TransferEndpointCandidate): string | null {
    const parsedCandidate = TransferEndpointCandidateSchema.safeParse(candidate);
    if (!parsedCandidate.success) {
        return null;
    }
    try {
        const parsedUrl = new URL(parsedCandidate.data.url);
        parsedUrl.searchParams.delete('token');
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
