import type { CreateMicSessionOptions, MicSession } from './MicSession';
import { isPermissionDeniedMicrophoneError } from '@/utils/platform/microphonePermissions';
import {
    createMicLifecycleInvalidation,
    joinMicAcquisition,
    type MicAcquisitionAttempt,
} from './micAcquisitionLifecycle';

type AudioContextCtor = new () => AudioContext;

type CreateWebMicSessionOptions = Readonly<{
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    mediaDevices?: MediaDevices;
    document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
    /** Factory for the capture {@link AudioContext}; defaults to the platform ctor. */
    createAudioContext?: () => AudioContext | null;
    setTimer?: (task: () => void, waitMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    /**
     * Grace period before a sustained track `mute` escalates to a failure.
     * Browsers fire transient `mute`/`unmute` for route blips and other apps
     * grabbing the device; only a mute that outlives this window is a fault.
     */
    muteEscalationMs?: number;
    /** Schedules the next metering frame; defaults to requestAnimationFrame. */
    requestLevelFrame?: (callback: () => void) => number;
    /** Cancels a scheduled metering frame; defaults to cancelAnimationFrame. */
    cancelLevelFrame?: (handle: number) => void;
}> & CreateMicSessionOptions;

function resolveDefaultAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') {
        return null;
    }
    const candidate = window as typeof window & { webkitAudioContext?: AudioContextCtor };
    const Ctor = candidate.AudioContext ?? candidate.webkitAudioContext ?? null;
    if (!Ctor) {
        return null;
    }
    try {
        return new Ctor();
    } catch {
        return null;
    }
}

