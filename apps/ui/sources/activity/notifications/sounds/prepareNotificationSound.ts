import { encodeWavPcm16 } from '../../../voice/kokoro/audio/encodeWavPcm16.ts';

export const NOTIFICATION_SOUND_SAMPLE_RATE = 44_100;
export const NOTIFICATION_SOUND_MAX_SECONDS = 30;
export const NOTIFICATION_SOUND_MAX_BYTES = 44 + NOTIFICATION_SOUND_SAMPLE_RATE * NOTIFICATION_SOUND_MAX_SECONDS * 2;

const WINDOW_SAMPLES = Math.round(NOTIFICATION_SOUND_SAMPLE_RATE * 0.4);
const HOP_SAMPLES = Math.round(NOTIFICATION_SOUND_SAMPLE_RATE * 0.05);
const SOFT_REFERENCE_RMS = 10 ** (-15.4 / 20);
const PEAK_LIMIT = 10 ** (-1 / 20);

/** The decoder supplies 44.1 kHz PCM. Bundled and downloaded clips use the same leveller. */
export function prepareNotificationSound(channels: readonly Float32Array[]) {
    const sourceLength = channels[0]?.length ?? 0;
    if (sourceLength === 0) throw new Error('notification_sound_empty');
    const length = Math.min(sourceLength, NOTIFICATION_SOUND_SAMPLE_RATE * NOTIFICATION_SOUND_MAX_SECONDS);
    const samples = new Float32Array(length);
    for (const channel of channels) {
        for (let i = 0; i < length; i++) samples[i] += channel[i] / channels.length;
    }
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    const windowSize = Math.min(length, WINDOW_SAMPLES);
    let sum = 0;
    for (let i = 0; i < windowSize; i++) sum += samples[i] ** 2;
    let loudest = sum;
    for (let start = 0; start + windowSize < length;) {
        const advance = Math.min(HOP_SAMPLES, length - windowSize - start);
        for (let i = start; i < start + advance; i++) {
            sum += samples[i + windowSize] ** 2 - samples[i] ** 2;
        }
        start += advance;
        loudest = Math.max(loudest, sum);
    }
    const gain = peak > 0 ? Math.min(SOFT_REFERENCE_RMS / Math.sqrt(loudest / windowSize), PEAK_LIMIT / peak) : 1;
    for (let i = 0; i < length; i++) samples[i] *= gain;
    return {
        bytes: encodeWavPcm16({ samples, sampleRate: NOTIFICATION_SOUND_SAMPLE_RATE }),
        durationSeconds: length / NOTIFICATION_SOUND_SAMPLE_RATE,
        truncated: length < sourceLength,
        gainDb: 20 * Math.log10(gain),
    };
}
