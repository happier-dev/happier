import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useDesktopOverlayTransparentDocumentBackground } from '@/activity/adapters/desktop/ui/useDesktopOverlayTransparentDocumentBackground';
import { showRecentCapturePicker } from '@/components/screenCapture/recent/RecentCaptureModal';
import { isEmptyEdit, useImageAnnotator, useImageAnnotatorState } from '@/components/ui/media/annotation';
import { hideCaptureWindow, presentCaptureWindow, setCaptureWindowFloating } from '@/desktop/capture/captureWindowHost';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import {
    requestNativeCapturePermission,
    relaunchForCapturePermission,
    subscribeNativeCapturePermissions,
    type NativeCapturePermissions,
    readNativeCaptureDisplayFacts,
    readNativeCaptureShortcuts,
    type NativeCaptureWindowDisplay,
    type NativeCaptureResult,
} from '@/desktop/capture/nativeCapture';
import { t } from '@/text';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { formatKeybindingLabel, parseKeybindingRule } from '@/keyboard/bindings';
import { resolveKeyboardPlatform } from '@/keyboard/runtime';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';

import { RecordingControlWindow } from '../recording/RecordingControlWindow';
import { VideoCaptureEditor } from '../recording/VideoCaptureEditor';
import { CaptureEditorShell, openRecentInCaptureWindow, workAreaOf, type CaptureEditorMedia } from './CaptureEditorShell';
import { CaptureWindowKeyboard } from './CaptureWindowKeyboard';
import { CaptureWindowStates, CAPTURE_STATE_WINDOW_WIDTH } from './CaptureWindowStates';
import { useAppBundleDragAvailable } from '@/components/systemPermissions/SystemPermissionDragTile';
import type { CaptureRect } from './resolveCaptureWindowFrame';
import { useCaptureWindowActions } from './useCaptureWindowActions';
import { useCaptureWindowCapture, type CaptureWindowCapture } from './useCaptureWindowCapture';
import { useCaptureWindowText } from './useCaptureWindowText';
import { useCaptureAnnotationActions } from './useCaptureAnnotationActions';
import { usePreparedCaptureThumbnail } from './usePreparedCaptureThumbnail';

type LoadedCapture = Readonly<{ capture: NativeCaptureResult; source: NonNullable<CaptureWindowCapture['source']> }>;


/** `/desktop/capture`: binds the screen to P1's capture and the main renderer's delivery Actions. */
export const CaptureWindowRoute = React.memo(function CaptureWindowRoute() {
    useDesktopOverlayTransparentDocumentBackground(true);
    const held = useCaptureWindowCapture();
    return <React.Activity mode={held.active ? 'visible' : 'hidden'}><ActiveCaptureWindowRoute held={held} /></React.Activity>;
});

