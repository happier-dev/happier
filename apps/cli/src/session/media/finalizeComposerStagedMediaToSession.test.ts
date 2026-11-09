import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  SessionMediaMessageMetaV1Schema,
  renderSessionInputContextPromptV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

import {
  finalizeComposerStagedMediaToSession,
} from './finalizeComposerStagedMediaToSession';
import { settleComposerStagedMediaAdmissionV1 } from './settleComposerStagedMediaAdmission';
import { SessionUserMessageSendRequestSchema } from '@happier-dev/protocol/sessions/userMessageRpc';
import { admitSessionStructuredInputV1, preserveComposerAttachmentSelectionAcrossSessionInputTransformV1 } from '@/session/services/admitSessionStructuredInputV1';
import { resolveStructuredInputProviderDispatchContext } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';

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

async function createReadyStage(root: string, format?: 'mp4' | 'webm') {
  const bytes = format === 'mp4' ? Buffer.from('000000186674797069736f6d0000020069736f6d61766331', 'hex')
    : format === 'webm' ? Buffer.concat([Buffer.from('1a45dfa342868101', 'hex'), Buffer.from('webm recording bytes')]) : pngBytes;
  const sourcePath = join(root, `incoming.${format ?? 'png'}`);
  await writeFile(sourcePath, bytes);
  const stageStore = createComposerMediaStageStore({
    rootDirectory: join(root, 'stages'),
    executionTarget,
  });
  const staged = await stageStore.finalizeUpload({
    tempPath: sourcePath,
    sizeBytes: bytes.byteLength,
    sha256: sha256(bytes),
    executionTarget,
    owner: attachmentOwner,
    mediaKind: format ? 'video' : 'image',
    mimeType: format ? `video/${format}` : 'image/png',
    name: `review.${format ?? 'png'}`,
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

  it.each(['mp4', 'webm'] as const)('makes staged %s bytes readable at the path delivered in the Agent turn', async format => {
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-video-dispatch-'));
    temporaryDirectories.push(root);
    const { stageStore, draftAttachment } = await createReadyStage(root, format);
    const finalized = await finalizeComposerStagedMediaToSession(finalizationParams({ root, stageStore, draftAttachment }));
    const admitted = admitSessionStructuredInputV1({ text: 'Watch the transition', meta: finalized.meta,
      preparedComposerAttachments: finalized.attachments });
    const media = SessionMediaMessageMetaV1Schema.parse(finalized.meta.happier).payload.media;
    const dispatched = await resolveStructuredInputProviderDispatchContext({
      structuredInput: admitted.structuredInput, sessionMedia: media,
      composerAttachments: { scope: { kind: 'session', sessionId: 'session-1' }, localId: 'local-1',
        signal: new AbortController().signal,
        resolve: async input => ({ attachments: input.request.attachments.map(attachment => ({
          instanceId: attachment.instanceId, status: 'ready' as const, data: {},
        })) }),
      },
    });
    const file = dispatched.promptContext.references?.uploads?.[0];
    expect(file).toMatchObject({ path: media[0]!.path, mimeType: `video/${format}` });
    if (!file) throw new Error('Expected the persisted movie in the turn file context');
    const prompt = renderSessionInputContextPromptV1({ ...dispatched.promptContext, transformedUserText: admitted.text });
    expect(prompt).toContain(`path=${JSON.stringify(file.path)}`);
    await expect(readFile(join(root, 'workspace', file.path))).resolves.toEqual(await readFile(join(root, `incoming.${format}`)));
    expect(dispatched.structuredInput?.imageInputs ?? []).toEqual([]);
  });

  it('projects source review context before media slot selection and persists one review representation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-review-media-'));
    temporaryDirectories.push(root);
    const { stageStore, draftAttachment } = await createReadyStage(root);
    const reviewComments = { sessionId: 'source-session', comments: [{
      id: 'comment-1', filePath: 'src/index.ts', source: 'file',
      anchor: { kind: 'line', filePath: 'src/index.ts', line: 2 },
      snapshot: { selectedLines: ['const value = 1;'], beforeContext: [], afterContext: [] },
      body: 'Keep the original anchor', createdAt: 1,
    }] };
    const request = SessionUserMessageSendRequestSchema.parse({ text: 'Rendered review prompt', meta: {
      happierStructuredInputV1: { v: 1, reviewComments, composerAttachments: [draftAttachment] },
    } });
    const legacyAttachments = { kind: 'attachments.v1', payload: { attachments: [{
      name: 'notes.txt', path: '.happier/uploads/messages/source-session/file/notes.txt',
      mimeType: 'text/plain', sizeBytes: 12,
    }] } };
    const transformed = preserveComposerAttachmentSelectionAcrossSessionInputTransformV1({
      sourceMeta: request.meta, transformedMeta: { happier: legacyAttachments, unrelated: 'retained' },
    });
    const finalized = await finalizeComposerStagedMediaToSession(finalizationParams({
      root, stageStore, draftAttachment, meta: transformed!,
    }));
    const admitted = admitSessionStructuredInputV1({ text: request.text, meta: finalized.meta,
      preparedComposerAttachments: finalized.attachments });
    expect(admitted.text).toBe('Rendered review prompt');
    expect(admitted.meta.happier).toEqual({ kind: 'review_comments.v1', payload: reviewComments });
    expect(admitted.meta.happierAttachments).toEqual(legacyAttachments);
    expect(SessionMediaMessageMetaV1Schema.parse(admitted.meta.happierMedia).payload.media).toHaveLength(1);
    expect(admitted.structuredInput).not.toHaveProperty('reviewComments');
    expect(admitted.meta).toMatchObject({ unrelated: 'retained' });
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
    expect(result.releaseIntents).toHaveLength(1);
    const releaseIntent = result.releaseIntents[0]!;
    // The submission consumes its own fork copy, never the mutable draft original.
    expect(releaseIntent.handle.id).not.toBe(staged.handle.id);
    expect(releaseIntent.handle).toMatchObject({
      executionTarget,
      owner: attachmentOwner,
      mediaKind: staged.handle.mediaKind,
      mimeType: staged.handle.mimeType,
      name: staged.handle.name,
      sizeBytes: staged.handle.sizeBytes,
      sha256: staged.handle.sha256,
    });
    expect(releaseIntent.claimant).toEqual({
      composer: { kind: 'session', sessionId: 'session-1' },
      attachmentInstanceId: 'attachment-image-1',
    });
    await expect(stageStore.inspectForFinalization({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
    })).resolves.toMatchObject({ status: 'ready' });
  });

  it.each([
    ['Pending', { kind: 'pendingMessage' as const, sessionId: 'session-1', localId: 'pending-1' }],
    ['NewSession', { kind: 'newSession' as const, instanceId: 'new-session-composer-1' }],
    ['other Session', { kind: 'session' as const, sessionId: 'source-session-a' }],
  ] as const)('finalizes a %s cross-location submission through a claimed clone while retaining the original draft stage', async (
    _kind,
    sourceComposerRef,
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-finalize-fork-'));
    temporaryDirectories.push(root);
    const { stageStore, staged, draftAttachment } = await createReadyStage(root);
    const sourceClaimant = { composer: sourceComposerRef, attachmentInstanceId: draftAttachment.instanceId };
    await expect(stageStore.claim({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
      claimant: sourceClaimant,
    })).resolves.toMatchObject({ status: 'claimed' });

    const first = await finalizeComposerStagedMediaToSession({
      ...finalizationParams({ root, stageStore, draftAttachment }),
      sourceComposerRef,
    });

    expect(first.releaseIntents[0]?.handle.id).not.toBe(staged.handle.id);
    await expect(stageStore.inspectForFinalization({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
      claimant: sourceClaimant,
    })).resolves.toMatchObject({ status: 'ready' });
    const envelope = SessionMediaMessageMetaV1Schema.parse(first.meta.happier);
    const media = envelope.payload.media[0]!;
    expect(first.releaseIntents[0]?.claimant.composer).toEqual({ kind: 'session', sessionId: 'session-1' });
    await settleComposerStagedMediaAdmissionV1({
      outcome: 'accepted',
      settlement: {
        v: 1,
        workingDirectory: join(root, 'workspace'),
        releaseIntents: [...first.releaseIntents],
        createdWorkspaceRelativePaths: [...first.createdWorkspaceRelativePaths],
      },
      stageStore,
    });
    await expect(readFile(join(root, 'workspace', media.path))).resolves.toEqual(pngBytes);
    await expect(stageStore.inspectForFinalization(first.releaseIntents[0]!))
      .resolves.toEqual({ status: 'unavailable', reason: 'notFound' });
    await expect(stageStore.inspectForFinalization({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
      claimant: sourceClaimant,
    })).resolves.toMatchObject({ status: 'ready' });
  });

  it.each(['accepted', 'definitiveFailure'] as const)(
    'retains a target submission snapshot until %s settlement, then releases both snapshots but not the mutable source',
    async (outcome) => {
      const root = await mkdtemp(join(tmpdir(), 'happier-composer-snapshot-settlement-'));
      temporaryDirectories.push(root);
      const { stageStore, staged, draftAttachment } = await createReadyStage(root);
      const sourceClaimant = {
        composer: { kind: 'session' as const, sessionId: 'source-session-a' },
        attachmentInstanceId: draftAttachment.instanceId,
      };
      const targetClaimant = {
        composer: { kind: 'session' as const, sessionId: 'session-1' },
        attachmentInstanceId: draftAttachment.instanceId,
      };
      await stageStore.claim({ handle: staged.handle, executionTarget, owner: attachmentOwner, claimant: sourceClaimant });
      const captured = await stageStore.forkClaimForSubmission({
        handle: staged.handle,
        executionTarget,
        owner: attachmentOwner,
        sourceClaimant,
        destinationClaimant: targetClaimant,
        messageLocalId: 'local-1',
      });
      if (!captured.handle) throw new Error('expected a captured target submission');
      const targetDraft = {
        ...draftAttachment,
        content: { kind: 'stagedMedia' as const, handle: captured.handle },
      };
      const targetInspection = { handle: captured.handle, executionTarget, owner: attachmentOwner, claimant: targetClaimant };
      await expect(finalizeComposerStagedMediaToSession({
        ...finalizationParams({ root, stageStore, draftAttachment: targetDraft }),
        meta: { happier: { kind: 'session_media.v1', payload: { media: [] } } },
      })).rejects.toMatchObject({ code: 'composer_staged_media_metadata_conflict' });
      await expect(stageStore.inspectForFinalization(targetInspection)).resolves.toMatchObject({ status: 'ready' });
      const finalized = await finalizeComposerStagedMediaToSession(finalizationParams({
        root, stageStore, draftAttachment: targetDraft,
      }));
      // Preparation is not acceptance: queued/offline custody retains both immutable copies.
      await expect(stageStore.inspectForFinalization(targetInspection)).resolves.toMatchObject({ status: 'ready' });
      expect(finalized.releaseIntents.map((intent) => intent.handle.id)).toEqual(expect.arrayContaining([
        captured.handle.id,
      ]));
      expect(finalized.releaseIntents).toHaveLength(2);
      const media = SessionMediaMessageMetaV1Schema.parse(finalized.meta.happier).payload.media[0]!;
      const mediaPath = join(root, 'workspace', media.path);
      await expect(readFile(mediaPath)).resolves.toEqual(pngBytes);
      await settleComposerStagedMediaAdmissionV1({
        outcome,
        settlement: {
          v: 1,
          workingDirectory: join(root, 'workspace'),
          releaseIntents: [...finalized.releaseIntents],
          createdWorkspaceRelativePaths: [...finalized.createdWorkspaceRelativePaths],
        },
        stageStore,
      });
      for (const intent of finalized.releaseIntents) {
        await expect(stageStore.inspectForFinalization(intent)).resolves.toEqual({ status: 'unavailable', reason: 'notFound' });
      }
      await expect(stageStore.inspectForFinalization({
        handle: staged.handle, executionTarget, owner: attachmentOwner, claimant: sourceClaimant,
      })).resolves.toMatchObject({ status: 'ready' });
      if (outcome === 'accepted') await expect(readFile(mediaPath)).resolves.toEqual(pngBytes);
      else await expect(readFile(mediaPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('persists through the submission fork when a concurrent draft removal releases the original stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-finalize-race-'));
    temporaryDirectories.push(root);
    const { stageStore, staged, draftAttachment } = await createReadyStage(root);
    const draftClaimant = {
      composer: { kind: 'session' as const, sessionId: 'session-1' },
      attachmentInstanceId: draftAttachment.instanceId,
    };
    const actualPersist = sessionMediaBridgeSpies.persist.getMockImplementation();
    if (!actualPersist) throw new Error('expected the real persistence implementation to be wired');
    sessionMediaBridgeSpies.persist.mockImplementationOnce(async (input: unknown) => {
      // The draft lifecycle removes the attachment after the finalizer captured
      // its submission snapshot but before persistence opens the staged bytes.
      await stageStore.release({
        handle: staged.handle,
        executionTarget,
        owner: attachmentOwner,
        claimant: draftClaimant,
      });
      return await actualPersist(input);
    });

    const result = await finalizeComposerStagedMediaToSession(finalizationParams({
      root,
      stageStore,
      draftAttachment,
    }));
    expect(result.releaseIntents[0]?.handle.id).not.toBe(staged.handle.id);
    // The concurrently removed draft stage is gone while the durable media exists.
    await expect(stageStore.inspectForFinalization({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
    })).resolves.toMatchObject({ status: 'unavailable' });
    const envelope = SessionMediaMessageMetaV1Schema.parse(result.meta.happier);
    expect(envelope.payload.media).toHaveLength(1);

    // Settlement releases only the submission fork, which is now consumed.
    await expect(stageStore.release({
      handle: result.releaseIntents[0]!.handle,
      executionTarget,
      owner: attachmentOwner,
      claimant: result.releaseIntents[0]!.claimant,
    })).resolves.toEqual({ status: 'released' });
  });

  it('retains the draft original and rejoins the same submission fork when persistence fails then retries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-finalize-retry-'));
    temporaryDirectories.push(root);
    const { stageStore, staged, draftAttachment } = await createReadyStage(root);
    const draftClaimant = {
      composer: { kind: 'session' as const, sessionId: 'session-1' },
      attachmentInstanceId: draftAttachment.instanceId,
    };
    const params = finalizationParams({ root, stageStore, draftAttachment });

    sessionMediaBridgeSpies.persist.mockResolvedValueOnce({
      success: false,
      items: [],
      createdWorkspaceRelativePaths: [],
      failures: [],
      meta: {},
    });
    await expect(finalizeComposerStagedMediaToSession(params)).rejects.toMatchObject({
      code: 'composer_staged_media_persist_failed',
    });
    // Failure cleanup garbage-collects only the failed durable write.
    expect(sessionMediaBridgeSpies.cleanup).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: join(root, 'workspace'),
    }));
    // The mutable draft original survives for its own lifecycle.
    await expect(stageStore.inspectForFinalization({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
      claimant: draftClaimant,
    })).resolves.toMatchObject({ status: 'ready' });

    const retry = await finalizeComposerStagedMediaToSession(params);
    // The retry submits through a fork, never the draft original.
    expect(retry.releaseIntents[0]?.handle.id).not.toBe(staged.handle.id);
    await expect(stageStore.release({
      handle: retry.releaseIntents[0]!.handle,
      executionTarget,
      owner: attachmentOwner,
      claimant: retry.releaseIntents[0]!.claimant,
    })).resolves.toEqual({ status: 'released' });
    await expect(stageStore.inspectForFinalization({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
      claimant: draftClaimant,
    })).resolves.toMatchObject({ status: 'ready' });
  });

  it.each([
    ['missing', undefined, { kind: 'pendingMessage' as const, sessionId: 'session-1', localId: 'pending-1' }],
    ['forged', { kind: 'newSession' as const, instanceId: 'composer-forged' }, { kind: 'pendingMessage' as const, sessionId: 'session-1', localId: 'pending-1' }],
    ['wrong Session', { kind: 'session' as const, sessionId: 'source-session-b' }, { kind: 'session' as const, sessionId: 'source-session-a' }],
  ] as const)('refuses a %s source claim without consuming the original stage', async (
    _kind,
    sourceComposerRef,
    originalSource,
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-composer-finalize-source-'));
    temporaryDirectories.push(root);
    const { stageStore, staged, draftAttachment } = await createReadyStage(root);
    const originalClaimant = { composer: originalSource, attachmentInstanceId: draftAttachment.instanceId };
    await expect(stageStore.claim({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
      claimant: originalClaimant,
    })).resolves.toMatchObject({ status: 'claimed' });

    await expect(finalizeComposerStagedMediaToSession({
      ...finalizationParams({ root, stageStore, draftAttachment }),
      ...(sourceComposerRef ? { sourceComposerRef } : {}),
    })).rejects.toMatchObject({ code: 'composer_staged_media_stage_unavailable' });
    expect(sessionMediaBridgeSpies.persist).not.toHaveBeenCalled();
    await expect(stageStore.inspectForFinalization({
      handle: staged.handle,
      executionTarget,
      owner: attachmentOwner,
      claimant: originalClaimant,
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
