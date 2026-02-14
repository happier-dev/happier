import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { createSessionWithCiphertexts, fetchAllMessages } from '../../src/testkit/sessions';
import { encryptLegacyBase64, decryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { postEncryptedUiTextMessage } from '../../src/testkit/uiMessages';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: structured message meta (review_comments.v1) persists end-to-end', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('stores meta.happier.kind=review_comments.v1 on user messages', async () => {
    const testDir = run.testDir(`structured-meta-review-comments-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const secret = Uint8Array.from(randomBytes(32));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(workspaceDir, { recursive: true });

    const metadataCiphertextBase64 = encryptLegacyBase64(
      {
        path: workspaceDir,
        host: 'e2e',
        name: 'structured-meta-review-comments',
        createdAt: Date.now(),
      },
      secret,
    );

    const { sessionId } = await createSessionWithCiphertexts({
      baseUrl: server.baseUrl,
      token: auth.token,
      tag: `e2e-structured-review-comments-${randomUUID()}`,
      metadataCiphertextBase64,
      agentStateCiphertextBase64: null,
    });

    await postEncryptedUiTextMessage({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId,
      secret,
      text: 'Review comments (1)',
      metaExtras: {
        happier: {
          kind: 'review_comments.v1',
          payload: {
            sessionId,
            comments: [
              {
                id: 'c1',
                filePath: 'src/foo.ts',
                source: 'file',
                body: 'Please refactor',
                createdAt: 1,
                anchor: { kind: 'fileLine', startLine: 12 },
                snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
              },
            ],
          },
        },
      },
    });

    const rows = await fetchAllMessages(server.baseUrl, auth.token, sessionId);
    expect(rows.length).toBeGreaterThan(0);

    const decoded = rows
      .map((row) => decryptLegacyBase64(row.content.c, secret))
      .filter(Boolean) as any[];

    const withMeta = decoded.find((m) => m?.meta?.happier?.kind === 'review_comments.v1');
    expect(withMeta).toBeTruthy();
    expect(withMeta.meta.happier.payload?.comments?.[0]?.filePath).toBe('src/foo.ts');
  });
});

