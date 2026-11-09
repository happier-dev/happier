import * as React from 'react';
import { Image, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { HeldVideoPlayer } from '@/components/workspaces/files/file/HeldVideoPlayer';
import { withVideoFrameSource, type MediaPlayerVideoControls } from '@/components/workspaces/files/file/videoFrameAccess';
import type { NativeRecordingSnapshot } from '@/desktop/capture/nativeCapture';
import { t } from '@/text';

import { RecordingAreaMarks } from '../recording/RecordingAreaMarks';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { RecordingControlBar, RECORDING_CONTROL_HEIGHT } from '../recording/RecordingControlBar';
import { createRecordingDocument, reduceRecordingDocument, type RecordingDocument } from '../recording/recordingDocument';
import { resolveRecordingControlPlace } from '../recording/recordingEditorProjection';
import { useRecordingEditor, type RecordingMediaAccess } from '../recording/useRecordingEditor';
import { useRecordingSurface } from '../recording/useRecordingSurface';
import { createCaptureDisclosureState } from '../disclosure/captureDisclosureRule';
import { CaptureDeliveryPill } from '../window/CaptureDeliveryPill';
import { CaptureWindowTextChip } from '../window/CaptureWindowTextChip';
import { resolveCaptureWindowTextView } from '../window/captureWindowTextView';
import { CaptureWindowScreen, type CaptureWindowMeasure } from '../window/CaptureWindowScreen';
import { resolveCaptureWindowFrame, type CaptureRect } from '../window/resolveCaptureWindowFrame';
import { RecentCaptureGridView, type RecentCaptureThumbnailReader } from '../recent/RecentCaptureGrid';
import { CHECKOUT_FULL, CHOOSER_ROWS, TERMINAL_URI } from './screenCaptureFixtures';

const DURATION_MS = 42_000;

const FRAME_MARKS: ImageMarksDocumentV1 = {
    v: 1,
    image: { width: 1440, height: 900, scale: 1 },
    marks: [
        { id: 'arrow', kind: 'arrow', color: 'orange', size: 'm', from: { x: 1120, y: 760 }, to: { x: 1250, y: 690 } },
        { id: 'step', kind: 'step', color: 'orange', size: 'm', at: { x: 1400, y: 690 } },
    ],
};

function seedDocument(): RecordingDocument {
    const operations = [
        { kind: 'trim.set', startMs: 4_000, endMs: 38_000 },
        { kind: 'note.set', id: 'time:11000', sourceTimeMs: 11_000, text: 'the total jumps when SPRING10 applies, then' },
        { kind: 'note.set', id: 'time:18000', sourceTimeMs: 18_000, text: 'Pay slides over the card edge.' },
        { kind: 'frame.document', sourceTimeMs: 18_000, document: FRAME_MARKS, cause: 'edit' },
    ] as const;
    return operations.reduce(reduceRecordingDocument, createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'specimen', durationMs: DURATION_MS, includeWindowText: false }));
}

/** A clock and a still stand in for the movie: the composition is what this scene judges. */
function createSpecimenMedia(): RecordingMediaAccess {
    let timeSeconds = 18;
    let startedAt: number | null = null;
    const listeners = new Set<(playing: boolean) => void>();
    const readTime = () => startedAt === null ? timeSeconds : timeSeconds + (Date.now() - startedAt) / 1000;
    const set = (playing: boolean) => {
        timeSeconds = readTime();
        startedAt = playing ? Date.now() : null;
        for (const listener of listeners) listener(playing);
    };
    const controls: MediaPlayerVideoControls = {
        seekTo: (next) => { timeSeconds = next; if (startedAt !== null) startedAt = Date.now(); },
        readFrame: async (options = {}) => ({ uri: CHECKOUT_FULL.uri, width: CHECKOUT_FULL.width, height: CHECKOUT_FULL.height, timeSeconds: options.timeSeconds ?? timeSeconds }),
        playback: {
            play: () => set(true),
            pause: () => set(false),
            readTime,
            subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        },
    };
    return {
        renderPlayer: (onControls) => <SpecimenPlayer controls={controls} onControls={onControls} />,
        withFrames: (operation) => operation(controls),
    };
}

function SpecimenPlayer(props: Readonly<{ controls: MediaPlayerVideoControls; onControls: (controls: MediaPlayerVideoControls | null) => void }>) {
    const { controls, onControls } = props;
    React.useEffect(() => { onControls(controls); return () => onControls(null); }, [controls, onControls]);
    return <Image source={{ uri: CHECKOUT_FULL.uri }} style={StyleSheet.absoluteFill} resizeMode="stretch" />;
}

/** `rc-ed&real=1`: a short true WebM through the held player and the finite frame decoder. */
const REAL_CLIP_MS = 2_400;
async function recordRealClip(): Promise<string> {
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 450;
    const context = canvas.getContext('2d')!;
    const recorder = new MediaRecorder(canvas.captureStream(24), { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.start();
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
        const draw = () => {
            const progress = (performance.now() - startedAt) / REAL_CLIP_MS;
            context.fillStyle = '#FBFAF7';
            context.fillRect(0, 0, 720, 450);
            context.fillStyle = '#FF9500';
            context.fillRect(40 + progress * 560, 180, 90, 90);
            if (progress < 1) requestAnimationFrame(draw); else resolve();
        };
        draw();
    });
    recorder.stop();
    await stopped;
    return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
}

