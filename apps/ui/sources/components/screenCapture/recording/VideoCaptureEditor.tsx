import * as React from 'react';

import { type NativeCaptureResult, type NativeCaptureWindowDisplay } from '@/desktop/capture/nativeCapture';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { t } from '@/text';

import type { CaptureDisclosureEvent } from '../disclosure/captureDisclosureRule';
import { CaptureEditorShell, type CaptureEditorMedia } from '../window/CaptureEditorShell';
import type { CaptureWindowCapture } from '../window/useCaptureWindowCapture';
import { useCaptureWindowText } from '../window/useCaptureWindowText';
import type { RecordingDocument } from './recordingDocument';
import { useRecordingEditor, type RecordingMediaAccess } from './useRecordingEditor';
import { useRecordingSurface } from './useRecordingSurface';
import { useRecordingMedia } from './useRecordingMedia';
import { prepareNativeRecordingDelivery } from '@/sync/ops/actions/prepareRecordingDelivery';

/**
 * Before the window has its first frame, the route composes opening/failed in the Capture window's state chrome;
 * once it is open, a failure is the delivery line's Retry under the picture. Retry keeps the edit document.
 */
export type RecordingEditorStatus = Readonly<{ status: 'loading' | 'failed'; onRetry: () => void }>;

/** A video in the Capture window: same window, same palette, with the timeline under the picture (lab `rc` ED). */
export function VideoCaptureEditor(props: Readonly<{
    held: CaptureWindowCapture;
    capture: NativeCaptureResult;
    document: RecordingDocument;
    display: NativeCaptureWindowDisplay;
    onClose: () => void;
    renderStatus?: (state: RecordingEditorStatus) => React.ReactNode;
}>) {
    const source = useRecordingMedia(props.capture, props.held.signal);
    return source.media ? <LoadedVideoEditor {...props} media={source.media} source={source} />
        : props.renderStatus?.({ status: source.status === 'failed' ? 'failed' : 'loading', onRetry: source.retry }) ?? null;
}

function LoadedVideoEditor(props: Readonly<{
    held: CaptureWindowCapture;
    capture: NativeCaptureResult;
    document: RecordingDocument;
    display: NativeCaptureWindowDisplay;
    media: RecordingMediaAccess;
    onClose: () => void;
    source: ReturnType<typeof useRecordingMedia>;
    renderStatus?: (state: RecordingEditorStatus) => React.ReactNode;
}>) {
    const { held, capture, document, display, media } = props;
    const scale = capture.scale ?? 1;
    const picture = React.useMemo(() => ({ width: capture.pixelSize.width / scale, height: capture.pixelSize.height / scale }), [capture.pixelSize, scale]);
    const editor = useRecordingEditor({ document, commitDocument: held.commitRecordingDocument, media, scale });
    const { authoring } = editor;
    const failed = props.source.status === 'failed' || editor.status === 'failed';
    const onRetry = props.source.status === 'failed' ? props.source.retry : editor.retry;
    const surface = useRecordingSurface(editor, {
        media, aspectRatio: picture.width / picture.height, appName: capture.source?.appName ?? null,
        agentName: null, byteSize: capture.byteSize, mediaFailure: failed ? { onRetry } : null,
    });
    const [defaultIncluded] = React.useState(() => loadLocalSettings().screenCaptureIncludeWindowText);
    const dispatchText = (event: CaptureDisclosureEvent) => {
        if (event.type === 'toggle') void authoring.setWindowTextIncluded(event.included);
        else if (event.type === 'warning') void authoring.resolveWindowTextWarning(event.include);
        else if (event.type === 'input') void authoring.onInput();
    };
    const text = useCaptureWindowText({ captureRef: capture.captureRef, defaultIncluded,
        signal: held.signal ?? undefined,
        controlled: { disclosure: editor.effective.windowTextDisclosure, dispatch: dispatchText } });
    const { annotator, frameSession } = surface;
    const { frameSource } = editor;
    if (!annotator || !frameSource) {
        return <>{frameSession}{props.renderStatus?.({ status: failed ? 'failed' : 'loading', onRetry }) ?? null}</>;
    }
    const shellMedia: CaptureEditorMedia = {
        annotator, picture, text, renderPicture: surface.renderPicture, canvasHidden: surface.canvasHidden,
        belowPicture: surface.belowPicture, notice: surface.notice, noteChips: surface.noteChips,
        caption: surface.caption, discardedTitle: surface.discardedTitle,
        note: editor.draft.text, onNoteChange: editor.onNoteChange, hasWork: editor.hasWork,
        thumbnailUri: frameSource.uri,
        prepare: async () => {
            let cause = t('screenCapture.recording.commitFailed');
            try {
                const { note } = await editor.prepareDelivery(async controls => {
                    cause = t('screenCapture.window.flattenFailed');
                    const prepared = await prepareNativeRecordingDelivery({ result: capture }, { controls, signal: held.signal ?? undefined });
                    if ('ok' in prepared) throw new Error(prepared.errorCode);
                });
                return { ok: true, note };
            } catch {
                return { ok: false, cause };
            }
        },
        copyFrameAtMs: editor.frame!.sourceTimeMs,
        prepareCopy: async () => { await editor.session?.flush(); },
        more: editor.effective.trim.startMs !== 0 || editor.effective.trim.endMs !== editor.effective.durationMs
            ? { onResetTrim: () => { void authoring.commit([{ kind: 'trim.reset' }]); } } : {},
    };
    return (
        <>
            {frameSession}
            <CaptureEditorShell held={held} capture={capture} media={shellMedia} display={display} onClose={props.onClose} />
        </>
    );
}
