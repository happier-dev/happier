import { MEMORY_SEARCH_FTS_TOKENIZER, memorySearchQueryGroups, memorySearchTextColumns } from '@happier-dev/protocol/memory/memorySearchText';
import type { SqliteDatabaseSync } from '../persistence/sqliteSync';

type MemoryFtsIndexOptions = Readonly<{
  table: 'message_chunks' | 'summary_shards';
  id: 'chunkId' | 'shardId';
  fts: 'chunk_fts' | 'summary_fts';
}>;

/** Search-owned predicates over the retained row alias `r`, shared with repair. */
export type MemoryFtsSearchFilter = Readonly<{ where: string; params: readonly (string | number)[] }>;

/** One FTS owner for retained daemon transcript rows. Original text stays in its existing table. */
export function createMemoryFtsIndex(db: SqliteDatabaseSync, options: MemoryFtsIndexOptions) {
  const { table, id, fts } = options;
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(body, identifiers, tokenize = '${MEMORY_SEARCH_FTS_TOKENIZER}');
    CREATE VIRTUAL TABLE IF NOT EXISTS ${fts}_vocab USING fts5vocab(${fts}, 'row');
    CREATE TRIGGER IF NOT EXISTS ${fts}_delete AFTER DELETE ON ${table} BEGIN
      DELETE FROM ${fts} WHERE rowid = old.${id};
    END;
  `);
  const insert = db.prepare(`INSERT INTO ${fts}(rowid, body, identifiers) VALUES (?, ?, ?);`);
  const remove = db.prepare(`DELETE FROM ${fts} WHERE rowid = ?;`);
  const vocabulary = db.prepare(`SELECT term FROM ${fts}_vocab WHERE length(term) BETWEEN ? AND ? ORDER BY term ASC;`);
  const quotePrefix = (term: string) => `"${term.replace(/"/gu, '""')}"*`;
  return {
    put: (rowId: number, body: string, identifiers = '') => {
      const bodyColumns = memorySearchTextColumns(body);
      const identifierColumns = memorySearchTextColumns(identifiers);
      remove.run(rowId);
      insert.run(rowId, bodyColumns.body, [bodyColumns.identifiers, identifierColumns.body, identifierColumns.identifiers].filter(Boolean).join(' '));
    },
    clear: () => db.exec(`DELETE FROM ${fts};`),
    query: (query: string, filters: readonly MemoryFtsSearchFilter[]): Readonly<{ match: string; matchedQuery: string }> => {
      // Vocabulary proposes spellings; only postings the search can return
      // decide whether repair is needed and which spelling wins. Filters are
      // disjoint eligibility batches supplied by the existing search owner.
      const livePostings = filters.map((filter) => ({
        params: filter.params,
        exists: db.prepare(`SELECT 1 FROM ${fts}
          JOIN ${table} r ON r.${id} = ${fts}.rowid
          WHERE ${fts} MATCH ? AND (${filter.where}) LIMIT 1;`),
        count: db.prepare(`SELECT COUNT(*) AS count FROM ${fts}
          JOIN ${table} r ON r.${id} = ${fts}.rowid
          WHERE ${fts} MATCH ? AND (${filter.where});`),
      }));
      const count = (term: string): number => livePostings.reduce((total, filter) => {
        const row = filter.count.get(quotePrefix(term), ...filter.params) as { count: number };
        return total + Number(row.count);
      }, 0);
      const repair = (term: string): string => {
        // A single edit repairs a mistyped word while preserving short/common tokens literally.
        const length = Array.from(term).length;
        if (length < 4) return term;
        if (livePostings.some((filter) => Boolean(filter.exists.get(quotePrefix(term), ...filter.params)))) return term;
        let best = term;
        let bestCount = 0;
        for (const row of vocabulary.all(length - 1, length + 1) as Array<{ term: string }>) {
          if (!isOneEditAway(term, row.term)) continue;
          const visibleCount = count(row.term);
          if (visibleCount > bestCount) { best = row.term; bestCount = visibleCount; }
        }
        return best;
      };
      const terms = new Set<string>();
      const match = memorySearchQueryGroups(query).filter((group) => group.parts.length > 0).map((group) => {
        const quoted = (term: string) => {
          const repaired = repair(term);
          terms.add(repaired);
          return quotePrefix(repaired);
        };
        const parts = group.parts.map(quoted).join(' AND ');
        return group.whole ? `(${quoted(group.whole)} OR (${parts}))` : `(${parts})`;
      }).join(' AND ');
      return { match, matchedQuery: [...terms].join(' ') };
    },
    termCount: (): number => Number((db.prepare(`SELECT COALESCE(SUM(doc), 0) AS count FROM ${fts}_vocab;`).get() as { count: number }).count),
  };
}

function isOneEditAway(left: string, right: string): boolean {
  const a = Array.from(left);
  const b = Array.from(right);
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (++edits > 1) return false;
    if (a.length === b.length && a[i] === b[j + 1] && a[i + 1] === b[j]) { i += 2; j += 2; continue; }
    if (a.length >= b.length) i += 1;
    if (b.length >= a.length) j += 1;
  }
  return edits + (a.length - i) + (b.length - j) === 1;
}
