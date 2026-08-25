import type {
    LocalVoiceCaptureOwner,
    LocalVoiceCaptureProvider,
} from '@/voice/runtime/input/LocalVoiceCaptureOwner';
import {
    resolveVoiceDictationSttCapturePlan,
} from '@/voice/dictation/voiceDictationRuntimeSettings';
import type {
    RecordedAudioTranscriptionRequest,
} from '@/voice/runtime/input/recordedAudioTranscriptionController';
import {
    createRecordedAudioArtifactCleanup,
    type RecordedAudioArtifactCleanup,
} from '@/voice/runtime/input/recordedAudioArtifactCleanup';
import type {
    VoiceMachineErrorKind,
} from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import type {
    VoiceAudioSessionCoordinator,
    VoiceAudioSessionPlatformEvent,
} from '@happier-dev/audio-stream-native';

export const VOICE_DICTATION_LIMITS = Object.freeze({
    // Dictation is one utterance, not a conversational session. One minute is
    // deliberately below the retained speech-carrier/session ceilings while
    // remaining generous for a composer entry.
    captureDurationMs: 60_000,
    // Provider transports own shorter per-hop timeouts where applicable. This
    // owner-level deadline bounds complete finalization, beginning when the
    // recorder is asked to stop so it cannot wait forever for a final artifact.
    transcriptionDeadlineMs: 30_000,
    // A one-minute utterance is comfortably below these composer bounds. The
    // independent UTF-8 ceiling prevents multi-byte output from bypassing the
    // character ceiling.
    transcriptCharacters: 8_000,
    transcriptUtf8Bytes: 16_000,
    // This is the smallest current recorded-audio carrier ceiling: both bundled
    // speech and OpenAI-compatible daemon uploads reject payloads above 8 MiB.
    recordedAudioBytes: 8 * 1024 * 1024,
});

const TRANSCRIPTION_DEADLINE = Symbol('voice_dictation_transcription_deadline');

export type VoiceDictationFailureReason =
    | 'capture_failed'
    | 'provider_unavailable'
    | 'capture_start_deadline_exceeded'
    | 'capture_duration_exceeded'
    | 'transcription_deadline_exceeded'
    | 'transcript_character_limit_exceeded'
    | 'transcript_utf8_limit_exceeded'
    | 'recorded_audio_size_unavailable'
    | 'recorded_audio_limit_exceeded';

export type VoiceDictationFailure = Readonly<{
    id: number;
    sessionId: string;
    kind: VoiceMachineErrorKind;
    reason: VoiceDictationFailureReason;
}>;

export type VoiceDictationCaptureError = Readonly<{
    controlSessionId: string;
    kind: VoiceMachineErrorKind;
    reason: string;
}>;

export type VoiceDictationSnapshot = Readonly<{
    sessionId: string | null;
    status: 'idle' | 'starting' | 'listening' | 'transcribing';
    failure?: VoiceDictationFailure;
}>;

export type VoiceDictationToggleResult =
    | Readonly<{ kind: 'started' }>
    | Readonly<{ kind: 'completed'; text: string | null }>
    | Readonly<{ kind: 'cancelled' }>;

type DictationCaptureOwner = Pick<
    LocalVoiceCaptureOwner,
    'startCapture' | 'stopCapture' | 'stopSession'
>;

type ActiveDictation = {
    sessionId: string;
    provider: LocalVoiceCaptureProvider;
    executionMachineId: string | null;
    settings: any;
    abortController: AbortController;
    phase: 'starting' | 'listening' | 'transcribing';
    cancelled: boolean;
    failed: boolean;
    captureTimer: ReturnType<typeof setTimeout> | null;
    transcriptionTimer: ReturnType<typeof setTimeout> | null;
    stopCapturePromise: Promise<Awaited<ReturnType<DictationCaptureOwner['stopCapture']>>> | null;
    stopCaptureSettled: boolean;
    stopSessionPromise: Promise<void> | null;
    recordedAudioCleanup: RecordedAudioArtifactCleanup;
    cleanupPromise: Promise<void> | null;
};

