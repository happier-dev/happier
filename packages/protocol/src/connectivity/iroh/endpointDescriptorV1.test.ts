import { describe, expect, it } from 'vitest';

import {
  IROH_DESCRIPTOR_MAX_RELAY_URLS,
  IROH_ENDPOINT_DESCRIPTOR_VERSION_V1,
  IrohEndpointDescriptorV1Schema,
  IrohRelayUrlsV1Schema,
  parseIrohEndpointDescriptorV1,
  type IrohEndpointDescriptorV1,
} from './endpointDescriptorV1.js';

const VALID_DESCRIPTOR = {
  endpointId: 'a'.repeat(64),
  relayUrls: ['https://relay.example.test'],
  directAddresses: ['127.0.0.1:1234'],
};

describe('IrohEndpointDescriptorV1 (canonical Iroh endpoint sub-descriptor)', () => {
  it('accepts the strict transport-only shape without duplicating a version field', () => {
    expect(IrohEndpointDescriptorV1Schema.parse(VALID_DESCRIPTOR)).toEqual(VALID_DESCRIPTOR);
    expect(IrohEndpointDescriptorV1Schema.safeParse({ ...VALID_DESCRIPTOR, v: 1 }).success).toBe(false);
    expect(IROH_ENDPOINT_DESCRIPTOR_VERSION_V1).toBe(1);
  });

  it('accepts endpoint IDs the native Iroh FromStr grammar accepts', () => {
    // 32-byte key as 64 lowercase hex characters (Iroh Display/FromStr canonical form).
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      endpointId: '3f9a2c7e5b1d4a8f9e0c2b6d4f8a1c3e5b7d9f0a2c4e6b8d0f2a4c6e8b0d1f3a',
    }).success).toBe(true);
    // Unpadded lowercase RFC4648 base32 of the exact decoded length (52 chars = 32 bytes).
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      endpointId: 'a'.repeat(52),
    }).success).toBe(true);
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      endpointId: 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst',
    }).success).toBe(true);
  });

  it('rejects arbitrary, malformed-length, and mixed-alphabet endpoint IDs', () => {
    const invalidEndpointIds = [
      'endpoint-home-iroh',
      'hello',
      // Not 64 lowercase hex and not 52 lowercase base32.
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      'a'.repeat(51),
      'a'.repeat(53),
      'a'.repeat(256),
      // '0' and '1' are not in the RFC4648 base32 alphabet.
      '0'.repeat(52),
      '1'.repeat(52),
      // Hex length with one non-hex character: mixed wire garbage.
      `${'a'.repeat(63)}g`,
      `${'a'.repeat(31)}G${'a'.repeat(32)}`,
      '',
      '   ',
    ];
    for (const endpointId of invalidEndpointIds) {
      expect(IrohEndpointDescriptorV1Schema.safeParse({ ...VALID_DESCRIPTOR, endpointId }).success).toBe(false);
    }
  });

  it('accepts strict IP socket address direct hints', () => {
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      directAddresses: [
        '192.0.2.10:443',
        '127.0.0.1:1',
        '[2001:db8::1]:443',
        '[::1]:65535',
        '[::ffff:192.0.2.128]:8080',
        '[2001:0db8:0000:0000:0000:0000:0000:0001]:443',
      ],
    }).success).toBe(true);
  });

  it('rejects non-socket-address direct hints', () => {
    const invalidDirectAddresses = [
      // DNS names are never socket addresses.
      'relay.example.test:443',
      'localhost:8080',
      // URLs, paths, and credentials are not bare socket addresses.
      'https://192.0.2.10:443',
      'http://[::1]:8080',
      '192.0.2.10:443/path',
      '[2001:db8::1]:443/tunnel',
      'user@192.0.2.10:443',
      // Missing, zero, negative, and out-of-range ports.
      '192.0.2.10',
      '192.0.2.10:',
      '192.0.2.10:0',
      '192.0.2.10:-1',
      '192.0.2.10:65536',
      '192.0.2.10:99999',
      '[2001:db8::1]',
      // Unbracketed IPv6 is ambiguous and must be rejected.
      '::1:443',
      '2001:db8::1:443',
      // Malformed address material.
      '256.0.2.10:443',
      '01.0.2.10:443',
      '[zz::1]:443',
      '[2001:db8::::1]:443',
      '',
    ];
    for (const directAddresses of invalidDirectAddresses) {
      expect(IrohEndpointDescriptorV1Schema.safeParse({
        ...VALID_DESCRIPTOR,
        directAddresses: [directAddresses],
      }).success).toBe(false);
    }
  });

  it('rejects credentials, bearer material, and unknown fields', () => {
    expect(IrohEndpointDescriptorV1Schema.safeParse({ ...VALID_DESCRIPTOR, token: 'secret' }).success).toBe(false);
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      relayUrls: ['https://user:pass@relay.example.test'],
    }).success).toBe(false);
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      relayUrls: ['ftp://relay.example.test'],
    }).success).toBe(false);
    expect(IrohEndpointDescriptorV1Schema.safeParse({ ...VALID_DESCRIPTOR, extra: true }).success).toBe(false);
  });

  it('rejects relay URL query material so deployment credentials cannot enter descriptors', () => {
    for (const relayUrl of [
      'https://relay.example.test?token=shared-secret',
      'https://relay.example.test/path?admission=enabled',
      'https://relay.example.test?',
    ]) {
      expect(IrohEndpointDescriptorV1Schema.safeParse({
        ...VALID_DESCRIPTOR,
        relayUrls: [relayUrl],
      }).success).toBe(false);
    }
  });

  it('accepts valid unique hint lists beyond the former arbitrary item ceilings', () => {
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      directAddresses: Array.from({ length: 17 }, (_, index) => `192.0.2.${index + 1}:443`),
    }).success).toBe(true);
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      relayUrls: Array.from({ length: 9 }, (_, index) => `https://relay-${index}.example.test`),
    }).success).toBe(true);
  });

  it('keeps relay URL strictness intact alongside the address grammar', () => {
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      relayUrls: ['https://relay.example.test/holepunch'],
    }).success).toBe(true);
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      relayUrls: ['relay.example.test'],
    }).success).toBe(false);
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      relayUrls: ['https://relay.example.test#fragment'],
    }).success).toBe(false);
  });

  it('rejects empty and duplicate hint lists', () => {
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      relayUrls: [],
    }).success).toBe(false);
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      directAddresses: [],
    }).success).toBe(false);
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      relayUrls: ['https://relay.example.test', 'https://relay.example.test'],
    }).success).toBe(false);
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      directAddresses: ['192.0.2.10:443', ' 192.0.2.10:443 '],
    }).success).toBe(false);
    // Distinct entries remain acceptable.
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      relayUrls: ['https://relay.example.test', 'https://backup.example.test'],
      directAddresses: ['192.0.2.10:443', '[2001:db8::1]:443'],
    }).success).toBe(true);
  });

  it('rejects relay URLs that differ only by normalization, exactly like the native transport owner', () => {
    // `RelaySelection::resolve`
    // (packages/iroh-native/rust/happier-iroh-core/src/endpoint.rs) parses every
    // hint with iroh's `RelayUrl` and rejects entries that normalize to the same
    // relay. Admitting them here would publish a descriptor the transport owner
    // refuses to bind, so the ambiguity has to fail at the producer instead.
    for (const relayUrls of [
      ['https://relay.example.test', 'https://relay.example.test/'],
      ['https://relay.example.test/', 'https://RELAY.example.test/'],
      ['https://relay.example.test:443/', 'https://relay.example.test/'],
    ]) {
      expect(IrohEndpointDescriptorV1Schema.safeParse({ ...VALID_DESCRIPTOR, relayUrls }).success).toBe(false);
    }
    // Two relays that merely share a host are still two distinct relays.
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      relayUrls: ['https://relay.example.test/', 'https://relay.example.test/backup'],
    }).success).toBe(true);
  });

  it('rejects non-canonical (leading-zero) ports on direct addresses', () => {
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      directAddresses: ['192.0.2.10:0443'],
    }).success).toBe(false);
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      directAddresses: ['[2001:db8::1]:0080'],
    }).success).toBe(false);
    expect(IrohEndpointDescriptorV1Schema.safeParse({
      ...VALID_DESCRIPTOR,
      directAddresses: ['[2001:db8::1]:0'],
    }).success).toBe(false);
  });

  it('exposes one strict parser that rejects malformed descriptors with a typed error', () => {
    const parsed: IrohEndpointDescriptorV1 = parseIrohEndpointDescriptorV1({
      endpointId: 'a'.repeat(64),
      directAddresses: ['127.0.0.1:1234'],
    });
    expect(parsed.endpointId).toBe('a'.repeat(64));
    expect(parsed.relayUrls).toBeUndefined();
    expect(() => parseIrohEndpointDescriptorV1({ endpointId: '' })).toThrow(TypeError);
    expect(() => parseIrohEndpointDescriptorV1(null)).toThrow(TypeError);
    expect(() => parseIrohEndpointDescriptorV1({ endpointId: 'a'.repeat(64), alpns: ['x'] })).toThrow(TypeError);
    expect(() => parseIrohEndpointDescriptorV1({ endpointId: 'endpoint-home-iroh' })).toThrow(TypeError);
    expect(() => parseIrohEndpointDescriptorV1({ endpointId: 'a'.repeat(64), directAddresses: ['relay.example.test:443'] })).toThrow(TypeError);
  });

  it('enforces the bounded relay URL list ceiling and rejects control characters, internal whitespace, and bare fragments', () => {
    expect(IROH_DESCRIPTOR_MAX_RELAY_URLS).toBe(64);
    const maxList = Array.from({ length: IROH_DESCRIPTOR_MAX_RELAY_URLS }, (_, i) => `https://relay-${i}.example.test`);
    expect(IrohRelayUrlsV1Schema.safeParse(maxList).success).toBe(true);
    const oversized = [...maxList, 'https://relay-overflow.example.test'];
    expect(IrohRelayUrlsV1Schema.safeParse(oversized).success).toBe(false);
    expect(IrohEndpointDescriptorV1Schema.safeParse({ ...VALID_DESCRIPTOR, relayUrls: oversized }).success).toBe(false);

    for (const badUrl of [
      'https://relay.example.test\r\n',
      '\nhttps://relay.example.test',
      'https://relay\t.example.test',
      'https://relay.example.test/path\x00',
      'https://relay.example.test/a b',
      'https://relay.example.test#',
    ]) {
      expect(IrohRelayUrlsV1Schema.safeParse([badUrl]).success).toBe(false);
      expect(IrohEndpointDescriptorV1Schema.safeParse({ ...VALID_DESCRIPTOR, relayUrls: [badUrl] }).success).toBe(false);
    }
  });
});
