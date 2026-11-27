export type ToolSearchCandidateV1 = Readonly<{ id: string; title: string; searchText: string }>;

export function normalizeToolSearchQueryV1(query: string | null | undefined): Readonly<{ text: string; tokens: readonly string[] }> {
  const text = query?.trim().toLowerCase() ?? '';
  return { text, tokens: text.split(/[^a-z0-9]+/i).filter(Boolean) };
}

export function scoreToolSearchMatchV1(
  candidate: ToolSearchCandidateV1,
  query: ReturnType<typeof normalizeToolSearchQueryV1>,
): Readonly<{ score: number; matchesAllTokens: boolean }> {
  if (!query.text) return { score: 1, matchesAllTokens: true };

  const { id } = candidate;
  const title = candidate.title.trim().toLowerCase();
  const haystack = candidate.searchText.toLowerCase();
  let score = 0;
  if (id === query.text) score += 1000;
  if (title === query.text) score += 500;
  if (haystack.includes(query.text)) score += 100;

  let matchesAllTokens = true;
  for (const token of query.tokens) {
    const inId = id.includes(token);
    const inTitle = title.includes(token);
    const inSearchText = haystack.includes(token);
    if (inId) score += 50;
    if (inTitle) score += 25;
    if (inSearchText) score += 10;
    if (!inId && !inTitle && !inSearchText) matchesAllTokens = false;
  }
  return { score, matchesAllTokens };
}

export function rankToolCatalogSearchV1<T>(
  items: readonly T[],
  query: string | null | undefined,
  describe: (item: T) => ToolSearchCandidateV1,
  limit?: number,
): T[] {
  const normalized = normalizeToolSearchQueryV1(query);
  return items.map(item => {
    const candidate = describe(item);
    return { item, title: candidate.title, ...scoreToolSearchMatchV1(candidate, normalized) };
  }).filter(match => match.score > 0).sort((left, right) => {
    // A description can capture the whole intent even when its ID lacks a query token.
    if (left.matchesAllTokens !== right.matchesAllTokens) return left.matchesAllTokens ? -1 : 1;
    return right.score - left.score || left.title.localeCompare(right.title);
  }).slice(0, limit).map(match => match.item);
}
