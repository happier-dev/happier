import * as React from 'react';
import { isEmptyEdit, type ImageMarksDocumentV1 } from '@happier-dev/protocol/sessions/media/imageMarksV1';
import { NativeCaptureError, cancelNativeCapture, commitNativeCapture, readCaptureSourcePng, retryNativeCapture, subscribeNativeCapture,
    loadNativeRecordingDocument, readNativeCaptureErrorCode, writePreparedCapturePng, type NativeCaptureResult, type NativePreparedPng,
    type NativeCaptureErrorCode, type NativeCaptureSnapshot, type NativeCaptureSessionTarget,
    type NativeRecordingSnapshot, type NativeCaptureDisclosure } from '@/desktop/capture/nativeCapture';
import type { ImageAnnotationSource } from '@/components/ui/media/annotation/types';
import { flattenAnnotatedImage } from '@/components/ui/media/annotation/flattenImage';
import { announceCaptureWindowReady, subscribeCaptureWindowLifecycle } from '@/desktop/capture/captureWindowHost';
import { executeDesktopWindowActionWithResult } from '@/utils/platform/desktopWindowActionBridge';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { playCaptureSound } from '@/sync/ops/actions/playBundledSound';
import { t } from '@/text';
import type { RecordingDocument, RecordingOperation } from '../recording/recordingDocument';
import type { CaptureDefaultReason } from '../main/resolveCaptureDefaultTarget';
import type { CaptureOpenResult } from '@/sync/ops/actions/screenCaptureActions';

export type CapturePreparationResult = Readonly<{ ok: true; prepared: NativePreparedPng; png: Uint8Array }>
    | Readonly<{ ok: false; errorCode: NativeCaptureErrorCode | 'canvasUnavailable' | 'decodeFailed' }>;

export type CaptureWindowCapture = Readonly<{
    active: boolean;
    signal: AbortSignal | null;
    capture: NativeCaptureResult | null;
    targetSession: NativeCaptureSessionTarget | null;
    defaultReason?: CaptureDefaultReason;
    source: ImageAnnotationSource | null;
    recording: Readonly<{ operationRef: number; snapshot: NativeRecordingSnapshot; origin: NativeCaptureResult['origin'] }> | null;
    systemSelection: Extract<NativeCaptureSnapshot, { status: 'system_selection' }> | null;
    continueSystemSelection: () => Promise<void>;
    cancelSystemSelection: () => Promise<void>;
    recordingDocument: RecordingDocument | null;
    commitRecordingDocument: (document: RecordingDocument, previous: RecordingDocument, operations: readonly RecordingOperation[]) => Promise<void>;
    status: 'empty' | 'loading' | 'ready' | 'recording' | 'system_selection' | 'failed';
    errorCode: NativeCaptureErrorCode | null;
    failureReason: string | null;
    retry: () => Promise<void>;
    prepare: (document: ImageMarksDocumentV1, disclosure: Pick<NativeCaptureDisclosure, 'includeWindowText'>) => Promise<CapturePreparationResult>;
    onOpenStart: () => void;
}>;

type SourceState = Readonly<{ captureRef: string; source: ImageAnnotationSource }>
    | Readonly<{ captureRef: string; errorCode: NativeCaptureErrorCode }>;
type RecordingDocumentState = Readonly<{ captureRef: string; document: RecordingDocument | null; errorCode: NativeCaptureErrorCode | null }>;

function readNativeFailure(error: unknown): NativeCaptureErrorCode {
    return error instanceof NativeCaptureError ? error.code : 'native_failure';
}

function recordingFailureReason(code: NativeCaptureErrorCode | null): string | null {
    switch (code) {
        case 'pipewire_unavailable': return t('screenCapture.recording.pipewireUnavailable');
        case 'video_encoder_unavailable': return t('screenCapture.recording.videoEncoderUnavailable');
        case 'video_muxer_unavailable': return t('screenCapture.recording.videoMuxerUnavailable');
        case 'video_decoder_unavailable': return t('screenCapture.recording.videoDecoderUnavailable');
        case 'cursor_unavailable': return t('screenCapture.recording.cursorUnavailable');
        case 'video_pipeline_unavailable': return t('screenCapture.recording.videoPipelineUnavailable');
        default: return null;
    }
}

