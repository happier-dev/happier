import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import {
  openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

import type { CliAccessKey } from './cliAccessKey';
import { fetchJson } from './http';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from './rpcCrypto';
import { unwrapSerializedJsonValue } from './unwrapSerializedJsonValue';

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

export interface ArtifactCreateRequest {
  id: string;
  header: string;
  body: string;
  dataEncryptionKey: string;
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

export function buildEncryptedArtifactCreateRequestForCliAccessKey(params: Readonly<{
  artifactId: string;
  headerJson: unknown;
  bodyJson: unknown;
  cliAccessKey: CliAccessKey;
  dataEncryptionKeyBytes?: Uint8Array;
  randomBytes?: (length: number) => Uint8Array;
}>): ArtifactCreateRequest {
  const credentials = requireDataKeyAccessKey(params.cliAccessKey);
  const dataEncryptionKey = params.dataEncryptionKeyBytes ?? new Uint8Array(randomBytes(32));
  if (dataEncryptionKey.length !== 32) {
    throw new Error(`Expected 32-byte artifact data encryption key, received ${dataEncryptionKey.length}`);
  }

  const encryptedDataKey = sealEncryptedDataKeyEnvelopeV1({
    dataKey: dataEncryptionKey,
    recipientPublicKey: credentials.publicKey,
    randomBytes: params.randomBytes ?? randomBytes,
  });

  return {
    id: params.artifactId,
    header: encryptDataKeyBase64(params.headerJson, dataEncryptionKey),
    body: encryptDataKeyBase64(params.bodyJson, dataEncryptionKey),
    dataEncryptionKey: Buffer.from(encryptedDataKey).toString('base64'),
  };
}

export async function createEncryptedArtifactViaApi(params: Readonly<{
  baseUrl: string;
  token: string;
  artifactId: string;
  headerJson: unknown;
  bodyJson: unknown;
  cliAccessKey: CliAccessKey;
}>): Promise<ArtifactRecord> {
  const request = buildEncryptedArtifactCreateRequestForCliAccessKey({
    artifactId: params.artifactId,
    headerJson: params.headerJson,
    bodyJson: params.bodyJson,
    cliAccessKey: params.cliAccessKey,
  });
  const res = await fetchJson<ArtifactRecord>(`${params.baseUrl}/v1/artifacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
    throw new Error(`Expected 200 encrypted artifact create, received ${res.status}`);
  }
  return res.data;
}

export function decodeEncryptedArtifactJsonBase64ForCliAccessKey<T>(params: Readonly<{
  encryptedJsonBase64: string;
  dataEncryptionKeyBase64: string;
  cliAccessKey: CliAccessKey;
}>): T | null {
  const credentials = requireDataKeyAccessKey(params.cliAccessKey);
  const dataEncryptionKey = openEncryptedDataKeyEnvelopeV1({
    envelope: decodeBase64Bytes(params.dataEncryptionKeyBase64),
    recipientSecretKeyOrSeed: credentials.machineKey,
  });
  if (!dataEncryptionKey) return null;
  const decrypted = decryptDataKeyBase64(params.encryptedJsonBase64, dataEncryptionKey);
  return unwrapSerializedJsonValue(decrypted) as T | null;
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

function requireDataKeyAccessKey(accessKey: CliAccessKey): Readonly<{
  publicKey: Uint8Array;
  machineKey: Uint8Array;
}> {
  if (!('encryption' in accessKey)) {
    throw new Error('Encrypted artifact helpers require a data-key CLI access key');
  }
  return {
    publicKey: decodeBase64Bytes(accessKey.encryption.publicKey),
    machineKey: decodeBase64Bytes(accessKey.encryption.machineKey),
  };
}

function decodeBase64Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}
