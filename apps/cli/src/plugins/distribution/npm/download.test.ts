import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { downloadResolvedNpmArtifact, type NpmArtifactBodyClient } from './download';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function bodyClient(bytes: Uint8Array): NpmArtifactBodyClient {
  return { getBody: async () => ({ body: Readable.from([bytes]), contentLength: bytes.byteLength }) };
}

describe('downloadResolvedNpmArtifact', () => {
  it('streams exact bytes to a candidate only after mandatory SRI succeeds', async () => {
    const bytes = Buffer.from('npm tarball bytes');
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-test-'));
    tempDirs.push(dir);
    const destinationPath = join(dir, 'candidate.tgz');

    const result = await downloadResolvedNpmArtifact({
      resolved: {
        registryOrigin: 'https://registry.example.test',
        packageName: 'plugin',
        version: '1.0.0',
        versionMetadata: {},
        integrity: sri(bytes),
        tarballUrl: 'https://registry.example.test/plugin/-/plugin-1.0.0.tgz',
        signatures: [],
      },
      destinationPath,
      maxBytes: bytes.byteLength,
      client: bodyClient(bytes),
    });

    expect(await readFile(destinationPath)).toEqual(bytes);
    expect(result).toMatchObject({
      artifactPath: destinationPath,
      byteLength: bytes.byteLength,
      // The registry's source SRI is SHA-512 here. Availability needs the
      // exact verified tarball's canonical SHA-256, not a re-encoded SRI.
      archiveDigestSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      registrySignature: { status: 'absent' },
    });
  });

  it('removes partial output and rejects integrity or byte-limit failures', async () => {
    const bytes = Buffer.from('too many bytes');
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-test-'));
    tempDirs.push(dir);

    await expect(downloadResolvedNpmArtifact({
      resolved: {
        registryOrigin: 'https://registry.example.test', packageName: 'plugin', version: '1.0.0',
        versionMetadata: {},
        integrity: sri(Buffer.from('different')), tarballUrl: 'https://registry.example.test/plugin.tgz', signatures: [],
      },
      destinationPath: join(dir, 'bad-integrity.tgz'), maxBytes: 100, client: bodyClient(bytes),
    })).rejects.toThrow(/integrity/i);
    await expect(readFile(join(dir, 'bad-integrity.tgz'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(downloadResolvedNpmArtifact({
      resolved: {
        registryOrigin: 'https://registry.example.test', packageName: 'plugin', version: '1.0.0',
        versionMetadata: {},
        integrity: sri(bytes), tarballUrl: 'https://registry.example.test/plugin.tgz', signatures: [],
      },
      destinationPath: join(dir, 'too-large.tgz'), maxBytes: bytes.byteLength - 1, client: bodyClient(bytes),
    })).rejects.toThrow(/size limit/i);
    await expect(readFile(join(dir, 'too-large.tgz'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never deletes a pre-existing destination it did not create', async () => {
    const bytes = Buffer.from('existing');
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-test-'));
    tempDirs.push(dir);
    const destinationPath = join(dir, 'existing.tgz');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(destinationPath, bytes);

    await expect(downloadResolvedNpmArtifact({
      resolved: {
        registryOrigin: 'https://registry.example.test', packageName: 'plugin', version: '1.0.0',
        versionMetadata: {},
        integrity: sri(bytes), tarballUrl: 'https://registry.example.test/plugin.tgz', signatures: [],
      },
      destinationPath, maxBytes: 100, client: bodyClient(bytes),
    })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destinationPath)).toEqual(bytes);
  });

  it('validates a claimed npm ECDSA registry signature against a matching rotated key', async () => {
    const bytes = Buffer.from('signed tarball');
    const integrity = sri(bytes);
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const keyid = `SHA256:${createHash('sha256').update(der).digest('base64')}`;
    const signature = sign('sha256', Buffer.from(`plugin@1.0.0:${integrity}`), privateKey).toString('base64');
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-test-'));
    tempDirs.push(dir);

    await expect(downloadResolvedNpmArtifact({
      resolved: {
        registryOrigin: 'https://registry.example.test', packageName: 'plugin', version: '1.0.0', integrity,
        versionMetadata: {},
        tarballUrl: 'https://registry.example.test/plugin.tgz', signatures: [{ keyid, sig: signature }],
      },
      destinationPath: join(dir, 'signed.tgz'), maxBytes: 100, client: bodyClient(bytes),
      registryKeys: [
        { keyid: 'SHA256:unrelated-future-key', keytype: 'future-key-type', scheme: 'future-scheme', key: 'future-key', expires: null },
        { keyid, keytype: 'ecdsa-sha2-nistp256', scheme: 'ecdsa-sha2-nistp256', key: der.toString('base64'), expires: null },
      ],
    })).resolves.toMatchObject({ registrySignature: { status: 'verified', keyid } });
  });

  it('retains historical verification through a rotated key whose signing window has expired', async () => {
    const bytes = Buffer.from('historical signed tarball');
    const integrity = sri(bytes);
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const keyid = 'SHA256:historical-key-id-from-registry';
    const signature = sign('sha256', Buffer.from(`plugin@1.0.0:${integrity}`), privateKey).toString('base64');
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-test-'));
    tempDirs.push(dir);

    await expect(downloadResolvedNpmArtifact({
      resolved: {
        registryOrigin: 'https://registry.example.test', packageName: 'plugin', version: '1.0.0', integrity,
        versionMetadata: {},
        tarballUrl: 'https://registry.example.test/plugin.tgz', signatures: [{ keyid, sig: signature }],
      },
      destinationPath: join(dir, 'historical.tgz'), maxBytes: 100, client: bodyClient(bytes),
      registryKeys: [{ keyid, keytype: 'ecdsa-sha2-nistp256', scheme: 'ecdsa-sha2-nistp256', key: der.toString('base64'), expires: '2025-01-29T00:00:00.000Z' }],
    })).resolves.toMatchObject({ registrySignature: { status: 'verified', keyid } });
  });

  it('rejects a claimed signature that cannot be validated', async () => {
    const bytes = Buffer.from('signed tarball');
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-test-'));
    tempDirs.push(dir);

    const destinationPath = join(dir, 'invalid.tgz');
    await expect(downloadResolvedNpmArtifact({
      resolved: {
        registryOrigin: 'https://registry.example.test', packageName: 'plugin', version: '1.0.0', integrity: sri(bytes),
        versionMetadata: {},
        tarballUrl: 'https://registry.example.test/plugin.tgz', signatures: [{ keyid: 'SHA256:missing', sig: 'bad' }],
      },
      destinationPath, maxBytes: 100, client: bodyClient(bytes), registryKeys: [],
    })).rejects.toThrow(/registry signature/i);
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a matching unsupported signature algorithm as nonblocking and ignores unrelated rotated algorithms', async () => {
    const bytes = Buffer.from('future signature algorithm');
    const dir = await mkdtemp(join(tmpdir(), 'happier-npm-test-'));
    tempDirs.push(dir);
    const keyid = 'SHA256:future';
    await expect(downloadResolvedNpmArtifact({
      resolved: {
        registryOrigin: 'https://registry.example.test', packageName: 'plugin', version: '1.0.0', integrity: sri(bytes),
        versionMetadata: {},
        tarballUrl: 'https://registry.example.test/plugin.tgz', signatures: [{ keyid, sig: 'future-signature' }],
        provenance: { status: 'absent' },
      },
      destinationPath: join(dir, 'future.tgz'), maxBytes: 100, client: bodyClient(bytes),
      registryKeys: [{ keyid, keytype: 'future-key-type', scheme: 'future-scheme', key: 'future-key', expires: null }],
    })).resolves.toMatchObject({ registrySignature: { status: 'unsupported', keyid } });
  });
});
