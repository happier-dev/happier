import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import {
  fetchSessionsPage,
  type RawSessionListRow,
  type SessionReadHttpObserver,
} from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';

/**
 * One Account session as external-identity proofs read it: the decrypted owner
 * metadata view plus the storage facts hosted-identity proofs need.
 */
export type ExternalSessionAccountScanRow = Readonly<{
  sessionId: string;
  metadata: Readonly<Record<string, unknown>> | null;
  currentStorageState: RawSessionListRow['currentStorageState'];
  currentStorageStateWasOmitted: boolean;
}>;

/**
 * Content-free cost of one Account read: pages and rows, plus per-kind request
 * time and declared wire bytes (list vs read-batch) and the time spent opening
 * row metadata. Wire bytes count only responses that declared a length.
 */
export type ExternalSessionAccountScanStats = {
  pages: number;
  rows: number;
  listMs: number;
  listBytes: number;
  readBatchMs: number;
  readBatchBytes: number;
  decryptMs: number;
};

export function createExternalSessionAccountScanStats(): ExternalSessionAccountScanStats {
  return { pages: 0, rows: 0, listMs: 0, listBytes: 0, readBatchMs: 0, readBatchBytes: 0, decryptMs: 0 };
}

function observeInto(stats: ExternalSessionAccountScanStats | undefined): SessionReadHttpObserver | undefined {
  if (!stats) return undefined;
  return ({ kind, ms, bytes }) => {
    if (kind === 'list') {
      stats.listMs += ms;
      stats.listBytes += bytes ?? 0;
    } else {
      stats.readBatchMs += ms;
      stats.readBatchBytes += bytes ?? 0;
    }
  };
}

/**
 * Plain paged read of the Account's sessions (active pages, then archived
 * pages, newest first), decrypting each row's owner metadata view. It keeps no
 * state between calls. Two callers: the per-Machine external-identity backfill
 * (every page, once) and `link.ensure` on a Machine whose backfill has not
 * finished yet (bounded by `maxPagesPerStorage`). The caller stops at its
 * first match, so a hit reads no further pages.
 */
export async function* readExternalSessionAccountRows(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  /** Omitted = every page. */
  maxPagesPerStorage?: number;
  signal?: AbortSignal;
  stats?: ExternalSessionAccountScanStats;
}>): AsyncGenerator<ExternalSessionAccountScanRow> {
  for (const archivedOnly of [false, true]) {
    let cursor: string | undefined;
    for (let pageIndex = 0; params.maxPagesPerStorage === undefined || pageIndex < params.maxPagesPerStorage; pageIndex += 1) {
      params.signal?.throwIfAborted();
      if (params.stats) params.stats.pages += 1;
      const page = await fetchSessionsPage({
        token: params.credentials.token,
        cursor,
        limit: 200,
        archivedOnly,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.stats ? { observeHttp: observeInto(params.stats) } : {}),
      });
      if (params.stats) params.stats.rows += page.sessions.length;
      const startedAtMs = performance.now();
      const rows = page.sessions.map((raw): ExternalSessionAccountScanRow => ({
        sessionId: raw.id,
        metadata: tryDecryptSessionOwnerMetadataView({
          credentials: params.credentials,
          rawSession: raw,
          accountEncryptionMode: params.accountEncryptionMode,
        }),
        currentStorageState: raw.currentStorageState,
        currentStorageStateWasOmitted: !Object.prototype.hasOwnProperty.call(raw, 'currentStorageState'),
      }));
      if (params.stats) params.stats.decryptMs += performance.now() - startedAtMs;
      yield* rows;
      if (!page.hasNext || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }
}