function ActiveCaptureWindowRoute({ held }: Readonly<{ held: CaptureWindowCapture }>) {
    const actions = useCaptureWindowActions(held.signal ?? undefined);
    const [closed, setClosed] = React.useState<string | null>(null);
    const [discardedRecording, setDiscardedRecording] = React.useState(false);
    const [displays, setDisplays] = React.useState<readonly NativeCaptureWindowDisplay[]>([]);
    const [shortcutLabel, setShortcutLabel] = React.useState<string | undefined>();
    React.useEffect(() => { setClosed(null); }, [held.signal]);
    const needsDisplays = held.status !== 'empty';
    const needsPermission = held.errorCode === 'screen_permission_required';
    React.useEffect(() => {
        let active = true;
        if (needsDisplays) void readNativeCaptureDisplayFacts().then(next => { if (active && !held.signal?.aborted) setDisplays(next); });
        return () => { active = false; };
    }, [needsDisplays, held.signal]);
    React.useEffect(() => {
        if (!needsPermission) { setShortcutLabel(undefined); return; }
        let active = true;
        void readNativeCaptureShortcuts().then(snapshot => {
            const binding = snapshot.bindings.find(({ key }) => key === 'captureShortcut')?.active;
            if (active && !held.signal?.aborted) setShortcutLabel(binding ? formatKeybindingLabel(parseKeybindingRule(binding), resolveKeyboardPlatform()) : undefined);
        }).catch(() => { if (active && !held.signal?.aborted) setShortcutLabel(undefined); });
        return () => { active = false; };
    }, [needsPermission, held.signal]);
    // The line swaps on the grant event; nothing starts a capture by itself (MIS §5).
    const [screenPermission, setScreenPermission] = React.useState<NativeCapturePermissions['screen'] | null>(null);
    React.useEffect(() => {
        if (!needsPermission) return;
        let active = true;
        let stop: (() => void) | undefined;
        void subscribeNativeCapturePermissions((snapshot) => { if (active && !held.signal?.aborted) setScreenPermission(snapshot.screen); }, held.signal ?? undefined)
            .then((unsubscribe) => { if (active) stop = unsubscribe; else unsubscribe(); })
            .catch(() => undefined);
        return () => { active = false; stop?.(); };
    }, [needsPermission, held.signal]);
    const draggable = useAppBundleDragAvailable(needsPermission);
    const close = React.useCallback((captureRef: string | null) => {
        setClosed(captureRef);
        void hideCaptureWindow();
    }, []);
    const { capture, source, recording } = held;
    const origin = capture?.origin ?? recording?.origin ?? null;
    const display = displays.find(({ displayId }) => displayId === origin?.displayId) ?? displays[0];
    const presentControl = React.useCallback((frame: CaptureRect, glassRadius: number) => { void presentCaptureWindow(frame, { activate: false, glassRadius }); }, []);
    const finishDiscard = React.useCallback(async () => {
        if (actions.state.status === 'pending') return;
        const captureRef = capture?.captureRef ?? recording?.snapshot.sourceRef;
        if (captureRef) {
            const result = await actions.discard(captureRef);
            if (!result.ok) return;
        }
        setDiscardedRecording(false);
        close(captureRef ?? null);
    }, [actions, capture?.captureRef, close, recording?.snapshot.sourceRef]);
    if (!display) return null;
    if (actions.state.status === 'settled' && !actions.state.result.ok) {
        const failure = actions.state.result;
        return <BlockedWindow display={display}
            state={{ kind: 'failed', recording: recording !== null, diagnostic: failure.errorCode ?? null,
                ...(failure.error ? { reason: failure.error } : {}), onTryAgain: () => {
                    if (actions.retry() === null) void finishDiscard();
                } }}
            onClose={() => void finishDiscard()} />;
    }
    if (discardedRecording || (recording && held.status === 'recording')) {
        const workArea = workAreaOf(display);
        const area = origin
            ? { ...origin.rect, x: display.frame.x + origin.rect.x, y: display.frame.y + origin.rect.y }
            : null;
        return (
            <CaptureWindowKeyboard>
            <RecordingControlWindow
                snapshot={recording?.snapshot ?? null}
                area={area}
                workArea={workArea}
                discarded={discardedRecording}
                onPresent={presentControl}
                onPause={() => { if (recording) void actions.pauseRecording(recording.operationRef); }}
                onResume={() => { if (recording) void actions.resumeRecording(recording.operationRef); }}
                onStop={() => { if (recording) void actions.stopRecording(recording.operationRef); }}
                onDiscard={() => {
                    if (!recording) return;
                    setDiscardedRecording(true);
                    void actions.stopRecording(recording.operationRef);
                }}
                onUndoDiscard={() => setDiscardedRecording(false)}
                onDiscardHoldEnded={finishDiscard}
                onClose={() => {
                    if (discardedRecording) void finishDiscard();
                    // Native hidden retires renderer demand. Changing editor-close state here
                    // would re-render the measured control and present it again before that event.
                    else void hideCaptureWindow();
                }}
            />
            </CaptureWindowKeyboard>
        );
    }
    if (capture && capture.captureRef !== closed && capture.kind === 'video' && held.recordingDocument) {
        return (
            <CaptureWindowKeyboard>
                <VideoCaptureEditor
                    key={capture.captureRef}
                    held={held}
                    capture={capture}
                    document={held.recordingDocument}
                    display={display}
                    onClose={() => setClosed(capture.captureRef)}
                    renderStatus={({ status, onRetry }) => (
                        <BlockedWindow
                            display={display}
                            state={status === 'loading'
                                ? { kind: 'loading', title: t('screenCapture.recording.openingTitle') }
                                : { kind: 'failed', recording: true, diagnostic: null,
                                    title: t('screenCapture.recording.openFailedTitle'),
                                    reason: t('screenCapture.recording.openFailedReason'), onTryAgain: onRetry }}
                            onClose={() => close(capture.captureRef)}
                        />
                    )}
                />
            </CaptureWindowKeyboard>
        );
    }
    if (capture && source && capture.captureRef !== closed) {
        return (
            <CaptureWindowKeyboard>
                <StillCaptureEditor
                    key={capture.captureRef}
                    held={held}
                    loaded={{ capture, source }}
                    display={display}
                    onClose={() => setClosed(capture.captureRef)}
                />
            </CaptureWindowKeyboard>
        );
    }
    if (needsPermission) {
        return (
            <BlockedWindow
                display={display}
                state={{ kind: 'permission', shortcutLabel,
                    progress: screenPermission === 'granted' ? 'allowed' : screenPermission === 'restart_required' ? 'reopen' : 'waiting',
                    ...(draggable ? { drag: {} } : {}),
                    onOpenSettings: async () => {
                        await setCaptureWindowFloating(false);
                        if (!held.signal?.aborted) await requestNativeCapturePermission('screen');
                    },
                    onReopen: () => void relaunchForCapturePermission(),
                    onNotNow: () => close(null) }}
                onClose={() => close(null)}
            />
        );
    }
    if (held.systemSelection) {
        const cancel = () => { void held.cancelSystemSelection(); close(null); };
        return (
            <BlockedWindow
                display={display}
                state={{ kind: 'systemSelection', onContinue: () => void held.continueSystemSelection(), onCancel: cancel }}
                onClose={cancel}
            />
        );
    }
    if (held.status === 'failed') {
        const partial = recording?.snapshot.sourceRef ?? null;
        return (
            <BlockedWindow
                display={display}
                state={{ kind: 'failed', recording: recording !== null, diagnostic: held.errorCode, ...(held.failureReason ? { reason: held.failureReason } : {}),
                    onTryAgain: () => void held.retry(),
                    onAttachRecent: () => showRecentCapturePicker((entry) => openRecentInCaptureWindow(entry, held.targetSession, { signal: held.signal ?? undefined })),
                    ...(partial ? { onDiscard: finishDiscard } : {}) }}
                onClose={() => close(null)}
            />
        );
    }
    return null;
}

