import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveAndDownloadNpmArtifact, type NpmRegistryArtifactClient } from './adapter';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('resolveAndDownloadNpmArtifact', () => {
  it('hands an exact integrity-verified immutable candidate to staging without executing package logic', async () => {
    const bytes = Buffer.from('self-contained plugin package');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const calls: string[] = [];
    const client: NpmRegistryArtifactClient = {
      getJson: async ({ url }) => {
        calls.push(url);
        return {
          name: 'plugin', 'dist-tags': { latest: '1.0.0' }, versions: {
            '1.0.0': { name: 'plugin', version: '1.0.0', scripts: { install: 'never-run-this' }, dependencies: { evil: '*' }, dist: {
              integrity, tarball: 'https://registry.example.test/plugin/-/plugin-1.0.0.tgz',
            } },
          },
        };
      },
      getBody: async ({ url }) => { calls.push(url); return { body: Readable.from([bytes]), contentLength: bytes.byteLength }; },
    };
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-adapter-'));
    dirs.push(dir);

    const candidate = await resolveAndDownloadNpmArtifact({
      input: { registryOrigin: 'https://registry.example.test', packageName: 'plugin', selector: '1.0.0' },
      destinationPath: join(dir, 'plugin.tgz'), artifactMaxBytes: 1024, client,
    });

    expect(candidate).toMatchObject({
      source: { packageName: 'plugin', version: '1.0.0', integrity },
      compatibility: {
        automaticEligible: false,
        diagnostics: [expect.objectContaining({ code: 'plugin_compatibility_projection_missing' })],
      },
    });
    expect(calls).toEqual([
      'https://registry.example.test/plugin',
      'https://registry.example.test/plugin/-/plugin-1.0.0.tgz',
    ]);
  });

  it.each([
    ['an omitted selector', undefined],
    ['a tag selector', 'latest'],
    ['a range selector', '^1.0.0'],
  ] as const)('refuses %s without generated compatibility facts before downloading an archive', async (_label, selector) => {
    const bytes = Buffer.from('ineligible package');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const bodyRequests: string[] = [];
    const client: NpmRegistryArtifactClient = {
      getJson: async () => ({
        name: 'plugin', 'dist-tags': { latest: '1.0.0' }, versions: {
          '1.0.0': {
            name: 'plugin', version: '1.0.0',
            dist: { integrity, tarball: 'https://registry.example.test/plugin/-/plugin-1.0.0.tgz' },
          },
        },
      }),
      getBody: async ({ url }) => {
        bodyRequests.push(url);
        return { body: Readable.from([bytes]), contentLength: bytes.byteLength };
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-adapter-ineligible-manual-'));
    dirs.push(dir);

    await expect(resolveAndDownloadNpmArtifact({
      input: {
        registryOrigin: 'https://registry.example.test',
        packageName: 'plugin',
        ...(selector === undefined ? {} : { selector }),
      },
      destinationPath: join(dir, 'plugin.tgz'),
      artifactMaxBytes: 1024,
      client,
    })).rejects.toThrow(/compatible generated compatibility projection/i);

    expect(bodyRequests).toEqual([]);
  });

  it('does not let an automatic exact selector defer missing compatibility facts to review', async () => {
    const bytes = Buffer.from('ineligible automatic package');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const bodyRequests: string[] = [];
    const client: NpmRegistryArtifactClient = {
      getJson: async () => ({
        name: 'plugin', 'dist-tags': { latest: '1.0.0' }, versions: {
          '1.0.0': {
            name: 'plugin', version: '1.0.0',
            dist: { integrity, tarball: 'https://registry.example.test/plugin/-/plugin-1.0.0.tgz' },
          },
        },
      }),
      getBody: async ({ url }) => {
        bodyRequests.push(url);
        return { body: Readable.from([bytes]), contentLength: bytes.byteLength };
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-adapter-ineligible-automatic-'));
    dirs.push(dir);

    await expect(resolveAndDownloadNpmArtifact({
      input: { registryOrigin: 'https://registry.example.test', packageName: 'plugin', selector: '1.0.0' },
      destinationPath: join(dir, 'plugin.tgz'),
      artifactMaxBytes: 1024,
      requireCompatibleProjection: true,
      client,
    })).rejects.toThrow(/compatible generated compatibility projection/i);

    expect(bodyRequests).toEqual([]);
  });

  it('downloads only the newest compatible artifact after inspecting full-version metadata', async () => {
    const compatibleBytes = Buffer.from('compatible package');
    const incompatibleBytes = Buffer.from('incompatible package');
    const compatibleIntegrity = `sha512-${createHash('sha512').update(compatibleBytes).digest('base64')}`;
    const incompatibleIntegrity = `sha512-${createHash('sha512').update(incompatibleBytes).digest('base64')}`;
    const bodyRequests: string[] = [];
    const projection = (
      version: string,
      entries: readonly Record<string, unknown>[] = [],
    ) => ({
      version: 1,
      manifest: {
        schemaVersion: 2,
        id: 'acme.download-selection',
        version,
        displayName: 'Download selection',
        engines: { happier: '>=0.0.0' },
        runtime: { apiVersion: 1 },
        contributes: {},
      },
      uiArtifacts: { version: 1, entries },
    });
    const incompatibleUiEntry = {
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
    const client: NpmRegistryArtifactClient = {
      getJson: async () => ({
        name: 'plugin',
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '1.0.0': {
            name: 'plugin',
            version: '1.0.0',
            happier: { manifest: '.happier-plugin/plugin.json', compatibilityProjection: projection('1.0.0') },
            dist: { integrity: compatibleIntegrity, tarball: 'https://registry.example.test/plugin/-/plugin-1.0.0.tgz' },
          },
          '2.0.0': {
            name: 'plugin',
            version: '2.0.0',
            happier: { manifest: '.happier-plugin/plugin.json', compatibilityProjection: projection('2.0.0', [incompatibleUiEntry]) },
            dist: { integrity: incompatibleIntegrity, tarball: 'https://registry.example.test/plugin/-/plugin-2.0.0.tgz' },
          },
        },
      }),
      getBody: async ({ url }) => {
        bodyRequests.push(url);
        const bytes = url.endsWith('1.0.0.tgz') ? compatibleBytes : incompatibleBytes;
        return { body: Readable.from([bytes]), contentLength: bytes.byteLength };
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-adapter-selection-'));
    dirs.push(dir);

    await expect(resolveAndDownloadNpmArtifact({
      input: { registryOrigin: 'https://registry.example.test', packageName: 'plugin' },
      destinationPath: join(dir, 'plugin.tgz'),
      artifactMaxBytes: 1024,
      client,
    })).resolves.toMatchObject({ source: { version: '1.0.0' } });

    expect(bodyRequests).toEqual(['https://registry.example.test/plugin/-/plugin-1.0.0.tgz']);
  });

  it('retrieves declared provenance under bounds as a non-authoritative review signal', async () => {
    const bytes = Buffer.from('provenance package');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const client: NpmRegistryArtifactClient = {
      getJson: async ({ url }) => url.includes('/attestations/') ? {
        attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' } }],
      } : {
        name: 'plugin', 'dist-tags': { latest: '1.0.0' }, versions: {
          '1.0.0': { name: 'plugin', version: '1.0.0', dist: {
            integrity, tarball: 'https://registry.example.test/plugin.tgz',
            attestations: { url: 'https://registry.example.test/-/npm/v1/attestations/plugin@1.0.0', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
          } },
        },
      },
      getBody: async () => ({ body: Readable.from([bytes]), contentLength: bytes.byteLength }),
    };
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-adapter-'));
    dirs.push(dir);
    await expect(resolveAndDownloadNpmArtifact({
      input: { registryOrigin: 'https://registry.example.test', packageName: 'plugin', selector: '1.0.0' },
      destinationPath: join(dir, 'plugin.tgz'), artifactMaxBytes: 1024, client,
    })).resolves.toMatchObject({
      provenance: { status: 'retrieved', predicateTypes: ['https://slsa.dev/provenance/v1'], verified: false },
    });
  });

  it('keeps valid SRI bytes usable when declared provenance is unavailable', async () => {
    const bytes = Buffer.from('unavailable provenance package');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const client: NpmRegistryArtifactClient = {
      getJson: async ({ url }) => {
        if (url.includes('/attestations/')) throw new Error('registry attestation endpoint unavailable');
        return {
          name: 'plugin', 'dist-tags': { latest: '1.0.0' }, versions: {
            '1.0.0': { name: 'plugin', version: '1.0.0', dist: {
              integrity, tarball: 'https://registry.example.test/plugin.tgz',
              attestations: { url: 'https://registry.example.test/-/npm/v1/attestations/plugin@1.0.0', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
            } },
          },
        };
      },
      getBody: async () => ({ body: Readable.from([bytes]), contentLength: bytes.byteLength }),
    };
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-adapter-'));
    dirs.push(dir);
    await expect(resolveAndDownloadNpmArtifact({
      input: { registryOrigin: 'https://registry.example.test', packageName: 'plugin', selector: '1.0.0' },
      destinationPath: join(dir, 'plugin.tgz'), artifactMaxBytes: 1024, client,
    })).resolves.toMatchObject({
      provenance: { status: 'unavailable', code: 'attestation_unavailable', verified: false },
    });
  });

  it('rejects a signing-key expiry that is not an exact calendar timestamp', async () => {
    const bytes = Buffer.from('signed package');
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const keyid = 'SHA256:key';
    const client: NpmRegistryArtifactClient = {
      getJson: async ({ url }) => url.endsWith('/-/npm/v1/keys') ? { keys: [{
        keyid, key: 'key', keytype: 'ecdsa-sha2-nistp256', scheme: 'ecdsa-sha2-nistp256', expires: '2025-02-31T00:00:00.000Z',
      }] } : {
        name: 'plugin', 'dist-tags': { latest: '1.0.0' }, versions: {
          '1.0.0': { name: 'plugin', version: '1.0.0', dist: {
            integrity, tarball: 'https://registry.example.test/plugin.tgz', signatures: [{ keyid, sig: 'signature' }],
          } },
        },
      },
      getBody: async () => ({ body: Readable.from([bytes]), contentLength: bytes.byteLength }),
    };
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-adapter-'));
    dirs.push(dir);
    await expect(resolveAndDownloadNpmArtifact({
      input: { registryOrigin: 'https://registry.example.test', packageName: 'plugin', selector: '1.0.0' },
      destinationPath: join(dir, 'plugin.tgz'), artifactMaxBytes: 1024, client,
    })).rejects.toThrow(/expiry/i);
  });
});
