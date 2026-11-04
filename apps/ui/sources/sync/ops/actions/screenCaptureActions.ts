import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import type {
    ScreenCaptureDeliveryInputSchema, ScreenCaptureDiscardInputSchema, ScreenCaptureOpenInputSchema, ScreenCaptureOpenResultSchema, ScreenCaptureStartInputSchema,
} from '@happier-dev/protocol/actions/actionSpecs';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { leafFolderName } from '@/utils/path/pathUtils';
import { resolveCaptureDefaultSelection } from '@/components/screenCapture/main/resolveCaptureDefaultTarget';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { executeNativeScreenCaptureAction } from './screenCaptureNativeActions';
import { executeScreenCaptureCopy } from './screenCaptureCopyAction';
import { executeInteractiveScreenCapture } from './screenCaptureAgentActions';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { resolveAttachmentsUploadConfig } from '@/components/sessions/attachments/useAttachmentsUploadConfig';
import { sessionAttachmentsUploadFile } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import { randomUUID } from '@/platform/randomUUID';
import type { SessionImageMediaReferenceV1 } from '@happier-dev/protocol/sessions/media/imageReferenceV1';
import { storage } from '@/sync/domains/state/storage';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readSessionImageInputAvailability } from '@/sync/domains/session/media/sessionImageInputAvailability';
import { selectSessionViewShellSessionForRouteState } from '@/components/sessions/shell/sessionViewStableSession';
import { playCaptureSound } from './playBundledSound';
import { NativeCaptureError, openNativeCapture, readCaptureDeliveryState,
    readPreparedCapturePng, readNativeCaptureState, settleNativeCapture, discardCapture, showCaptureInFolder,
    readCaptureSourcePng, writePreparedCapturePng, readNativeCaptureWindowText } from '@/desktop/capture/nativeCapture';
