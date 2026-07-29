import {
  SessionSynopsisV1Schema,
  isAgentThreadTextConversationTurnMeta,
} from '@happier-dev/protocol';

import { decodeBase64, decrypt } from '@/api/encryption';
import { collectReferencedSessionMediaWorkspacePaths } from '@/session/media/referencedPaths';
import { decodeTranscriptBody } from '@/session/services/transcript/transcriptBodyDecoder';

import type { HappierReplayDialogItem } from './types';

type RawTranscriptRow = Readonly<{
  seq?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

function isMemoryArtifactMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const happier = (meta as Record<string, unknown>).happier;
  if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return false;
  const kind = (happier as Record<string, unknown>).kind;
  return kind === 'session_summary_shard.v1' || kind === 'session_synopsis.v1';
}

function tryReadSessionSynopsisText(meta: unknown): { synopsis: string; updatedAtMs: number; seqTo: number } | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const happier = (meta as any).happier;
  if (!happier || typeof happier !== 'object') return null;
  if (happier.kind !== 'session_synopsis.v1') return null;
  const parsed = SessionSynopsisV1Schema.safeParse(happier.payload);
  if (!parsed.success) return null;
  return { synopsis: parsed.data.synopsis, updatedAtMs: parsed.data.updatedAtMs, seqTo: parsed.data.seqTo };
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

export function decryptTranscriptReplayCore(params: Readonly<{
  rows: readonly RawTranscriptRow[];
  encryptionKey?: Uint8Array;
  encryptionVariant?: 'dataKey';
  maxTextChars?: number;
  maxDialogItems?: number;
}>): Readonly<{
  dialog: HappierReplayDialogItem[];
  latestSynopsisText: string | null;
  referencedSessionMediaWorkspacePaths: readonly string[];
}> {
  const maxTextChars = params.maxTextChars;
  const maxDialogItems = normalizePositiveInt(params.maxDialogItems, 200, { min: 1, max: 10_000 });
  const out: Array<{ role: 'User' | 'Assistant'; createdAt: number; seq: number | null; text: string }> = [];
  let bestSynopsis: { synopsis: string; updatedAtMs: number; seqTo: number } | null = null;
  const referencedSessionMediaWorkspacePaths = new Set<string>();

  for (const row of params.rows ?? []) {
    try {
      const seq =
        typeof (row as any)?.seq === 'number' && Number.isFinite((row as any).seq) ? Number((row as any).seq) : null;
      const createdAt = typeof row?.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : 0;
      const content = (row as any)?.content;
      if (!content || typeof content !== 'object') continue;

      let decryptedValue: any = null;
      if (content.t === 'plain') {
        decryptedValue = content.v;
      } else {
        if (content.t !== 'encrypted' || typeof content.c !== 'string') continue;
        if (!params.encryptionKey || params.encryptionVariant !== 'dataKey') continue;
        decryptedValue = decrypt(params.encryptionKey, 'dataKey', decodeBase64(content.c));
      }
      if (!decryptedValue || typeof decryptedValue !== 'object') continue;
      for (const path of collectReferencedSessionMediaWorkspacePaths([decryptedValue])) {
        referencedSessionMediaWorkspacePaths.add(path);
      }

      const synopsisCandidate = tryReadSessionSynopsisText(decryptedValue.meta);
      if (synopsisCandidate) {
        if (
          !bestSynopsis ||
          synopsisCandidate.updatedAtMs > bestSynopsis.updatedAtMs ||
          (synopsisCandidate.updatedAtMs === bestSynopsis.updatedAtMs && synopsisCandidate.seqTo > bestSynopsis.seqTo)
        ) {
          bestSynopsis = synopsisCandidate;
        }
        continue;
      }

      if (!isAgentThreadTextConversationTurnMeta(decryptedValue.meta)) continue;

      if (decryptedValue.role === 'agent') {
        // Skip explicit thinking transcripts when they are surfaced as agent messages.
        if (decryptedValue?.meta?.isThinking === true) continue;
        // Skip daemon-generated memory artifacts (summary shards / synopsis).
        if (isMemoryArtifactMeta(decryptedValue?.meta)) continue;
      }

      const decoded = decodeTranscriptBody(decryptedValue);
      if (!decoded) continue;
      if (decoded.semanticRole === 'user') {
        if (!decoded.text) continue;
        out.push({
          role: 'User',
          createdAt,
          seq,
          text: typeof maxTextChars === 'number' ? truncateText(decoded.text, maxTextChars) : decoded.text,
        });
        continue;
      }

      if (decryptedValue.role === 'agent' && (decoded.semanticRole === 'assistant' || decoded.semanticRole === 'tool')) {
        const text = decoded.text ?? decoded.summary;
        if (!text) continue;
        out.push({
          role: 'Assistant',
          createdAt,
          seq,
          text: typeof maxTextChars === 'number' ? truncateText(text, maxTextChars) : text,
        });
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
  // Safety bound: keep the most recent items (oldest dropped first).
  const bounded = out.length > maxDialogItems ? out.slice(out.length - maxDialogItems) : out;

  return {
    dialog: bounded.map(({ seq: _seq, ...rest }) => rest),
    latestSynopsisText: bestSynopsis?.synopsis ?? null,
    referencedSessionMediaWorkspacePaths: [...referencedSessionMediaWorkspacePaths].sort((left, right) => left.localeCompare(right)),
  };
}
