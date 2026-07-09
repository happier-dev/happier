import * as ExpoSpeech from 'expo-speech';

/**
 * Speak `text` through the on-device speech engine.
 *
 * `onStart` is the transition-to-speaking hook: it fires immediately before we
 * invoke the device speech API, and ONLY if we actually decide to speak. When
 * `signal` is already aborted (a barge-in landed before this call ran) we skip
 * `ExpoSpeech.speak()` entirely and never transition to speaking — mirroring the
 * pre-interrupt skip the {@link DaemonTtsController} performs at the synth
 * boundary, so a stale queued chunk cannot start audio after an interrupt.
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

    return await new Promise<void>((resolve, reject) => {
        let settled = false;
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
            // Notify callers right before we invoke the device speech API.
            // This makes calling code (and tests) more deterministic, and keeps
            // the speaking transition tied to actually starting audio.
            onStart?.();
            ExpoSpeech.speak(text, {
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
}

export function stopDeviceSpeech(): void {
    try {
        ExpoSpeech.stop();
    } catch {
        // best-effort
    }
}