function useRealMedia(enabled: boolean): RecordingMediaAccess | null {
    const [uri, setUri] = React.useState<string | null>(null);
    React.useEffect(() => { if (enabled) void recordRealClip().then(setUri); }, [enabled]);
    return React.useMemo(() => uri ? {
        renderPlayer: (onControls) => <HeldVideoPlayer uri={uri} title="Clip" isActive chrome="none" onError={() => {}} onVideoControls={onControls} />,
        withFrames: (operation, signal) => withVideoFrameSource(uri, operation, signal),
    } : null, [uri]);
}

export function RealRecordingEditorScene(props: Readonly<{ workArea: CaptureRect }>) {
    const media = useRealMedia(true);
    const [document] = React.useState(() => createRecordingDocument({ frameDurationMs: 1000 / 24, sourceCaptureRef: 'real', durationMs: REAL_CLIP_MS, includeWindowText: false }));
    return media ? <RecordingEditorScene workArea={props.workArea} area={null} media={media} document={document} initialTimeMs={0} /> : null;
}

const noCommit = async () => {};
const readNoPage = async () => ({ rows: CHOOSER_ROWS, total: CHOOSER_ROWS.length });

/** `rc-ed`: the Capture window on a video, through the same hooks and timeline as the route. */
export function RecordingEditorScene(props: Readonly<{
    workArea: CaptureRect;
    area: CaptureRect | null;
    media?: RecordingMediaAccess;
    document?: RecordingDocument;
    initialTimeMs?: number;
    /** `rc-ed&phase=media-fail`: the open video stopped reading. */
    mediaFailed?: boolean;
}>) {
    const { theme } = useUnistyles();
    const [fallbackMedia] = React.useState(createSpecimenMedia);
    const [newSession, setNewSession] = React.useState(false);
    const media = props.media ?? fallbackMedia;
    const [document, setDocument] = React.useState(() => props.document ?? seedDocument());
    const commitDocument = React.useCallback(async (next: RecordingDocument) => { setDocument(next); await noCommit(); }, []);
    const editor = useRecordingEditor({ document, commitDocument, media, scale: 1, initialTimeMs: props.initialTimeMs ?? 18_000 });
    const surface = useRecordingSurface(editor, { media, aspectRatio: 1.6, appName: 'Safari', agentName: 'Claude', byteSize: 12_400_000,
        mediaFailure: props.mediaFailed ? { onRetry: () => {} } : null });
    const [measure, setMeasure] = React.useState<CaptureWindowMeasure | null>(null);
    const frame = React.useMemo(() => measure ? resolveCaptureWindowFrame({
        picture: CHECKOUT_FULL, origin: props.area, workArea: props.workArea, remembered: null,
        metrics: { gutter: theme.space.s24, screenInset: theme.space.s24, ...measure },
    }) : null, [measure, props.area, props.workArea, theme.space.s24]);
    if (!surface.annotator) return <>{surface.frameSession}</>;
    return (
        <>
            {surface.frameSession}
            <CaptureWindowScreen
                frame={frame}
                area={props.area}
                workArea={props.workArea}
                screenInset={theme.space.s24}
                onMeasure={setMeasure}
                annotator={surface.annotator}
                renderPicture={surface.renderPicture}
                canvasHidden={surface.canvasHidden}
                belowPicture={surface.belowPicture}
                notice={surface.notice}
                noteChips={surface.noteChips}
                discardedTitle={surface.discardedTitle}
                caption={surface.caption}
                target={newSession ? { kind: 'newSession', title: t('transcript.selection.sendTo.newSession'), machineName: '', mark: null }
                    : { title: 'Fix checkout total clipping', machineName: 'MacBook Pro', mark: <AgentIcon agentId="claude" size={14} /> }}
                chooser={{ readPage: readNoPage, selected: newSession ? null : CHOOSER_ROWS[0].address,
                    onSelect: () => setNewSession(false), onNewSession: () => setNewSession(true), canStartSession: true, newSessionContext: 'storefront · MacBook Pro' }}
                unreachable={null}
                renderWindowText={(windowTextSurface) => (
                    <CaptureWindowTextChip
                        view={resolveCaptureWindowTextView({
                            disclosure: createCaptureDisclosureState(false), read: { status: 'idle' }, appName: 'Safari',
                        })}
                        onToggle={() => {}}
                        surface={windowTextSurface}
                        onResolveBlurWarning={() => {}}
                        onOpenPermissionSettings={() => {}}
                        onDeclinePermission={() => {}}
                    />
                )}
                note={editor.draft.text}
                onNoteChange={editor.onNoteChange}
                onDeliver={async () => ({ ok: true, pill: { kind: 'sent', session: 'Fix checkout total clipping', detail: 'Claude · MacBook Pro' } })}
                onRetry={async () => ({ ok: false, cause: '' })}
                thumbnailUri={editor.frameSource?.uri ?? null}
                hasWork={editor.hasWork}
                onDiscard={() => {}}
                onUndoDiscard={() => {}}
                onClosed={() => {}}
                onCopy={() => {}}
                onShowInFolder={() => {}}
                more={{ onAttachRecent: () => {}, onOpenSettings: () => {} }}
            />
        </>
    );
}

