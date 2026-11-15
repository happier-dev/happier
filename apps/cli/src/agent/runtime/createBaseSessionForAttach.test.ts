import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { Metadata } from '@/api/types';
import { buildSessionCreationCorrespondence } from '@/session/shared/sessionCreationCorrespondence';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  type SessionOwnerMetadataV1,
} from '@happier-dev/protocol';

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR',
  'HAPPIER_SESSION_ATTACH_FILE',
]);

describe('createBaseSessionForAttach', () => {
  it('attaches concurrent hosted Sessions from their own launch handoffs', async () => {
    const dir = await createTempDir('happy-hosted-attach-');
    envScope.patch({ HAPPIER_HOME_DIR: dir, HAPPIER_SESSION_ATTACH_FILE: undefined });
    try {
      vi.resetModules();
      const { createBaseSessionForAttach } = await import('./createBaseSessionForAttach');
      const { runAddedHostedSession } = await import('./lifecycle/hostedSessionScope');
      const attachDir = join(dir, 'tmp', 'session-attach');
      await mkdir(attachDir, { recursive: true });
      const environments = await Promise.all(['plain', 'e2ee'].map(async (encryptionMode, index) => {
        const filePath = join(attachDir, `attach-${index}.json`);
        await writeFile(filePath, JSON.stringify({
          v: 2, encryptionMode, lastObservedMessageSeq: index + 11,
          ...(encryptionMode === 'e2ee' ? {
            encryptionKeyBase64: Buffer.alloc(32, 7).toString('base64'), encryptionVariant: 'dataKey',
          } : {}),
        }), { mode: 0o600 });
        return { HAPPIER_SESSION_ATTACH_FILE: filePath };
      }));
      const sessions = await Promise.all(environments.map((environment, index) =>
        runAddedHostedSession({ environment, workingDirectory: dir,
          end: () => { throw new Error('Attach must not terminate its host'); } },
        () => createBaseSessionForAttach({ existingSessionId: `hosted-${index}`,
          metadata: createTestMetadata(), state: { controlledByUser: false } })),
      ));
      expect(sessions).toMatchObject([
        { id: 'hosted-0', encryptionMode: 'plain', seq: 11 },
        { id: 'hosted-1', encryptionMode: 'e2ee', seq: 12, encryptionKey: new Uint8Array(32).fill(7) },
      ]);
      for (const [index, environment] of environments.entries()) {
        expect(environment.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();
        await expect(stat(join(attachDir, `attach-${index}.json`)))
          .rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(process.env.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();
    } finally {
      envScope.restore();
      await removeTempDir(dir);
    }
  });
  it.each(['plain', 'e2ee'] as const)('bootstraps the admitted birth Agent before constructing its %s Session client', async (encryptionMode) => {
    const { createBaseSessionForAttach } = await import('./createBaseSessionForAttach');
    const correspondence = buildSessionCreationCorrespondence({
      identity: { callerCreationNamespace: 'test', creationKey: 'failed-birth' },
      recipe: { execution: { machineId: 'machine', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
    });
    const runtimeMetadata = createTestMetadata({ flavor: 'codex' });
    const birthMetadata = { ...runtimeMetadata, flavor: undefined, sessionCreationCorrespondenceV1: correspondence };
    const transport = encryptionMode === 'plain' ? { encryptionMode } : {
      encryptionMode, encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey' as const,
    };
    const attach = (metadata: Metadata, next = runtimeMetadata) => createBaseSessionForAttach({
      existingSessionId: 'failed-birth', metadata: next, state: { controlledByUser: false },
      sessionAttachSecret: { ...transport, snapshot: { metadata, metadataVersion: 4, agentState: null, agentStateVersion: 1 } },
    });
    const recovered = await attach(birthMetadata);
    expect(recovered.metadata).toMatchObject({ flavor: 'codex', sessionCreationCorrespondenceV1: correspondence });
    expect(birthMetadata.flavor).toBeUndefined();
    expect(recovered.metadataVersion).toBe(4);
    // A later Agent cutover and a mismatched runner must never be relabeled
    // with the original birth Agent or a fresh process default.
    expect((await attach({ ...birthMetadata, flavor: 'claude' })).metadata.flavor).toBe('claude');
    expect((await attach(birthMetadata, createTestMetadata({ flavor: 'claude' }))).metadata.flavor).toBeUndefined();
    expect((await attach({ ...birthMetadata, sessionCreationCorrespondenceV1: undefined })).metadata.flavor).toBeUndefined();
    expect((await attach({ ...birthMetadata, codexSessionId: 'codex', claudeSessionId: 'claude' })).metadata.flavor).toBeUndefined();
  });
  it('restores the current server relation and origin independently from an inherited role snapshot', async () => {
    const { createBaseSessionForAttach } = await import('./createBaseSessionForAttach');
    const session = await createBaseSessionForAttach({ existingSessionId: 'worker',
      metadata: createTestMetadata(), state: { controlledByUser: false },
      sessionAttachSecret: { encryptionMode: 'plain', snapshot: {
        metadata: { ...createTestMetadata(), work: { sessionRolesV1: {
          inheritedFrom: 'old-lead', overrides: {}, sessionRoles: {}, notes: '',
        } } }, metadataVersion: 1, agentState: null, agentStateVersion: 1,
        manager: { sessionId: 'current-lead' }, origin: { kind: 'run_step' },
      } },
    });
    expect(session).toMatchObject({ manager: { sessionId: 'current-lead' }, origin: { kind: 'run_step' } });
  });
  it('accepts a process-local attach secret without consulting ambient process state', async () => {
    envScope.patch({ HAPPIER_SESSION_ATTACH_FILE: '/ambient/must-not-be-read.json' });
    try {
      vi.resetModules();
      const { createBaseSessionForAttach } = await import('./createBaseSessionForAttach');
      const encryptionKey = new Uint8Array(32).fill(13);

      const session = await createBaseSessionForAttach({
        existingSessionId: 'session-process-local',
        metadata: createTestMetadata(),
        state: { controlledByUser: false },
        sessionAttachSecret: {
          encryptionMode: 'e2ee',
          encryptionKey,
          encryptionVariant: 'dataKey',
        },
      });

      expect(session).toMatchObject({
        id: 'session-process-local',
        encryptionMode: 'e2ee',
        encryptionKey,
        encryptionVariant: 'dataKey',
      });
      expect(process.env.HAPPIER_SESSION_ATTACH_FILE).toBe('/ambient/must-not-be-read.json');
    } finally {
      envScope.restore();
    }
  });

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

  it('carries queued Execution Run targets from the attach snapshot into the initial Session', async () => {
    const { createBaseSessionForAttach } = await import('./createBaseSessionForAttach');

    const session = await createBaseSessionForAttach({
      existingSessionId: 'session-with-pending-run',
      metadata: createTestMetadata(),
      state: { controlledByUser: false },
      sessionAttachSecret: {
        encryptionMode: 'plain',
        snapshot: {
          metadata: createTestMetadata(),
          metadataVersion: 2,
          agentState: null,
          agentStateVersion: 3,
          pendingExecutionRunIds: ['run-offline'],
        },
      },
    });

    expect(session.pendingExecutionRunIds).toEqual(['run-offline']);
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
            agent: {
              backendMode: 'appServer',
              providerSessionId: 'private-vendor-id',
            },
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