import type { NativeCaptureResult } from '@/desktop/capture/nativeCapture';
import type { PreparedRecordingDelivery } from './prepareRecordingDelivery';
import type { SessionDraftAppendItem } from '@/components/sessions/composer/appendToSessionDraft';
import type { PublicActionInputById } from '@happier-dev/protocol/actions/actionSpecs';
import { readScreenSharingPrivacyActive, setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';

import { captureWindowTextAttachment, readCaptureImageForDraft, readPreparedCaptureDelivery, resolveCaptureDelivery,
    type CaptureDeliveryRecord, type StillDelivery, type RecordingDelivery } from './screenCaptureDelivery';
export { resolveCaptureDelivery, type CaptureDeliveryRecord } from './screenCaptureDelivery';

/** Host effects: P1 file I/O and P3's reversible discard; pixels never cross window events. */
export type CaptureOpenResult = Readonly<ReturnType<typeof ScreenCaptureOpenResultSchema.parse>>;
export type ScreenCaptureNativePort = Readonly<{
    readDelivery: (captureRef: string, options?: Readonly<{ freshCapture?: NativeCaptureResult }>) => Promise<CaptureDeliveryRecord | ActionExecuteFailure>;
    open: (input: Readonly<{ captureRef: string; targetSession?: ExactSessionMachineTargetIdentity }>) => Promise<ActionExecuteFailure | void
        | CaptureOpenResult>;
    discard: (captureRef: string) => Promise<ActionExecuteFailure | void>;
    showInFolder?: (captureRef: string) => Promise<void>;
    settle?: (captureRef: string) => Promise<void>;
}>;

function failure(errorCode: string): ActionExecuteFailure {
    return { ok: false, errorCode, error: errorCode };
}

async function settleDeliveredCapture<Result extends Readonly<{ captureRef: string }>>(
    native: ScreenCaptureNativePort,
    delivered: Result,
): Promise<Result | ActionExecuteFailure> {
    try { await native.settle?.(delivered.captureRef); }
    catch (error) {
        if (!(error instanceof NativeCaptureError)) throw error;
        return { ...failure(error.code), effectAttempted: true, details: { captureStaged: true, delivered } };
    }
    return delivered;
}

/** One prepared item batch also serves ordinary New Session intake; no second pixel/disclosure path. */
export async function prepareCaptureDelivery(delivery: StillDelivery | RecordingDelivery,
    options: Readonly<{ imageOnly?: boolean; signal?: AbortSignal; captureWindowPress?: boolean }> = {}): Promise<ActionExecuteFailure | Readonly<{
        items: readonly SessionDraftAppendItem[]; copyImage: Uint8Array;
        windowText?: StillDelivery['windowText']; summary?: PreparedRecordingDelivery['summary'];
    }>> {
    if ('recording' in delivery) {
        const preparation = await import('./prepareRecordingDelivery');
        const prepared = await (options.captureWindowPress
            ? preparation.readPreparedRecordingDelivery(delivery.recording, options)
            : preparation.prepareRecordingDelivery(delivery.recording, options));
        if ('ok' in prepared) return prepared;
        const items: SessionDraftAppendItem[] = prepared.images.map(image => ({ kind: 'image',
            source: { kind: 'memory', bytes: image.bytes, name: image.name, mimeType: 'image/png', savedFile: image.savedFile }, note: image.note }));
        if (prepared.video) items.push({ kind: 'video', source: { kind: 'memory', ...prepared.video } });
        const windowText = captureWindowTextAttachment(prepared.windowText);
        return { items, copyImage: prepared.images[0]!.bytes, ...(windowText ? { windowText } : {}), summary: prepared.summary };
    }
    const image = delivery.image;
    const staged = image.readForDraft ? await image.readForDraft()
        : { bytes: 'bytes' in image ? image.bytes : await image.readBytes(), savedFile: image.savedFile };
    const { bytes, savedFile } = staged;
    const windowText = delivery.windowText ?? await delivery.readWindowText?.();
    return { copyImage: bytes, items: [{ kind: 'image', source: { kind: 'memory', bytes, name: delivery.image.name, mimeType: 'image/png',
        ...(savedFile ? { savedFile } : {}),
        ...(delivery.image.previewUri ? { previewUri: delivery.image.previewUri } : {}) } }],
        ...(windowText ? { windowText } : {}) };
}

export function createScreenCaptureAction(
    native: ScreenCaptureNativePort,
    options: Readonly<{ sendDraftOnly?: boolean; captureWindowPress?: boolean }> = {},
): NonNullable<ActionExecutorDeps['screenCaptureAction']> {
    return async args => {
        const { actionId, input, context } = args;
        if (actionId === 'screenCapture.privacy.set') {
            context.signal?.throwIfAborted();
            setScreenSharingPrivacyActive((input as PublicActionInputById['screenCapture.privacy.set']).active);
            return { active: readScreenSharingPrivacyActive() };
        }
        if (actionId === 'screenCapture.copy') return executeScreenCaptureCopy(args, { ...options, readDelivery: native.readDelivery });
        if (!isDesktopHost()) return failure('desktop_only');
        context.signal?.throwIfAborted();
        if (actionId === 'screenCapture.start') {
            return executeInteractiveScreenCapture(input as ReturnType<typeof ScreenCaptureStartInputSchema.parse>, context,
                (capture, target) => executeCaptureDelivery(native, args, options, { capture, target }));
        }
        const nativeResult = await executeNativeScreenCaptureAction(args);
        if (nativeResult !== undefined) return nativeResult;
        if (actionId === 'screenCapture.open') {
            const parsed = input as ReturnType<typeof ScreenCaptureOpenInputSchema.parse>;
            const result = await native.open(parsed);
            return result ?? { captureRef: parsed.captureRef, status: 'opened' };
        }
        if (actionId === 'screenCapture.discard') {
            const parsed = input as ReturnType<typeof ScreenCaptureDiscardInputSchema.parse>;
            return await native.discard(parsed.captureRef) ?? { captureRef: parsed.captureRef, status: 'discarded' };
        }
        if (actionId === 'screenCapture.showInFolder') {
            const parsed = input as ReturnType<typeof ScreenCaptureDiscardInputSchema.parse>;
            if (!native.showInFolder) return failure('operation_unavailable');
            await native.showInFolder(parsed.captureRef);
            return { captureRef: parsed.captureRef, status: 'revealed' };
        }
        return executeCaptureDelivery(native, args, options);
    };
}

/** L5 and preparation run once before any clipboard, draft, send or instant-media delivery. */
async function executeCaptureDelivery(native: ScreenCaptureNativePort,
    { actionId, input, context }: Parameters<NonNullable<ActionExecutorDeps['screenCaptureAction']>>[0],
    options: Readonly<{ sendDraftOnly?: boolean; captureWindowPress?: boolean }>,
    instant?: Readonly<{ capture: NativeCaptureResult; target: ExactSessionMachineTargetIdentity }>,
) {
    let delivered = false;
    try {
        // The shared Action executor has already admitted and normalized this input.
        const parsed = input as ReturnType<typeof ScreenCaptureDeliveryInputSchema.parse>;
        const captureRef = instant?.capture.captureRef ?? parsed.captureRef;
        const record = await native.readDelivery(captureRef, instant ? { freshCapture: instant.capture } : undefined);
        if ('ok' in record) return record;
        const delivery = resolveCaptureDelivery(record, context, options);
        if ('ok' in delivery) return delivery;
        const target = instant?.target ?? (actionId === 'screenCapture.copy' ? undefined : parsed.session);
        if (target) {
            const state = storage.getState();
            const session = readSessionListRowForServerId(state.sessionListRowsByServerId, target.serverId, target.sessionId)
                ?? selectSessionViewShellSessionForRouteState(state, target.sessionId, target.serverId);
            const availability = readSessionImageInputAvailability(session);
            if (!availability.available) return failure(availability.reason);
        }
        const prepared = actionId === 'screenCapture.send' && options.sendDraftOnly ? null
            : await prepareCaptureDelivery(delivery, { signal: context.signal, captureWindowPress: options.captureWindowPress });
        if (prepared && 'ok' in prepared) return prepared;
        if (instant) {
            await playCaptureSound(storage.getState().localSettings.screenCaptureSound);
            const account = await captureLazyActionAccountContext(instant.target.serverId, context.signal);
            try {
                const uploaded = await sessionAttachmentsUploadFile({ sessionId: instant.target.sessionId, sessionTarget: instant.target,
                    file: { kind: 'memory', bytes: prepared!.copyImage,
                        name: leafFolderName(instant.capture.path) ?? 'Capture.png', mimeType: 'image/png' }, messageLocalId: randomUUID(),
                    config: resolveAttachmentsUploadConfig(await account.readSettings()),
                    signal: context.signal, isCurrent: account.accountLifetime.isCurrent });
                if (!uploaded.success) return failure('errorCode' in uploaded && uploaded.errorCode ? uploaded.errorCode : 'attachment_upload_failed');
                const media = { mediaId: uploaded.attachmentHandle?.id ?? uploaded.sha256, mediaKind: 'image',
                    width: instant.capture.pixelSize.width, height: instant.capture.pixelSize.height, sizeBytes: uploaded.sizeBytes,
                    file: { sessionId: instant.target.sessionId, storage: 'session', path: uploaded.path, sha256: uploaded.sha256, mimeType: 'image/png' },
                } satisfies SessionImageMediaReferenceV1;
                delivered = true;
                return settleDeliveredCapture(native, { captureRef, media,
                    ...(prepared!.windowText ? { windowText: prepared!.windowText } : {}) });
            } finally { account.dispose(); }
        }
        if (prepared) {
            const { appendToSessionDraft } = await import('@/components/sessions/composer/appendToSessionDraft');
            const appended = appendToSessionDraft({ sessionTarget: parsed.session,
                items: prepared.items,
                ...(parsed.note === undefined ? {} : { note: parsed.note }),
                ...(prepared.windowText ? { windowText: prepared.windowText } : {}),
            });
            if (appended.status !== 'applied') return failure(appended.status);
            const { flushAttachmentDraftsForKey } = await import('@/components/sessions/attachments/attachmentDraftMemoryStore');
            const { sessionAttachmentDraftKey, resolveSessionAttachmentDraftScope } = await import('@/components/sessions/attachments/sessionAttachmentDraftStore');
            await flushAttachmentDraftsForKey(sessionAttachmentDraftKey(resolveSessionAttachmentDraftScope(parsed.session)));
            if (actionId === 'screenCapture.addToDraft') {
                return settleDeliveredCapture(native, { captureRef: parsed.captureRef, imageNumber: appended.imageNumbers[0],
                    ...(prepared.summary ? { imageNumbers: appended.imageNumbers, summary: prepared.summary } : {}), waiting: false });
            }
        }
        const { submitSessionDraft } = await import('@/components/sessions/composer/submitSessionDraft');
        const submitted = await submitSessionDraft({ sessionTarget: parsed.session, signal: context.signal });
        if (!submitted.ok) return { ...submitted, details: { captureStaged: true,
            ...(submitted.details === undefined ? {} : { submission: submitted.details }) } };
        return settleDeliveredCapture(native, { captureRef: parsed.captureRef, messageRef: submitted.result.localId,
            ...(prepared?.summary ? { summary: prepared.summary } : {}) });
    } finally {
        if (instant && !delivered) await native.settle?.(instant.capture.captureRef);
    }
}

/** One by-reference reader for Actions and the Capture window's New Session intent. */
export async function readNativeCaptureDelivery(captureRef: string,
    options: Readonly<{ freshCapture?: NativeCaptureResult }> = {}): Promise<CaptureDeliveryRecord | ActionExecuteFailure> {
    if (!options.freshCapture) return readPreparedCaptureDelivery(captureRef);
    const result = options.freshCapture;
    const state = await readCaptureDeliveryState(captureRef);
    if (result.kind === 'video') return { captureRef, inUse: state.inUse, disclosure: state.disclosure, recording: { result } };
    if (options.freshCapture && !state.disclosure) {
        const disclosure = { hasMarks: false, includeWindowText: storage.getState().localSettings.screenCaptureIncludeWindowText };
        const readBytes = async () => {
            const bytes = await readCaptureSourcePng(captureRef);
            await writePreparedCapturePng(captureRef, bytes, disclosure);
            return bytes;
        };
        return { captureRef, inUse: state.inUse, disclosure,
            image: { kind: 'original', name: leafFolderName(result.path) ?? 'Capture.png', readBytes,
                readForDraft: async () => { await readBytes(); return readCaptureImageForDraft(captureRef); } },
            readWindowText: async () => captureWindowTextAttachment(await readNativeCaptureWindowText(captureRef)) };
    }
    const windowText = captureWindowTextAttachment(state.windowText);
    return { captureRef, inUse: state.inUse, disclosure: state.disclosure,
        ...(windowText ? { windowText } : {}),
        image: { kind: 'prepared', name: leafFolderName(result.path) ?? 'Capture.png',
            readBytes: () => readPreparedCapturePng(captureRef), readForDraft: () => readCaptureImageForDraft(captureRef) } };
}

/** The native prepared PNG and its disclosure record are shared by every delivery Action. */
export function createNativeScreenCaptureAction(options: Readonly<{
    sendDraftOnly?: boolean; captureWindowPress?: boolean; discard?: ScreenCaptureNativePort['discard'];
}> = {}): NonNullable<ActionExecutorDeps['screenCaptureAction']> {
    const native: ScreenCaptureNativePort = {
        readDelivery: readNativeCaptureDelivery,
        open: async ({ captureRef, targetSession }) => {
            let defaultReason: CaptureOpenResult['defaultReason'] | null = null;
            if (!targetSession) {
                const current = await readNativeCaptureState(captureRef);
                if (current.status === 'completed' && current.result.captureRef === captureRef && current.targetSession) {
                    targetSession = current.targetSession;
                } else {
                    const selection = resolveCaptureDefaultSelection();
                    const { address } = selection;
                    const scope = address && selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), address.serverId);
                    if (scope && address) {
                        targetSession = { ...address, accountId: scope.accountId };
                        defaultReason = selection.defaultReason;
                    }
                }
            }
            await openNativeCapture(captureRef, targetSession);
            return { captureRef, status: 'opened', ...(targetSession ? { targetSession } : {}), ...(defaultReason ? { defaultReason } : {}) };
        },
        discard: options.discard ?? discardCapture,
        showInFolder: showCaptureInFolder,
        settle: async captureRef => { await settleNativeCapture(captureRef); },
    };
    const execute = createScreenCaptureAction(native, options);
    return async args => {
        try { return await execute(args); }
        catch (error) { if (error instanceof NativeCaptureError) return failure(error.code); throw error; }
    };
}
