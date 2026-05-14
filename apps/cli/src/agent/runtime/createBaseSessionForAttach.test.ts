import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR',
  'HAPPIER_SESSION_ATTACH_FILE',
]);

describe('createBaseSessionForAttach', () => {
  it('seeds the attached ApiSession seq from the attach payload', async () => {
    const dir = await createTempDir('happy-base-attach-');
    try {
      envScope.patch({
        HAPPIER_HOME_DIR: dir,
        HAPPIER_SESSION_ATTACH_FILE: undefined,
      });
      vi.resetModules();

      const { createBaseSessionForAttach } = await import('./createBaseSessionForAttach');

      const attachDir = join(dir, 'tmp', 'session-attach');
      await mkdir(attachDir, { recursive: true });
      const filePath = join(attachDir, 'attach.json');
      await writeFile(
        filePath,
        JSON.stringify({ v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 123 }),
        { mode: 0o600 },
      );
      process.env.HAPPIER_SESSION_ATTACH_FILE = filePath;

      const session = await createBaseSessionForAttach({
        existingSessionId: 'session-attach',
        metadata: createTestMetadata(),
        state: { controlledByUser: false },
      });

      expect(session.seq).toBe(123);
    } finally {
      envScope.restore();
      await removeTempDir(dir);
    }
  });
});
