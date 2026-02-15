import * as ExpoSpeech from 'expo-speech';

export async function speakDeviceText(text: string, onStart?: () => void): Promise<void> {

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

        try {
            // Notify callers right before we invoke the device speech API.
            // This makes calling code (and tests) more deterministic.
            onStart?.();
            ExpoSpeech.speak(text, {
                onDone: done,
                onStopped: done,
                onError: fail,
            } as any);
        } catch (err) {
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
