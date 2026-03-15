import { SessionSynopsisV1Schema } from '@happier-dev/protocol';

import { decodeBase64, decrypt } from '@/api/encryption';

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

function normalizeInlineText(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  // Keep replay lines compact and stable across renderers.
  return text.replace(/\s+/g, ' ').trim();
}

function safeInlineJson(value: unknown, maxChars: number): string | null {
  try {
    const raw = JSON.stringify(value);
    const normalized = normalizeInlineText(raw);
    if (!normalized) return null;
    return normalized.length > maxChars ? normalized.slice(0, maxChars) + '…' : normalized;
  } catch {
    return null;
  }
}

function extractToolResultText(value: unknown): string | null {
  if (typeof value === 'string') {
    return normalizeText(value);
  }
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === 'string') {
      const text = normalizeText(part);
      if (text) parts.push(text);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if ((part as any).type === 'text') {
      const text = normalizeText((part as any).text);
      if (text) parts.push(text);
    }
  }
  const joined = parts.join('\n').trim();
  return joined.length > 0 ? joined : null;
}

function extractAcpLikeToolCallDetail(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return safeInlineJson(rawInput, 200);
  }

  const rec = rawInput as Record<string, unknown>;
  const command = typeof rec.command === 'string' ? normalizeInlineText(rec.command) : null;
  const cmd = typeof rec.cmd === 'string' ? normalizeInlineText(rec.cmd) : null;
  const description = typeof rec.description === 'string' ? normalizeInlineText(rec.description) : null;
  const resolvedCommand = command ?? cmd;

  if (description && resolvedCommand) return `${description} — ${resolvedCommand}`;
  return description ?? resolvedCommand ?? safeInlineJson(rawInput, 200);
}

function extractAssistantTextFromAcpData(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = (value as any).type;

  if (type === 'message') {
    return normalizeText((value as any).message);
  }
  if (type === 'reasoning') {
    return null;
  }
  if (type === 'thinking') {
    return null;
  }
  if (type === 'tool-call') {
    const name = normalizeText((value as any).name) ?? '';
    const detail = extractAcpLikeToolCallDetail((value as any).input);
    if (!name && !detail) return null;
    return detail ? `Tool use (${name || 'Unknown'}): ${detail}` : `Tool use (${name || 'Unknown'})`;
  }
  if (type === 'tool-result') {
    const out = (value as any).output;
    const isError = (value as any).isError === true;
    const outText =
      typeof out === 'string'
        ? normalizeInlineText(out)
        : safeInlineJson(out, 400) ?? (out == null ? null : normalizeInlineText(String(out)));
    if (!outText) return null;
    return isError ? `Tool result (error): ${outText}` : `Tool result: ${outText}`;
  }
  if (type === 'file-edit') {
    const description = normalizeText((value as any).description);
    const filePath = normalizeText((value as any).filePath);
    if (!description && !filePath) return null;
    if (description && filePath) return `File edit: ${description} — ${filePath}`;
    return `File edit: ${description ?? filePath}`;
  }
  if (type === 'terminal-output') {
    const data = normalizeText((value as any).data);
    if (!data) return null;
    const normalized = normalizeInlineText(data) ?? data;
    return `Terminal output: ${normalized}`;
  }

  return null;
}

function extractAssistantTextFromCodexData(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = (value as any).type;

  if (type === 'message') {
    return normalizeText((value as any).message);
  }
  if (type === 'reasoning') {
    return null;
  }
  if (type === 'thinking') {
    return null;
  }
  if (type === 'tool-call') {
    const name = normalizeText((value as any).name) ?? '';
    const detail = extractAcpLikeToolCallDetail((value as any).input);
    if (!name && !detail) return null;
    return detail ? `Tool use (${name || 'Unknown'}): ${detail}` : `Tool use (${name || 'Unknown'})`;
  }
  if (type === 'tool-call-result') {
    const out = (value as any).output;
    const outText =
      typeof out === 'string'
        ? normalizeInlineText(out)
        : safeInlineJson(out, 400) ?? (out == null ? null : normalizeInlineText(String(out)));
    if (!outText) return null;
    return `Tool result: ${outText}`;
  }

  return null;
}

