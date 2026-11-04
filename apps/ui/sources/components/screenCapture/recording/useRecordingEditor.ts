import * as React from 'react';
import { isEmptyEdit } from '@happier-dev/protocol/sessions/media/imageMarksV1';

import type { ComposerEditorReference } from '@/components/ui/forms/composerEditor/composerEditorTypes';
import type { ImageAnnotator } from '@/components/ui/media/annotation/annotatorStore';
import type { ImageAnnotationSource } from '@/components/ui/media/annotation/types';
import type { MediaPlayerFrame, MediaPlayerVideoControls } from '@/components/workspaces/files/file/videoFrameAccess';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';

import { createRecordingClock, type RecordingClock } from './recordingClock';
import { projectRecordingDocument, reduceRecordingDocument, toRecordingTimeMs, type RecordingDocument } from './recordingDocument';
import {
    composeRecordingNoteDraft,
    insertRecordingTimeChip,
    parseRecordingNoteDraft,
    recordingNoteOperations,
    type RecordingNoteDraft,
} from './recordingEditorProjection';
import { useRecordingAuthoring, type RecordingAuthoring, type RecordingAuthoringInput } from './useRecordingAuthoring';

/** How the editor reaches the movie: the mounted player, and one finite decoder for frames it must not disturb. */
export type RecordingMediaAccess = Readonly<{
    renderPlayer: (onControls: (controls: MediaPlayerVideoControls | null) => void) => React.ReactNode;
    withFrames: <Result>(operation: (controls: MediaPlayerVideoControls) => Promise<Result>, signal?: AbortSignal) => Promise<Result>;
}>;

export type RecordingFrameSession = Readonly<{
    annotator: ImageAnnotator;
    flush: () => Promise<void>;
    retry: () => Promise<void>;
}>;

export type RecordingEditor = ReturnType<typeof useRecordingEditor>;

const commonPrefix = (left: string, right: string) => {
    let index = 0;
    while (index < left.length && left[index] === right[index]) index += 1;
    return index;
};

/**
 * One video in the Capture window (lab `rc` ED, MIS §7): the transport, the paused frame the marks
 * draw on, and the note. The native document stays the authority; the typed note joins it on commit.
 */