export function createWebMicSession(options: CreateWebMicSessionOptions = {}): MicSession {
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let muted = false;
    let activeTrack: MediaStreamTrack | null = null;
    let ensureActiveInFlight: MicAcquisitionAttempt | null = null;
    let teardownInFlight: Promise<void> | null = null;
    let lifecycleVersion = 0;
    let lifecycleInvalidated = createMicLifecycleInvalidation();
    let trackEndedListener: EventListener | null = null;
    let trackMuteListener: EventListener | null = null;
    let trackUnmuteListener: EventListener | null = null;
    let deviceChangeListener: EventListener | null = null;
    let visibilityChangeListener: EventListener | null = null;
    let lastFailureReason: string | null = null;
    let muteEscalationTimer: ReturnType<typeof setTimeout> | null = null;
    // Level-metering state: an AnalyserNode tapped off the canonical stream feeds
    // an RMS loop that emits a normalized amplitude while capture is active.
    let analyserNode: AnalyserNode | null = null;
    let analyserSource: MediaStreamAudioSourceNode | null = null;
    let levelBuffer: Uint8Array<ArrayBuffer> | null = null;
    let levelFrameHandle: number | null = null;

    const getUserMedia =
        options.getUserMedia
        ?? ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));
    const mediaDevices = options.mediaDevices ?? navigator.mediaDevices;
    const documentLike = options.document ?? document;
    const createAudioContext = options.createAudioContext ?? resolveDefaultAudioContext;
    const setTimer = options.setTimer ?? ((task, waitMs) => setTimeout(task, waitMs));
    const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    const muteEscalationMs = typeof options.muteEscalationMs === 'number' && options.muteEscalationMs >= 0
        ? options.muteEscalationMs
        : 1_500;
    const requestLevelFrame = options.requestLevelFrame
        ?? ((callback: () => void): number =>
            (typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame(() => callback())
                : (setTimer(callback, 33) as unknown as number)));
    const cancelLevelFrame = options.cancelLevelFrame
        ?? ((handle: number): void => {
            if (typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(handle);
            } else {
                clearTimer(handle as unknown as ReturnType<typeof setTimeout>);
            }
        });

    const stopLevelMetering = () => {
        if (levelFrameHandle !== null) {
            cancelLevelFrame(levelFrameHandle);
            levelFrameHandle = null;
        }
        if (analyserSource) {
            try {
                analyserSource.disconnect();
            } catch {
                // ignore
            }
            analyserSource = null;
        }
        if (analyserNode) {
            try {
                analyserNode.disconnect();
            } catch {
                // ignore
            }
            analyserNode = null;
        }
        levelBuffer = null;
        // Settle the visualizer back to idle when capture stops.
        options.onLevel?.(0);
    };

    const sampleLevel = () => {
        if (!analyserNode || !levelBuffer || !options.onLevel) {
            return;
        }
        analyserNode.getByteTimeDomainData(levelBuffer);
        let sumSquares = 0;
        for (let i = 0; i < levelBuffer.length; i += 1) {
            // Center the unsigned byte (0..255, silence = 128) to [-1,1].
            const deviation = (levelBuffer[i]! - 128) / 128;
            sumSquares += deviation * deviation;
        }
        const rms = Math.sqrt(sumSquares / levelBuffer.length);
        // RMS is already in [0,1]; clamp defensively.
        options.onLevel(Math.max(0, Math.min(1, rms)));
    };

    const scheduleLevelFrame = () => {
        levelFrameHandle = requestLevelFrame(() => {
            levelFrameHandle = null;
            // A teardown between schedule and fire clears the analyser; bail so a
            // stale queued frame never emits a level after capture stopped.
            if (!analyserNode) {
                return;
            }
            sampleLevel();
            scheduleLevelFrame();
        });
    };

    const startLevelMetering = (mediaStream: MediaStream) => {
        if (!options.onLevel || analyserNode) {
            return;
        }
        const context = ensureAudioContext();
        if (!context || typeof context.createAnalyser !== 'function' || typeof context.createMediaStreamSource !== 'function') {
            return;
        }
        try {
            const analyser = context.createAnalyser();
            analyser.fftSize = 1024;
            const sourceNode = context.createMediaStreamSource(mediaStream);
            sourceNode.connect(analyser);
            analyserNode = analyser;
            analyserSource = sourceNode;
            levelBuffer = new Uint8Array(analyser.fftSize);
            scheduleLevelFrame();
        } catch {
            stopLevelMetering();
        }
    };

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

    const clearMuteEscalationTimer = () => {
        if (muteEscalationTimer !== null) {
            clearTimer(muteEscalationTimer);
            muteEscalationTimer = null;
        }
    };

    const ensureAudioContext = (): AudioContext | null => {
        if (!audioContext) {
            audioContext = createAudioContext();
        }
        return audioContext;
    };

    const resumeAudioContext = () => {
        const context = audioContext;
        if (context && context.state === 'suspended') {
            void context.resume().catch(() => {});
        }
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

    const clearActiveStream = (): MediaStream | null => {
        const activeStream = stream;
        clearMuteEscalationTimer();
        stopLevelMetering();
        detachTrackListeners();
        stream = null;
        lastFailureReason = null;
        return activeStream;
    };

    const retireActiveStream = (): void => {
        const activeStream = clearActiveStream();
        if (!activeStream) return;
        for (const track of activeStream.getAudioTracks()) {
            track.stop();
        }
    };

    const attachTrackListeners = (track: MediaStreamTrack) => {
        detachTrackListeners();
        activeTrack = track;
        trackEndedListener = () => {
            clearActiveStream();
            notifyFailure('web_mic_track_ended', 'mic_ended');
        };
        trackMuteListener = () => {
            // A transient `mute` is not yet a failure: debounce and only escalate
            // if the track stays muted past the grace window with no `unmute`.
            syncTrackMute();
            clearMuteEscalationTimer();
            muteEscalationTimer = setTimer(() => {
                muteEscalationTimer = null;
                if (activeTrack === track && track.muted === true) {
                    notifyFailure('web_mic_track_muted', 'audio_context_suspended');
                }
            }, muteEscalationMs);
        };
        trackUnmuteListener = () => {
            clearMuteEscalationTimer();
            lastFailureReason = null;
            syncTrackMute();
        };
        track.addEventListener('ended', trackEndedListener);
        track.addEventListener('mute', trackMuteListener);
        track.addEventListener('unmute', trackUnmuteListener);
    };

    const handleDeviceChange = () => {
        // Distinguish a real input loss (device unplugged -> no audio inputs left)
        // from a mere route change (default device/output swap), which fires
        // `devicechange` constantly and must not churn the canonical stream.
        const enumerate = mediaDevices.enumerateDevices?.bind(mediaDevices);
        if (!enumerate) {
            syncTrackMute();
            return;
        }
        const streamAtDeviceChange = stream;
        void Promise.resolve(enumerate())
            .then((devices) => {
                const hasAudioInput = devices.some((device) => device.kind === 'audioinput');
                if (!hasAudioInput) {
                    // The capture input is gone; drop the stream so the next
                    // `ensureActive` re-acquires once an input returns. The
                    // enumeration is asynchronous, so retire only the stream
                    // that was active when this device-change was observed;
                    // teardown/reacquisition may have installed a newer owner
                    // while the browser was enumerating devices.
                    if (!streamAtDeviceChange || stream !== streamAtDeviceChange) {
                        return;
                    }
                    retireActiveStream();
                    notifyFailure('web_mic_input_removed', 'mic_ended');
                    return;
                }
                syncTrackMute();
            })
            .catch(() => {
                syncTrackMute();
            });
    };

    const attachEnvironmentListeners = () => {
        if (!deviceChangeListener) {
            deviceChangeListener = () => {
                handleDeviceChange();
            };
            mediaDevices.addEventListener('devicechange', deviceChangeListener);
        }
        if (!visibilityChangeListener) {
            visibilityChangeListener = () => {
                if (documentLike.visibilityState === 'visible') {
                    resumeAudioContext();
                    syncTrackMute();
                }
            };
            documentLike.addEventListener('visibilitychange', visibilityChangeListener);
        }
    };

    const joinAcquisition = async (attempt: MicAcquisitionAttempt): Promise<boolean> =>
        await joinMicAcquisition(attempt, lifecycleInvalidated);

    const ensureActive = async (): Promise<void> => {
            const pendingTeardown = teardownInFlight;
            if (pendingTeardown) {
                await pendingTeardown;
            }
            if (stream) {
                ensureAudioContext();
                resumeAudioContext();
                syncTrackMute();
                return;
            }
            if (ensureActiveInFlight) {
                if (!await joinAcquisition(ensureActiveInFlight)) {
                    return;
                }
                if (!stream) {
                    await ensureActive();
                    return;
                }
                syncTrackMute();
                return;
            }

            const acquisitionVersion = lifecycleVersion;
            const acquire = (async () => {
                try {
                    const acquired = await getUserMedia({
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                        },
                    });
                    if (acquisitionVersion !== lifecycleVersion) {
                        for (const track of acquired.getAudioTracks()) {
                            track.stop();
                        }
                        return;
                    }
                    stream = acquired;
                    const [track] = acquired.getAudioTracks();
                    if (track) {
                        attachTrackListeners(track);
                    }
                    ensureAudioContext();
                    resumeAudioContext();
                    attachEnvironmentListeners();
                    startLevelMetering(acquired);
                } catch (error) {
                    if (isPermissionDeniedMicrophoneError(error)) {
                        throw new Error('mic_permission_denied');
                    }
                    throw error;
                }
            })();

            const attempt: MicAcquisitionAttempt = {
                outcome: acquire.then(() => null, (error: unknown) => ({ error })),
            };
            ensureActiveInFlight = attempt;
            try {
                if (!await joinAcquisition(attempt)) {
                    return;
                }
            } finally {
                if (ensureActiveInFlight === attempt) {
                    ensureActiveInFlight = null;
                }
            }
            syncTrackMute();
    };

    return {
        ensureActive,
        setMuted: (nextMuted) => {
            muted = nextMuted;
            syncTrackMute();
        },
        isMuted: () => muted,
        teardown: async () => {
            if (teardownInFlight) {
                await teardownInFlight;
                return;
            }

            lifecycleVersion += 1;
            // Ownership moves here, so an outstanding acquisition is abandoned rather
            // than joined: the version bump makes a late `getUserMedia` stop its own
            // tracks, and its rejection is already consumed by the attempt outcome.
            ensureActiveInFlight = null;
            lifecycleInvalidated.invalidate();
            lifecycleInvalidated = createMicLifecycleInvalidation();
            const teardown = (async () => {
                const activeContext = audioContext;
                retireActiveStream();
                detachEnvironmentListeners();
                audioContext = null;
                if (activeContext && activeContext.state !== 'closed') {
                    await activeContext.close().catch(() => {});
                }
            })();
            teardownInFlight = teardown;
            try {
                await teardown;
            } finally {
                if (teardownInFlight === teardown) {
                    teardownInFlight = null;
                }
            }
        },
        getStream: () => stream,
        getAudioContext: () => audioContext,
    };
}
