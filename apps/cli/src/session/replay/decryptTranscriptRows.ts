import type { SessionEncryptionContext } from '@/sessionControl/sessionEncryptionContext';
import { decryptSessionPayload } from '@/sessionControl/sessionEncryptionContext';

export type DecryptedTranscriptRow = Readonly<{
  seq: number;
  createdAtMs: number;
  role: 'user' | 'agent';
  content: unknown;
  meta?: unknown;
}>;

type EncryptedRowLike = Readonly<{
  seq?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

export function decryptTranscriptRows(params: Readonly<{
  ctx: SessionEncryptionContext;
  rows: ReadonlyArray<EncryptedRowLike>;
}>): DecryptedTranscriptRow[] {
  const out: DecryptedTranscriptRow[] = [];

  for (const row of params.rows) {
    const seq = typeof row?.seq === 'number' && Number.isFinite(row.seq) ? Math.trunc(row.seq) : null;
    const createdAtMs =
      typeof row?.createdAt === 'number' && Number.isFinite(row.createdAt) ? Math.trunc(row.createdAt) : null;
    const content = row?.content as any;
    if (seq === null || createdAtMs === null) continue;

    try {
      let decrypted: any = null;
      if (content && typeof content === 'object' && content.t === 'plain') {
        decrypted = content.v;
      } else {
        const ciphertextBase64 =
          content && typeof content === 'object' && content.t === 'encrypted' ? content.c : null;
        if (typeof ciphertextBase64 !== 'string' || ciphertextBase64.trim().length === 0) continue;
        decrypted = decryptSessionPayload({ ctx: params.ctx, ciphertextBase64 }) as any;
      }

      const role = decrypted?.role;
      if (role !== 'user' && role !== 'agent') continue;
      const body = decrypted?.content;
      const meta = decrypted?.meta;
      out.push({
        seq,
        createdAtMs,
        role,
        content: body,
        ...(meta !== undefined ? { meta } : {}),
      });
    } catch {
      // Best-effort: ignore undecipherable rows.
      continue;
    }
  }

  return out;
}
