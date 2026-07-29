import * as ExpoSpeech from 'expo-speech';
import { acquireVoicePlaybackAudioMode } from '@/voice/runtime/voiceAudioMode';

/**
 * Speak `text` through the on-device speech engine.
 *
 * `onStart` is the transition-to-speaking hook: it fires from Expo Speech's
 * playback-start event, never merely because synthesis was requested. When
 * `signal` is already aborted (a barge-in landed before this call ran) we skip
 * `ExpoSpeech.speak()` entirely and never transition to speaking.
 */
export async function speakDeviceText(
    text: string,
    onStart?: () => void,
    opts?: Readonly<{ signal?: AbortSignal | null }>,
): Promise<void> {
    if (opts?.signal?.aborted) {
        // Pre-interrupt: a barge-in already advanced the playback epoch before
        // this chunk reached the device. Do not start audio.
        return;
    }

    const playbackLease = await acquireVoicePlaybackAudioMode('device-speech');
    try {
        if (opts?.signal?.aborted) {
            return;
        }
        return await new Promise<void>((resolve, reject) => {
            let settled = false;
            let started = false;
            const notifyStarted = () => {
                if (settled || started) return;
                started = true;
                try {
                    onStart?.();
                } catch {
                    // State notification must not break already-started speech.
                }
            };
            const done = () => {
                if (settled) return;
                settled = true;
                resolve();
            };
            const fail = (err: unknown) => {
                if (settled) return;
                settled = true;
                reject(err);
            };

            const onAbort = () => {
                // An interrupt landed mid-speak: stop the device engine and settle.
                stopDeviceSpeech();
                done();
            };
            opts?.signal?.addEventListener('abort', onAbort, { once: true });

            try {
                ExpoSpeech.speak(text, {
                    onStart: notifyStarted,
                    onDone: () => {
                        opts?.signal?.removeEventListener('abort', onAbort);
                        done();
                    },
                    onStopped: () => {
                        opts?.signal?.removeEventListener('abort', onAbort);
                        done();
                    },
                    onError: (err: unknown) => {
                        opts?.signal?.removeEventListener('abort', onAbort);
                        fail(err);
                    },
                } as any);
            } catch (err) {
                opts?.signal?.removeEventListener('abort', onAbort);
                fail(err);
            }
        });
    } finally {
        await playbackLease.release();
    }
}

export function stopDeviceSpeech(): void {
    try {
        ExpoSpeech.stop();
    } catch {
        // best-effort
    }
}
