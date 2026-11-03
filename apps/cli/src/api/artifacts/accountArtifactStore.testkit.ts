import { decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';
import { z } from 'zod/mini';
import axios from 'axios';
import { vi } from 'vitest';
import { artifactListResponse } from '@/testkit/http/artifactHome';

/** Model the HTTP boundary's published byte carrier while retaining real document codecs. */
export function readCarrierMutation(input: unknown): Record<string, unknown> {
  if (!Buffer.isBuffer(input)) return z.record(z.string(), z.unknown()).parse(input);
  const separator = input.indexOf(10);
  const metadata = decodeArtifactUploadMetadataV1(input.subarray(0, separator));
  const bytes = input.subarray(separator + 1).toString('base64');
  return { ...metadata, ...(metadata.kind === 'create' ? { id: metadata.artifactId } : {}),
    blob: { blobId: metadata.blobId, content: metadata.t === 'plain'
      ? { t: 'plain', v: bytes } : { t: 'encrypted', c: bytes } } };
}

/** Account Artifact HTTP is the boundary; document encoding and notice ownership stay real. */
export function createPlainAccountArtifactHttpBoundary() {
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  const rows = new Map<string, Record<string, unknown>>();
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (pathname === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, [...rows.values()]) };
    const row = rows.get(pathname.split('/')[3]!);
    return { status: row ? 200 : 404, data: row ?? {} };
  });
  const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, value) => {
    const mutation = readCarrierMutation(value);
    const id = typeof mutation.id === 'string' ? mutation.id : new URL(url).pathname.split('/').at(-1)!;
    const version = Number(rows.get(id)?.bodyVersion ?? 0) + 1;
    rows.set(id, { ...rows.get(id), ...mutation, id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
      encryptionMode: 'plain', headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version });
    return { status: 200, data: { id, success: true, headerVersion: version, bodyVersion: version } };
  });
  return { credentials: { token, encryption: null }, rows, writes };
}
