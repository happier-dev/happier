function titleRank(title: string, query: string): number {
  const text = title.toLowerCase();
  if (text === query) return 0;
  if (text.startsWith(query)) return 1;
  return text.includes(query) ? 2 : 3;
}

/**
 * What is called what was asked for leads; everything else keeps the order its catalog gave it. No score beyond the
 * title: catalogs report no popularity, and the Store shows none (DESIGN: Catalogs).
 */
export function rankByTitleMatch<Row extends Readonly<{ title: string }>>(rows: readonly Row[], rawQuery: string): readonly Row[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return rows;
  const ranked = rows.map((row, index) => ({ row, index, rank: titleRank(row.title, query) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
  return ranked.every((entry, index) => entry.index === index) ? rows : ranked.map(entry => entry.row);
}
