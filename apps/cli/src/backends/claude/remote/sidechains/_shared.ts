import type { RawJSONLines } from '@/backends/claude/types';

export function extractOutputFilePathFromTaskResultText(text: string): string | null {
  const raw = String(text ?? '');
  const m = raw.match(/\boutput_file\s*[:=]\s*([^\s]+)/i);
  const value = m?.[1] ? String(m[1]).trim() : '';
  if (!value) return null;
  return value.replace(/^['"]|['"]$/g, '').trim() || null;
}

export function coerceToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';

  // Some SDK surfaces return a content-block array (e.g. [{type:'text', text:'...'}]).
  // For Task/TaskOutput we only need best-effort text extraction.
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if ((item as any).type !== 'text') continue;
      const text = (item as any).text;
      if (typeof text === 'string' && text.trim().length > 0) {
        chunks.push(text);
      }
    }
    return chunks.join('\n');
  }

  return '';
}

export function isPromptRootUserMessage(record: RawJSONLines): boolean {
  if (record.type !== 'user') return false;
  if ((record as any).isSidechain !== true) return false;
  const msg = (record as any).message;
  if (!msg || typeof msg !== 'object') return false;
  if ((msg as any).role !== 'user') return false;
  return typeof (msg as any).content === 'string';
}

export function markRecordAsSidechain(record: RawJSONLines, sidechainId: string): RawJSONLines {
  (record as any).isSidechain = true;
  (record as any).sidechainId = sidechainId;
  return record;
}

export class LruSet {
  private readonly max: number;
  private readonly map = new Map<string, true>();

  constructor(max: number) {
    this.max = Math.max(0, Math.floor(max));
  }

  has(value: string): boolean {
    return this.map.has(value);
  }

  add(value: string): void {
    if (this.max === 0) return;
    if (this.map.has(value)) {
      this.map.delete(value);
    }
    this.map.set(value, true);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (!oldest) break;
      this.map.delete(oldest);
    }
  }
}

export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maxKeys: number): void {
  const limit = Math.max(0, Math.floor(maxKeys));
  if (map.has(key)) {
    map.delete(key); // refresh insertion order
  }
  map.set(key, value);
  if (limit === 0) {
    map.clear();
    return;
  }
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function markUuidSeenAndReturnIsDuplicate(params: {
  seenUuidsBySidechainId: Map<string, LruSet>;
  sidechainId: string;
  uuid: string;
  maxSeenUuidsPerSidechain: number;
  maxSidechains?: number;
}): boolean {
  const uuid = String(params.uuid ?? '').trim();
  if (!uuid) return false;

  const existing = params.seenUuidsBySidechainId.get(params.sidechainId) ?? null;
  const seen = existing ?? new LruSet(params.maxSeenUuidsPerSidechain);
  if (!existing) {
    if (typeof params.maxSidechains === 'number') {
      setBoundedMap(params.seenUuidsBySidechainId, params.sidechainId, seen, params.maxSidechains);
    } else {
      params.seenUuidsBySidechainId.set(params.sidechainId, seen);
    }
  } else if (typeof params.maxSidechains === 'number') {
    // refresh insertion order for bounded maps
    setBoundedMap(params.seenUuidsBySidechainId, params.sidechainId, existing, params.maxSidechains);
  }

  if (seen.has(uuid)) return true;
  seen.add(uuid);
  return false;
}
