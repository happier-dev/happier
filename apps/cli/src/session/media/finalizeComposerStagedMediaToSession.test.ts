import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  SessionMediaMessageMetaV1Schema,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

import {
  finalizeComposerStagedMediaToSession,
} from './finalizeComposerStagedMediaToSession';

const sessionMediaBridgeSpies = vi.hoisted(() => ({
  persist: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock('@/api/session/client/transcript/sessionMediaBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/session/client/transcript/sessionMediaBridge')>();
  sessionMediaBridgeSpies.persist.mockImplementation(actual.persistSessionMediaForTranscript);
  sessionMediaBridgeSpies.cleanup.mockImplementation(actual.garbageCollectFailedSessionMediaCommit);
  return {
    ...actual,
    persistSessionMediaForTranscript: sessionMediaBridgeSpies.persist,
    garbageCollectFailedSessionMediaCommit: sessionMediaBridgeSpies.cleanup,
  };
});

const executionTarget = { serverId: 'server-current', machineId: 'machine-current' } as const;
const attachmentOwner = { pluginId: 'com.example.media', localId: 'composer' } as const;
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlW6UYAAAAASUVORK5CYII=',
  'base64',
);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createReadyStage(root: string) {
  const sourcePath = join(root, 'incoming.png');
  await writeFile(sourcePath, pngBytes);
  const stageStore = createComposerMediaStageStore({
    rootDirectory: join(root, 'stages'),
    executionTarget,
  });
  const staged = await stageStore.finalizeUpload({
    tempPath: sourcePath,
    sizeBytes: pngBytes.byteLength,
    sha256: sha256(pngBytes),
    executionTarget,
    owner: attachmentOwner,
    mediaKind: 'image',
    mimeType: 'image/png',
    name: 'review.png',
  });
  expect(staged.success).toBe(true);
  if (!staged.success) throw new Error(staged.error);
  const draftAttachment = {
    v: 1 as const,
    instanceId: 'attachment-image-1',
    attachment: attachmentOwner,
    key: 'review-image',
    value: { reviewId: '42' },
    presentation: { label: 'Review image', typeLabel: 'Review media' },
    content: { kind: 'stagedMedia' as const, handle: staged.handle },
  };
  return { stageStore, staged, draftAttachment };
}

function finalizationParams(params: Readonly<{
  root: string;
  stageStore: ReturnType<typeof createComposerMediaStageStore>;
  draftAttachment: Awaited<ReturnType<typeof createReadyStage>>['draftAttachment'];
  meta?: Record<string, unknown>;
}>) {
  return {
    sessionId: 'session-1',
    messageLocalId: 'local-1',
    workingDirectory: join(params.root, 'workspace'),
    executionTarget,
    stageStore: params.stageStore,
    meta: params.meta ?? {
      [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
        v: 1,
        composerAttachments: [params.draftAttachment],
      },
    },
    attachments: [params.draftAttachment],
  };
}

