import { applyImageMarksOperations, hasBlur } from '@happier-dev/protocol/sessions/media/imageMarksV1';
import { type MediaAnnotationActionRequestV1, type MediaAnnotationReadResultV1, type MediaAnnotationApplyResultV1 } from '@happier-dev/protocol/actions/mediaAnnotationAction';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readMountedComposerPickedAttachments } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { commitComposerPicture, readComposerPicture, readComposerPictureSource } from '@/components/sessions/composer/replaceComposerPicture';
import { areServerAccountScopesEqual, createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { readTranscriptSessionMediaMeta } from '@/components/sessions/transcript/structured/happierMetaEnvelope';
import type { SessionMediaInlineImageAvailableSummary } from '@/sync/domains/session/media/sessionMediaMessageMeta';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { createSessionAttachmentPreviewSource, createSessionFilePreviewSource } from '@/sync/domains/sessionFilePreviews/createSessionFilePreviewSource';
import { copyAnnotatedPicture } from '@/components/sessions/composer/copyAnnotatedPicture';
import type { ImageAnnotationSource } from '@/components/ui/media/annotation/types';
import { executeRecordingFrameAnnotation } from './recordingActionRuntime';
import { readRegisteredBrowserContextAnnotationAdapter } from '@/sync/domains/browser/context/runtimeAnnotationRegistry';
import { requestCaptureAnnotationAction } from '@/desktop/capture/captureAnnotationActions';

function annotationFailure(reason: string): MediaAnnotationApplyResultV1 | ActionExecuteFailure {
    if (reason === 'canvasUnavailable' || reason === 'decodeFailed') return { status: 'unavailable', reason: `flatten.${reason}` };
    if (reason === 'annotation.targetUnavailable') return { status: 'unavailable', reason };
    return { ok: false, errorCode: reason, error: reason };
}

/** Read only the addressed, already-loaded Session; no annotator or media registry is introduced. */
async function readSessionImage(input: Readonly<{ scope: ServerAccountScope; sessionId: string; mediaId: string; signal?: AbortSignal }>): Promise<
    Readonly<{ source: ImageAnnotationSource; name: string; dispose: () => void | Promise<void> }> | ActionExecuteFailure | null
> {
    const state = storage.getState();
    if (!areServerAccountScopesEqual(state.profileScope, input.scope) || state.sessions[input.sessionId]?.access?.capabilities.readTranscript !== true) return null;
    const transcript = state.sessionMessages[input.sessionId];
    if (!transcript) return null;
    let media: SessionMediaInlineImageAvailableSummary | null = null;
    for (const message of Object.values(transcript.messagesById)) {
        const candidate = readTranscriptSessionMediaMeta('meta' in message ? message.meta : null)?.inlineImages.find(image => image.id === input.mediaId);
        if (candidate && candidate.status !== 'unavailable') { media = candidate; break; }
    }
    if (!media) return null;
    const options = { mimeType: media.mimeType, maxBytes: null, expectedSizeBytes: media.sizeBytes, signal: input.signal };
    const workspace = media.attachmentHandle ? null : resolveWorkspaceTargetForSession({ ...input.scope, sessionId: input.sessionId });
    if (!media.attachmentHandle && !workspace) return null;
    const preview = media.attachmentHandle
        ? await createSessionAttachmentPreviewSource({ ...options, handle: media.attachmentHandle, fileName: media.path })
        : await createSessionFilePreviewSource({ ...options, scope: workspace!, filePath: media.path });
    if (!preview.ok) return preview.errorCode ? { ok: false, errorCode: preview.errorCode, error: preview.errorCode } : null;
    const dispose = () => preview.source.kind === 'object-url' ? preview.source.revoke() : preview.source.delete();
    const source = await readComposerPictureSource({ kind: 'preview', source: { uri: preview.source.uri } });
    if (!source) { await dispose(); return null; }
    return { source, name: media.name, dispose };
}

/** ActionExecutor admits the closed input once; this adapter resolves the live picture owner. */
export async function executeMediaAnnotationAction(request: MediaAnnotationActionRequestV1 & Readonly<{
    context: ActionExecutorContext;
    signal?: AbortSignal;
}>): Promise<MediaAnnotationReadResultV1 | MediaAnnotationApplyResultV1 | ActionExecuteFailure> {
    const unavailable = { status: 'unavailable', reason: 'annotation.targetUnavailable' } as const;
    const scope = createServerAccountScope(request.context.serverId, request.context.runtimeAccountId);
    const { input } = request;
    if (request.actionId === 'media.annotation.apply' && request.input.cause !== undefined
        && request.input.cause !== 'edit' && request.context.surface !== 'ui') {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    }
    if (!areServerAccountScopesEqual(scope, input.scope) || request.signal?.aborted) return unavailable;
    if (input.target.kind === 'capture') {
        return requestCaptureAnnotationAction(input.target.captureRef, request);
    }
    if (input.target.kind === 'recordingFrame') {
        return executeRecordingFrameAnnotation(input.target,
            request.actionId === 'media.annotation.read' ? null : request.input.reset ? [{ kind: 'reset' }] : request.input.operations!,
            request.actionId === 'media.annotation.apply' ? request.input.cause : undefined);
    }
    if (input.target.kind === 'browserView') {
        const adapter = readRegisteredBrowserContextAnnotationAdapter({ ...input.target, scope: input.scope });
        const draft = adapter?.readFrozenDraft?.();
        if (!draft) return unavailable;
        if (request.actionId === 'media.annotation.apply') {
            const applied = await adapter?.applyOperations?.({ operations: request.input.operations, reset: request.input.reset });
            return applied ? { status: request.input.reset ? 'reverted' : 'replaced' } : unavailable;
        }
        const { width, height, scale } = draft.source;
        return { document: draft.document, image: { width, height, scale }, hasBlur: hasBlur(draft.document) };
    }
    if (input.target.kind === 'sessionImage') {
        const picture = await readSessionImage({ scope: input.scope, sessionId: input.target.sessionId, mediaId: input.target.mediaId, signal: request.signal });
        if (!picture) return unavailable;
        if ('ok' in picture) return picture;
        try {
            const { uri: _uri, ...image } = picture.source;
            const document = { v: 1 as const, image, marks: [] };
            if (request.actionId === 'media.annotation.read') return { image, hasBlur: false };
            const next = applyImageMarksOperations(document, request.input.reset ? [{ kind: 'reset' }] : request.input.operations!);
            const result = await copyAnnotatedPicture({ source: picture.source, document: next, name: picture.name,
                sessionTarget: { ...input.scope, sessionId: request.input.into!.sessionId } });
            return result.ok ? { status: result.status, imageNumber: result.imageNumber } : annotationFailure(result.reason);
        } finally { await picture.dispose(); }
    }
    if (input.target.kind !== 'composerAttachment') return unavailable;
    const manager = readMountedComposerPickedAttachments({ scope: input.scope, ref: input.target.ref, editable: request.actionId === 'media.annotation.apply' });
    if (!manager) return unavailable;
    const occurrence = { kind: 'picked' as const, attachmentId: input.target.attachmentId, ...manager };
    const draft = readComposerPicture(occurrence);
    if (!draft) return unavailable;
    const source = await readComposerPictureSource(occurrence);
    if (!source) return unavailable;
    const image = { width: source.width, height: source.height, scale: source.scale };
    const document = draft.edit?.document ?? { v: 1 as const, image, marks: [] };
    if (request.actionId === 'media.annotation.read') return { ...(draft.edit ? { document } : {}), image, hasBlur: hasBlur(document) };
    const next = applyImageMarksOperations(document, request.input.reset ? [{ kind: 'reset' }] : request.input.operations!);
    const result = await commitComposerPicture(occurrence, next, source);
    return result.ok ? { status: result.status } : annotationFailure(result.reason);
}
