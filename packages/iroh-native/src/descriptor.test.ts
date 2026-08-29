import { describe, expect, it } from 'vitest';
import { parseIrohEndpointDescriptor, HOME_TUNNEL_ALPN, TUNNEL_PREAMBLE } from './descriptor';

describe('Iroh endpoint descriptor', () => {
  it('accepts the strict transport-only shape', () => {
    expect(parseIrohEndpointDescriptor({
      endpointId: 'a'.repeat(64),
      relayUrls: ['https://relay.example'],
      directAddresses: ['127.0.0.1:1234'],
    })).toEqual({
      endpointId: 'a'.repeat(64),
      relayUrls: ['https://relay.example'],
      directAddresses: ['127.0.0.1:1234'],
    });
  });

  it('rejects credentials, destinations, and unknown fields', () => {
    expect(() => parseIrohEndpointDescriptor({ endpointId: 'a'.repeat(64), token: 'secret' })).toThrow();
    expect(() => parseIrohEndpointDescriptor({ endpointId: 'a'.repeat(64), port: 80 })).toThrow();
    expect(() => parseIrohEndpointDescriptor({ endpointId: 'a'.repeat(64), extra: true })).toThrow();
  });

  it('publishes the locked ALPN and preamble', () => {
    expect(HOME_TUNNEL_ALPN).toBe('happier/home-tunnel/1');
    expect(TUNNEL_PREAMBLE).toBe(0x01);
  });
});
