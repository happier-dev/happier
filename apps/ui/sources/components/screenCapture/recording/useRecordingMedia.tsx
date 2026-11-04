import * as React from 'react';
import { HeldVideoPlayer } from '@/components/workspaces/files/file/HeldVideoPlayer';
import { withVideoFrameSource, type MediaPlayerVideoControls } from '@/components/workspaces/files/file/videoFrameAccess';
import { readCaptureSource, type NativeCaptureResult } from '@/desktop/capture/nativeCapture';
import { t } from '@/text';
import type { RecordingMediaAccess } from './useRecordingEditor';

/** The player and frame decoder share the movie bytes held by this window. */
export function useRecordingMedia(capture: NativeCaptureResult, signal: AbortSignal | null) {
    const [uri, setUri] = React.useState<string | null>(null);
    const [status, setStatus] = React.useState<'loading' | 'ready' | 'failed'>('loading');
    const [attempt, nextAttempt] = React.useReducer(value => value + 1, 0);
    const retry = React.useCallback(() => { setStatus('loading'); nextAttempt(); }, []);
    const onPlayerError = React.useCallback(() => setStatus('failed'), []);
    React.useEffect(() => {
        let active = true;
        let created: string | undefined;
        void readCaptureSource(capture.captureRef).then((bytes) => {
            if (!active || signal?.aborted) return;
            created = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: capture.mimeType }));
            setUri(created);
            setStatus('ready');
        }).catch(() => { if (active && !signal?.aborted) setStatus('failed'); });
        return () => { active = false; if (created) URL.revokeObjectURL(created); };
    }, [attempt, capture.captureRef, capture.mimeType, signal]);
    const media = React.useMemo<RecordingMediaAccess | null>(() => uri ? {
        renderPlayer: (onControls: (controls: MediaPlayerVideoControls | null) => void) => (
            <HeldVideoPlayer uri={uri} title={t('screenCapture.recording.title')} isActive chrome="none" onError={onPlayerError} onVideoControls={onControls} />
        ),
        withFrames: (operation, signal) => withVideoFrameSource(uri, operation, signal),
    } : null, [uri, onPlayerError]);
    return { media, status, retry };
}
