import { describe, expect, it } from 'vitest';
import { rewriteDirectPeerEndpointCandidatesForTransferId } from './rewriteDirectPeerEndpointCandidatesForTransferId';

describe('rewriteDirectPeerEndpointCandidatesForTransferId', () => {
  it('does not throw when an http endpoint does not match the direct-peer URL marker', () => {
    const endpointCandidates = [
      { kind: 'https', url: 'https://example.com/not-a-direct-peer-endpoint', expiresAt: 0 },
    ] as const;

    expect(() =>
      rewriteDirectPeerEndpointCandidatesForTransferId({
        endpointCandidates,
        transferId: 't1',
      })
    ).not.toThrow();
  });

  it('rewrites the direct-peer URL path for the transfer id and strips query/hash', () => {
    const endpointCandidates = [
      { kind: 'https', url: 'https://user:pass@example.com/machine-transfers/direct/OLD?token=leak#frag', expiresAt: 0 },
    ] as const;

    const rewritten = rewriteDirectPeerEndpointCandidatesForTransferId({
      endpointCandidates,
      transferId: 'hello',
    });

    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]?.url).toBe('https://example.com/machine-transfers/direct/aGVsbG8');
  });
});
