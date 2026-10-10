import { readConnectedServiceMaterializationIdentityV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/connectedServiceMaterializationIdentityV1';

import type { StoredCredentials } from '@/persistence';
import { fetchSessionsPage } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

type SessionRowWithMetadata = Readonly<{
  id?: unknown;
  active?: unknown;
  archivedAt?: unknown;
  metadata?: unknown;
  metadataLayoutVersion?: unknown;
  ownerMetadata?: unknown;
  dataEncryptionKey?: unknown;
  encryptionMode?: unknown;
}>;

type FetchSessionsPage = (params: Readonly<{
  token: string;
  cursor?: string;
  limit?: number;
  archivedOnly?: boolean;
}>) => Promise<Readonly<{
  sessions: ReadonlyArray<SessionRowWithMetadata>;
  nextCursor: string | null;
  hasNext: boolean;
  metadataUpgradeRequiredCount?: number;
}>>;

type DecryptSessionMetadata = (input: Readonly<{
  credentials: StoredCredentials;
  rawSession: SessionRowWithMetadata;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
}>) => Record<string, unknown> | null;

const DEFAULT_PAGE_LIMIT = 200;

function retentionUnavailable(): Error & { code: string } {
  return Object.assign(new Error('Connected-service Session home references could not be fully read'), {
    code: 'connected_service_home_retention_unavailable',
  });
}

export async function readRetainedConnectedServiceMaterializationKeys(params: Readonly<{
  credentials: StoredCredentials;
  fetchSessionsPage?: FetchSessionsPage;
  decryptSessionMetadata?: DecryptSessionMetadata;
  getAccountEncryptionCurrentness?: () => Promise<AccountEncryptionCurrentnessResponse>;
  pageLimit?: number;
}>): Promise<ReadonlyArray<string>> {
  const fetchPage = params.fetchSessionsPage ?? fetchSessionsPage;
  const decryptMetadata = params.decryptSessionMetadata ?? tryDecryptSessionOwnerMetadataView;
  const pageLimit = typeof params.pageLimit === 'number' && Number.isFinite(params.pageLimit)
    ? Math.max(1, Math.trunc(params.pageLimit))
    : DEFAULT_PAGE_LIMIT;
  const retainedKeys: string[] = [];
  const seenKeys = new Set<string>();
  const accountEncryptionCurrentness = await (
    params.getAccountEncryptionCurrentness
    ?? (async () => await fetchAccountEncryptionCurrentness({ token: params.credentials.token }))
  )();

  for (const archivedOnly of [false, true]) {
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const page = await fetchPage({
        token: params.credentials.token,
        ...(cursor ? { cursor } : {}),
        ...(archivedOnly ? { archivedOnly: true } : {}),
        limit: pageLimit,
      });
      if (page.metadataUpgradeRequiredCount) throw retentionUnavailable();
      for (const row of page.sessions) {
        const metadata = decryptMetadata({
          credentials: params.credentials,
          rawSession: row,
          accountEncryptionMode: accountEncryptionCurrentness.mode,
        });
        if (!metadata) throw retentionUnavailable();
        const identity = readConnectedServiceMaterializationIdentityV1FromMetadata(metadata);
        const key = typeof identity?.id === 'string' ? identity.id.trim() : '';
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        retainedKeys.push(key);
      }
      if (!page.hasNext) break;
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) throw retentionUnavailable();
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  return retainedKeys;
}
