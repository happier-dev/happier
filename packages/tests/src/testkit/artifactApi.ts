import { Buffer } from 'node:buffer';

import { fetchJson } from './http';

export interface ArtifactListItemRecord {
  id: string;
  header: string;
  headerVersion: number;
  dataEncryptionKey: string;
  seq: number;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactRecord extends ArtifactListItemRecord {
  body: string;
  bodyVersion: number;
}

export async function listArtifactsViaApi(params: Readonly<{
  baseUrl: string;
  token: string;
}>): Promise<ArtifactListItemRecord[]> {
  const res = await fetchJson<ArtifactListItemRecord[]>(`${params.baseUrl}/v1/artifacts`, {
    headers: { Authorization: `Bearer ${params.token}` },
  });
  if (res.status !== 200 || !Array.isArray(res.data)) {
    throw new Error(`Expected 200 artifact list, received ${res.status}`);
  }
  return res.data;
}

export async function fetchArtifactViaApi(params: Readonly<{
  baseUrl: string;
  token: string;
  artifactId: string;
}>): Promise<ArtifactRecord> {
  const res = await fetchJson<ArtifactRecord>(`${params.baseUrl}/v1/artifacts/${encodeURIComponent(params.artifactId)}`, {
    headers: { Authorization: `Bearer ${params.token}` },
  });
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
    throw new Error(`Expected 200 artifact get, received ${res.status}`);
  }
  return res.data;
}

export async function createArtifactViaApi(params: Readonly<{
  baseUrl: string;
  token: string;
  artifactId: string;
  headerJson: unknown;
  bodyJson: unknown;
  dataEncryptionKeyBytes?: Uint8Array;
}>): Promise<ArtifactRecord> {
  const res = await fetchJson<ArtifactRecord>(`${params.baseUrl}/v1/artifacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: params.artifactId,
      header: encodeJsonBase64(params.headerJson),
      body: encodeJsonBase64(params.bodyJson),
      dataEncryptionKey: Buffer.from(params.dataEncryptionKeyBytes ?? new Uint8Array([1, 2, 3, 4])).toString('base64'),
    }),
  });
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
    throw new Error(`Expected 200 artifact create, received ${res.status}`);
  }
  return res.data;
}

export async function updateArtifactViaApi(params: Readonly<{
  baseUrl: string;
  token: string;
  artifactId: string;
  headerJson?: unknown;
  expectedHeaderVersion?: number;
  bodyJson?: unknown;
  expectedBodyVersion?: number;
}>): Promise<
  | Readonly<{ success: true; headerVersion?: number; bodyVersion?: number }>
  | Readonly<{
      success: false;
      error: 'version-mismatch';
      currentHeaderVersion?: number;
      currentBodyVersion?: number;
      currentHeader?: string;
      currentBody?: string;
    }>
> {
  const body: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(params, 'headerJson')) {
    body.header = encodeJsonBase64(params.headerJson);
  }
  if (typeof params.expectedHeaderVersion === 'number') {
    body.expectedHeaderVersion = params.expectedHeaderVersion;
  }
  if (Object.prototype.hasOwnProperty.call(params, 'bodyJson')) {
    body.body = encodeJsonBase64(params.bodyJson);
  }
  if (typeof params.expectedBodyVersion === 'number') {
    body.expectedBodyVersion = params.expectedBodyVersion;
  }

  const res = await fetchJson<any>(`${params.baseUrl}/v1/artifacts/${encodeURIComponent(params.artifactId)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
    throw new Error(`Expected 200 artifact update, received ${res.status}`);
  }
  return res.data;
}

export function decodeArtifactJsonBase64<T>(base64: string): T {
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as T;
}

function encodeJsonBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}
