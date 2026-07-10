import axios from 'axios';
import { randomUUID } from 'node:crypto';

import {
  ApprovalRequestV1Schema,
  ActionIdSchema,
  openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
  type ActionId,
  type ApprovalQueueListItemV1,
  type ApprovalRequestV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import {
  decodeBase64,
  decryptWithDataKey,
  encodeBase64,
  encryptWithDataKey,
  getRandomBytes,
  libsodiumPublicKeyFromSecretKey,
} from '@/api/encryption';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { deriveKey } from '@/utils/deriveKey';

type ArtifactFullRecord = Readonly<{
  id: string;
  header: string;
  headerVersion: number;
  body: string;
  bodyVersion: number;
  dataEncryptionKey: string;
  seq: number;
  createdAt: number;
  updatedAt: number;
}>;

type ArtifactListRecord = Omit<ArtifactFullRecord, 'body' | 'bodyVersion'>;

type ArtifactCreateRequest = Readonly<{
  id: string;
  header: string;
  body: string;
  dataEncryptionKey: string;
}>;

type ArtifactUpdateRequest = Readonly<{
  header: string;
  expectedHeaderVersion: number;
  body: string;
  expectedBodyVersion: number;
}>;

async function resolveRecipientSecretKeyOrSeed(credentials: Credentials): Promise<Uint8Array> {
  if (credentials.encryption.type === 'dataKey') return credentials.encryption.machineKey;
  return await deriveKey(credentials.encryption.secret, 'Happy EnCoder', ['content']);
}

async function resolveRecipientPublicKey(credentials: Credentials): Promise<Uint8Array> {
  if (credentials.encryption.type === 'dataKey') return credentials.encryption.publicKey;
  return libsodiumPublicKeyFromSecretKey(await resolveRecipientSecretKeyOrSeed(credentials));
}

async function openArtifactDataEncryptionKey(params: Readonly<{
  credentials: Credentials;
  encryptedDataEncryptionKeyBase64: string;
}>): Promise<Uint8Array | null> {
  const recipientSecretKeyOrSeed = await resolveRecipientSecretKeyOrSeed(params.credentials);
  return openEncryptedDataKeyEnvelopeV1({
    envelope: decodeBase64(params.encryptedDataEncryptionKeyBase64),
    recipientSecretKeyOrSeed,
  });
}

async function sealArtifactDataEncryptionKey(params: Readonly<{
  credentials: Credentials;
  dataEncryptionKey: Uint8Array;
}>): Promise<string> {
  const recipientPublicKey = await resolveRecipientPublicKey(params.credentials);
  const envelope = sealEncryptedDataKeyEnvelopeV1({
    dataKey: params.dataEncryptionKey,
    recipientPublicKey,
    randomBytes: getRandomBytes,
  });
  return encodeBase64(envelope, 'base64');
}

function buildApprovalArtifactHeader(request: ApprovalRequestV1): Record<string, unknown> {
  const sessionId = typeof request.createdBy.sessionId === 'string' ? request.createdBy.sessionId.trim() : '';
  return {
    v: 1,
    kind: 'approval_request.v1',
    title: request.summary,
    approvalStatus: request.status,
    actionId: request.actionId,
    ...(sessionId ? { sessions: [sessionId], sessionId } : {}),
  };
}

function parseApprovalStatus(value: unknown): ApprovalRequestV1['status'] | null {
  if (
    value === 'open'
    || value === 'approved'
    || value === 'rejected'
    || value === 'executed'
    || value === 'failed'
    || value === 'canceled'
  ) {
    return value;
  }
  return null;
}

function parseApprovalActionId(value: unknown): ActionId | null {
  return typeof value === 'string' && ActionIdSchema.safeParse(value).success ? value as ActionId : null;
}

function normalizeArtifactServerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function decryptApprovalArtifactHeader(
  encryptedHeaderBase64: string,
  dataEncryptionKey: Uint8Array,
): Record<string, unknown> | null {
  const header = decryptWithDataKey(decodeBase64(encryptedHeaderBase64), dataEncryptionKey) as Record<string, unknown> | null;
  return header && header.kind === 'approval_request.v1' ? header : null;
}

function approvalArtifactMatchesServerScope(
  header: Record<string, unknown>,
  serverId: string | null,
): boolean {
  if (!serverId) return true;
  return normalizeArtifactServerId(header.serverId) === serverId;
}

async function fetchArtifactFullRecord(params: Readonly<{
  credentials: Credentials;
  artifactId: string;
}>): Promise<ArtifactFullRecord | null> {
  const response = await axios.get(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(params.artifactId)}`, {
    headers: {
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
    validateStatus: () => true,
  });

  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) return null;

  const record = response.data as Record<string, unknown>;
  if (typeof record.id !== 'string') return null;
  if (typeof record.header !== 'string') return null;
  if (typeof record.body !== 'string') return null;
  if (typeof record.dataEncryptionKey !== 'string') return null;

  return {
    id: record.id,
    header: record.header,
    headerVersion: Number((record as any).headerVersion),
    body: record.body,
    bodyVersion: Number((record as any).bodyVersion),
    dataEncryptionKey: record.dataEncryptionKey,
    seq: Number((record as any).seq),
    createdAt: Number((record as any).createdAt),
    updatedAt: Number((record as any).updatedAt),
  };
}

async function fetchArtifactListRecords(params: Readonly<{
  credentials: Credentials;
  limit: number;
}>): Promise<readonly ArtifactListRecord[]> {
  const url = new URL('/v1/artifacts', resolveServerHttpBaseUrl());
  url.searchParams.set('limit', String(params.limit));
  const response = await axios.get(url.toString(), {
    headers: {
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300 || !Array.isArray(response.data)) return [];

  return response.data.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    if (typeof record.id !== 'string') return [];
    if (typeof record.header !== 'string') return [];
    if (typeof record.dataEncryptionKey !== 'string') return [];
    return [{
      id: record.id,
      header: record.header,
      headerVersion: Number(record.headerVersion),
      dataEncryptionKey: record.dataEncryptionKey,
      seq: Number(record.seq),
      createdAt: Number(record.createdAt),
      updatedAt: Number(record.updatedAt),
    }];
  });
}

async function createArtifact(params: Readonly<{
  credentials: Credentials;
  request: ArtifactCreateRequest;
}>): Promise<{ ok: true; artifactId: string } | { ok: false }> {
  const response = await axios.post(`${resolveServerHttpBaseUrl()}/v1/artifacts`, params.request, {
    headers: {
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) return { ok: false };
  const record = response.data as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : params.request.id;
  return { ok: true, artifactId: id };
}

async function updateArtifact(params: Readonly<{
  credentials: Credentials;
  artifactId: string;
  request: ArtifactUpdateRequest;
}>): Promise<
  | { ok: true }
  | { ok: false; errorCode: 'not_found' | 'version_mismatch' | 'update_failed'; error: string }
> {
  const response = await axios.post(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(params.artifactId)}`, params.request, {
    headers: {
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
    validateStatus: () => true,
  });

  if (response.status === 404) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
  if (response.status < 200 || response.status >= 300) return { ok: false, errorCode: 'update_failed', error: 'artifact_update_failed' };

  const parsed = response.data as any;
  if (parsed && parsed.success === true) return { ok: true };
  if (parsed && parsed.success === false && parsed.error === 'version-mismatch') {
    return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
  }
  return { ok: false, errorCode: 'update_failed', error: 'artifact_update_failed' };
}

export function createCliApprovalsArtifactStore(params: Readonly<{ credentials: Credentials }>): Readonly<{
  approvalsList: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsList']>;
  approvalsCreate: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsCreate']>;
  approvalsGet: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsGet']>;
  approvalsUpdate: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsUpdate']>;
}> {
  return {
    approvalsList: async ({ status, limit, serverId }) => {
      const items: ApprovalQueueListItemV1[] = [];
      const normalizedServerId = typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : null;
      const maxItems = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 32;
      const serverLimit = Math.max(maxItems, Math.min(500, maxItems * 5));
      const records = await fetchArtifactListRecords({ credentials: params.credentials, limit: serverLimit });

      for (const artifact of records) {
        if (items.length >= maxItems) break;
        const dataEncryptionKey = await openArtifactDataEncryptionKey({
          credentials: params.credentials,
          encryptedDataEncryptionKeyBase64: artifact.dataEncryptionKey,
        });
        if (!dataEncryptionKey) continue;

        const header = decryptApprovalArtifactHeader(artifact.header, dataEncryptionKey);
        if (!header) continue;
        if (typeof status === 'string' && header.approvalStatus !== status) continue;
        const headerServerId = normalizeArtifactServerId(header.serverId);
        if (!approvalArtifactMatchesServerScope(header, normalizedServerId)) continue;

        const actionId = parseApprovalActionId(header.actionId);
        const summary = typeof header.title === 'string' ? header.title : '';
        const approvalStatus = parseApprovalStatus(header.approvalStatus);
        if (!actionId || !summary || !approvalStatus) continue;

        items.push({
          artifactId: artifact.id,
          status: approvalStatus,
          actionId,
          summary,
          ...(typeof header.sessionId === 'string' && header.sessionId.trim().length > 0 ? { sessionId: header.sessionId.trim() } : {}),
          ...(headerServerId ? { serverId: headerServerId } : {}),
          updatedAtMs: Number.isFinite(artifact.updatedAt) ? artifact.updatedAt : 0,
        });
      }

      return {
        items,
        queryPlan: {
          kind: 'bounded_approval_artifact_header_scan',
          backingStore: 'ArtifactStore',
          boundedBy: `GET /v1/artifacts?limit=${serverLimit}`,
          serverLimit,
          hydratedTranscripts: false,
        },
      };
    },

    approvalsCreate: async ({ request, serverId }) => {
      const artifactId = randomUUID();
      const dataEncryptionKey = getRandomBytes(32);
      const encryptedKey = await sealArtifactDataEncryptionKey({ credentials: params.credentials, dataEncryptionKey });

      const header = {
        ...buildApprovalArtifactHeader(request),
        ...(typeof serverId === 'string' && serverId.trim().length > 0 ? { serverId: serverId.trim() } : {}),
      };
      const encryptedHeader = encodeBase64(encryptWithDataKey(header, dataEncryptionKey), 'base64');
      const encryptedBody = encodeBase64(encryptWithDataKey({ body: JSON.stringify(request) }, dataEncryptionKey), 'base64');

      const res = await createArtifact({
        credentials: params.credentials,
        request: {
          id: artifactId,
          header: encryptedHeader,
          body: encryptedBody,
          dataEncryptionKey: encryptedKey,
        },
      });
      if (!res.ok) {
        throw new Error('approval_request_create_failed');
      }
      return { artifactId: res.artifactId };
    },

    approvalsGet: async ({ artifactId, serverId }) => {
      const artifact = await fetchArtifactFullRecord({ credentials: params.credentials, artifactId });
      if (!artifact) return null;

      const dataEncryptionKey = await openArtifactDataEncryptionKey({
        credentials: params.credentials,
        encryptedDataEncryptionKeyBase64: artifact.dataEncryptionKey,
      });
      if (!dataEncryptionKey) return null;

      const header = decryptApprovalArtifactHeader(artifact.header, dataEncryptionKey);
      if (!header || !approvalArtifactMatchesServerScope(header, normalizeArtifactServerId(serverId))) return null;

      const decrypted = decryptWithDataKey(decodeBase64(artifact.body), dataEncryptionKey) as { body?: unknown } | null;
      const body = typeof decrypted?.body === 'string' ? decrypted.body : null;
      if (!body) return null;

      try {
        const parsed = ApprovalRequestV1Schema.safeParse(JSON.parse(body));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },

    approvalsUpdate: async ({ artifactId, request, serverId }) => {
      const artifact = await fetchArtifactFullRecord({ credentials: params.credentials, artifactId });
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };

      const dataEncryptionKey = await openArtifactDataEncryptionKey({
        credentials: params.credentials,
        encryptedDataEncryptionKeyBase64: artifact.dataEncryptionKey,
      });
      if (!dataEncryptionKey) return { ok: false, errorCode: 'invalid_parameters', error: 'artifact_key_unavailable' };

      const existingHeader = decryptApprovalArtifactHeader(artifact.header, dataEncryptionKey);
      if (!existingHeader || !approvalArtifactMatchesServerScope(existingHeader, normalizeArtifactServerId(serverId))) {
        return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      }

      const header = {
        ...buildApprovalArtifactHeader(request),
        ...(typeof serverId === 'string' && serverId.trim().length > 0 ? { serverId: serverId.trim() } : {}),
      };
      const encryptedHeader = encodeBase64(encryptWithDataKey(header, dataEncryptionKey), 'base64');
      const encryptedBody = encodeBase64(encryptWithDataKey({ body: JSON.stringify(request) }, dataEncryptionKey), 'base64');

      const updated = await updateArtifact({
        credentials: params.credentials,
        artifactId,
        request: {
          header: encryptedHeader,
          expectedHeaderVersion: artifact.headerVersion,
          body: encryptedBody,
          expectedBodyVersion: artifact.bodyVersion,
        },
      });

      if (updated.ok) return { ok: true };
      return { ok: false, errorCode: updated.errorCode, error: updated.error };
    },
  };
}
