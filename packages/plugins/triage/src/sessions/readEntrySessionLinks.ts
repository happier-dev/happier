import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1, type TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { CorpusCollectionHandleV1 } from '../corpus/collections/handles.js';
import { CORPUS_SESSION_LINKS_INDEX_ID } from '../corpus/collections/ids.js';
import { fromCorpusStoredRow, type CorpusRowV1 } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import { deriveSessionLinkEntryTag } from '../corpus/identity/tags.js';

export type TriageSessionLinksReaderV1 = Pick<CorpusCollectionHandleV1, 'query' | 'identityTag'>;

/** The same exact indexed selection serves reads and content-free observation. */
export async function triageSessionLinksSelectionV1(
  collection: Pick<TriageSessionLinksReaderV1, 'identityTag'>,
  relation: Readonly<{ entryRef: TriageEntryRefV1 }> | Readonly<{ sessionId: string }> | undefined,
  options?: PluginCancellationOptions,
) {
  const bySession = relation !== undefined && 'sessionId' in relation;
  const prefix = relation === undefined ? undefined : bySession ? [relation.sessionId]
    : [await deriveSessionLinkEntryTag(collection, relation.entryRef, options)];
  return { index: bySession ? CORPUS_SESSION_LINKS_INDEX_ID.bySession : CORPUS_SESSION_LINKS_INDEX_ID.byEntry,
    ...(prefix === undefined ? {} : { prefix }), order: 'asc' as const };
}

/** Resolve a current relationship without assuming its immutable storage identity. */
export async function findTriageEntrySessionLinkV1(
  collection: TriageSessionLinksReaderV1,
  input: Readonly<{ entryRef: TriageEntryRefV1; sessionId: string }>,
  options?: PluginCancellationOptions,
): Promise<CorpusSessionLinkRowV1 | null> {
  let cursor: string | undefined;
  do {
    const page = await readTriageSessionLinksPageV1(collection, { relation: { entryRef: input.entryRef }, cursor }, options);
    const link = page.links.find((row) => row.sessionId === input.sessionId);
    if (link !== undefined) return link;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return null;
}

/** The existing link indexes, one Collection page and one decoding boundary. */
export async function readTriageSessionLinksPageV1(
  collection: TriageSessionLinksReaderV1,
  input: Readonly<{
    relation?: Readonly<{ entryRef: TriageEntryRefV1 }> | Readonly<{ sessionId: string }>;
    cursor?: string;
  }> = {},
  options?: PluginCancellationOptions,
): Promise<Readonly<{ links: readonly CorpusSessionLinkRowV1[]; records: readonly CorpusRowV1<CorpusSessionLinkRowV1>[]; nextCursor?: string }>> {
  const selection = await triageSessionLinksSelectionV1(collection, input.relation, options);
  const page = await collection.query({
    ...selection,
    limit: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  }, options);
  const records = Object.freeze(page.rows.map((row) => fromCorpusStoredRow<CorpusSessionLinkRowV1>(row)));
  return Object.freeze({
    links: Object.freeze(records.map(row => row.value)), records,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  });
}

/** Exact entry-set demand shares the Collection's indexed paging owner. */
export async function readTriageSessionLinksForEntriesV1(
  collection: TriageSessionLinksReaderV1,
  entries: readonly TriageEntryRefV1[],
  options?: PluginCancellationOptions,
): Promise<readonly CorpusSessionLinkRowV1[]> {
  if (entries.length === 0) return [];
  const tags = await Promise.all(entries.map(entry => deriveSessionLinkEntryTag(collection, entry, options)));
  const prefixes = [...new Set(tags)].map(tag => [tag]);
  const links: CorpusSessionLinkRowV1[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await collection.query({ index: CORPUS_SESSION_LINKS_INDEX_ID.byEntry, prefixes,
      order: 'asc', limit: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
      ...(cursor === undefined ? {} : { cursor }),
    }, options);
    links.push(...page.rows.map(row => fromCorpusStoredRow<CorpusSessionLinkRowV1>(row).value));
    if (page.nextCursor !== undefined && seen.has(page.nextCursor)) throw new Error('triage:sessionLinks:cursorDidNotAdvance');
    if (page.nextCursor !== undefined) seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return links;
}
