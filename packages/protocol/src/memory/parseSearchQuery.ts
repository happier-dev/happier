export type ParsedSearchQuery = Readonly<{
  terms: readonly string[];
  phrases: readonly string[];
  excludedTerms: readonly string[];
}>;

/** Double quotes group literal text, a leading minus excludes it, and unfinished quotes group the rest while typing. */
export function parseSearchQuery(query: string): ParsedSearchQuery {
  const terms: string[] = [];
  const phrases: string[] = [];
  const excludedTerms: string[] = [];
  for (const match of query.matchAll(/(-?)"([^"]*)"?|([^\s"]+)/g)) {
    const raw = match[2] ?? match[3] ?? '';
    const excluded = match[2] !== undefined ? match[1] === '-' : raw.startsWith('-') && raw.length > 1;
    const text = (excluded && match[3] !== undefined ? raw.slice(1) : raw).trim().toLocaleLowerCase();
    if (!text) continue;
    if (excluded) {
      excludedTerms.push(text);
      continue;
    }
    terms.push(text);
    if (match[2] !== undefined) phrases.push(text);
  }
  return { terms, phrases, excludedTerms };
}
