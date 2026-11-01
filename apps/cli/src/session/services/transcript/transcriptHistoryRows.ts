import { decryptSessionPayload, type SessionEncryptionContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { SessionMessageContentSchema } from '@/api/types';

export type CompactHistoryRow = Readonly<{
  id: string;
  createdAt: number;
  role: string;
  kind: string;
  text: string;
  structuredKind?: string;
}>;

export type RawHistoryRow = Readonly<{
  id: string;
  createdAt: number;
  role: string;
  raw: Record<string, unknown>;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function isMemoryArtifactDecryptedRow(value: unknown): boolean {
  const obj = asRecord(value);
  if (!obj) return false;
  const meta = asRecord(obj.meta);
  if (!meta) return false;
  const happier = asRecord(meta.happier);
  if (!happier) return false;
  const kind = happier.kind;
  return kind === 'session_summary_shard.v1' || kind === 'session_synopsis.v1';
}

function isClaudeJsonlConsumedMarkerArtifact(value: unknown): boolean {
  const obj = asRecord(value);
  if (!obj) return false;
  const content = asRecord(obj.content);
  if (!content) return false;
  if (content.type === 'claude_jsonl_consumed_marker') return true;
  const data = asRecord(content.data);
  return content.type === 'output' && data?.type === 'progress' && data.marker === 'claude_jsonl_consumed_marker';
}

function readFirstText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const record = asRecord(item);
    const text = record?.text ?? record?.content;
    if (typeof text === 'string') return text;
  }
  return null;
}

function readTranscriptArtifactText(value: unknown): string | null {
  const obj = asRecord(value);
  const content = asRecord(obj?.content);
  if (!content) return null;

  if (content.type === 'text') {
    return readFirstText(content.text);
  }

  const data = asRecord(content.data);
  const message = asRecord(data?.message);
  return readFirstText(message?.content);
}

function isClaudeLocalCommandArtifactText(value: string): boolean {
  const trimmed = value.trim();
  // Boundary compatibility only: raw Claude JSONL classification is owned by
  // `apps/cli/src/backends/claude/utils/{controlCommandRows,isClaudeInternalTranscriptMessage}`.
  const prefixes = ['<local-command-caveat>', '<command-name>', '<local-command-stdout>'] as const;
  return prefixes.some((prefix) => trimmed.startsWith(prefix));
}

export function isHistoryArtifactDecryptedRow(value: unknown): boolean {
  if (isMemoryArtifactDecryptedRow(value)) return true;
  if (isClaudeJsonlConsumedMarkerArtifact(value)) return true;

  const text = readTranscriptArtifactText(value);
  if (!text) return false;
  return isClaudeLocalCommandArtifactText(text);
}

export function tryResolveDecryptedTranscriptPayload(params: Readonly<{
  content: unknown;
  ctx: SessionEncryptionContext;
}>): unknown | null {
  const parsed = SessionMessageContentSchema.safeParse(params.content);
  if (!parsed.success) return null;
  if (parsed.data.t === 'plain') return parsed.data.v;
  try {
    return decryptSessionPayload({ ctx: params.ctx, ciphertextBase64: parsed.data.c });
  } catch {
    return null;
  }
}

function extractOutputText(body: unknown): string {
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? (body as any) : null;
  const data = obj?.data && typeof obj.data === 'object' && !Array.isArray(obj.data) ? obj.data : null;

  const message = data?.message && typeof data.message === 'object' && !Array.isArray(data.message) ? data.message : null;
  const content = message?.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const piece = item && typeof item === 'object' && !Array.isArray(item) ? (item as any) : null;
      if (piece?.type === 'text' && typeof piece?.text === 'string') {
        parts.push(piece.text);
      }
    }
    if (parts.length > 0) return parts.join('');
  }

  if (typeof data?.text === 'string') return data.text;
  return '';
}

function extractAcpText(body: unknown): string {
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const rawData = obj?.data;
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? (rawData as Record<string, unknown>) : null;
  if (data?.type === 'message' && typeof data.message === 'string') {
    return data.message;
  }
  return '';
}

function extractCodexText(body: unknown): string {
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const rawData = obj?.data;
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? (rawData as Record<string, unknown>) : null;
  if (data?.type === 'message' && typeof data.message === 'string') {
    return data.message;
  }
  return '';
}

function extractSessionEventText(body: unknown): string {
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const rawData = obj?.data;
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData) ? (rawData as Record<string, unknown>) : null;
  if (data?.type === 'message' && typeof data.message === 'string') {
    return data.message;
  }
  return '';
}

export function extractCompactRow(params: Readonly<{
  decrypted: unknown;
  createdAt: number;
  fallbackId: string;
}>): CompactHistoryRow | null {
  if (isHistoryArtifactDecryptedRow(params.decrypted)) return null;

  const obj = params.decrypted && typeof params.decrypted === 'object' && !Array.isArray(params.decrypted) ? (params.decrypted as any) : null;
  const role = typeof obj?.role === 'string' ? String(obj.role) : 'unknown';
  const happierKind = typeof obj?.meta?.happier?.kind === 'string' ? String(obj.meta.happier.kind) : undefined;

  const body = obj?.content;
  const kind = typeof body?.type === 'string' ? String(body.type) : 'unknown';
  const text =
    kind === 'text' && typeof body?.text === 'string'
      ? String(body.text)
      : kind === 'output'
        ? extractOutputText(body)
        : kind === 'acp'
        ? extractAcpText(body)
        : kind === 'codex'
          ? extractCodexText(body)
          : kind === 'event'
            ? extractSessionEventText(body)
          : '';

  if (!text) return null;

  return {
    id: params.fallbackId,
    createdAt: params.createdAt,
    role,
    kind,
    text,
    ...(happierKind ? { structuredKind: happierKind } : {}),
  };
}

export function extractRawRow(params: Readonly<{
  decrypted: unknown;
  createdAt: number;
  fallbackId: string;
  includeMeta: boolean;
  includeStructuredPayload: boolean;
}>): RawHistoryRow | null {
  if (isHistoryArtifactDecryptedRow(params.decrypted)) return null;

  const obj = params.decrypted && typeof params.decrypted === 'object' && !Array.isArray(params.decrypted) ? (params.decrypted as any) : null;
  if (!obj) return null;
  const role = typeof obj.role === 'string' ? String(obj.role) : 'unknown';

  const raw: Record<string, unknown> = {};
  if (typeof obj.role === 'string') raw.role = obj.role;
  if (obj.content !== undefined) raw.content = obj.content;

  if (params.includeMeta) {
    const meta = obj.meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const metaOut: Record<string, unknown> = { ...(meta as Record<string, unknown>) };
      if (!params.includeStructuredPayload) {
        const happier = metaOut.happier;
        if (happier && typeof happier === 'object' && !Array.isArray(happier) && 'payload' in happier) {
          delete (happier as Record<string, unknown>).payload;
        }
      }
      raw.meta = metaOut;
    }
  }

  return {
    id: params.fallbackId,
    createdAt: params.createdAt,
    role,
    raw,
  };
}