describe('finalizeComposerStagedMediaToSession', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    sessionMediaBridgeSpies.persist.mockClear();
    sessionMediaBridgeSpies.cleanup.mockClear();
    await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }));
  });

  it('turns one verified staged image into exactly one durable SessionMedia item and attachment ref without releasing the retry stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-finalize-'));
    temporaryDirectories.push(root);
    const { stageStore, staged, draftAttachment } = await createReadyStage(root);
    const result = await finalizeComposerStagedMediaToSession(finalizationParams({
      root,
      stageStore,
      draftAttachment,
    }));

    const mediaRef = result.attachments[0]?.content;
    expect(mediaRef).toMatchObject({ kind: 'sessionMedia' });
    if (!mediaRef || mediaRef.kind !== 'sessionMedia') throw new Error('expected durable media ref');
    const envelope = SessionMediaMessageMetaV1Schema.parse(result.meta.happier);
    expect(envelope.payload.media).toHaveLength(1);
    expect(envelope.payload.media[0]).toMatchObject({
      id: mediaRef.mediaId,
      role: 'input',
      category: 'attachment',
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'review.png',
      sizeBytes: pngBytes.byteLength,
      sha256: sha256(pngBytes),
      origin: { source: 'user-upload' },
    });
    expect(result.releaseIntents).toEqual([{
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
      claimant: {
        composer: { kind: 'session', sessionId: 'session-1' },
        attachmentInstanceId: 'attachment-image-1',
      },
    }]);
    await expect(stageStore.inspectForFinalization({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
    })).resolves.toMatchObject({ status: 'ready' });
  });

  it('refuses the same staged handle when a different Composer attachment already claimed it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-finalize-custody-'));
    temporaryDirectories.push(root);
    const { stageStore, draftAttachment } = await createReadyStage(root);
    await finalizeComposerStagedMediaToSession(finalizationParams({ root, stageStore, draftAttachment }));
    sessionMediaBridgeSpies.persist.mockClear();

    await expect(finalizeComposerStagedMediaToSession({
      ...finalizationParams({
        root,
        stageStore,
        draftAttachment: { ...draftAttachment, instanceId: 'attachment-image-2' },
      }),
      sessionId: 'session-2',
      messageLocalId: 'local-2',
    })).rejects.toMatchObject({ code: 'composer_staged_media_stage_unavailable' });
    expect(sessionMediaBridgeSpies.persist).not.toHaveBeenCalled();
  });

  it.each([
    ['target', (handle: Awaited<ReturnType<typeof createReadyStage>>['staged']['handle']) => ({
      ...handle,
      executionTarget: { serverId: 'server-other', machineId: handle.executionTarget.machineId },
    }), 'composer_staged_media_target_mismatch'],
    ['owner', (handle: Awaited<ReturnType<typeof createReadyStage>>['staged']['handle']) => ({
      ...handle,
      owner: { pluginId: 'com.example.other', localId: handle.owner.localId },
    }), 'composer_staged_media_owner_mismatch'],
    ['digest', (handle: Awaited<ReturnType<typeof createReadyStage>>['staged']['handle']) => ({
      ...handle,
      sha256: 'c'.repeat(64),
    }), 'composer_staged_media_stage_unavailable'],
  ] as const)('rejects a %s-mismatched staged claim without consuming its retry stage', async (
    _kind,
    mutateHandle,
    code,
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-finalize-'));
    temporaryDirectories.push(root);
    const { stageStore, staged, draftAttachment } = await createReadyStage(root);
    const forgedAttachment = {
      ...draftAttachment,
      content: { kind: 'stagedMedia' as const, handle: mutateHandle(staged.handle) },
    };

    await expect(finalizeComposerStagedMediaToSession(finalizationParams({
      root,
      stageStore,
      draftAttachment: forgedAttachment,
    }))).rejects.toMatchObject({ code });
    expect(sessionMediaBridgeSpies.persist).not.toHaveBeenCalled();
    await expect(stageStore.inspectForFinalization({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
    })).resolves.toMatchObject({ status: 'ready' });
  });

  it('does not persist a valid sibling when another selected staged claim is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-finalize-'));
    temporaryDirectories.push(root);
    const { stageStore, staged, draftAttachment } = await createReadyStage(root);
    const invalidSibling = {
      ...draftAttachment,
      instanceId: 'attachment-image-2',
      key: 'review-image-2',
      content: {
        kind: 'stagedMedia' as const,
        handle: {
          ...staged.handle,
          executionTarget: { serverId: 'server-other', machineId: staged.handle.executionTarget.machineId },
        },
      },
    };

    await expect(finalizeComposerStagedMediaToSession({
      ...finalizationParams({ root, stageStore, draftAttachment }),
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [draftAttachment, invalidSibling],
        },
      },
      attachments: [draftAttachment, invalidSibling],
    })).rejects.toMatchObject({ code: 'composer_staged_media_target_mismatch' });
    expect(sessionMediaBridgeSpies.persist).not.toHaveBeenCalled();
    await expect(stageStore.inspectForFinalization({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
    })).resolves.toMatchObject({ status: 'ready' });
  });

  it('rejects a duplicate durable envelope before persistence and retains the stage for retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-finalize-'));
    temporaryDirectories.push(root);
    const { stageStore, staged, draftAttachment } = await createReadyStage(root);

    await expect(finalizeComposerStagedMediaToSession(finalizationParams({
      root,
      stageStore,
      draftAttachment,
      meta: {
        happier: {
          kind: 'session_media.v1',
          payload: { media: [] },
        },
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [draftAttachment],
        },
      },
    }))).rejects.toMatchObject({ code: 'composer_staged_media_metadata_conflict' });
    expect(sessionMediaBridgeSpies.persist).not.toHaveBeenCalled();
    await expect(stageStore.inspectForFinalization({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
    })).resolves.toMatchObject({ status: 'ready' });
  });

  it('cleans up only the newly-created durable path when persistence returns a mismatched item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-finalize-'));
    temporaryDirectories.push(root);
    const { stageStore, staged, draftAttachment } = await createReadyStage(root);
    const createdWorkspaceRelativePaths = ['.happier/uploads/messages/session-1/local-1/new.png'];
    sessionMediaBridgeSpies.persist.mockResolvedValueOnce({
      success: true,
      items: [{
        id: 'media-1',
        role: 'input',
        category: 'attachment',
        mediaKind: 'image',
        mimeType: 'image/png',
        name: 'wrong-name.png',
        path: createdWorkspaceRelativePaths[0],
        sizeBytes: pngBytes.byteLength,
        sha256: sha256(pngBytes),
        origin: { source: 'user-upload' },
      }],
      createdWorkspaceRelativePaths,
      failures: [],
      meta: {},
    });
    sessionMediaBridgeSpies.cleanup.mockResolvedValueOnce({ deletedFiles: 1, deletedBytes: pngBytes.byteLength });

    await expect(finalizeComposerStagedMediaToSession(finalizationParams({
      root,
      stageStore,
      draftAttachment,
    }))).rejects.toMatchObject({ code: 'composer_staged_media_persist_mismatch' });
    expect(sessionMediaBridgeSpies.cleanup).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: join(root, 'workspace'),
      persisted: expect.objectContaining({ createdWorkspaceRelativePaths }),
    }));
    await expect(stageStore.inspectForFinalization({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
    })).resolves.toMatchObject({ status: 'ready' });
  });
});