/** The native pending operation is the sole capture authority; this host loads no Sync. */
export function useCaptureWindowCapture(): CaptureWindowCapture {
    const [signal, setSignal] = React.useState<AbortSignal | null>(null);
    const active = signal !== null;
    const [snapshot, setSnapshot] = React.useState<NativeCaptureSnapshot>({ status: 'idle' });
    const [loaded, setLoaded] = React.useState<SourceState | null>(null);
    const [defaultSelection, setDefaultSelection] = React.useState<Readonly<{
        captureRef: string; targetSession: NativeCaptureSessionTarget; reason: CaptureDefaultReason;
    }> | null>(null);
    const [recordingState, setRecordingState] = React.useState<RecordingDocumentState | null>(null);
    const [sourceReadAttempt, retrySourceRead] = React.useReducer((attempt: number) => attempt + 1, 0);
    const currentVideoRef = React.useRef<string | null>(null);
    const mounted = React.useRef(false);
    const presentation = React.useRef(false);
    const controller = React.useRef<AbortController | null>(null);
    const sourceUrl = React.useRef<string | undefined>(undefined);
    React.useEffect(() => {
        mounted.current = true;
        let stopWake: (() => void) | undefined;
        let stopState: (() => void) | undefined;
        const deactivate = () => {
            controller.current?.abort();
            controller.current = null;
            stopState?.();
            stopState = undefined;
            presentation.current = false;
            currentVideoRef.current = null;
            if (mounted.current) setSignal(null);
        };
        const activate = () => {
            if (!mounted.current || stopState) return;
            const view = new AbortController();
            controller.current = view;
            let current = true;
            let dispose: (() => void) | undefined;
            let retireDocumentRead = () => {};
            stopState = () => { current = false; retireDocumentRead(); dispose?.(); };
            void subscribeNativeCapture(next => {
                if (!current || !mounted.current) return;
                presentation.current = true;
                setSignal(view.signal);
                retireDocumentRead();
                setSnapshot(next);
                const captureRef = next.status === 'completed' && next.result.kind === 'video' ? next.result.captureRef : null;
                currentVideoRef.current = captureRef;
                if (!captureRef) { setRecordingState(null); return; }
                let reading = true;
                retireDocumentRead = () => { reading = false; };
                setRecordingState(previous => previous?.captureRef === captureRef ? previous
                    : { captureRef, document: null, errorCode: null });
                // Metadata pushes refresh only an actively presented recording.
                void loadNativeRecordingDocument(captureRef).then(document => {
                    if (current && reading && !view.signal.aborted) setRecordingState({ captureRef, document, errorCode: null });
                }).catch(error => {
                    if (current && reading && !view.signal.aborted) setRecordingState(previous => ({ captureRef,
                        document: previous?.captureRef === captureRef ? previous.document : null, errorCode: readNativeFailure(error) }));
                });
            }).then(async stop => {
                if (!current) { stop(); return; }
                dispose = stop;
                // Native replay cannot race ahead of the state subscription.
                if (await announceCaptureWindowReady('state') === false && current) deactivate();
            }).catch(error => {
                if (current) {
                    presentation.current = true;
                    setSignal(view.signal);
                    setSnapshot({ status: 'failed', reason: readNativeFailure(error) });
                }
            });
        };
        void subscribeCaptureWindowLifecycle(lifecycle => {
            if (lifecycle === 'start') activate();
            else deactivate();
        }).then(async stop => {
            if (!mounted.current) { stop(); return; }
            stopWake = stop;
            // Recover a first-use start published before this webview finished booting.
            await announceCaptureWindowReady('wake');
        }).catch(error => {
            if (mounted.current) setSnapshot({ status: 'failed', reason: readNativeFailure(error) });
        });
        return () => {
            mounted.current = false;
            deactivate();
            stopWake?.();
            if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
        };
    }, []);

    const capture = snapshot.status === 'completed' ? snapshot.result : null;
    const soundedCapture = React.useRef<string | null>(null);
    const completedCaptureRef = capture?.captureRef;
    const onOpenStart = React.useCallback(() => {
        if (!presentation.current || !completedCaptureRef || soundedCapture.current === completedCaptureRef) return;
        soundedCapture.current = completedCaptureRef;
        void playCaptureSound(loadLocalSettings().screenCaptureSound);
    }, [completedCaptureRef]);
    const unpinnedCaptureRef = snapshot.status === 'completed' && !snapshot.targetSession ? snapshot.result.captureRef : null;
    React.useEffect(() => {
        if (!active || !unpinnedCaptureRef) return;
        // Main chooses once through the Action owner; native open replays its pinned snapshot.
        void executeDesktopWindowActionWithResult({ windowLabel: 'capture', actionIdentifier: 'screenCapture.open',
            data: { captureRef: unpinnedCaptureRef } }, { signal: signal ?? undefined }).then(result => {
                // Both ends consume the native-label-checked Action owner's typed result.
                const opened = result.ok ? result.result as CaptureOpenResult : null;
                if (!signal?.aborted && opened?.defaultReason && opened.targetSession) {
                    setDefaultSelection({ captureRef: unpinnedCaptureRef,
                        targetSession: opened.targetSession, reason: opened.defaultReason });
                }
            });
    }, [active, signal, unpinnedCaptureRef]);
    const captureRef = capture?.kind === 'still' ? capture.captureRef : null;
    const width = capture?.pixelSize.width;
    const height = capture?.pixelSize.height;
    const scale = capture?.scale ?? 1;
    React.useEffect(() => {
        if (!active || !captureRef || width === undefined || height === undefined
            || (loaded?.captureRef === captureRef && 'source' in loaded)) return;
        let reading = true;
        void readCaptureSourcePng(captureRef).then(bytes => {
            if (!reading || signal?.aborted) return;
            // The native adapter creates a fresh ArrayBuffer-backed Uint8Array.
            const uri = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
            if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
            sourceUrl.current = uri;
            setLoaded({ captureRef, source: { uri, width, height, scale } });
        }).catch(error => { if (reading && !signal?.aborted) setLoaded({ captureRef, errorCode: readNativeFailure(error) }); });
        return () => { reading = false; };
    }, [active, signal, captureRef, width, height, scale, sourceReadAttempt]);

    const current = loaded?.captureRef === captureRef ? loaded : null;
    const source = current && 'source' in current ? current.source : null;
    const currentRecording = recordingState?.captureRef === (capture?.kind === 'video' ? capture.captureRef : null) ? recordingState : null;
    const recordingDocument = currentRecording?.document ?? null;
    const errorCode = snapshot.status === 'failed' || snapshot.status === 'unavailable' ? snapshot.reason
        : snapshot.status === 'recording' ? snapshot.recording.error
        : current && 'errorCode' in current ? current.errorCode : currentRecording?.errorCode ?? null;
    const retry = async (): Promise<void> => {
        const view = controller.current?.signal;
        if (!view || view.aborted) return;
        try {
            // Native decides whether recovery means adoption, review or another
            // requested start, preserving mode/target at the operation owner.
            await retryNativeCapture();
            if (!view.aborted && captureRef) retrySourceRead();
        } catch (error) {
            if (!view.aborted) setSnapshot({ status: 'failed', reason: readNativeFailure(error) });
        }
    };
    const systemSelection = snapshot.status === 'system_selection' ? snapshot : null;
    const continueSystemSelection = async (): Promise<void> => {
        const view = controller.current?.signal;
        if (!systemSelection || !view || view.aborted) return;
        try { await commitNativeCapture(systemSelection.operationRef); }
        catch (error) { if (!view.aborted) setSnapshot({ status: 'failed', reason: readNativeFailure(error) }); }
    };
    const cancelSystemSelection = async (): Promise<void> => {
        const view = controller.current?.signal;
        if (!systemSelection || !view || view.aborted) return;
        try { await cancelNativeCapture(systemSelection.operationRef); }
        catch (error) { if (!view.aborted) setSnapshot({ status: 'failed', reason: readNativeFailure(error) }); }
    };
    const commitRecordingDocument = React.useCallback(async (_document: RecordingDocument, _previous: RecordingDocument,
        operations: readonly RecordingOperation[]): Promise<void> => {
        const captureRef = currentVideoRef.current;
        const view = controller.current?.signal;
        if (!captureRef || !view || view.aborted) throw new NativeCaptureError('operation_unavailable');
        try {
            // Keep metadata edits batched; P2 owns each frame's marks and history cause.
            let index = 0;
            while (index < operations.length) {
                const operation = operations[index]!;
                let actionIdentifier: string;
                let data: Record<string, unknown>;
                if (operation.kind === 'frame.document') {
                    actionIdentifier = 'media.annotation.apply';
                    data = { target: { kind: 'recordingFrame', captureRef, sourceTimeMs: operation.sourceTimeMs },
                        operations: [{ kind: 'reset' }, ...operation.document.marks.map(mark => ({ kind: 'mark.add', mark }))],
                        cause: operation.cause };
                    index += 1;
                } else {
                    const batch: Exclude<RecordingOperation, { kind: 'frame.document' }>[] = [];
                    while (index < operations.length) {
                        const next = operations[index]!;
                        if (next.kind === 'frame.document') break;
                        batch.push(next); index += 1;
                    }
                    actionIdentifier = 'screenCapture.recording.edit';
                    data = { captureRef, operations: batch };
                }
                const result = await executeDesktopWindowActionWithResult({ windowLabel: 'capture', actionIdentifier, data }, { signal: view });
                if (!result.ok) throw new NativeCaptureError(readNativeCaptureErrorCode(result.errorCode));
                if (result.result && typeof result.result === 'object' && 'status' in result.result
                    && result.result.status === 'unavailable') throw new NativeCaptureError('operation_unavailable');
            }
            if (!view.aborted && currentVideoRef.current === captureRef) {
                setRecordingState(previous => previous?.captureRef === captureRef && previous.errorCode
                    ? { ...previous, errorCode: null } : previous);
            }
        } catch (error) {
            if (!view.aborted && currentVideoRef.current === captureRef) setRecordingState(previous => ({ captureRef,
                document: previous?.captureRef === captureRef ? previous.document : null, errorCode: readNativeFailure(error) }));
            throw error;
        }
    }, []);
    const prepare = async (document: ImageMarksDocumentV1, disclosure: Pick<NativeCaptureDisclosure, 'includeWindowText'>): Promise<CapturePreparationResult> => {
        const view = controller.current?.signal;
        if (!view || view.aborted || !captureRef || !source) return { ok: false, errorCode: 'operation_unavailable' };
        const flattened = await flattenAnnotatedImage(source, document);
        if (view.aborted) return { ok: false, errorCode: 'operation_unavailable' };
        if (!flattened.ok) return { ok: false, errorCode: flattened.reason };
        try {
            const prepared = await writePreparedCapturePng(captureRef, flattened.png,
                { hasMarks: !isEmptyEdit(document), includeWindowText: disclosure.includeWindowText });
            return view.aborted ? { ok: false, errorCode: 'operation_unavailable' }
                : { ok: true, prepared, png: flattened.png };
        } catch (error) {
            return { ok: false, errorCode: readNativeFailure(error) };
        }
    };
    return { active, signal, capture, targetSession: snapshot.status === 'completed' ? snapshot.targetSession ?? null : null,
        ...(snapshot.status === 'completed' && defaultSelection?.captureRef === snapshot.result.captureRef
            && snapshot.targetSession?.serverId === defaultSelection.targetSession.serverId
            && snapshot.targetSession?.accountId === defaultSelection.targetSession.accountId
            && snapshot.targetSession?.sessionId === defaultSelection.targetSession.sessionId
            ? { defaultReason: defaultSelection.reason } : {}),
        systemSelection, continueSystemSelection, cancelSystemSelection,
        recordingDocument, commitRecordingDocument,
        recording: snapshot.status === 'recording' ? { operationRef: snapshot.operationRef, snapshot: snapshot.recording, origin: snapshot.origin ?? null } : null,
        source, errorCode, failureReason: recordingFailureReason(errorCode), retry, prepare, onOpenStart,
        status: errorCode ? 'failed' : snapshot.status === 'system_selection' ? 'system_selection' : snapshot.status === 'recording' ? 'recording'
        : source || recordingDocument ? 'ready' : capture ? 'loading' : 'empty' };
}
