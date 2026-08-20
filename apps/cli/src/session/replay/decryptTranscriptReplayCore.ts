import { SessionSynopsisV1Schema } from '@happier-dev/protocol';

import { extractSemanticTranscriptItem } from '../services/transcript/extractSemanticTranscriptItem';
import type { TranscriptRawRow } from '../services/transcript/semanticTranscriptItem';
import { tryResolveDecryptedTranscriptPayload } from '../services/transcript/transcriptHistoryRows';
import type { SessionEncryptionContext } from '../transport/encryption/sessionEncryptionContext';
import type { HappierReplayDialogItem } from './types';

type RawTranscriptRow = Readonly<{
  seq?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

function tryReadSessionSynopsisText(meta: unknown): { synopsis: string; updatedAtMs: number; seqTo: number } | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const happier = (meta as Record<string, unknown>).happier;
  if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return null;
  if ((happier as Record<string, unknown>).kind !== 'session_synopsis.v1') return null;
  const parsed = SessionSynopsisV1Schema.safeParse((happier as Record<string, unknown>).payload);
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

function truncateReplayText(text: string, maxChars: number | undefined): string {
  if (typeof maxChars !== 'number') return text;
  const normalizedMax = normalizePositiveInt(maxChars, 50_000, { min: 1, max: 50_000 });
  if (text.length <= normalizedMax) return text;

  const suffix = '...[truncated]';
  if (normalizedMax <= suffix.length) {
    return text.slice(0, normalizedMax);
  }
  return text.slice(0, normalizedMax - suffix.length) + suffix;
}

function resolveReplayDecryptedPayload(params: Readonly<{
  row: RawTranscriptRow;
  encryptionKey?: Uint8Array;
  encryptionVariant?: SessionEncryptionContext['encryptionVariant'];
}>): unknown | null {
  const content = params.row.content;
  if (!content || typeof content !== 'object') return null;
  if ((content as { t?: unknown }).t === 'plain') return (content as { v?: unknown }).v ?? null;
  if (!params.encryptionKey || !params.encryptionVariant) return null;
  return tryResolveDecryptedTranscriptPayload({
    content,
    ctx: { encryptionKey: params.encryptionKey, encryptionVariant: params.encryptionVariant },
  });
}

export function decryptTranscriptReplayCore(params: Readonly<{
  rows: readonly RawTranscriptRow[];
  encryptionKey?: Uint8Array;
  /**
   * Which scheme opens these rows, as the canonical session-crypto owner
   * resolves it. Hardcoding `dataKey` here silently made a legacy-secret
   * Account's e2ee transcript unreadable, which the Agent transition then
   * reported as `context_unavailable` — after it had stopped the source.
   */
  encryptionVariant?: SessionEncryptionContext['encryptionVariant'];
  maxTextChars?: number;
  maxDialogItems?: number;
}>): Readonly<{
  dialog: HappierReplayDialogItem[];
  latestSynopsisText: string | null;
  /**
   * Examined rows this decoder could not read at all — malformed envelopes and
   * ciphertext it has no key for.
   *
   * Every skip in the loop below is a `continue`, so without this count the
   * caller cannot tell "the source carries nothing more" from "part of the
   * conversation is missing", and the seed ends up presenting a conversation
   * with holes in it as the whole conversation. Rows that decoded fine but carry
   * nothing replayable — events, reasoning, empty turns — are READ, not missing,
   * and are not counted.
   */
  unreadableRowCount: number;
}> {
  const maxDialogItems = normalizePositiveInt(params.maxDialogItems, 200, { min: 1, max: 10_000 });
  const out: Array<{ role: 'User' | 'Assistant'; createdAt: number; seq: number | null; text: string }> = [];
  let bestSynopsis: { synopsis: string; updatedAtMs: number; seqTo: number } | null = null;
  let unreadableRowCount = 0;

  for (let index = 0; index < (params.rows ?? []).length; index += 1) {
    const row = params.rows[index]!;
    try {
      const decryptedValue = resolveReplayDecryptedPayload({
        row,
        ...(params.encryptionKey ? { encryptionKey: params.encryptionKey } : {}),
        ...(params.encryptionVariant ? { encryptionVariant: params.encryptionVariant } : {}),
      });
      if (decryptedValue && typeof decryptedValue === 'object' && !Array.isArray(decryptedValue)) {
        const synopsisCandidate = tryReadSessionSynopsisText((decryptedValue as Record<string, unknown>).meta);
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
      }

      const extracted = extractSemanticTranscriptItem({
        row: row as TranscriptRawRow,
        index,
        ctx: {
          encryptionKey: params.encryptionKey ?? new Uint8Array(0),
          encryptionVariant: params.encryptionVariant ?? 'legacy',
        },
        options: {
          mode: 'transcript',
          transcriptRoles: ['user', 'assistant'],
          includeTools: true,
          includeReasoning: false,
          includeEvents: false,
          maxTextChars: null,
        },
      });
      const item = extracted.item;
      if (!item) {
        // Nothing came out AND the payload never resolved: the row could not be
        // read, rather than read and found ineligible.
        if (!decryptedValue || typeof decryptedValue !== 'object') unreadableRowCount += 1;
        continue;
      }
      const rawText = item.text ?? item.summary;
      if (!rawText) continue;
      out.push({
        role: item.semanticRole === 'user' ? 'User' : 'Assistant',
        createdAt: item.createdAt,
        seq: typeof item.seq === 'number' ? item.seq : null,
        text: truncateReplayText(rawText, params.maxTextChars),
      });
    } catch {
      // Tolerate corrupted rows, and record that the replay cannot claim to be complete.
      unreadableRowCount += 1;
      continue;
    }
  }

  out.sort((a, b) => {
    if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
    return a.createdAt - b.createdAt;
  });
  const bounded = out.length > maxDialogItems ? out.slice(out.length - maxDialogItems) : out;

  return {
    // The row seq is carried, not dropped: it is the anchor the replay seed
    // gives the target Agent to page BACKWARDS from, and it is already resolved
    // here for ordering. Discarding it forced every consumer above to guess
    // which slice of the transcript the seed was holding.
    dialog: bounded,
    latestSynopsisText: bestSynopsis?.synopsis ?? null,
    unreadableRowCount,
  };
}
