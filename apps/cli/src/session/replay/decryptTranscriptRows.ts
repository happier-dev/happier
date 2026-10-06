import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';

import type { SessionStoredContentCryptoContext } from '../transport/encryption/sessionEncryptionContext';
import { openSessionStoredContent } from '../transport/encryption/sessionEncryptionContext';

export type DecryptedTranscriptRow = Readonly<{
  seq: number;
  createdAtMs: number;
  role: 'user' | 'agent';
  content: unknown;
  meta?: unknown;
  /** Canonical server-projected author identity; retained as opaque data for bounded consumers. */
  accountActor?: unknown;
}>;

type EncryptedRowLike = Readonly<{
  seq?: unknown;
  createdAt?: unknown;
  content?: unknown;
  accountActor?: unknown;
}>;

/**
 * Opens transcript rows under the Session's established content mode.
 *
 * The mode travels with the key on purpose. Admission is the canonical opener's
 * decision (`openSessionStoredContent`), so an E2EE Session never replays an
 * unauthenticated `{t:'plain'}` row the Home could have written, and a Plain
 * Session never silently accepts ciphertext. This reader adds no second cipher,
 * mode parser or fallback of its own.
 */
export function decryptTranscriptRows(params: Readonly<{
  crypto: SessionStoredContentCryptoContext;
  rows: ReadonlyArray<EncryptedRowLike>;
}>): DecryptedTranscriptRow[] {
  const out: DecryptedTranscriptRow[] = [];

  for (const row of params.rows) {
    const seq = typeof row?.seq === 'number' && Number.isFinite(row.seq) ? Math.trunc(row.seq) : null;
    const createdAtMs =
      typeof row?.createdAt === 'number' && Number.isFinite(row.createdAt) ? Math.trunc(row.createdAt) : null;
    const content = SessionStoredMessageContentSchema.safeParse(row?.content);
    if (seq === null || createdAtMs === null || !content.success) continue;

    try {
      const decrypted = openSessionStoredContent({ ...params.crypto, content: content.data }) as any;

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
        ...(row.accountActor !== undefined ? { accountActor: row.accountActor } : {}),
      });
    } catch {
      // Best-effort: a row the canonical opener refuses — wrong envelope kind for
      // this Session's mode, or ciphertext it cannot authenticate — is skipped.
      continue;
    }
  }

  return out;
}
