import { createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { once } from 'node:events';

import { createStreamingIntegrityVerifier } from '../integrity';
import { verifyNpmRegistrySignatures } from './signatures';
import type { DownloadedNpmArtifactCandidate, NpmRegistrySigningKey, ResolvedNpmArtifact } from './types';

export type NpmArtifactBodyClient = Readonly<{
  getBody(input: Readonly<{ url: string; maxBytes: number; headers: Readonly<Record<string, string>>; deadlineAtMonotonicMs?: number }>): Promise<Readonly<{
    body: Readable;
    contentLength?: number;
  }>>;
}>;

export async function downloadResolvedNpmArtifact(params: Readonly<{
  resolved: ResolvedNpmArtifact;
  destinationPath: string;
  maxBytes: number;
  client: NpmArtifactBodyClient;
  registryKeys?: readonly NpmRegistrySigningKey[];
  deadlineAtMonotonicMs?: number;
}>): Promise<DownloadedNpmArtifactCandidate> {
  if (!Number.isSafeInteger(params.maxBytes) || params.maxBytes < 1) throw new Error('Invalid npm artifact size limit');
  const response = await params.client.getBody({
    url: params.resolved.tarballUrl,
    maxBytes: params.maxBytes,
    headers: { accept: 'application/octet-stream' },
    deadlineAtMonotonicMs: params.deadlineAtMonotonicMs,
  });
  if (response.contentLength !== undefined && response.contentLength > params.maxBytes) {
    response.body.destroy();
    throw new Error(`Npm artifact exceeds the configured size limit (${params.maxBytes} bytes)`);
  }

  const integrity = createStreamingIntegrityVerifier(params.resolved.integrity);
  await mkdir(dirname(params.destinationPath), { recursive: true });
  const file = await open(params.destinationPath, 'wx').catch((error: unknown) => {
    response.body.destroy();
    throw error;
  });
  const output = file.createWriteStream();
  const archiveSha256 = createHash('sha256');
  let byteLength = 0;
  try {
    for await (const value of response.body) {
      const chunk = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
      byteLength += chunk.byteLength;
      if (byteLength > params.maxBytes) throw new Error(`Npm artifact exceeds the configured size limit (${params.maxBytes} bytes)`);
      integrity.update(chunk);
      archiveSha256.update(chunk);
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end();
    await finished(output);
    if (!integrity.verify()) throw new Error('Npm artifact integrity verification failed');
    const archiveDigestSha256 = `sha256:${archiveSha256.digest('hex')}` as const;
    const registrySignature = verifyNpmRegistrySignatures({
      packageName: params.resolved.packageName,
      version: params.resolved.version,
      integrity: params.resolved.integrity,
      signatures: params.resolved.signatures,
      keys: params.registryKeys ?? [],
    });
    return {
      source: {
        kind: 'npm', registryOrigin: params.resolved.registryOrigin, packageName: params.resolved.packageName,
        version: params.resolved.version, integrity: params.resolved.integrity, tarballUrl: params.resolved.tarballUrl,
      },
      artifactPath: params.destinationPath,
      byteLength,
      archiveDigestSha256,
      registrySignature,
      provenance: params.resolved.provenance?.status === 'declared'
        ? { ...params.resolved.provenance, verified: false }
        : params.resolved.provenance?.status === 'unavailable'
          ? { ...params.resolved.provenance, verified: false }
          : { status: 'absent' },
    };
  } catch (error) {
    output.destroy();
    await finished(output).catch(() => undefined);
    await rm(params.destinationPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