export function useRecordingEditor(input: Readonly<{
    document: RecordingDocument;
    commitDocument: RecordingAuthoringInput['onDocumentChange'];
    media: RecordingMediaAccess;
    scale: number;
    /** Reopening a clip stands where it was; a new one starts at its first frame. */
    initialTimeMs?: number;
}>) {
    const { document, media, scale } = input;
    const authoring: RecordingAuthoring = useRecordingAuthoring({ document, onDocumentChange: input.commitDocument });
    const firstFrameTime = React.useRef(input.initialTimeMs ?? document.trim.startMs);
    const [clock] = React.useState<RecordingClock>(() => createRecordingClock(firstFrameTime.current));
    const [controls, setControls] = React.useState<MediaPlayerVideoControls | null>(null);
    const [playing, setPlaying] = React.useState(false);
    const [frame, setFrame] = React.useState<MediaPlayerFrame & Readonly<{ sourceTimeMs: number }> | null>(null);
    const [failed, setFailed] = React.useState(false);
    const [session, setSession] = React.useState<RecordingFrameSession | null>(null);
    const currentSession = React.useRef(session);
    currentSession.current = session;
    const [commitFailed, setCommitFailed] = React.useState(false);
    const [draft, setDraft] = React.useState<RecordingNoteDraft>(() => composeRecordingNoteDraft(document));
    const [noteCaret, setNoteCaret] = React.useState<Readonly<{ at: number }> | null>(null);
    const [chipLanding, setChipLanding] = React.useState<Readonly<{ sourceTimeMs: number; at: number; typedLength: number }> | null>(null);
    const draftRef = React.useRef(draft);
    draftRef.current = draft;
    const committedNote = React.useRef(parseRecordingNoteDraft(draft));
    /** A moment the person stopped on: the next words typed belong to it. */
    const armedChip = React.useRef<number | null>(null);
    const frameRead = React.useRef<AbortController | null>(null);
    const scrubIntent = React.useRef<boolean | null>(null);
    const [readAttempt, retryRead] = React.useReducer((attempt: number) => attempt + 1, 0);
    const retry = React.useCallback(() => { setFailed(false); retryRead(); }, []);

    const replaceFrame = React.useCallback(async (next: MediaPlayerFrame, sourceTimeMs: number, signal: AbortSignal) => {
        if (signal.aborted) return false;
        // The keyed annotator owns uncommitted marks until its native write settles.
        // Retry and seeking must both keep a refused redaction mounted for explicit Retry.
        try { await currentSession.current?.flush(); }
        catch { if (!signal.aborted) setCommitFailed(true); return false; }
        if (signal.aborted) return false;
        setFailed(false);
        setFrame({ ...next, sourceTimeMs });
        return true;
    }, []);

    // The window opens on the clip's first frame, already decoded.
    React.useEffect(() => {
        const lifetime = new AbortController();
        void media.withFrames((player) => player.readFrame({ timeSeconds: firstFrameTime.current / 1000 }), lifetime.signal)
            .then((read) => replaceFrame(read, firstFrameTime.current, lifetime.signal))
            .catch(() => { if (!lifetime.signal.aborted) setFailed(true); });
        return () => { lifetime.abort(); frameRead.current?.abort(); };
    }, [media, readAttempt, replaceFrame]);

    const settle = React.useCallback((timeMs: number) => {
        frameRead.current?.abort();
        const read = new AbortController();
        frameRead.current = read;
        const sourceTimeMs = toRecordingTimeMs(timeMs);
        const resume = scrubIntent.current === true && sourceTimeMs < document.trim.endMs;
        scrubIntent.current = null;
        armedChip.current = sourceTimeMs;
        return controls?.readFrame({ timeSeconds: sourceTimeMs / 1000, signal: read.signal }).then(async (next) => {
            if (await replaceFrame(next, sourceTimeMs, read.signal) && resume) controls.playback?.play();
        }).catch(() => { if (!read.signal.aborted) setFailed(true); });
    }, [controls, document.trim.endMs, replaceFrame]);

    const scrub = React.useCallback((timeMs: number) => {
        if (scrubIntent.current === null) scrubIntent.current = playing;
        controls?.playback?.pause();
        controls?.seekTo(timeMs / 1000);
        clock.write(timeMs);
    }, [clock, controls, playing]);

    // Playback owns the clock only while it runs; a frame per paint, nothing at rest.
    React.useEffect(() => {
        const playback = controls?.playback;
        if (!playback) return;
        const stop = playback.subscribe(setPlaying);
        return stop;
    }, [controls]);
    const trimEnd = document.trim.endMs;
    React.useEffect(() => {
        const playback = controls?.playback;
        if (!playback || !playing) return;
        let handle = 0;
        const follow = () => {
            const timeMs = playback.readTime() * 1000;
            if (timeMs >= trimEnd) { playback.pause(); clock.write(trimEnd); void settle(trimEnd); return; }
            clock.write(timeMs);
            handle = requestAnimationFrame(follow);
        };
        handle = requestAnimationFrame(follow);
        return () => cancelAnimationFrame(handle);
    }, [clock, controls, playing, settle, trimEnd]);

    const togglePlaying = React.useCallback(() => {
        const playback = controls?.playback;
        if (!playback) return;
        if (playing) { playback.pause(); void settle(clock.read()); return; }
        if (clock.read() >= trimEnd) controls?.seekTo(document.trim.startMs / 1000);
        playback.play();
    }, [clock, controls, document.trim.startMs, playing, settle, trimEnd]);
    useKeyboardShortcutHandlers({ 'media.playPause': togglePlaying });

    const seek = React.useCallback((timeMs: number) => { scrub(timeMs); settle(timeMs); }, [scrub, settle]);

    /** The field reports its chips before its text, so this edit's chip positions are already here. */
    const editorReferences = React.useRef(draft.references);
    const onReferencesChange = React.useCallback((references: readonly ComposerEditorReference[]) => {
        editorReferences.current = references;
        setDraft((previous) => ({ ...previous, references }));
    }, []);
    const onNoteChange = React.useCallback((text: string) => {
        const previous = draftRef.current;
        if (text === previous.text) return;
        const armed = armedChip.current;
        if (armed === null || text.length <= previous.text.length) {
            setDraft({ text, references: editorReferences.current });
            return;
        }
        armedChip.current = null;
        setDraft({ text, references: editorReferences.current });
        setChipLanding({ sourceTimeMs: armed, at: commonPrefix(previous.text, text), typedLength: text.length - previous.text.length });
    }, []);
    // The field takes a new value only once it has seen its own text back, so the chip lands a commit later, before paint.
    React.useLayoutEffect(() => {
        if (!chipLanding) return;
        setChipLanding(null);
        const next = insertRecordingTimeChip(draftRef.current, chipLanding.at, chipLanding.sourceTimeMs);
        const chipLength = next.text.length - draftRef.current.text.length;
        editorReferences.current = next.references;
        setDraft(next);
        setNoteCaret({ at: chipLanding.at + chipLength + chipLanding.typedLength });
    }, [chipLanding]);

    const parsed = React.useMemo(() => parseRecordingNoteDraft(draft), [draft]);
    /** What would leave if the note were committed now: the summary never waits for that write. */
    const effective = React.useMemo(() => recordingNoteOperations(parsed, committedNote.current).reduce(reduceRecordingDocument, document),
        [document, parsed]);
    const projection = React.useMemo(() => projectRecordingDocument(effective), [effective]);

    const commitNote = React.useCallback(async () => {
        const operations = recordingNoteOperations(parsed, committedNote.current);
        if (operations.length > 0) await authoring.commit(operations);
        committedNote.current = parsed;
    }, [authoring, parsed]);

    /** Every edit reaches the native document before anything reads it for delivery. */
    const prepareDelivery = React.useCallback(async (prepareFrames?: (player: MediaPlayerVideoControls) => Promise<void>) => {
        await session?.flush();
        await commitNote();
        if (prepareFrames) {
            if (!controls) throw new Error('capture_not_prepared');
            const time = controls.playback?.readTime() ?? clock.read() / 1000;
            controls.playback?.pause();
            try { await prepareFrames(controls); }
            finally {
                controls.seekTo(time);
                if (playing) controls.playback?.play();
            }
        }
        return { note: parsed.lead };
    }, [clock, commitNote, controls, parsed.lead, playing, session]);

    const hasWork = parsed.lead.length > 0 || parsed.moments.length > 0
        || document.frames.some((entry) => !isEmptyEdit(entry.document))
        || document.trim.startMs !== 0 || document.trim.endMs !== document.durationMs;

    const frameSource = React.useMemo<ImageAnnotationSource | null>(() => frame
        ? { uri: frame.uri, width: frame.width, height: frame.height, scale } : null, [frame, scale]);

    return {
        status: failed ? 'failed' as const : frameSource ? 'ready' as const : 'loading' as const,
        retry,
        authoring,
        clock,
        playing,
        togglePlaying,
        scrub,
        seek,
        settle,
        controlsReady: controls !== null,
        setControls,
        frame,
        frameSource,
        session,
        setSession,
        commitFailed,
        setCommitFailed,
        draft,
        noteCaret,
        onNoteChange,
        onReferencesChange,
        effective,
        projection,
        lead: parsed.lead,
        commitNote,
        prepareDelivery,
        hasWork,
        /** Choosing a tool while it plays stops on the frame in view. */
        pauseForMarks: () => { if (playing) { controls?.playback?.pause(); void settle(clock.read()); } },
    };
}
