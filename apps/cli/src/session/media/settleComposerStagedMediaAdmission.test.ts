import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import type { ComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

import { settleComposerStagedMediaAdmissionV1 } from './settleComposerStagedMediaAdmission';

const releaseIntent = {
  handle: {
    v: 1 as const,
    id: 'staged-content-1',
    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
    owner: { pluginId: 'acme.media', localId: 'image' },
    mediaKind: 'image' as const,
    mimeType: 'image/png' as const,
    name: 'photo.png',
    sizeBytes: 4,
    sha256: 'a'.repeat(64),
  },
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  owner: { pluginId: 'acme.media', localId: 'image' },
  claimant: {
    composer: { kind: 'session' as const, sessionId: 'session-1' },
    attachmentInstanceId: 'attachment-1',
  },
};

const MEDIA_RELATIVE_PATH = '.happier/uploads/messages/msg-1/photo.png';

async function createWorkspaceWithMedia(): Promise<string> {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-settle-media-'));
  await mkdir(join(workingDirectory, '.happier/uploads/messages/msg-1'), { recursive: true });
  await writeFile(join(workingDirectory, MEDIA_RELATIVE_PATH), 'png!');
  return workingDirectory;
}

function createStageStore(): ComposerMediaStageStore & { release: ReturnType<typeof vi.fn> } {
  const release = vi.fn(async () => ({ success: true as const }));
  return {
    finalizeUpload: vi.fn(),
    claim: vi.fn(),
    inspectForFinalization: vi.fn(),
    release,
  } as unknown as ComposerMediaStageStore & { release: ReturnType<typeof vi.fn> };
}

describe('settleComposerStagedMediaAdmissionV1', () => {
  it('deletes the exact media it created when a definitive failure lands after Session teardown', async () => {
    const workingDirectory = await createWorkspaceWithMedia();
    const stageStore = createStageStore();

    await settleComposerStagedMediaAdmissionV1({
      outcome: 'definitiveFailure',
      settlement: {
        v: 1,
        workingDirectory,
        releaseIntents: [releaseIntent],
        createdWorkspaceRelativePaths: [MEDIA_RELATIVE_PATH],
      },
      stageStore,
    });

    await expect(readdir(join(workingDirectory, '.happier/uploads/messages/msg-1')))
      .resolves.toEqual([]);
    expect(stageStore.release).toHaveBeenCalledWith(releaseIntent);
  });

  it('releases the exact stages it consumed when acceptance lands after Session teardown', async () => {
    const workingDirectory = await createWorkspaceWithMedia();
    const stageStore = createStageStore();

    await settleComposerStagedMediaAdmissionV1({
      outcome: 'accepted',
      settlement: {
        v: 1,
        workingDirectory,
        releaseIntents: [releaseIntent],
        createdWorkspaceRelativePaths: [MEDIA_RELATIVE_PATH],
      },
      stageStore,
    });

    expect(stageStore.release).toHaveBeenCalledWith(releaseIntent);
    // Acceptance keeps the durable Message media it just admitted.
    await expect(readdir(join(workingDirectory, '.happier/uploads/messages/msg-1')))
      .resolves.toEqual(['photo.png']);
  });

  it('never deletes a workspace path outside the Session media tree', async () => {
    const workingDirectory = await createWorkspaceWithMedia();
    await writeFile(join(workingDirectory, 'secret.env'), 'token');
    const stageStore = createStageStore();

    await settleComposerStagedMediaAdmissionV1({
      outcome: 'definitiveFailure',
      settlement: {
        v: 1,
        workingDirectory,
        releaseIntents: [],
        createdWorkspaceRelativePaths: ['secret.env', '../escape.txt'],
      },
      stageStore,
    });

    await expect(readdir(workingDirectory)).resolves.toContain('secret.env');
  });
});
