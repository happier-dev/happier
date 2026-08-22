import { describe, expect, it } from 'vitest';

import { ProviderCredentialTransportV1Schema } from '../credentials/v1.js';
import {
  BUNDLED_PROVIDER_WIRE_PROTOCOLS_V1,
  BundledProviderWireProtocolSchema,
  isBundledProviderWireProtocol,
  PROVIDER_WIRE_PROTOCOL_LIMITS_V1,
  ProviderWireProtocolSchema,
  readBundledProviderWireProtocolFactV1,
  type BundledProviderWireProtocol,
} from './v1.js';

/**
 * A wire protocol is the rendezvous key between a Provider plugin's endpoint
 * and an Agent plugin's `acceptsProtocols`. Both sides are contributable, so
 * the bundled vocabulary is a fact about what Happier ships, never a gate on
 * what a plugin may declare.
 */
const CONTRIBUTED = 'acme-wire-v1';

describe('provider wire protocol identity', () => {
  it('accepts a plugin-contributed protocol alongside every bundled one', () => {
    for (const protocol of BUNDLED_PROVIDER_WIRE_PROTOCOLS_V1) {
      expect(ProviderWireProtocolSchema.parse(protocol)).toBe(protocol);
      expect(BundledProviderWireProtocolSchema.parse(protocol)).toBe(protocol);
    }
    expect(ProviderWireProtocolSchema.parse(CONTRIBUTED)).toBe(CONTRIBUTED);
    // The bundled schema stays exact: it answers "does Happier ship this", and
    // must not silently accept a contributed protocol as a bundled one.
    expect(BundledProviderWireProtocolSchema.safeParse(CONTRIBUTED).success).toBe(false);
  });

  it('answers only whether the host bundles an implementation, and never rejects', () => {
    expect(isBundledProviderWireProtocol('openai-responses')).toBe(true);
    expect(isBundledProviderWireProtocol(CONTRIBUTED)).toBe(false);
    // A `false` answer is not a refusal: the same value still parses.
    expect(ProviderWireProtocolSchema.parse(CONTRIBUTED)).toBe(CONTRIBUTED);
  });

  it('reports no bundled fact for a contributed protocol instead of borrowing one', () => {
    const facts = {
      anthropic: 'anthropic-fact',
      'openai-chat': 'openai-chat-fact',
      'openai-responses': 'openai-responses-fact',
      'ollama-native': 'ollama-native-fact',
    } as const satisfies Record<BundledProviderWireProtocol, string>;

    expect(readBundledProviderWireProtocolFactV1(facts, 'ollama-native')).toBe('ollama-native-fact');
    expect(readBundledProviderWireProtocolFactV1(facts, CONTRIBUTED)).toBeNull();
  });

  it('does not cap protocol-keyed declarations at the bundled protocol count', () => {
    expect(PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration)
      .toBeGreaterThan(BUNDLED_PROVIDER_WIRE_PROTOCOLS_V1.length);

    // A declaration spanning every bundled protocol plus a contributed one is
    // the exact case a bundled-count cap would have rejected.
    expect(ProviderCredentialTransportV1Schema.parse({
      id: 'every-protocol',
      protocols: [...BUNDLED_PROVIDER_WIRE_PROTOCOLS_V1, CONTRIBUTED],
      uses: ['runtime'],
      destination: { kind: 'httpHeader', name: 'Authorization', format: 'bearer' },
    }).protocols).toEqual([...BUNDLED_PROVIDER_WIRE_PROTOCOLS_V1, CONTRIBUTED]);
  });
});
