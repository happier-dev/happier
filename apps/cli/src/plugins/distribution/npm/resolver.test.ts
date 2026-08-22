import { describe, expect, it } from 'vitest';

import { resolveNpmArtifactMetadata, type NpmRegistryJsonClient } from './resolver';

const integrity = 'sha512-qvTGHdzF6KLavt4PO0gs2a6pQ00GGlZf8p4dB7w5HhN7M7sXGmBv42a8Te+fZ4zEX7fA0cTj7s9Lr5byJx34WQ==';

function jsonClient(packument: unknown): NpmRegistryJsonClient {
  return { getJson: async () => packument };
}

function compatibilityProjection(
  version: string,
  engines: Record<string, unknown> | undefined = { happier: '>=0.0.0' },
  entries: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    version: 1,
    manifest: {
      schemaVersion: 2,
      id: 'acme.compatibility-fixture',
      version,
      displayName: 'Compatibility fixture',
      ...(engines ? { engines } : {}),
      runtime: { apiVersion: 1 },
      contributes: {},
    },
    uiArtifacts: { version: 1, entries },
  };
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

  it('requests full npm metadata so generated compatibility facts are available', async () => {
    const requests: Parameters<NpmRegistryJsonClient['getJson']>[0][] = [];
    await resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'tag', value: 'latest' } },
      client: {
        getJson: async (input) => {
          requests.push(input);
          return packument;
        },
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.accept).toBe('application/json');
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

  it('selects the newest generated-compatible version instead of treating latest as an artifact decision', async () => {
    const compatibilityAwarePackument = {
      ...packument,
      'dist-tags': { latest: '2.0.0' },
      versions: {
        ...packument.versions,
        '1.4.0': {
          ...packument.versions['1.4.0'],
          happier: { manifest: '.happier-plugin/plugin.json', compatibilityProjection: compatibilityProjection('1.4.0') },
        },
        '2.0.0': {
          ...packument.versions['2.0.0'],
          happier: {
            manifest: '.happier-plugin/plugin.json',
            compatibilityProjection: compatibilityProjection('2.0.0', { happier: '>=9999.0.0' }),
          },
        },
      },
    };

    await expect(resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'tag', value: 'latest' } },
      client: jsonClient(compatibilityAwarePackument),
    })).resolves.toMatchObject({
      version: '1.4.0',
      compatibility: {
        automaticEligible: true,
        blockedNewerVersions: [{
          version: '2.0.0',
          diagnostics: [expect.objectContaining({ code: 'plugin_manifest_semantic_invalid' })],
        }],
      },
    });
  });

  it('retains only the newest 32 incompatible versions before the compatible selection', async () => {
    const incompatibleVersions = Object.fromEntries(
      Array.from({ length: 33 }, (_, minor) => {
        const version = `2.${minor}.0`;
        return [version, {
          name: '@scope/plugin',
          version,
          happier: { compatibilityProjection: compatibilityProjection(version, { happier: '>=9999.0.0' }) },
          dist: { integrity, tarball: `https://registry.example.test/@scope/plugin/-/plugin-${version}.tgz` },
        }];
      }),
    );
    const compatibilityAwarePackument = {
      name: '@scope/plugin',
      'dist-tags': { latest: '2.32.0' },
      versions: {
        '1.4.0': {
          name: '@scope/plugin',
          version: '1.4.0',
          happier: { compatibilityProjection: compatibilityProjection('1.4.0') },
          dist: { integrity, tarball: 'https://registry.example.test/@scope/plugin/-/plugin-1.4.0.tgz' },
        },
        ...incompatibleVersions,
      },
    };

    const resolved = await resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'tag', value: 'latest' } },
      client: jsonClient(compatibilityAwarePackument),
    });

    expect(resolved.version).toBe('1.4.0');
    expect(resolved.compatibility?.blockedNewerVersions).toHaveLength(32);
    expect(resolved.compatibility?.blockedNewerVersions.map((blocked) => blocked.version)).toEqual([
      '2.32.0',
      '2.31.0',
      '2.30.0',
      '2.29.0',
      '2.28.0',
      '2.27.0',
      '2.26.0',
      '2.25.0',
      '2.24.0',
      '2.23.0',
      '2.22.0',
      '2.21.0',
      '2.20.0',
      '2.19.0',
      '2.18.0',
      '2.17.0',
      '2.16.0',
      '2.15.0',
      '2.14.0',
      '2.13.0',
      '2.12.0',
      '2.11.0',
      '2.10.0',
      '2.9.0',
      '2.8.0',
      '2.7.0',
      '2.6.0',
      '2.5.0',
      '2.4.0',
      '2.3.0',
      '2.2.0',
      '2.1.0',
    ]);
  });

  it('rejects a candidate whose generated UI artifact targets a different Host UI API before body selection', async () => {
    const generatedEntry = {
      contributionId: 'main',
      tier: 'hostedWeb',
      entry: 'web/index.html',
      files: [{
        relativePath: 'web/index.html',
        digest: `sha256:${'a'.repeat(64)}`,
        byteSize: 1,
      }],
      digest: `sha256:${'b'.repeat(64)}`,
      builtWith: { bundler: 'vite', version: '7.0.0' },
      hostUiApiVersion: '999.0.0',
      compat: {},
    };
    const compatibilityAwarePackument = {
      ...packument,
      'dist-tags': { latest: '2.0.0' },
      versions: {
        ...packument.versions,
        '1.4.0': {
          ...packument.versions['1.4.0'],
          happier: { compatibilityProjection: compatibilityProjection('1.4.0') },
        },
        '2.0.0': {
          ...packument.versions['2.0.0'],
          happier: { compatibilityProjection: compatibilityProjection('2.0.0', undefined, [generatedEntry]) },
        },
      },
    };

    await expect(resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'tag', value: 'latest' } },
      client: jsonClient(compatibilityAwarePackument),
    })).resolves.toMatchObject({
      version: '1.4.0',
      compatibility: {
        automaticEligible: true,
        blockedNewerVersions: [{
          version: '2.0.0',
          diagnostics: [expect.objectContaining({ code: 'plugin_compatibility_projection_invalid' })],
        }],
      },
    });
  });

  it('binds compatibility projection manifest version to the candidate coordinate before body selection', async () => {
    const compatibilityAwarePackument = {
      ...packument,
      'dist-tags': { latest: '2.0.0' },
      versions: {
        ...packument.versions,
        '1.4.0': {
          ...packument.versions['1.4.0'],
          happier: { compatibilityProjection: compatibilityProjection('1.4.0') },
        },
        '2.0.0': {
          ...packument.versions['2.0.0'],
          happier: { compatibilityProjection: compatibilityProjection('1.4.0') },
        },
      },
    };

    await expect(resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'tag', value: 'latest' } },
      client: jsonClient(compatibilityAwarePackument),
    })).resolves.toMatchObject({
      version: '1.4.0',
      compatibility: {
        automaticEligible: true,
        blockedNewerVersions: [{
          version: '2.0.0',
          diagnostics: [expect.objectContaining({ code: 'plugin_compatibility_projection_invalid' })],
        }],
      },
    });
  });

  it('never falls below the installed-version range when that version lacks compatibility facts', async () => {
    const compatibilityAwarePackument = {
      name: '@scope/plugin',
      'dist-tags': { latest: '1.9.0' },
      versions: {
        '1.9.0': {
          name: '@scope/plugin',
          version: '1.9.0',
          happier: { compatibilityProjection: compatibilityProjection('1.9.0') },
          dist: { integrity, tarball: 'https://registry.example.test/plugin-1.9.0.tgz' },
        },
        '2.0.0': {
          name: '@scope/plugin',
          version: '2.0.0',
          dist: { integrity, tarball: 'https://registry.example.test/plugin-2.0.0.tgz' },
        },
      },
    };

    await expect(resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'range', value: '>=2.0.0' } },
      client: jsonClient(compatibilityAwarePackument),
    })).resolves.toMatchObject({
      version: '2.0.0',
      compatibility: {
        automaticEligible: false,
        diagnostics: [expect.objectContaining({ code: 'plugin_compatibility_projection_missing' })],
      },
    });
  });

  it('keeps preview-range selection on the installed prerelease line', async () => {
    const compatibilityAwarePackument = {
      name: '@scope/plugin',
      'dist-tags': { latest: '1.9.0', next: '2.0.0-beta.2' },
      versions: {
        '1.9.0': {
          name: '@scope/plugin',
          version: '1.9.0',
          happier: { compatibilityProjection: compatibilityProjection('1.9.0') },
          dist: { integrity, tarball: 'https://registry.example.test/plugin-1.9.0.tgz' },
        },
        '2.0.0-beta.1': {
          name: '@scope/plugin',
          version: '2.0.0-beta.1',
          happier: { compatibilityProjection: compatibilityProjection('2.0.0-beta.1') },
          dist: { integrity, tarball: 'https://registry.example.test/plugin-2.0.0-beta.1.tgz' },
        },
        '2.0.0-beta.2': {
          name: '@scope/plugin',
          version: '2.0.0-beta.2',
          happier: { compatibilityProjection: compatibilityProjection('2.0.0-beta.2') },
          dist: { integrity, tarball: 'https://registry.example.test/plugin-2.0.0-beta.2.tgz' },
        },
        '2.0.0': {
          name: '@scope/plugin',
          version: '2.0.0',
          happier: { compatibilityProjection: compatibilityProjection('2.0.0') },
          dist: { integrity, tarball: 'https://registry.example.test/plugin-2.0.0.tgz' },
        },
      },
    };

    await expect(resolveNpmArtifactMetadata({
      request: {
        ...base,
        selector: { kind: 'range', value: '>=2.0.0-beta.1 <2.0.0' },
      },
      client: jsonClient(compatibilityAwarePackument),
    })).resolves.toMatchObject({
      version: '2.0.0-beta.2',
      compatibility: { automaticEligible: true },
    });
  });

  it('does not admit author-supplied build provenance into compatibility selection', async () => {
    const compatibilityAwarePackument = {
      ...packument,
      'dist-tags': { latest: '2.0.0' },
      versions: {
        ...packument.versions,
        '1.4.0': {
          ...packument.versions['1.4.0'],
          happier: { manifest: '.happier-plugin/plugin.json', compatibilityProjection: compatibilityProjection('1.4.0') },
        },
        '2.0.0': {
          ...packument.versions['2.0.0'],
          happier: {
            manifest: '.happier-plugin/plugin.json',
            compatibilityProjection: {
              ...compatibilityProjection('2.0.0', undefined),
              builtWith: { pluginSdk: '9999.0.0' },
            },
          },
        },
      },
    };

    await expect(resolveNpmArtifactMetadata({
      request: { ...base, selector: { kind: 'tag', value: 'latest' } },
      client: jsonClient(compatibilityAwarePackument),
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
