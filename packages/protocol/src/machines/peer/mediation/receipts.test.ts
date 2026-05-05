import { describe, expect, it } from 'vitest';

import { PEER_MEDIATION_RECEIPTS } from './receipts.js';

describe('PEER_MEDIATION_RECEIPTS', () => {
  it('includes deterministic TCP tunnel lifecycle receipts', () => {
    expect(PEER_MEDIATION_RECEIPTS.tunnelOpened).toBe('peer.tunnel.opened');
    expect(PEER_MEDIATION_RECEIPTS.tunnelClosed).toBe('peer.tunnel.closed');
  });
});
