import { describe, expect, it } from 'vitest';
import { ManagedBootstrapCarrierV1Schema, ProviderNativeOptionFactsV1Schema, ProviderObservationV1Schema } from './providerFactsV1.js';

describe('native option presentation facts', () => {
  it('preserves declarative image metadata and native country codes without admitting executable or remote previews', () => {
    const facts = {
      image: { id: 'ubuntu', title: 'Ubuntu', description: 'Ubuntu 24.04 LTS',
        preview: { resource: { pluginId: 'fixture.compute', localId: 'ubuntu-preview' }, accessibilityLabel: 'Ubuntu desktop' } },
      location: { id: 'fsn1', title: 'Falkenstein', countryCode: 'DE' },
    };
    expect(ProviderNativeOptionFactsV1Schema.parse(facts)).toEqual(facts);
    expect(ProviderNativeOptionFactsV1Schema.parse({ image: { id: 'ubuntu', title: 'Ubuntu' }, location: { id: 'local', title: 'This computer' } }))
      .toEqual({ image: { id: 'ubuntu', title: 'Ubuntu' }, location: { id: 'local', title: 'This computer' } });
    for (const preview of [{ uri: 'https://example.test/ubuntu.png' }, { resource: { pluginId: 'fixture.compute', localId: 'ubuntu-preview', privateKey: 'secret' } }, () => 'component']) {
      expect(ProviderNativeOptionFactsV1Schema.safeParse({ image: { ...facts.image, preview } }).success).toBe(false);
    }
    expect(ProviderNativeOptionFactsV1Schema.safeParse({ location: { ...facts.location, countryCode: 'Germany' } }).success).toBe(false);
  });
});

describe('managed bootstrap transport custody', () => {
  it('keeps native power, retained storage and daemon connectivity independent', () => {
    const stopped = { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained', daemon: 'disconnected' };
    expect(ProviderObservationV1Schema.parse(stopped)).toEqual(stopped);
    expect(ProviderObservationV1Schema.parse({ ...stopped, power: 'running', storage: 'lost' }).storage).toBe('lost');
    expect(ProviderObservationV1Schema.parse({ observedAt: 10, availability: 'present' }).storage).toBeUndefined();
    expect(ProviderObservationV1Schema.safeParse({ ...stopped, prompt: 'private' }).success).toBe(false);
  });
  it('selects a native transport without copying native identity or secret material', () => {
    const carrier = { kind: 'native', transport: { contributionRef: { pluginId: 'fixture.compute', localId: 'compute' }, schemaVersion: 1 } };
    expect(ManagedBootstrapCarrierV1Schema.safeParse(carrier).success).toBe(true);
    expect(ManagedBootstrapCarrierV1Schema.safeParse({ ...carrier, resource: { id: 'native' } }).success).toBe(false);
    expect(ManagedBootstrapCarrierV1Schema.safeParse({ ...carrier, privateKey: 'secret' }).success).toBe(false);
  });
  it('requires reviewed SSH host evidence and a shared credential reference', () => {
    const carrier = { kind: 'ssh', address: 'host.example', user: 'guest', hostKeyEvidence: { hostKey: 'ssh-ed25519 observed-key', fingerprint: 'SHA256:observed' }, credentialRef: { kind: 'shared_resource', resourceId: 'bootstrap-key' } };
    expect(ManagedBootstrapCarrierV1Schema.safeParse(carrier).success).toBe(true);
    expect(ManagedBootstrapCarrierV1Schema.safeParse({ ...carrier, hostKeyEvidence: undefined }).success).toBe(false);
    expect(ManagedBootstrapCarrierV1Schema.safeParse({ ...carrier, privateKey: 'raw-secret' }).success).toBe(false);
  });
});
