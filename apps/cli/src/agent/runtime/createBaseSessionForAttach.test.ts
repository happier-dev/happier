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
        JSON.stringify({
          v: 2,
          encryptionMode: 'plain',
          lastObservedMessageSeq: 123,
          initialTranscriptAfterSeq: 0,
        }),
        { mode: 0o600 },
      );
      process.env.HAPPIER_SESSION_ATTACH_FILE = filePath;

      const session = await createBaseSessionForAttach({
        existingSessionId: 'session-attach',
        metadata: createTestMetadata(),
        state: { controlledByUser: false },
      });

      expect(session.seq).toBe(123);
      expect(session.initialTranscriptAfterSeq).toBe(0);
    } finally {
      envScope.restore();
      await removeTempDir(dir);
    }
  });

  it('uses legacy attach lastObservedMessageSeq as the startup cursor', async () => {
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
        JSON.stringify({
          v: 2,
          encryptionMode: 'plain',
          lastObservedMessageSeq: 8,
        }),
        { mode: 0o600 },
      );
      process.env.HAPPIER_SESSION_ATTACH_FILE = filePath;

      const session = await createBaseSessionForAttach({
        existingSessionId: 'session-attach',
        metadata: createTestMetadata(),
        state: { controlledByUser: false },
      });

      expect(session.seq).toBe(8);
      expect(session.initialTranscriptAfterSeq).toBe(8);
    } finally {
      envScope.restore();
      await removeTempDir(dir);
    }
  });

  it('prefers explicit initialTranscriptAfterSeq over legacy lastObservedMessageSeq', async () => {
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
        JSON.stringify({
          v: 2,
          encryptionMode: 'plain',
          lastObservedMessageSeq: 55,
          initialTranscriptAfterSeq: 12,
        }),
        { mode: 0o600 },
      );
      process.env.HAPPIER_SESSION_ATTACH_FILE = filePath;

      const session = await createBaseSessionForAttach({
        existingSessionId: 'session-attach',
        metadata: createTestMetadata(),
        state: { controlledByUser: false },
      });

      expect(session.seq).toBe(55);
      expect(session.initialTranscriptAfterSeq).toBe(12);
    } finally {
      envScope.restore();
      await removeTempDir(dir);
    }
  });

  it('seeds authoritative attach snapshot versions from the attach payload', async () => {
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
        JSON.stringify({
          v: 2,
          encryptionMode: 'plain',
          lastObservedMessageSeq: 55,
          snapshot: {
            metadata: { path: '/stored/project', flavor: 'codex' },
            metadataVersion: 7,
            agentState: { controlledByUser: true },
            agentStateVersion: 3,
          },
        }),
        { mode: 0o600 },
      );
      process.env.HAPPIER_SESSION_ATTACH_FILE = filePath;

      const session = await createBaseSessionForAttach({
        existingSessionId: 'session-attach',
        metadata: createTestMetadata({ path: '/runtime/project' }),
        state: { controlledByUser: false },
      });

      expect(session.metadata).toEqual({ path: '/stored/project', flavor: 'codex' });
      expect(session.metadataVersion).toBe(7);
      expect(session.agentState).toEqual({ controlledByUser: true });
      expect(session.agentStateVersion).toBe(3);
    } finally {
      envScope.restore();
      await removeTempDir(dir);
    }
  });
});
