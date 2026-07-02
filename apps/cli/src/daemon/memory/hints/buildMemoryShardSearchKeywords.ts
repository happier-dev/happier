import type { MemoryIndexableTranscriptItem } from '../transcript/indexableItem';

const MAX_MEMORY_SHARD_SEARCH_KEYWORDS = 128;
const MAX_MEMORY_SHARD_SEARCH_KEYWORD_CHARS = 128;

function tokenizeSearchKeywords(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((term) => term.length >= 3);
}

export function buildMemoryShardSearchKeywords(params: Readonly<{
  modelKeywords: readonly string[];
  items: readonly MemoryIndexableTranscriptItem[];
}>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const keyword = String(raw ?? '').trim().slice(0, MAX_MEMORY_SHARD_SEARCH_KEYWORD_CHARS);
    if (!keyword) return;
    const key = keyword.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(keyword);
  };

  for (const keyword of params.modelKeywords) add(keyword);
  for (const item of params.items) {
    for (const keyword of tokenizeSearchKeywords(item.text)) {
      add(keyword);
      if (out.length >= MAX_MEMORY_SHARD_SEARCH_KEYWORDS) return out;
    }
  }
  return out.slice(0, MAX_MEMORY_SHARD_SEARCH_KEYWORDS);
}
