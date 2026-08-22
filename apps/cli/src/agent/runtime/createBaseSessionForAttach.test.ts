import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  type SessionOwnerMetadataV1,
} from '@happier-dev/protocol';

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR',
  'HAPPIER_SESSION_ATTACH_FILE',
]);

describe('createBaseSessionForAttach', () => {
  it('prefers the typed attach path without reading or mutating ambient process state', async () => {
    const dir = await createTempDir('happy-base-attach-');
    try {
      envScope.patch({
        HAPPIER_HOME_DIR: dir,
        HAPPIER_SESSION_ATTACH_FILE: '/ambient/must-not-be-read.json',
      });
      vi.resetModules();
      const { createBaseSessionForAttach } = await import('./createBaseSessionForAttach');
      const attachDir = join(dir, 'tmp', 'session-attach');
      await mkdir(attachDir, { recursive: true });
      const filePath = join(attachDir, 'typed-attach.json');
      await writeFile(filePath, JSON.stringify({
        v: 2,
        encryptionMode: 'plain',
        lastObservedMessageSeq: 9,
      }), { mode: 0o600 });

      const session = await createBaseSessionForAttach({
        existingSessionId: 'session-typed-attach',
        metadata: createTestMetadata(),
        state: { controlledByUser: false },
        sessionAttachFilePath: filePath,
      });

      expect(session.seq).toBe(9);
      expect(process.env.HAPPIER_SESSION_ATTACH_FILE).toBe('/ambient/must-not-be-read.json');
    } finally {
      envScope.restore();
      await removeTempDir(dir);
    }
  });

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

  it('materializes strict owner categories for the resumed local runtime without treating shared metadata as authority', async () => {
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
      const filePath = join(attachDir, 'attach-layout-v1.json');
      const ownerMetadata: SessionOwnerMetadataV1 = {
        v: 1,
        workspace: {
          path: '/private/worktree',
          host: 'private-host',
          homeDir: '/private/home',
        },
        nativeSession: {
          codexSessionId: 'private-vendor-id',
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            backendMode: 'appServer',
            providerSessionId: 'private-vendor-id',
          },
        },
        runtime: {
          tools: ['Read', 'Bash'],
        },
      };
      const ownerMetadataEnvelope =
        createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata);
      await writeFile(filePath, JSON.stringify({
        v: 2,
        encryptionMode: 'plain',
        snapshot: {
          metadataLayoutVersion: 1,
          metadata: {
            v: 1,
            summary: { text: 'Safe summary', updatedAt: 1 },
            agentPresentation: { agentId: 'codex' },
          },
          ownerMetadata,
          ownerMetadataEnvelope,
          metadataVersion: 3,
          agentState: { controlledByUser: false },
          agentStateVersion: 2,
        },
      }), { mode: 0o600 });

      const session = await createBaseSessionForAttach({
        existingSessionId: 'session-layout-v1',
        metadata: createTestMetadata({ path: '/unsafe-fallback' }),
        state: { controlledByUser: true },
        sessionAttachFilePath: filePath,
      });

      expect(session).toMatchObject({
        metadataLayoutVersion: 1,
        ownerMetadata,
        ownerMetadataEnvelope,
        metadataVersion: 3,
        metadata: {
          path: '/private/worktree',
          host: 'private-host',
          homeDir: '/private/home',
          codexSessionId: 'private-vendor-id',
          tools: ['Read', 'Bash'],
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            agent: {
              backendMode: 'appServer',
              providerSessionId: 'private-vendor-id',
            },
          },
          summary: { text: 'Safe summary', updatedAt: 1 },
        },
      });
      expect(JSON.stringify(session.metadata)).not.toContain('/unsafe-fallback');
      expect(session.metadata).not.toHaveProperty('ownerMetadata');
    } finally {
      envScope.restore();
      await removeTempDir(dir);
    }
  });

  it('rejects a layout-v1 attach snapshot without owner authority', async () => {
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
      const filePath = join(attachDir, 'attach-layout-v1-no-owner.json');
      await writeFile(filePath, JSON.stringify({
        v: 2,
        encryptionMode: 'plain',
        snapshot: {
          metadataLayoutVersion: 1,
          metadata: { v: 1 },
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
        },
      }), { mode: 0o600 });

      await expect(createBaseSessionForAttach({
        existingSessionId: 'session-layout-v1',
        metadata: createTestMetadata(),
        state: { controlledByUser: false },
        sessionAttachFilePath: filePath,
      })).rejects.toThrow('missing owner metadata envelope');
    } finally {
      envScope.restore();
      await removeTempDir(dir);
    }
  });
});