function BlockedWindow(props: React.ComponentProps<typeof CaptureWindowStates> & Readonly<{ display: NativeCaptureWindowDisplay }>) {
    const { display, ...state } = props;
    const { theme } = useUnistyles();
    const dragProps = useDesktopWindowDragMouseProps();
    useEscapeLayer({ priority: ESCAPE_LAYER_PRIORITIES.overlay, allowEditableTarget: true,
        onEscape: () => { props.onClose(); return true; } });
    // The window takes the state's own height, centred on the display it serves (MIS §2.2).
    const onLayout = (event: LayoutChangeEvent) => {
        const area = workAreaOf(display);
        const { height } = event.nativeEvent.layout;
        void presentCaptureWindow({
            x: area.x + (area.width - CAPTURE_STATE_WINDOW_WIDTH) / 2,
            y: area.y + (area.height - height) / 2,
            width: CAPTURE_STATE_WINDOW_WIDTH,
            height,
        }, { glassRadius: theme.borderRadius.xxl });
    };
    return (
        <View style={styles.blocked} onLayout={onLayout} {...dragProps} testID="capture-window-blocked-chrome">
            {/* The window's own material over the desktop, as the editor's card. */}
            <GlassSurface surfaceGroup="content" finishRole={null} style={StyleSheet.absoluteFillObject} children={null} />
            <CaptureWindowStates {...state} />
        </View>
    );
}

/** A still: the picture itself, flat on the paper, with its marks and its one note. */
function StillCaptureEditor(props: Readonly<{
    held: CaptureWindowCapture;
    loaded: LoadedCapture;
    display: NativeCaptureWindowDisplay;
    onClose: () => void;
}>) {
    const { held, display } = props;
    const { capture, source } = props.loaded;
    const picture = React.useMemo(() => ({ width: source.width / source.scale, height: source.height / source.scale }), [source]);
    const [defaultIncluded] = React.useState(() => loadLocalSettings().screenCaptureIncludeWindowText);
    const text = useCaptureWindowText({ captureRef: capture.captureRef, defaultIncluded, signal: held.signal ?? undefined });
    const annotator = useImageAnnotator({ source, onDocumentChange: text.onDocumentChange });
    useCaptureAnnotationActions(capture.captureRef, annotator, held.signal ?? undefined);
    const [note, setNote] = React.useState('');
    const { thumbnailUri, setPreparedPng } = usePreparedCaptureThumbnail();
    const edited = useImageAnnotatorState(annotator, (state) => !isEmptyEdit(state.document));
    const media: CaptureEditorMedia = {
        annotator, picture, pictureUri: source.uri, text, note, onNoteChange: setNote, thumbnailUri,
        hasWork: note.length > 0 || edited,
        caption: {
            icon: 'browsers',
            lead: capture.source?.appName ?? null,
            facts: [capture.source?.windowTitle, `${Math.round(picture.width)} × ${Math.round(picture.height)}`, t('screenCapture.window.justNow')]
                .filter((fact): fact is string => Boolean(fact)),
        },
        prepare: async () => {
            const disclosure = await text.prepareDisclosure();
            if (held.signal?.aborted) return { ok: false, cause: t('screenCapture.window.flattenFailed') };
            const prepared = await held.prepare(annotator.store.getState().document, disclosure);
            if (!prepared.ok || held.signal?.aborted) return { ok: false, cause: t('screenCapture.window.flattenFailed') };
            setPreparedPng(prepared.png);
            return { ok: true, note };
        },
        prepareCopy: async () => {
            const prepared = await held.prepare(annotator.store.getState().document, { includeWindowText: text.disclosure.included });
            if (!prepared.ok) return { ok: false, errorCode: prepared.errorCode, error: prepared.errorCode };
        },
    };
    return <CaptureEditorShell held={held} capture={capture} media={media} display={display} onClose={props.onClose} />;
}

const styles = StyleSheet.create((theme) => ({
    blocked: {
        borderRadius: theme.borderRadius.xxl,
        boxShadow: theme.colors.glass.castShadow,
        overflow: 'hidden',
    },
}));
