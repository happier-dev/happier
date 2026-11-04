import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ImageAnnotator } from '@/components/ui/media/annotation/annotatorStore';
import { formatPlaybackTime } from '@/components/workspaces/files/file/filePageMediaFacts';
import { t } from '@/text';

import type { CaptureWindowCaption, CaptureWindowNoteChips } from '../window/CaptureWindowScreen';
import { RecordingDeliveryNotice } from './RecordingDeliveryNotice';
import { RecordingFrameSessionLeaf } from './RecordingFrameSessionLeaf';
import { RecordingTimeline } from './RecordingTimeline';
import type { RecordingEditor, RecordingMediaAccess } from './useRecordingEditor';

const byteLabel = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export type RecordingSurface = Readonly<{
    /** Mounted beside the window: one paused frame's annotator. */
    frameSession: React.ReactNode;
    annotator: ImageAnnotator | null;
    renderPicture: () => React.ReactNode;
    canvasHidden: boolean;
    belowPicture: React.ReactNode;
    notice: React.ReactNode;
    noteChips: CaptureWindowNoteChips;
    caption: CaptureWindowCaption;
    discardedTitle: string;
}>;

/** The video's parts of the Capture window (lab `rc` ED), for the route and for the specimen alike. */
export function useRecordingSurface(editor: RecordingEditor, input: Readonly<{
    media: RecordingMediaAccess;
    aspectRatio: number;
    appName: string | null;
    agentName: string | null;
    /** The whole file; a trimmed clip's size is only known once it is prepared. */
    byteSize: number;
    /** The open video stopped reading (playback or a frame); Retry keeps every edit. */
    mediaFailure?: Readonly<{ onRetry: () => void }> | null;
}>): RecordingSurface {
    const { media, aspectRatio } = input;
    const { authoring, clock, frame, frameSource, effective, playing, session, setSession, setCommitFailed, setControls } = editor;
    const trimmed = effective.trim.startMs !== 0 || effective.trim.endMs !== effective.durationMs;
    const clipSeconds = (effective.trim.endMs - effective.trim.startMs) / 1000;
    const player = React.useMemo(() => media.renderPlayer(setControls), [media, setControls]);
    return {
        frameSession: frame && frameSource ? (
            <RecordingFrameSessionLeaf
                key={`${effective.sourceCaptureRef}:${frame.sourceTimeMs}`}
                authoring={authoring}
                sourceTimeMs={frame.sourceTimeMs}
                source={frameSource}
                previous={session}
                onSession={setSession}
                onCommitError={setCommitFailed}
                onToolChosen={editor.pauseForMarks}
            />
        ) : null,
        annotator: session?.annotator ?? null,
        renderPicture: () => <View style={styles.player}>{player}</View>,
        canvasHidden: playing,
        belowPicture: (
            <RecordingTimeline
                document={effective}
                clock={clock}
                playing={playing}
                aspectRatio={aspectRatio}
                media={media}
                onTogglePlaying={editor.togglePlaying}
                onScrub={editor.scrub}
                onSettle={editor.settle}
                onSeek={editor.seek}
                onTrim={(startMs, endMs) => { void authoring.commit([{ kind: 'trim.set', startMs, endMs }]); }}
                onMoveDefaultPin={(sourceTimeMs) => { void authoring.commit([{ kind: 'defaultPin.move', sourceTimeMs }]); }}
            />
        ),
        notice: (
            <RecordingDeliveryNotice
                agentName={input.agentName}
                frameCount={editor.projection.frames.length}
                disclosure={effective.videoDisclosure}
                failure={input.mediaFailure
                    ? { line: t('screenCapture.recording.mediaFailed'), onRetry: input.mediaFailure.onRetry }
                    : editor.commitFailed ? { line: t('screenCapture.recording.commitFailed'), onRetry: () => {
                        setCommitFailed(false);
                        void session?.retry();
                    } } : null}
                onToggle={(included) => { void authoring.setIncludeVideo(included ? 'on' : 'off'); }}
                onResolveWarning={(include) => { void authoring.resolveWarning(include); }}
            />
        ),
        noteChips: {
            references: editor.draft.references,
            onReferencesChange: editor.onReferencesChange,
            onReferencePress: (ref) => {
                const timeMs = Number(ref.slice('time:'.length));
                if (Number.isFinite(timeMs)) editor.seek(timeMs);
            },
            caret: editor.noteCaret,
        },
        caption: {
            icon: 'video-camera',
            lead: t('screenCapture.recording.title'),
            facts: [
                input.appName,
                trimmed ? t('screenCapture.recording.afterTrim', { time: formatPlaybackTime(clipSeconds) }) : formatPlaybackTime(clipSeconds),
                trimmed ? null : byteLabel(input.byteSize),
                t('screenCapture.recording.marksOnPausedFrame'),
            ].filter((fact): fact is string => Boolean(fact)),
        },
        discardedTitle: t('screenCapture.recording.discarded'),
    };
}

const styles = StyleSheet.create(() => ({
    player: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
    },
}));
