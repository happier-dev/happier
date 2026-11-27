import { describe, expect, it } from 'vitest';
import { NOTIFICATION_SOUND_SAMPLE_RATE, prepareNotificationSound } from './prepareNotificationSound';

describe('notification sound preparation', () => {
    it('stores only the first 30 seconds as mono PCM16 and matches the reference level', () => {
        const source = new Float32Array(31 * NOTIFICATION_SOUND_SAMPLE_RATE).fill(0.05);
        source.fill(1, 30 * NOTIFICATION_SOUND_SAMPLE_RATE);
        const { bytes, durationSeconds, truncated } = prepareNotificationSound([source]);
        const wav = new DataView(bytes);
        expect(truncated).toBe(true);
        expect(durationSeconds).toBe(30);
        expect(wav.getUint16(22, true)).toBe(1);
        expect(wav.getUint16(34, true)).toBe(16);
        expect(wav.getUint32(40, true)).toBe(30 * NOTIFICATION_SOUND_SAMPLE_RATE * 2);
        expect(20 * Math.log10(wav.getInt16(44, true) / 32767)).toBeCloseTo(-15.4, 1);
    });

    it('preserves headroom for a short transient', () => {
        const source = new Float32Array(NOTIFICATION_SOUND_SAMPLE_RATE);
        source[0] = 0.7;
        const { bytes } = prepareNotificationSound([source]);
        expect(20 * Math.log10(new DataView(bytes).getInt16(44, true) / 32767)).toBeCloseTo(-1, 1);
    });
});
