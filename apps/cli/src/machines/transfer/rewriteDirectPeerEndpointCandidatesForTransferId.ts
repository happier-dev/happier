import type { TransferEndpointCandidate } from '@happier-dev/protocol';

export function rewriteDirectPeerEndpointCandidatesForTransferId(input: Readonly<{
  endpointCandidates: readonly TransferEndpointCandidate[];
  transferId: string;
}>): readonly TransferEndpointCandidate[] {
  const encodedKey = Buffer.from(input.transferId, 'utf8').toString('base64url');
  const marker = '/machine-transfers/direct/';

  return input.endpointCandidates.map((candidate) => {
    if (candidate.kind !== 'http' && candidate.kind !== 'https') {
      return candidate;
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate.url);
    } catch {
      return candidate;
    }
    parsed.username = '';
    parsed.password = '';
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex < 0) {
      return candidate;
    }
    parsed.pathname = `${parsed.pathname.slice(0, markerIndex + marker.length)}${encodedKey}`;
    // Direct-peer candidates should not rely on query params for auth or routing.
    parsed.search = '';
    parsed.hash = '';
    return {
      ...candidate,
      url: parsed.toString(),
    };
  });
}
