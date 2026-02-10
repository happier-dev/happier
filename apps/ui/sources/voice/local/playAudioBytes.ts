import { Platform } from 'react-native';

export async function playAudioBytes(opts: {
    bytes: ArrayBuffer;
    format: 'mp3' | 'wav';
}): Promise<void> {
    if (Platform.OS !== 'web') {
        throw new Error('audio_not_supported');
    }

    const AudioCtor: any = (globalThis as any).Audio;
    if (typeof AudioCtor !== 'function') {
        throw new Error('audio_not_supported');
    }

    const mimeType = opts.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
    const blob = new Blob([opts.bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const audio = new AudioCtor(url);
    try {
        if (typeof audio?.addEventListener === 'function' && typeof URL.revokeObjectURL === 'function') {
            audio.addEventListener('ended', () => {
                try {
                    URL.revokeObjectURL(url);
                } catch {
                    // best-effort
                }
            });
        }
        await audio.play();
    } catch (err) {
        // On failure, try to revoke immediately.
        try {
            if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
        } catch {
            // best-effort
        }
        throw err;
    }
}

