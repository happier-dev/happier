import { decodeBase64, decrypt } from '@/api/encryption';

import type { HappierReplayDialogItem } from './types';

type RawTranscriptRow = Readonly<{
  seq?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePositiveInt(value: unknown, fallback: number, opts?: { min?: number; max?: number }): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  const n = Number.isFinite(raw) ? Math.floor(raw) : fallback;
  const min = opts?.min ?? 1;
  const max = opts?.max ?? 1_000_000;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function truncateText(text: string, maxChars: number): string {
  const normalizedMax = normalizePositiveInt(maxChars, 50_000, { min: 1, max: 50_000 });
  if (text.length <= normalizedMax) return text;

  const suffix = '...[truncated]';
  if (normalizedMax <= suffix.length) {
    return text.slice(0, normalizedMax);
  }
  return text.slice(0, normalizedMax - suffix.length) + suffix;
}

export function decryptTranscriptTextItems(params: Readonly<{
  rows: readonly RawTranscriptRow[];
  encryptionKey?: Uint8Array;
  encryptionVariant?: 'dataKey';
  maxTextChars?: number;
}>): HappierReplayDialogItem[] {
  const maxTextChars = params.maxTextChars;
  const out: Array<{ role: 'User' | 'Assistant'; createdAt: number; seq: number | null; text: string }> = [];
  for (const row of params.rows ?? []) {
    try {
      const seq =
        typeof (row as any)?.seq === 'number' && Number.isFinite((row as any).seq) ? Number((row as any).seq) : null;
      const createdAt = typeof row?.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : 0;
      const content = row?.content as any;
      if (!content || typeof content !== 'object') continue;

      let decrypted: any = null;
      if (content.t === 'plain') {
        decrypted = content.v;
      } else {
        if (content.t !== 'encrypted' || typeof content.c !== 'string') continue;
        if (!params.encryptionKey || params.encryptionVariant !== 'dataKey') continue;
        decrypted = decrypt(params.encryptionKey, params.encryptionVariant, decodeBase64(content.c));
      }
      if (!decrypted || typeof decrypted !== 'object') continue;

      const role = decrypted.role;
      const body = decrypted.content;

      if (role === 'user') {
        if (body?.type !== 'text') continue;
        const text = normalizeText(body?.text);
        if (!text) continue;
        out.push({
          role: 'User',
          createdAt,
          seq,
          text: typeof maxTextChars === 'number' ? truncateText(text, maxTextChars) : text,
        });
        continue;
      }

      if (role === 'agent') {
        // Skip explicit thinking transcripts when they are surfaced as agent messages.
        if (decrypted?.meta?.isThinking === true) continue;

        if (body?.type === 'text') {
          const text = normalizeText(body?.text);
          if (!text) continue;
          out.push({
            role: 'Assistant',
            createdAt,
            seq,
            text: typeof maxTextChars === 'number' ? truncateText(text, maxTextChars) : text,
          });
          continue;
        }

        if (body?.type === 'acp') {
          const data = body?.data;
          const text = normalizeText(data?.message);
          if (!text) continue;
          out.push({
            role: 'Assistant',
            createdAt,
            seq,
            text: typeof maxTextChars === 'number' ? truncateText(text, maxTextChars) : text,
          });
          continue;
        }
      }
    } catch {
      // Tolerate corrupted transcript rows or unexpected shapes; skip the row.
      continue;
    }
  }

  out.sort((a, b) => {
    if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
    return a.createdAt - b.createdAt;
  });
  // Hard safety bound: keep the most recent 200.
  const bounded = out.length > 200 ? out.slice(out.length - 200) : out;
  return bounded.map(({ seq: _seq, ...rest }) => rest);
}
