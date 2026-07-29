import { describe, expect, it } from 'vitest';

import { resolveNpmArtifactMetadata, type NpmRegistryJsonClient } from './resolver';

const integrity = 'sha512-qvTGHdzF6KLavt4PO0gs2a6pQ00GGlZf8p4dB7w5HhN7M7sXGmBv42a8Te+fZ4zEX7fA0cTj7s9Lr5byJx34WQ==';

function jsonClient(packument: unknown): NpmRegistryJsonClient {
  return { getJson: async () => packument };
}

describe('resolveNpmArtifactMetadata', () => {
  const base = {
    registryOrigin: 'https://registry.example.test',
    packageName: '@scope/plugin',
    selection: { packageName: '@scope/plugin', origin: 'https://registry.example.test', reason: 'publicDefault' as const },
  };

  const packument = {
    name: '@scope/plugin',
    'dist-tags': { latest: '2.0.0', next: '3.0.0-beta.1' },
    versions: {
      '1.2.0': { name: '@scope/plugin', version: '1.2.0', dist: { integrity, tarball: 'https://registry.example.test/@scope/plugin/-/plugin-1.2.0.tgz' } },
      '1.4.0': { name: '@scope/plugin', version: '1.4.0', dist: { integrity, tarball: 'https://registry.example.test/@scope/plugin/-/plugin-1.4.0.tgz' } },
      '2.0.0': { name: '@scope/plugin', version: '2.0.0', dist: { integrity, tarball: 'https://registry.example.test/@scope/plugin/-/plugin-2.0.0.tgz' } },
      '3.0.0-beta.1': { name: '@scope/plugin', version: '3.0.0-beta.1', dist: { integrity, tarball: 'https://registry.example.test/@scope/plugin/-/plugin-3.0.0-beta.1.tgz' } },
    },
  };

  it('resolves a range to one highest immutable exact version', async () => {
    await expect(resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'range', value: '^1.2.0' } },
      client: jsonClient(packument),
    })).resolves.toMatchObject({ version: '1.4.0', integrity, packageName: '@scope/plugin' });
  });

  it('resolves a tag only through dist-tags', async () => {
    await expect(resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'tag', value: 'next' } },
      client: jsonClient(packument),
    })).resolves.toMatchObject({ version: '3.0.0-beta.1' });
  });

  it('rejects a dist-tag that does not resolve to an exact canonical semver', async () => {
    await expect(resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'tag', value: 'bad' } },
      client: jsonClient({ ...packument, 'dist-tags': { ...packument['dist-tags'], bad: 'not-a-version' } }),
    })).rejects.toThrow(/dist-tag.*semver/i);
  });

  it('projects a bounded same-origin provenance declaration as a review signal', async () => {
    const withProvenance = structuredClone(packument);
    Object.assign(withProvenance.versions['2.0.0'].dist, {
      attestations: {
        url: 'https://registry.example.test/-/npm/v1/attestations/%40scope%2fplugin@2.0.0',
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
    });
    await expect(resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'exact', value: '2.0.0' } }, client: jsonClient(withProvenance),
    })).resolves.toMatchObject({
      provenance: { status: 'declared', predicateType: 'https://slsa.dev/provenance/v1' },
    });
  });

  it('does not let malformed provenance metadata block otherwise valid integrity metadata', async () => {
    const malformed = structuredClone(packument);
    Object.assign(malformed.versions['2.0.0'].dist, {
      attestations: { url: 'https://evil.example.test/attestations', provenance: { predicateType: 'x'.repeat(513) } },
    });
    await expect(resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'exact', value: '2.0.0' } }, client: jsonClient(malformed),
    })).resolves.toMatchObject({ provenance: { status: 'unavailable', code: 'declaration_invalid' } });
  });

  it('never returns a noncanonical version key as the immutable exact version', async () => {
    const versions = {
      ...packument.versions,
      'v1.9.0': { name: '@scope/plugin', version: 'v1.9.0', dist: { integrity, tarball: 'https://registry.example.test/plugin-v1.9.0.tgz' } },
    };
    await expect(resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'range', value: '^1.0.0' } }, client: jsonClient({ ...packument, versions }),
    })).resolves.toMatchObject({ version: '1.4.0' });
  });

  it.each([
    [{ ...packument, name: 'other' }, /package identity/i],
    [{ ...packument, versions: { '2.0.0': { name: '@scope/plugin', version: '2.0.0', dist: { tarball: 'https://registry.example.test/x.tgz' } } } }, /integrity/i],
    [{ ...packument, versions: { '2.0.0': { name: '@scope/plugin', version: '2.0.0', dist: { integrity, tarball: 'https://evil.example.test/x.tgz' } } } }, /tarball origin/i],
  ])('rejects malformed or rebound metadata', async (value, expected) => {
    await expect(resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'exact', value: '2.0.0' } },
      client: jsonClient(value),
    })).rejects.toThrow(expected as RegExp);
  });
});
