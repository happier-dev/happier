import {
  SessionStoredMessageContentSchema,
  SessionSynopsisV1Schema,
  TranscriptRawRecordV1Schema,
  isAgentThreadTextConversationTurnMeta,
} from '@happier-dev/protocol';

import { collectReferencedSessionMediaWorkspacePaths } from '@/session/media/referencedPaths';
import { decodeTranscriptBody } from '@/session/services/transcript/transcriptBodyDecoder';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { openSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';

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
  /**
   * The Session's established content mode together with the material that opens
   * it, exactly as the canonical session-crypto owner resolves both.
   *
   * Which scheme opens these rows is not this reader's decision — hardcoding
   * `dataKey` once made a legacy-secret Account's e2ee transcript unreadable,
   * which the Agent transition reported as `context_unavailable` after it had
   * stopped the source. Neither is *whether* a row may be opened at all: the mode
   * travels with the key so `openSessionStoredContent` can refuse a plaintext row
   * under an E2EE Session instead of replaying it as authentic content.
   */
  crypto: SessionStoredContentCryptoContext;
  maxTextChars?: number;
  maxDialogItems?: number;
}>): Readonly<{
  dialog: HappierReplayDialogItem[];
  /**
   * Media paths parallel to `dialog`. This is retrieval-local bookkeeping so
   * the fork-chain window can carry paths only for items it actually retains.
   */
  dialogReferencedSessionMediaWorkspacePaths: readonly (readonly string[])[];
  latestSynopsisText: string | null;
  referencedSessionMediaWorkspacePaths: readonly string[];
  /**
   * Examined rows this decoder could not read at all — malformed envelopes,
   * ciphertext it has no key for, and bodies that failed to decode.
   *
   * Every skip below is a `continue`, so without this count the caller cannot
   * tell "the source carries nothing more" from "part of the conversation is
   * missing", and the seed ends up presenting a conversation with holes in it as
   * the whole conversation. Rows that decoded fine but carry nothing replayable
   * — thinking transcripts, memory artifacts, non-conversation events, empty
   * turns — are READ, not missing, and are not counted.
   */
  unreadableRowCount: number;
}> {
  const maxTextChars = params.maxTextChars;
  const maxDialogItems = normalizePositiveInt(params.maxDialogItems, 200, { min: 1, max: 10_000 });
  const out: Array<{
    dialog: { role: 'User' | 'Assistant'; createdAt: number; seq: number | null; text: string };
    referencedSessionMediaWorkspacePaths: readonly string[];
  }> = [];
  let bestSynopsis: { synopsis: string; updatedAtMs: number; seqTo: number } | null = null;
  let unreadableRowCount = 0;

  for (const row of params.rows ?? []) {
    try {
      const seq =
        typeof (row as any)?.seq === 'number' && Number.isFinite((row as any).seq) ? Number((row as any).seq) : null;
      const createdAt = typeof row?.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : 0;
      const content = SessionStoredMessageContentSchema.safeParse((row as any)?.content);
      if (!content.success) {
        unreadableRowCount += 1;
        continue;
      }

      // A refusal here — wrong envelope kind for the established mode, or
      // ciphertext this reader cannot authenticate — is a hole in the replay, not
      // an ineligible row, so the outer catch counts it.
      const decryptedValue: any = openSessionStoredContent({ ...params.crypto, content: content.data });
      if (!decryptedValue || typeof decryptedValue !== 'object') {
        unreadableRowCount += 1;
        continue;
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
      if (!decoded) {
        // The semantic projection omits empty text, but a schema-admitted text
        // record is readable. Keep that distinct from an undecodable body.
        const record = TranscriptRawRecordV1Schema.safeParse(decryptedValue);
        if (record.success && record.data.content.type === 'text') continue;
        // Declared a text conversation turn, yet its body did not decode: this
        // one IS a hole in the replayed conversation, not an ineligible row.
        unreadableRowCount += 1;
        continue;
      }
      // Media follows only a replayable dialog item. A readable event, synopsis,
      // thinking row, or a row later excluded by this decoder must not trigger
      // workspace replication merely because it named an attachment.
      const rowMediaPaths = collectReferencedSessionMediaWorkspacePaths([decryptedValue]);
      if (decoded.semanticRole === 'user') {
        if (!decoded.text) continue;
        out.push({
          dialog: {
            role: 'User',
            createdAt,
            seq,
            text: typeof maxTextChars === 'number' ? truncateText(decoded.text, maxTextChars) : decoded.text,
          },
          referencedSessionMediaWorkspacePaths: rowMediaPaths,
        });
        continue;
      }

      if (decryptedValue.role === 'agent' && (decoded.semanticRole === 'assistant' || decoded.semanticRole === 'tool')) {
        const text = decoded.text ?? decoded.summary;
        if (!text) continue;
        out.push({
          dialog: {
            role: 'Assistant',
            createdAt,
            seq,
            text: typeof maxTextChars === 'number' ? truncateText(text, maxTextChars) : text,
          },
          referencedSessionMediaWorkspacePaths: rowMediaPaths,
        });
      }
    } catch {
      // Tolerate corrupted transcript rows or unexpected shapes; skip the row and
      // record that the replay cannot claim to be complete.
      unreadableRowCount += 1;
      continue;
    }
  }

  out.sort((a, b) => {
    if (a.dialog.seq !== null && b.dialog.seq !== null) return a.dialog.seq - b.dialog.seq;
    return a.dialog.createdAt - b.dialog.createdAt;
  });
  // Safety bound: keep the most recent items (oldest dropped first).
  const bounded = out.length > maxDialogItems ? out.slice(out.length - maxDialogItems) : out;
  const referencedSessionMediaWorkspacePaths = new Set<string>();
  for (const entry of bounded) {
    for (const path of entry.referencedSessionMediaWorkspacePaths) {
      referencedSessionMediaWorkspacePaths.add(path);
    }
  }

  return {
    // The row seq is carried, not dropped: it is the anchor the replay seed
    // gives the target Agent to page BACKWARDS from, and it is already resolved
    // here for ordering. Discarding it forced every consumer above to guess
    // which slice of the transcript the seed was holding.
    dialog: bounded.map((entry) => entry.dialog),
    dialogReferencedSessionMediaWorkspacePaths: bounded.map(
      (entry) => entry.referencedSessionMediaWorkspacePaths,
    ),
    latestSynopsisText: bestSynopsis?.synopsis ?? null,
    unreadableRowCount,
    referencedSessionMediaWorkspacePaths: [...referencedSessionMediaWorkspacePaths].sort((left, right) => left.localeCompare(right)),
  };
}
