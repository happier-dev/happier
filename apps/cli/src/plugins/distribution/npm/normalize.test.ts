import { describe, expect, it } from 'vitest';

import { normalizeNpmArtifactRequest } from './normalize';

describe('normalizeNpmArtifactRequest', () => {
  it('uses the credential-free public npm registry when no source profile applies', () => {
    expect(normalizeNpmArtifactRequest({
      packageName: 'public-plugin',
      selector: '1.2.3',
      profiles: [],
    })).toEqual({
      registryOrigin: 'https://registry.npmjs.org',
      packageName: 'public-plugin',
      selector: { kind: 'exact', value: '1.2.3' },
      selection: {
        packageName: 'public-plugin',
        origin: 'https://registry.npmjs.org',
        reason: 'publicDefault',
      },
    });
  });

  it('canonicalizes the registry, scoped package, selector, and matching profile once', () => {
    expect(normalizeNpmArtifactRequest({
      registryOrigin: 'https://registry.example.test/',
      packageName: ' @scope/plugin ',
      selector: ' ^1.2.0 ',
      profiles: [{
        version: 1,
        id: 'private',
        displayName: 'Private',
        origin: 'https://registry.example.test',
        scopes: ['@scope'],
        useAsDefault: false,
        credentialSecretRef: 'secret:npm-private',
        createdAtMs: 1,
        updatedAtMs: 1,
      }],
    })).toEqual({
      registryOrigin: 'https://registry.example.test',
      packageName: '@scope/plugin',
      selector: { kind: 'range', value: '^1.2.0' },
      selection: {
        packageName: '@scope/plugin',
        origin: 'https://registry.example.test',
        reason: 'originMapping',
        profileId: 'private',
      },
      credentialSecretRef: 'secret:npm-private',
    });
  });

  it.each([
    'http://registry.example.test',
    'https://user:token@registry.example.test',
    'https://registry.example.test/path',
    'https://registry.example.test?x=1',
  ])('rejects a non-canonical or unsafe registry origin: %s', (registryOrigin) => {
    expect(() => normalizeNpmArtifactRequest({ registryOrigin, packageName: 'plugin' })).toThrow(/registry origin/i);
  });

  it.each(['Plugin', '@scope', '@Scope/plugin', '../plugin', 'plugin name'])('rejects an invalid package name: %s', (packageName) => {
    expect(() => normalizeNpmArtifactRequest({ registryOrigin: 'https://registry.example.test', packageName })).toThrow(/package name/i);
  });

  it('bounds package and selector input before constructing registry requests', () => {
    expect(() => normalizeNpmArtifactRequest({ registryOrigin: 'https://registry.example.test', packageName: 'a'.repeat(215) })).toThrow(/package name/i);
    expect(() => normalizeNpmArtifactRequest({ registryOrigin: 'https://registry.example.test', packageName: 'plugin', selector: 'a'.repeat(257) })).toThrow(/version|range|tag/i);
  });

  it.each([
    ['1', '>=1.0.0 <2.0.0-0'],
    ['1.2', '>=1.2.0 <1.3.0-0'],
    ['v1.4', '>=1.4.0 <1.5.0-0'],
  ])('classifies npm partial semver %s as a range rather than a tag', (selector) => {
    expect(normalizeNpmArtifactRequest({
      registryOrigin: 'https://registry.example.test', packageName: 'plugin', selector,
    }).selector).toEqual({ kind: 'range', value: selector });
  });

  it('bounds and runtime-validates registry profile input', () => {
    const profile = {
      version: 1 as const, id: 'profile', displayName: 'Profile', origin: 'https://registry.example.test',
      scopes: [] as string[], useAsDefault: false, createdAtMs: 1, updatedAtMs: 1,
    };
    expect(() => normalizeNpmArtifactRequest({ packageName: 'plugin', profiles: Array.from({ length: 65 }, (_, index) => ({ ...profile, id: `p-${index}` })) })).toThrow(/profiles.*limit/i);
    expect(() => normalizeNpmArtifactRequest({ packageName: 'plugin', profiles: [{ ...profile, id: 'x'.repeat(129) }] })).toThrow(/profile/i);
    expect(() => normalizeNpmArtifactRequest({ packageName: 'plugin', profiles: [{ ...profile, createdAtMs: -1 }] })).toThrow(/profile/i);
    expect(() => normalizeNpmArtifactRequest({ packageName: 'plugin', profiles: [{ ...profile, origin: `https://${'a'.repeat(3000)}.test` }] })).toThrow(/profile|origin/i);
    expect(() => normalizeNpmArtifactRequest({ packageName: 'plugin', explicitProfileId: 'x'.repeat(129), profiles: [] })).toThrow(/profile/i);
  });

  it('does not silently use a profile whose origin or scope does not match', () => {
    expect(() => normalizeNpmArtifactRequest({
      registryOrigin: 'https://registry.example.test',
      packageName: '@scope/plugin',
      explicitProfileId: 'wrong',
      profiles: [{
        version: 1,
        id: 'wrong',
        displayName: 'Wrong',
        origin: 'https://other.example.test',
        scopes: ['@scope'],
        useAsDefault: false,
        createdAtMs: 1,
        updatedAtMs: 1,
      }],
    })).toThrow(/profile.*origin/i);

    expect(() => normalizeNpmArtifactRequest({
      registryOrigin: 'https://registry.example.test',
      packageName: '@other/plugin',
      explicitProfileId: 'wrong-scope',
      profiles: [{
        version: 1,
        id: 'wrong-scope',
        displayName: 'Wrong scope',
        origin: 'https://registry.example.test',
        scopes: ['@scope'],
        useAsDefault: false,
        createdAtMs: 1,
        updatedAtMs: 1,
      }],
    })).toThrow(/profile.*scope/i);
  });

  it('selects a scoped registry mapping when no origin was explicitly supplied', () => {
    expect(normalizeNpmArtifactRequest({
      packageName: '@scope/plugin',
      profiles: [{
        version: 1, id: 'scope', displayName: 'Scope', origin: 'https://private.example.test',
        scopes: ['@scope'], useAsDefault: false, createdAtMs: 1, updatedAtMs: 1,
      }],
    })).toMatchObject({
      registryOrigin: 'https://private.example.test',
      selection: { reason: 'scopeMapping', profileId: 'scope' },
    });
  });

  it('does not infer credentials by origin for a curated exact marketplace request', () => {
    expect(normalizeNpmArtifactRequest({
      curatedExactOrigin: 'https://private.example.test',
      packageName: 'curated-plugin',
      profiles: [{
        version: 1,
        id: 'curated-private',
        displayName: 'Curated private registry',
        origin: 'https://private.example.test',
        scopes: [],
        useAsDefault: false,
        credentialSecretRef: 'secret:curated-private',
        createdAtMs: 1,
        updatedAtMs: 1,
      }],
    })).toEqual({
      registryOrigin: 'https://private.example.test',
      packageName: 'curated-plugin',
      selector: { kind: 'tag', value: 'latest' },
      selection: {
        packageName: 'curated-plugin',
        origin: 'https://private.example.test',
        reason: 'curatedExact',
      },
    });
  });

  it('uses credentials from the unique configured profile for an explicit registry origin', () => {
    expect(normalizeNpmArtifactRequest({
      registryOrigin: 'https://private.example.test',
      packageName: 'private-plugin',
      profiles: [{
        version: 1, id: 'explicit-origin', displayName: 'Private registry', origin: 'https://private.example.test',
        scopes: [], useAsDefault: false, credentialSecretRef: 'secret:explicit-origin', createdAtMs: 1, updatedAtMs: 1,
      }],
    })).toMatchObject({
      selection: { reason: 'originMapping', profileId: 'explicit-origin' },
      credentialSecretRef: 'secret:explicit-origin',
    });
  });

  it('rejects ambiguous profile ids, scope mappings, and defaults', () => {
    const profile = {
      version: 1 as const, displayName: 'Registry', origin: 'https://private.example.test',
      scopes: ['@scope'], useAsDefault: true, createdAtMs: 1, updatedAtMs: 1,
    };
    expect(() => normalizeNpmArtifactRequest({
      packageName: '@scope/plugin',
      profiles: [{ ...profile, id: 'one' }, { ...profile, id: 'two' }],
    })).toThrow(/ambiguous/i);
    expect(() => normalizeNpmArtifactRequest({
      packageName: 'plugin',
      profiles: [{ ...profile, id: 'same', scopes: [] }, { ...profile, id: 'same', scopes: [], useAsDefault: false }],
    })).toThrow(/duplicate.*profile/i);
  });
});
