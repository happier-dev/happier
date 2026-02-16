import { redactBugReportSensitiveText, type MemoryWindowV1 } from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resolveSessionEncryptionContextFromCredentials } from '@/sessionControl/sessionEncryptionContext';
import { decryptTranscriptRows } from '@/session/replay/decryptTranscriptRows';

import type { RawSessionRecord } from '@/sessionControl/sessionsHttp';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import type { FetchEncryptedTranscriptRangeResult } from '@/api/session/fetchEncryptedTranscriptWindow';
import { fetchEncryptedTranscriptRange } from '@/api/session/fetchEncryptedTranscriptWindow';
import { configuration } from '@/configuration';

function isMemoryArtifactMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const happier = (meta as Record<string, unknown>).happier;
  if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return false;
  const kind = (happier as Record<string, unknown>).kind;
  return kind === 'session_summary_shard.v1' || kind === 'session_synopsis.v1';
}

function extractTextFromContent(role: 'user' | 'agent', content: unknown): string | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  const type = (content as Record<string, unknown>).type;
  if (type === 'text') {
    const text = (content as Record<string, unknown>).text;
    return typeof text === 'string' ? text : null;
  }
  if (role === 'agent' && type === 'acp') {
    const data = (content as Record<string, unknown>).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const t = (data as Record<string, unknown>).type;
    if (t === 'message' || t === 'reasoning') {
      const message = (data as Record<string, unknown>).message;
      return typeof message === 'string' ? message : null;
    }
  }
  return null;
}

export async function getMemoryWindow(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  seqFrom: number;
  seqTo: number;
  paddingMessages: number;
  deps?: Readonly<{
    fetchSessionById: (args: Readonly<{ token: string; sessionId: string }>) => Promise<RawSessionRecord | null>;
    fetchEncryptedTranscriptRange: (args: Readonly<{
      token: string;
      sessionId: string;
      seqFrom: number;
      seqTo: number;
    }>) => Promise<FetchEncryptedTranscriptRangeResult>;
  }>;
}>): Promise<MemoryWindowV1> {
  const fetchSession = params.deps?.fetchSessionById ?? fetchSessionById;
  const fetchRange = params.deps?.fetchEncryptedTranscriptRange ?? fetchEncryptedTranscriptRange;

  const sessionId = String(params.sessionId ?? '').trim();
  const seqFrom = Math.max(0, Math.trunc(params.seqFrom));
  const seqTo = Math.max(0, Math.trunc(params.seqTo));
  const padding = Math.max(0, Math.trunc(params.paddingMessages));

  const paddedFrom = Math.max(0, seqFrom - padding);
  const paddedTo = seqTo + padding;
  const maxMessages = configuration.memoryMaxTranscriptWindowMessages;
  const requestedMessages = paddedTo >= paddedFrom ? paddedTo - paddedFrom + 1 : 0;

  const effectiveFrom = paddedFrom;
  const effectiveTo = requestedMessages > maxMessages ? Math.max(effectiveFrom, effectiveFrom + maxMessages - 1) : paddedTo;

  const rawSession = await fetchSession({ token: params.credentials.token, sessionId });
  if (!rawSession) {
    return {
      v: 1,
      snippets: [],
      citations: [{ sessionId, seqFrom, seqTo }],
    };
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, rawSession);
  const range = await fetchRange({ token: params.credentials.token, sessionId, seqFrom: effectiveFrom, seqTo: effectiveTo });
  if (!range.ok) {
    return {
      v: 1,
      snippets: [],
      citations: [{ sessionId, seqFrom, seqTo }],
    };
  }

  const decrypted = decryptTranscriptRows({ ctx, rows: range.rows });
  const lines: string[] = [];
  for (const row of decrypted) {
    if (isMemoryArtifactMeta(row.meta)) continue;
    const text = extractTextFromContent(row.role, row.content);
    if (!text || text.trim().length === 0) continue;
    const prefix = row.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${prefix}: ${redactBugReportSensitiveText(text).trim()}`);
  }

  const createdAtFromMs = decrypted.length > 0 ? decrypted[0]!.createdAtMs : 0;
  const createdAtToMs = decrypted.length > 0 ? decrypted[decrypted.length - 1]!.createdAtMs : 0;
  const text = lines.join('\n');

  return {
    v: 1,
    snippets: text
      ? [
          {
            sessionId,
            seqFrom: effectiveFrom,
            seqTo: effectiveTo,
            createdAtFromMs,
            createdAtToMs,
            text,
          },
        ]
      : [],
    citations: [{ sessionId, seqFrom, seqTo }],
  };
}

