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
  it('preserves explicit initialTranscriptAfterSeq=0 from the attach payload', async () => {
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

  it('seeds only a valid retained session role from the attach handoff into the base metadata', async () => {
    const dir = await createTempDir('happy-base-attach-role-');
    try {
      envScope.patch({ HAPPIER_HOME_DIR: dir, HAPPIER_SESSION_ATTACH_FILE: undefined });
      vi.resetModules();
      const { createBaseSessionForAttach } = await import('./createBaseSessionForAttach');
      const attachDir = join(dir, 'tmp', 'session-attach');
      await mkdir(attachDir, { recursive: true });
      const role = { v: 1, role: 'reviewer', instructions: 'REVIEW SNAPSHOT', assignmentId: 'a-1', assignedAt: 1 };
      const attachWith = async (name: string, sessionRoleV1: unknown) => {
        const filePath = join(attachDir, name);
        await writeFile(filePath, JSON.stringify({ v: 2, encryptionMode: 'plain', sessionRoleV1 }), { mode: 0o600 });
        process.env.HAPPIER_SESSION_ATTACH_FILE = filePath;
        return await createBaseSessionForAttach({ existingSessionId: 'session-attach', metadata: createTestMetadata(), state: { controlledByUser: false } });
      };

      expect((await attachWith('role.json', role)).metadata).toMatchObject({ sessionRoleV1: role });
      // A malformed role is ignored rather than failing the resume.
      expect((await attachWith('bad-role.json', { v: 1, role: 'architect' })).metadata).not.toHaveProperty('sessionRoleV1');
    } finally {
      envScope.restore();
      await removeTempDir(dir);
    }
  });

  it('uses legacy lastObservedMessageSeq as the explicit startup cursor when initialTranscriptAfterSeq is absent', async () => {
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

  it('carries the server-provided catch-up authorization from the attach payload', async () => {
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
          lastObservedMessageSeq: 9,
          initialTranscriptAfterSeq: 4,
        }),
        { mode: 0o600 },
      );
      process.env.HAPPIER_SESSION_ATTACH_FILE = filePath;

      const session = await createBaseSessionForAttach({
        existingSessionId: 'session-attach',
        metadata: createTestMetadata(),
        state: { controlledByUser: false },
      });

      expect(session.seq).toBe(9);
      expect(session.initialTranscriptAfterSeq).toBe(4);
    } finally {
      envScope.restore();
      await removeTempDir(dir);
    }
  });
});