const AREA: CaptureRect = { x: 486, y: 96, width: 472, height: 620 };
const WORK: CaptureRect = { x: 0, y: 30, width: 1440, height: 910 };
const PILL_WIDTH = 258;

/** `rc-bar`: the marks and the control over the desk, in each phase; `rc-bar&phase=paused` and so on. */
export function RecordingControlScene(props: Readonly<{ phase: NativeRecordingSnapshot['phase'] | 'discarded' }>) {
    const [paused, setPaused] = React.useState(props.phase === 'paused');
    const [anchor] = React.useState(() => Date.now() - 42_000);
    const { theme } = useUnistyles();
    const phase = props.phase === 'recording' || props.phase === 'paused' ? (paused ? 'paused' : 'recording') : props.phase;
    const place = resolveRecordingControlPlace({ area: AREA, pill: { width: PILL_WIDTH, height: RECORDING_CONTROL_HEIGHT }, workArea: WORK, gap: theme.space.s16 });
    return (
        <>
            {phase === 'finalizing' || phase === 'discarded' ? null : <RecordingAreaMarks area={AREA} />}
            <View style={[styles.place, { left: place.x, top: place.y }]}>
                {phase === 'discarded' ? (
                    <GlassLivePictureBackdropContext.Provider value>
                    <GlassPanel shadowLevel={2} innerShadow={false} radius={26} style={styles.discarded}>
                        <CaptureDeliveryPill state={{ kind: 'discarded', title: 'Recording discarded' }} thumbnailUri={null} onUndo={() => {}} />
                    </GlassPanel>
                    </GlassLivePictureBackdropContext.Provider>
                ) : (
                    <RecordingControlBar
                        snapshot={{
                            phase: phase === 'ready' || phase === 'failed' ? 'recording' : phase,
                            timing: phase === 'recording' ? { durationMs: 0, activeSinceMs: anchor } : { durationMs: 42_000, activeSinceMs: null },
                            sourceRef: null, result: null, error: null,
                        }}
                        onPause={() => setPaused(true)}
                        onResume={() => setPaused(false)}
                        onStop={() => {}}
                        onDiscard={() => {}}
                        onHide={() => {}}
                    />
                )}
            </View>
        </>
    );
}

const MINUTE = 60_000;
const recentEntry = (name: string, kind: 'still' | 'video', minutes: number) => ({
    path: `/Pictures/Happier/${name}`, name, kind, byteSize: 0, modifiedAt: Date.now() - minutes * MINUTE, modifiedAtNanos: null,
});
const RECENT_ENTRIES = [
    recentEntry('Screenshot 10.42', 'still', 2), recentEntry('Screen Recording 10.38', 'video', 6), recentEntry('Screenshot 10.31', 'still', 13),
    recentEntry('Screenshot 09.58', 'still', 46), recentEntry('Screen Recording 09.40', 'video', 62), recentEntry('Screenshot 09.12', 'still', 90),
];
const readRecentSpecimen: RecentCaptureThumbnailReader = async (entry) => ({
    uri: entry.name.endsWith('10.31') || entry.name.endsWith('09.40') ? TERMINAL_URI : CHECKOUT_FULL.uri,
    ...(entry.kind === 'video' ? { durationSeconds: entry.name.endsWith('09.40') ? 72 : 42 } : {}),
});

/** `rc-rec`: the composer's Attach recent capture, on its card; `op-error` keeps the captures under a failed operation. */
export function RecentCapturesScene(props: Readonly<{ phase: string | undefined }>) {
    const { phase } = props;
    return (
        <View style={styles.recent}>
            <RecentCaptureGridView
                maxHeight={420}
                entries={phase === 'loading' || phase === 'error' || phase === 'empty' ? [] : RECENT_ENTRIES}
                folders={[{ path: '/Users/ana/Pictures/Screenshots', issue: null },
                    { path: '/Users/ana/Desktop', issue: phase === 'issue' ? 'denied' : null }]}
                status={phase === 'loading' ? 'loading' : phase === 'error' || phase === 'op-error' ? 'error' : 'ready'}
                error={null}
                readThumbnail={readRecentSpecimen}
                onChoose={() => {}}
                onRefresh={() => {}}
                onChooseFile={() => {}}
                onChooseFolder={() => {}}
            />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    recent: {
        position: 'absolute',
        left: 460,
        top: 360,
        width: 520,
        padding: theme.space.s6,
        borderRadius: theme.borderRadius.xl,
        backgroundColor: theme.colors.surface.base,
        boxShadow: theme.colors.glass.castShadow,
    } as never,
    place: {
        position: 'absolute',
    },
    discarded: {
        width: 280,
        height: 52,
    },
}));
