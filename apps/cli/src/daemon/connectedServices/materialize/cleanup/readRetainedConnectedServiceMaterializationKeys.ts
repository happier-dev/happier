import { readConnectedServiceMaterializationIdentityV1FromMetadata } from '@happier-dev/protocol';

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
}>) => Promise<Readonly<{
  sessions: ReadonlyArray<SessionRowWithMetadata>;
  nextCursor: string | null;
  hasNext: boolean;
}>>;

type DecryptSessionMetadata = (input: Readonly<{
  credentials: StoredCredentials;
  rawSession: SessionRowWithMetadata;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
}>) => Record<string, unknown> | null;

const DEFAULT_PAGE_LIMIT = 200;

function isArchived(row: SessionRowWithMetadata): boolean {
  return row.archivedAt !== null && row.archivedAt !== undefined;
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
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  const accountEncryptionCurrentness = await (
    params.getAccountEncryptionCurrentness
    ?? (async () => await fetchAccountEncryptionCurrentness({ token: params.credentials.token }))
  )();

  while (true) {
    const page = await fetchPage({
      token: params.credentials.token,
      ...(cursor ? { cursor } : {}),
      limit: pageLimit,
    });
    for (const row of page.sessions) {
      if (row.active === true || isArchived(row)) continue;
      const metadata = decryptMetadata({
        credentials: params.credentials,
        rawSession: row,
        accountEncryptionMode: accountEncryptionCurrentness.mode,
      });
      const identity = readConnectedServiceMaterializationIdentityV1FromMetadata(metadata);
      const key = typeof identity?.id === 'string' ? identity.id.trim() : '';
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      retainedKeys.push(key);
    }
    if (!page.hasNext || !page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) break;
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return retainedKeys;
}
