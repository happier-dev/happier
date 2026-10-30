import { describe, expect, it } from 'vitest';

import { readIrohRelayConfigFromEnv } from './relayConfig';
import { classifyIrohHomeCarrierFailure } from './errors';

describe('readIrohRelayConfigFromEnv', () => {
  it('normalizes explicit relay configuration without ambient discovery', () => {
    expect(readIrohRelayConfigFromEnv({
      HAPPIER_IROH_RELAY_POLICY: ' AUTOMATIC ',
      HAPPIER_IROH_RELAY_URLS: 'https://relay-b.example, https://relay-a.example',
    })).toEqual({
      relayPolicy: 'automatic',
      relayUrls: ['https://relay-a.example', 'https://relay-b.example'],
      explicitlyConfigured: true,
    });

    expect(readIrohRelayConfigFromEnv({})).toEqual({
      relayPolicy: 'automatic',
      relayUrls: [],
      explicitlyConfigured: false,
    });

    expect(readIrohRelayConfigFromEnv({ HAPPIER_IROH_RELAY_POLICY: 'disabled' })).toEqual({
      relayPolicy: 'disabled',
      relayUrls: [],
      explicitlyConfigured: true,
    });

    expect(readIrohRelayConfigFromEnv({
      HAPPIER_IROH_RELAY_URLS: Array.from(
        { length: 9 },
        (_, index) => `https://relay-${index}.example`,
      ).join(','),
    }).relayUrls).toHaveLength(9);
  });

  it('fails closed for disabled relays with explicit URLs', () => {
    expect(() => readIrohRelayConfigFromEnv({
      HAPPIER_IROH_RELAY_POLICY: 'disabled',
      HAPPIER_IROH_RELAY_URLS: 'https://relay.example',
    })).toThrow(/cannot be combined/);
  });

  it.each([
    { HAPPIER_IROH_RELAY_POLICY: 'relay-only' },
    { HAPPIER_IROH_RELAY_URLS: 'not-a-url' },
    { HAPPIER_IROH_RELAY_URLS: 'https://relay.example, ' },
    { HAPPIER_IROH_RELAY_POLICY: 'disabled', HAPPIER_IROH_RELAY_URLS: 'https://relay.example' },
  ])('preserves configuration refusal at the carrier classifier for %j', env => {
    let failure: unknown;
    try { readIrohRelayConfigFromEnv(env); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'endpoint_config_conflict' });
    expect(classifyIrohHomeCarrierFailure(failure)).toMatchObject({ fallbackAllowed: false, failureClass: 'endpoint-config' });
  });

  it('fails closed for credential-bearing or unsupported relay descriptors', () => {
    for (const relayUrls of [
      'https://relay.example?token=shared-secret',
      'https://relay.example#fragment',
      'https://operator:secret@relay.example',
      'https://relay.example, ',
      'https://relay.example, https://relay.example',
    ]) {
      expect(() => readIrohRelayConfigFromEnv({
        HAPPIER_IROH_RELAY_POLICY: 'automatic',
        HAPPIER_IROH_RELAY_URLS: relayUrls,
      })).toThrow();
    }

    expect(() => readIrohRelayConfigFromEnv({ HAPPIER_IROH_RELAY_POLICY: 'relay-only' }))
      .toThrow(/must be "automatic" or "disabled"/);
  });
});

describe('applied relay truth for production endpoint composition', () => {
  it('applies exactly the configured relay set under automatic and none under disabled', () => {
    // `automatic` carries the operator's explicit fleet verbatim (normalized and
    // sorted); it never discovers an ambient or default relay.
    expect(readIrohRelayConfigFromEnv({
      HAPPIER_IROH_RELAY_POLICY: 'automatic',
      HAPPIER_IROH_RELAY_URLS: 'https://relay-b.example, https://relay-a.example',
    }).relayUrls).toEqual(['https://relay-a.example', 'https://relay-b.example']);

    // `automatic` with no configured fleet stays direct-capable rather than
    // inventing a managed relay URL.
    expect(readIrohRelayConfigFromEnv({ HAPPIER_IROH_RELAY_POLICY: 'automatic' }).relayUrls).toEqual([]);

    // `disabled` is direct-only.
    expect(readIrohRelayConfigFromEnv({ HAPPIER_IROH_RELAY_POLICY: 'disabled' })).toEqual({
      relayPolicy: 'disabled',
      relayUrls: [],
      explicitlyConfigured: true,
    });
  });
});
