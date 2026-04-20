import type { CreateMicSessionOptions, MicSession } from './MicSession';
import { isPermissionDeniedMicrophoneError } from '@/utils/platform/microphonePermissions';

type CreateWebMicSessionOptions = Readonly<{
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    mediaDevices?: MediaDevices;
    document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}> & CreateMicSessionOptions;

export function createWebMicSession(options: CreateWebMicSessionOptions = {}): MicSession {
    let stream: MediaStream | null = null;
    let muted = false;
    let activeTrack: MediaStreamTrack | null = null;
    let ensureActiveInFlight: Promise<void> | null = null;
    let trackEndedListener: EventListener | null = null;
    let trackMuteListener: EventListener | null = null;
    let trackUnmuteListener: EventListener | null = null;
    let deviceChangeListener: EventListener | null = null;
    let visibilityChangeListener: EventListener | null = null;
    let lastFailureReason: string | null = null;

    const getUserMedia =
        options.getUserMedia
        ?? ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));
    const mediaDevices = options.mediaDevices ?? navigator.mediaDevices;
    const documentLike = options.document ?? document;

    const syncTrackMute = () => {
        const track = activeTrack;
        if (!track) return;
        track.enabled = !muted;
    };

    const notifyFailure = (reason: string, kind: 'mic_ended' | 'audio_context_suspended') => {
        if (lastFailureReason === reason) {
            return;
        }
        lastFailureReason = reason;
        options.onFailure?.({
            kind,
            reason,
        });
    };

    const detachTrackListeners = () => {
        if (activeTrack && trackEndedListener) {
            activeTrack.removeEventListener('ended', trackEndedListener);
        }
        if (activeTrack && trackMuteListener) {
            activeTrack.removeEventListener('mute', trackMuteListener);
        }
        if (activeTrack && trackUnmuteListener) {
            activeTrack.removeEventListener('unmute', trackUnmuteListener);
        }
        activeTrack = null;
        trackEndedListener = null;
        trackMuteListener = null;
        trackUnmuteListener = null;
    };

    const detachEnvironmentListeners = () => {
        if (deviceChangeListener) {
            mediaDevices.removeEventListener('devicechange', deviceChangeListener);
            deviceChangeListener = null;
        }
        if (visibilityChangeListener) {
            documentLike.removeEventListener('visibilitychange', visibilityChangeListener);
            visibilityChangeListener = null;
        }
    };

    const clearActiveStream = () => {
        detachTrackListeners();
        stream = null;
        lastFailureReason = null;
    };

    const attachTrackListeners = (track: MediaStreamTrack) => {
        detachTrackListeners();
        activeTrack = track;
        trackEndedListener = () => {
            clearActiveStream();
            notifyFailure('web_mic_track_ended', 'mic_ended');
        };
        trackMuteListener = () => {
            syncTrackMute();
            notifyFailure('web_mic_track_muted', 'audio_context_suspended');
        };
        trackUnmuteListener = () => {
            lastFailureReason = null;
            syncTrackMute();
        };
        track.addEventListener('ended', trackEndedListener);
        track.addEventListener('mute', trackMuteListener);
        track.addEventListener('unmute', trackUnmuteListener);
    };

    const attachEnvironmentListeners = () => {
        if (!deviceChangeListener) {
            deviceChangeListener = () => {
                syncTrackMute();
            };
            mediaDevices.addEventListener('devicechange', deviceChangeListener);
        }
        if (!visibilityChangeListener) {
            visibilityChangeListener = () => {
                if (documentLike.visibilityState === 'visible') {
                    syncTrackMute();
                }
            };
            documentLike.addEventListener('visibilitychange', visibilityChangeListener);
        }
    };

    return {
        ensureActive: async () => {
            if (stream) {
                syncTrackMute();
                return;
            }
            if (ensureActiveInFlight) {
                await ensureActiveInFlight;
                syncTrackMute();
                return;
            }

            const acquire = (async () => {
                try {
                    const acquired = await getUserMedia({
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                        },
                    });
                    stream = acquired;
                    const [track] = acquired.getAudioTracks();
                    if (track) {
                        attachTrackListeners(track);
                    }
                    attachEnvironmentListeners();
                } catch (error) {
                    if (isPermissionDeniedMicrophoneError(error)) {
                        throw new Error('mic_permission_denied');
                    }
                    throw error;
                }
            })();

            ensureActiveInFlight = acquire;
            try {
                await acquire;
            } finally {
                if (ensureActiveInFlight === acquire) {
                    ensureActiveInFlight = null;
                }
            }
            syncTrackMute();
        },
        setMuted: (nextMuted) => {
            muted = nextMuted;
            syncTrackMute();
        },
        isMuted: () => muted,
        teardown: async () => {
            const activeStream = stream;
            clearActiveStream();
            detachEnvironmentListeners();
            if (!activeStream) return;
            for (const track of activeStream.getAudioTracks()) {
                track.stop();
            }
        },
        getStream: () => stream,
    };
}
