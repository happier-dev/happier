import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { encodeBase64 } from './messageCrypto';

export async function writeCliSessionAttachFile(opts: Readonly<{
  cliHome: string;
  sessionId: string;
  secret: Uint8Array;
  encryptionVariant?: 'legacy';
}>): Promise<string> {
  const attachDir = resolve(join(opts.cliHome, 'tmp', 'session-attach'));
  await mkdir(attachDir, { recursive: true });

  const attachFile = resolve(join(attachDir, `attach-${opts.sessionId}-${randomUUID()}.json`));
  await writeFile(
    attachFile,
    JSON.stringify({
      encryptionKeyBase64: encodeBase64(opts.secret),
      encryptionVariant: opts.encryptionVariant ?? 'legacy',
    }),
    { mode: 0o600 },
  );

  return attachFile;
}

