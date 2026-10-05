import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1, type TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { CorpusCollectionHandleV1 } from '../corpus/collections/handles.js';
import { CORPUS_SESSION_LINKS_INDEX_ID } from '../corpus/collections/ids.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import { deriveSessionLinkEntryTag } from '../corpus/identity/tags.js';

export type TriageSessionLinksReaderV1 = Pick<CorpusCollectionHandleV1, 'query' | 'identityTag'>;

/** The existing link indexes, one Collection page and one decoding boundary. */
export async function readTriageSessionLinksPageV1(
  collection: TriageSessionLinksReaderV1,
  input: Readonly<{
    relation?: Readonly<{ entryRef: TriageEntryRefV1 }> | Readonly<{ sessionId: string }>;
    cursor?: string;
  }> = {},
  options?: PluginCancellationOptions,
): Promise<Readonly<{ links: readonly CorpusSessionLinkRowV1[]; nextCursor?: string }>> {
  const relation = input.relation;
  const bySession = relation !== undefined && 'sessionId' in relation;
  const prefix = relation === undefined
    ? undefined
    : bySession
      ? [relation.sessionId]
      : [await deriveSessionLinkEntryTag(collection, relation.entryRef, options)];
  const page = await collection.query({
    index: bySession ? CORPUS_SESSION_LINKS_INDEX_ID.bySession : CORPUS_SESSION_LINKS_INDEX_ID.byEntry,
    ...(prefix === undefined ? {} : { prefix }),
    order: 'asc',
    limit: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  }, options);
  return Object.freeze({
    links: Object.freeze(page.rows.map((row) => fromCorpusStoredRow<CorpusSessionLinkRowV1>(row).value)),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  });
}