function extractAssistantTextFromClaudeOutputEnvelope(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const type = (value as any).type;
  if (type !== 'assistant') return null;
  const message = (value as any).message;
  if (!message || typeof message !== 'object') return null;
  const role = (message as any).role;

  const content = (message as any).content;
  if (typeof content === 'string') {
    return normalizeText(content);
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      const text = normalizeText(part);
      if (text) parts.push(text);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if ((part as any).type === 'text') {
      const text = normalizeText((part as any).text);
      if (text) parts.push(text);
    }
  }
  const joined = parts.join('\n').trim();
  if (joined.length > 0) return joined;

  // Claude (and Claude Code) frequently emits tool_use / tool_result turns without any
  // adjacent natural language. For replay forks, those tool interactions carry critical
  // context, so include a compact text summary.
  if (role === 'assistant') {
    const toolLines: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if ((part as any).type !== 'tool_use') continue;
      const name = typeof (part as any).name === 'string' ? String((part as any).name).trim() : '';
      if (!name) continue;
      const input = (part as any).input;
      const command = typeof input?.command === 'string' ? normalizeInlineText(input.command) : null;
      const description = typeof input?.description === 'string' ? normalizeInlineText(input.description) : null;
      const detail =
        description && command
          ? `${description} — ${command}`
          : description ?? command ?? safeInlineJson(input, 200) ?? '';
      toolLines.push(detail ? `Tool use (${name}): ${detail}` : `Tool use (${name})`);
    }
    const toolsJoined = toolLines.join('\n').trim();
    return toolsJoined.length > 0 ? toolsJoined : null;
  }

  if (role === 'user') {
    const resultLines: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if ((part as any).type !== 'tool_result') continue;
      const resultText = extractToolResultText((part as any).content);
      if (!resultText) continue;
      const normalized = normalizeInlineText(resultText) ?? resultText.trim();
      resultLines.push(`Tool result: ${normalized}`);
    }
    const resultsJoined = resultLines.join('\n').trim();
    return resultsJoined.length > 0 ? resultsJoined : null;
  }

  return null;
}

export function decryptTranscriptReplayCore(params: Readonly<{
  rows: readonly RawTranscriptRow[];
  encryptionKey?: Uint8Array;
  encryptionVariant?: 'dataKey';
  maxTextChars?: number;
  maxDialogItems?: number;
}>): Readonly<{ dialog: HappierReplayDialogItem[]; latestSynopsisText: string | null }> {
  const maxTextChars = params.maxTextChars;
  const maxDialogItems = normalizePositiveInt(params.maxDialogItems, 200, { min: 1, max: 10_000 });
  const out: Array<{ role: 'User' | 'Assistant'; createdAt: number; seq: number | null; text: string }> = [];
  let bestSynopsis: { synopsis: string; updatedAtMs: number; seqTo: number } | null = null;

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

      const role = decryptedValue.role;
      const body = decryptedValue.content;

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
        if (decryptedValue?.meta?.isThinking === true) continue;
        // Skip daemon-generated memory artifacts (summary shards / synopsis).
        if (isMemoryArtifactMeta(decryptedValue?.meta)) continue;

        if (body?.type === 'output') {
          const text = extractAssistantTextFromClaudeOutputEnvelope(body?.data);
          if (!text) continue;
          out.push({
            role: 'Assistant',
            createdAt,
            seq,
            text: typeof maxTextChars === 'number' ? truncateText(text, maxTextChars) : text,
          });
          continue;
        }

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
          const text = extractAssistantTextFromAcpData(data);
          if (!text) continue;
          out.push({
            role: 'Assistant',
            createdAt,
            seq,
            text: typeof maxTextChars === 'number' ? truncateText(text, maxTextChars) : text,
          });
          continue;
        }

        if (body?.type === 'codex') {
          const data = body?.data;
          const text = extractAssistantTextFromCodexData(data);
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
  // Safety bound: keep the most recent items (oldest dropped first).
  const bounded = out.length > maxDialogItems ? out.slice(out.length - maxDialogItems) : out;

  return {
    dialog: bounded.map(({ seq: _seq, ...rest }) => rest),
    latestSynopsisText: bestSynopsis?.synopsis ?? null,
  };
}