export type VoiceDictationController = Readonly<{
    cancel: (sessionId?: string | null) => Promise<void>;
    dismissFailure: (failureId: number) => void;
    getSnapshot: () => VoiceDictationSnapshot;
    reportCaptureError: (error: VoiceDictationCaptureError) => void;
    subscribe: (listener: () => void) => () => void;
    toggle: (sessionId: string) => Promise<VoiceDictationToggleResult>;
}>;

export function createVoiceDictationController(deps: Readonly<{
    captureOwner: DictationCaptureOwner;
    getSettings: () => any;
    nativeAudioSessionCoordinator?: VoiceAudioSessionCoordinator | null;
    resolveExecutionMachineId?: () => string | null;
    transcribeRecordedAudio: (
        params: RecordedAudioTranscriptionRequest,
    ) => Promise<string | null>;
    measureRecordedAudioBytes: (uri: string) => Promise<number | null>;
    deleteRecordedAudio: (uri: string) => Promise<void>;
    setTimer?: (task: () => void, waitMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}>): VoiceDictationController {
    const listeners = new Set<() => void>();
    const setTimer = deps.setTimer ?? ((task, waitMs) => setTimeout(task, waitMs));
    const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
    const textEncoder = new TextEncoder();
    let snapshot: VoiceDictationSnapshot = {
        sessionId: null,
        status: 'idle',
    };
    let active: ActiveDictation | null = null;
    let nextFailureId = 1;
    let nativeLifecycleWork = Promise.resolve();

    const publish = (next: VoiceDictationSnapshot): void => {
        if (
            snapshot.sessionId === next.sessionId
            && snapshot.status === next.status
            && snapshot.failure?.id === next.failure?.id
        ) {
            return;
        }
        snapshot = next;
        listeners.forEach((listener) => listener());
    };

    const clearCaptureTimer = (attempt: ActiveDictation): void => {
        if (attempt.captureTimer === null) return;
        clearTimer(attempt.captureTimer);
        attempt.captureTimer = null;
    };

    const clearTranscriptionTimer = (attempt: ActiveDictation): void => {
        if (attempt.transcriptionTimer === null) return;
        clearTimer(attempt.transcriptionTimer);
        attempt.transcriptionTimer = null;
    };

    const clearAttemptTimers = (attempt: ActiveDictation): void => {
        clearCaptureTimer(attempt);
        clearTranscriptionTimer(attempt);
    };

    const stopCapture = (
        attempt: ActiveDictation,
    ): Promise<Awaited<ReturnType<DictationCaptureOwner['stopCapture']>>> => {
        attempt.stopCapturePromise ??= deps.captureOwner.stopCapture({
            sessionId: attempt.sessionId,
            provider: attempt.provider,
        }).then((stopped) => {
            if (stopped.provider === 'recorded_audio') {
                attempt.recordedAudioCleanup.admit(stopped.uri);
            }
            return stopped;
        }).finally(() => {
            attempt.stopCaptureSettled = true;
        });
        return attempt.stopCapturePromise;
    };

    const stopSessionAfterCapture = (attempt: ActiveDictation): Promise<void> => {
        attempt.stopSessionPromise ??= Promise.resolve()
            .then(async () => {
                // A recorded URI is produced by stopCapture. Do not tear down
                // the recorder/session until that result has had a chance to
                // admit its one attempt-owned cleanup artifact.
                await attempt.stopCapturePromise?.catch(() => {});
                await deps.captureOwner.stopSession(attempt.sessionId);
            })
            .catch(() => {});
        return attempt.stopSessionPromise;
    };

    const cleanup = (attempt: ActiveDictation): Promise<void> => {
        if (attempt.phase === 'listening') {
            // Cancellation starts the existing capture-owner stop before the
            // session teardown. Its promise remains attempt-owned, so a late
            // native URI or web Blob is admitted and deleted exactly once.
            void stopCapture(attempt).catch(() => {});
        }
        attempt.cleanupPromise ??= (async () => {
            await attempt.stopCapturePromise?.catch(() => {});
            // stopCapture is the capture-owner boundary that yields the final
            // recording URI. Once it settles, delete or revoke that temporary
            // artifact before a later session teardown can stall.
            const cleanupResult = await attempt.recordedAudioCleanup.cleanup();
            await stopSessionAfterCapture(attempt);
            if (active !== attempt) return;
            active = null;
            if (cleanupResult.kind === 'failed' && !snapshot.failure) {
                // Dictation deliberately uses its existing bounded terminal
                // failure boundary: the transcript remains usable and the UI
                // does not silently imply that temporary cleanup succeeded.
                publish({
                    sessionId: null,
                    status: 'idle',
                    failure: {
                        id: nextFailureId++,
                        sessionId: attempt.sessionId,
                        kind: 'provider_error',
                        reason: 'capture_failed',
                    },
                });
            }
        })();
        return attempt.cleanupPromise;
    };

    const cleanupInBackground = (attempt: ActiveDictation): void => {
        void cleanup(attempt);
    };

    const failAttempt = (
        attempt: ActiveDictation,
        failure: Readonly<{
            kind: VoiceMachineErrorKind;
            reason: VoiceDictationFailureReason;
        }>,
    ): boolean => {
        if (attempt.cancelled || attempt.failed) return false;
        attempt.failed = true;
        clearAttemptTimers(attempt);
        attempt.abortController.abort();
        if (active === attempt) {
            publish({
                sessionId: null,
                status: 'idle',
                failure: {
                    id: nextFailureId++,
                    sessionId: attempt.sessionId,
                    ...failure,
                },
            });
        }
        return true;
    };

    const settleFailedCapture = async (attempt: ActiveDictation): Promise<void> => {
        try {
            if (attempt.phase !== 'starting') {
                await stopCapture(attempt);
            }
        } catch {
            // The typed bound failure is already authoritative; teardown below
            // must still settle even when provider stop/finalization rejects.
        } finally {
            await cleanup(attempt);
        }
    };

    const armCaptureDurationBound = (attempt: ActiveDictation): void => {
        clearCaptureTimer(attempt);
        attempt.captureTimer = setTimer(() => {
            attempt.captureTimer = null;
            if (
                active !== attempt
                || (attempt.phase !== 'starting' && attempt.phase !== 'listening')
                || !failAttempt(attempt, {
                    kind: 'stt_timeout',
                    reason: attempt.phase === 'starting'
                        ? 'capture_start_deadline_exceeded'
                        : 'capture_duration_exceeded',
                })
            ) {
                return;
            }
            void settleFailedCapture(attempt);
        }, VOICE_DICTATION_LIMITS.captureDurationMs + 1);
    };

    const startCaptureUntilAbort = (
        attempt: ActiveDictation,
        request: Promise<void>,
    ): Promise<'started' | 'aborted'> => (
        new Promise((resolve, reject) => {
            let settled = false;
            const settle = (result: 'started' | 'aborted'): void => {
                if (settled) return;
                settled = true;
                attempt.abortController.signal.removeEventListener('abort', onAbort);
                resolve(result);
            };
            const onAbort = (): void => {
                settle('aborted');
            };
            attempt.abortController.signal.addEventListener('abort', onAbort, { once: true });
            request.then(
                () => settle('started'),
                (error) => {
                    if (settled) return;
                    settled = true;
                    attempt.abortController.signal.removeEventListener('abort', onAbort);
                    reject(error);
                },
            );
            if (attempt.abortController.signal.aborted) {
                onAbort();
            }
        })
    );

    const transcribeWithDeadline = <T,>(
        attempt: ActiveDictation,
        request: () => Promise<T>,
    ): Promise<T | typeof TRANSCRIPTION_DEADLINE> => (
        new Promise((resolve, reject) => {
            let settled = false;
            const onAbort = (): void => {
                settle(TRANSCRIPTION_DEADLINE);
            };
            const settle = (
                value: T | typeof TRANSCRIPTION_DEADLINE,
            ): void => {
                if (settled) return;
                settled = true;
                attempt.abortController.signal.removeEventListener('abort', onAbort);
                clearTranscriptionTimer(attempt);
                resolve(value);
            };
            attempt.abortController.signal.addEventListener('abort', onAbort, { once: true });
            attempt.transcriptionTimer = setTimer(() => {
                attempt.transcriptionTimer = null;
                if (
                    active === attempt
                    && attempt.phase === 'transcribing'
                ) {
                    settle(TRANSCRIPTION_DEADLINE);
                    failAttempt(attempt, {
                        kind: 'stt_timeout',
                        reason: 'transcription_deadline_exceeded',
                    });
                }
            }, VOICE_DICTATION_LIMITS.transcriptionDeadlineMs + 1);
            request().then(settle, (error) => {
                if (settled) return;
                settled = true;
                attempt.abortController.signal.removeEventListener('abort', onAbort);
                clearTranscriptionTimer(attempt);
                reject(error);
            });
            if (attempt.abortController.signal.aborted) {
                onAbort();
            }
        })
    );

    const finishAttempt = async (
        attempt: ActiveDictation,
    ): Promise<VoiceDictationToggleResult> => {
        clearCaptureTimer(attempt);
        attempt.phase = 'transcribing';
        publish({
            sessionId: attempt.sessionId,
            status: 'transcribing',
        });
        try {
            const result = await transcribeWithDeadline(attempt, async () => {
                const stopped = await stopCapture(attempt);
                if (
                    attempt.cancelled
                    || attempt.failed
                    || attempt.abortController.signal.aborted
                ) {
                    return { kind: 'cancelled' } as const;
                }

                let rawText: string | null;
                if (stopped.provider === 'recorded_audio') {
                    if (!stopped.uri) {
                        rawText = null;
                    } else {
                        const sizeBytes = await deps
                            .measureRecordedAudioBytes(stopped.uri)
                            .catch(() => null);
                        if (
                            typeof sizeBytes !== 'number'
                            || !Number.isSafeInteger(sizeBytes)
                            || sizeBytes < 0
                        ) {
                            failAttempt(attempt, {
                                kind: 'provider_error',
                                reason: 'recorded_audio_size_unavailable',
                            });
                            return { kind: 'cancelled' } as const;
                        }
                        if (sizeBytes > VOICE_DICTATION_LIMITS.recordedAudioBytes) {
                            failAttempt(attempt, {
                                kind: 'provider_error',
                                reason: 'recorded_audio_limit_exceeded',
                            });
                            return { kind: 'cancelled' } as const;
                        }
                        rawText = await deps.transcribeRecordedAudio({
                            sessionId: attempt.sessionId,
                            uri: stopped.uri,
                            executionMachineId: attempt.executionMachineId,
                            settings: attempt.settings,
                            signal: attempt.abortController.signal,
                        });
                    }
                } else {
                    rawText = stopped.text;
                }
                if (
                    attempt.cancelled
                    || attempt.failed
                    || attempt.abortController.signal.aborted
                ) {
                    return { kind: 'cancelled' } as const;
                }
                const text = typeof rawText === 'string' && rawText.trim()
                    ? rawText.trim()
                    : null;
                if (text && Array.from(text).length > VOICE_DICTATION_LIMITS.transcriptCharacters) {
                    failAttempt(attempt, {
                        kind: 'provider_error',
                        reason: 'transcript_character_limit_exceeded',
                    });
                    return { kind: 'cancelled' } as const;
                }
                if (text && textEncoder.encode(text).byteLength > VOICE_DICTATION_LIMITS.transcriptUtf8Bytes) {
                    failAttempt(attempt, {
                        kind: 'provider_error',
                        reason: 'transcript_utf8_limit_exceeded',
                    });
                    return { kind: 'cancelled' } as const;
                }
                return { kind: 'completed', text } as const;
            });
            if (result === TRANSCRIPTION_DEADLINE) {
                return { kind: 'cancelled' };
            }
            if (
                attempt.cancelled
                || attempt.failed
                || attempt.abortController.signal.aborted
            ) {
                return { kind: 'cancelled' };
            }
            return result;
        } catch (error) {
            if (
                attempt.cancelled
                || attempt.failed
                || attempt.abortController.signal.aborted
            ) {
                return { kind: 'cancelled' };
            }
            throw error;
        } finally {
            clearAttemptTimers(attempt);
            if (attempt.failed && !attempt.stopCaptureSettled) {
                // A capture provider may still be finalizing a late URI. Its
                // attempt-owned cleanup retains that URI/session work without
                // keeping this timeout/cancel result pending indefinitely.
                cleanupInBackground(attempt);
            } else {
                await cleanup(attempt);
            }
            if (
                snapshot.sessionId === attempt.sessionId
                && snapshot.failure?.sessionId !== attempt.sessionId
            ) {
                publish({ sessionId: null, status: 'idle' });
            }
        }
    };

    const cancel = async (
        sessionId?: string | null,
        options: Readonly<{ awaitTeardown?: boolean }> = {},
    ): Promise<void> => {
        const attempt = active;
        const normalizedSessionId = typeof sessionId === 'string'
            ? sessionId.trim()
            : '';
        if (!attempt) {
            if (
                snapshot.failure
                && (
                    !normalizedSessionId
                    || snapshot.failure.sessionId === normalizedSessionId
                )
            ) {
                publish({ sessionId: null, status: 'idle' });
            }
            return;
        }
        if (normalizedSessionId && normalizedSessionId !== attempt.sessionId) {
            return;
        }
        attempt.cancelled = true;
        clearAttemptTimers(attempt);
        attempt.abortController.abort();
        if (active === attempt) {
            publish({ sessionId: null, status: 'idle' });
        }
        const cleanupPromise = cleanup(attempt);
        // A listening recorder may take time to finalize its URI. Navigation
        // cancellation remains prompt, while a caller that immediately starts
        // another session waits for the existing admission to release.
        if (
            options.awaitTeardown === true
            || (attempt.phase === 'starting' && attempt.stopCapturePromise === null)
        ) {
            await cleanupPromise;
        }
    };

    const isTerminalNativeLifecycleEvent = (
        event: VoiceAudioSessionPlatformEvent,
    ): boolean => (
        event.kind === 'interruption_began'
        || (event.kind === 'interruption_ended' && !event.shouldResume)
        || (event.kind === 'focus_changed' && event.state === 'lost_permanent')
        || (event.kind === 'lifecycle_changed' && event.state === 'background')
        // The native graph this attempt records through is gone, so the attempt
        // is capturing nothing no matter how healthy it still looks here.
        || event.kind === 'audio_graph_terminal'
    );

    deps.nativeAudioSessionCoordinator?.subscribe((event) => {
        if (!isTerminalNativeLifecycleEvent(event)) return;
        // The coordinator already rejects stale native generations. Retain the
        // exact active attempt so queued cleanup cannot terminate a later retry.
        const attempt = active;
        if (!attempt) return;
        nativeLifecycleWork = nativeLifecycleWork
            .catch(() => undefined)
            .then(async () => {
                if (active !== attempt) return;
                await cancel(attempt.sessionId);
            });
    });

    const start = async (
        sessionId: string,
    ): Promise<VoiceDictationToggleResult> => {
        const {
            plan,
            runtimeSettings: settings,
        } = resolveVoiceDictationSttCapturePlan(deps.getSettings());
        const attempt: ActiveDictation = {
            sessionId,
            provider: plan.provider,
            executionMachineId: deps.resolveExecutionMachineId?.() ?? null,
            settings,
            abortController: new AbortController(),
            phase: 'starting',
            cancelled: false,
            failed: false,
            captureTimer: null,
            transcriptionTimer: null,
            stopCapturePromise: null,
            stopCaptureSettled: false,
            stopSessionPromise: null,
            recordedAudioCleanup: createRecordedAudioArtifactCleanup(deps.deleteRecordedAudio),
            cleanupPromise: null,
        };
        active = attempt;
        publish({ sessionId, status: 'starting' });
        armCaptureDurationBound(attempt);
        try {
            const captureStart = deps.captureOwner.startCapture({
                sessionId,
                provider: plan.provider,
                handsFree: false,
                ...(plan.localNeuralExecution
                    ? { localNeuralExecution: plan.localNeuralExecution }
                    : {}),
                settings,
                signal: attempt.abortController.signal,
            });
            const startOutcome = await startCaptureUntilAbort(attempt, captureStart);
            if (startOutcome === 'aborted') {
                return { kind: 'cancelled' };
            }
            if (
                attempt.cancelled
                || attempt.failed
                || attempt.abortController.signal.aborted
            ) {
                return { kind: 'cancelled' };
            }
            attempt.phase = 'listening';
            publish({ sessionId, status: 'listening' });
            armCaptureDurationBound(attempt);
            return { kind: 'started' };
        } catch (error) {
            if (
                attempt.cancelled
                || attempt.failed
                || attempt.abortController.signal.aborted
            ) {
                return { kind: 'cancelled' };
            }
            throw error;
        } finally {
            if (
                attempt.cancelled
                || attempt.failed
                || attempt.abortController.signal.aborted
            ) {
                cleanupInBackground(attempt);
            } else if (snapshot.status === 'starting') {
                await cleanup(attempt);
                if (
                    snapshot.sessionId === attempt.sessionId
                    && snapshot.failure?.sessionId !== attempt.sessionId
                ) {
                    publish({ sessionId: null, status: 'idle' });
                }
            }
        }
    };

    return {
        cancel,
        dismissFailure: (failureId) => {
            if (snapshot.failure?.id !== failureId) return;
            publish({ sessionId: null, status: 'idle' });
        },
        getSnapshot: () => snapshot,
        reportCaptureError: (error) => {
            const attempt = active;
            const sessionId = error.controlSessionId.trim();
            if (!attempt || !sessionId || attempt.sessionId !== sessionId) {
                return;
            }
            failAttempt(attempt, {
                kind: error.kind,
                reason: error.kind === 'provider_error'
                    ? 'provider_unavailable'
                    : 'capture_failed',
            });
            void cleanup(attempt);
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        toggle: async (requestedSessionId) => {
            const sessionId = requestedSessionId.trim();
            if (!sessionId) {
                throw new Error('dictation_session_required');
            }
            const attempt = active;
            if (!attempt) {
                return await start(sessionId);
            }
            if (attempt.cancelled) {
                // Navigation cancellation is intentionally prompt while a
                // recorder finalizes. A deliberate retry must instead wait
                // for that same attempt-owned teardown before reacquiring the
                // capture admission.
                await cleanup(attempt);
                // Another waiter can claim the now-released controller before
                // this one resumes. The active attempt remains the one
                // currentness fact for Dictation, so do not overwrite or
                // retire that winner with a second start.
                if (active !== null) {
                    return { kind: 'cancelled' };
                }
                return await start(sessionId);
            }
            if (attempt.failed) {
                cleanupInBackground(attempt);
                return { kind: 'cancelled' };
            }
            if (attempt.sessionId !== sessionId) {
                await cancel(attempt.sessionId, { awaitTeardown: true });
                return await start(sessionId);
            }
            if (snapshot.status === 'listening') {
                return await finishAttempt(attempt);
            }
            await cancel(sessionId);
            return { kind: 'cancelled' };
        },
    };
}
