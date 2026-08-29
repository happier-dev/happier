import { describe, expect, it } from 'vitest';
import { IROH_NODE_ID_HEADER, readIrohNodeIdHeader } from './relayAdmission';

describe('Iroh relay admission header', () => {
  it('accepts only the upstream X-Iroh-NodeId header', () => {
    const nodeId = 'AB'.repeat(32);
    expect(IROH_NODE_ID_HEADER).toBe('x-iroh-nodeid');
    expect(readIrohNodeIdHeader({ 'X-Iroh-NodeId': ` ${nodeId} ` })).toBe(nodeId.toLowerCase());
    expect(readIrohNodeIdHeader({ 'X-Iroh-Node-ID': nodeId })).toBeNull();
    expect(readIrohNodeIdHeader({ 'X-Iroh-NodeId': 'not-a-node' })).toBeNull();
  });
});
