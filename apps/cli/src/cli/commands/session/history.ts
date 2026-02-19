import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { fetchEncryptedTranscriptMessages } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { decodeBase64, decrypt } from '@/api/encryption';
import { readIntFlagValue, readFlagValue, hasFlag } from '@/sessionControl/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { resolveSessionEncryptionContextFromCredentials } from '@/sessionControl/sessionEncryptionContext';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';

type CompactHistoryRow = Readonly<{
  id: string;
  createdAt: number;
  role: string;
  kind: string;
  text: string;
  structuredKind?: string;
}>;

type RawHistoryRow = Readonly<{
  id: string;
  createdAt: number;
  role: string;
  raw: Record<string, unknown>;
}>;

function extractCompactRow(params: Readonly<{
  decrypted: unknown;
  createdAt: number;
  fallbackId: string;
}>): CompactHistoryRow | null {
  const obj = params.decrypted && typeof params.decrypted === 'object' && !Array.isArray(params.decrypted) ? (params.decrypted as any) : null;
  const role = typeof obj?.role === 'string' ? String(obj.role) : 'unknown';
  const happierKind = typeof obj?.meta?.happier?.kind === 'string' ? String(obj.meta.happier.kind) : undefined;

  const body = obj?.content;
  const kind = typeof body?.type === 'string' ? String(body.type) : 'unknown';
  const text = kind === 'text' && typeof body?.text === 'string' ? String(body.text) : '';

  return {
    id: params.fallbackId,
    createdAt: params.createdAt,
    role,
    kind,
    text,
    ...(happierKind ? { structuredKind: happierKind } : {}),
  };
}

function extractRawRow(params: Readonly<{
  decrypted: unknown;
  createdAt: number;
  fallbackId: string;
  includeMeta: boolean;
  includeStructuredPayload: boolean;
}>): RawHistoryRow | null {
  const obj = params.decrypted && typeof params.decrypted === 'object' && !Array.isArray(params.decrypted) ? (params.decrypted as any) : null;
  if (!obj) return null;
  const role = typeof obj.role === 'string' ? String(obj.role) : 'unknown';

  const raw: Record<string, unknown> = {};
  if (typeof obj.role === 'string') raw.role = obj.role;
  if (obj.content !== undefined) raw.content = obj.content;

  if (params.includeMeta) {
    const meta = obj.meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const metaOut: any = { ...(meta as any) };
      if (!params.includeStructuredPayload) {
        if (metaOut?.happier && typeof metaOut.happier === 'object' && !Array.isArray(metaOut.happier)) {
          if ('payload' in metaOut.happier) {
            delete metaOut.happier.payload;
          }
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

export async function cmdSessionHistory(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);

  const idOrPrefix = String(argv[1] ?? '').trim();
  if (!idOrPrefix) {
    throw new Error('Usage: happier session history <session-id-or-prefix> [--limit <n>] [--format <compact|raw>] [--json]');
  }

  const limitRaw = readIntFlagValue(argv, '--limit');
  const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 250) : 50;
  const format = (readFlagValue(argv, '--format') ?? 'compact').trim();
  const includeMeta = hasFlag(argv, '--include-meta');
  const includeStructuredPayload = hasFlag(argv, '--include-structured-payload');

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_history', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const resolved = await resolveSessionIdOrPrefix({ credentials, idOrPrefix });
  if (!resolved.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_history',
        error: { code: resolved.code, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
      });
      return;
    }
    throw new Error(resolved.code);
  }
  const sessionId = resolved.sessionId;

  const rawSession = await fetchSessionById({ token: credentials.token, sessionId });
  if (!rawSession) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_history', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);

  const rows = await fetchEncryptedTranscriptMessages({
    token: credentials.token,
    sessionId,
    limit,
  });

  if (format === 'raw') {
    const messages: RawHistoryRow[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const content = (row as any)?.content;
      if (!content || typeof content !== 'object') continue;
      if ((content as any).t !== 'encrypted' || typeof (content as any).c !== 'string') continue;

      const decrypted = decrypt(ctx.encryptionKey, ctx.encryptionVariant, decodeBase64(String((content as any).c), 'base64'));
      const createdAt = typeof (row as any)?.createdAt === 'number' ? (row as any).createdAt : 0;
      const seq = (row as any)?.seq;
      const id = typeof seq === 'number' || typeof seq === 'string' ? String(seq) : String(i);

      const extracted = extractRawRow({
        decrypted,
        createdAt,
        fallbackId: id,
        includeMeta,
        includeStructuredPayload,
      });
      if (extracted) messages.push(extracted);
    }

    if (json) {
      printJsonEnvelope({
        ok: true,
        kind: 'session_history',
        data: { sessionId, format: 'raw', messages },
      });
      return;
    }

    console.log(chalk.green('✓'), `history fetched (${messages.length} messages)`);
    console.log(JSON.stringify({ sessionId, messages }, null, 2));
    return;
  }

  // compact (default)
  const messages: CompactHistoryRow[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const content = (row as any)?.content;
    if (!content || typeof content !== 'object') continue;
    if ((content as any).t !== 'encrypted' || typeof (content as any).c !== 'string') continue;

    const decrypted = decrypt(ctx.encryptionKey, ctx.encryptionVariant, decodeBase64(String((content as any).c), 'base64'));
    const createdAt = typeof (row as any)?.createdAt === 'number' ? (row as any).createdAt : 0;
    const seq = (row as any)?.seq;
    const id = typeof seq === 'number' || typeof seq === 'string' ? String(seq) : String(i);

    const extracted = extractCompactRow({ decrypted, createdAt, fallbackId: id });
    if (extracted) messages.push(extracted);
  }

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_history',
      data: { sessionId, format: 'compact', messages },
    });
    return;
  }

  console.log(chalk.green('✓'), `history fetched (${messages.length} messages)`);
  console.log(JSON.stringify({ sessionId, messages }, null, 2));
}
