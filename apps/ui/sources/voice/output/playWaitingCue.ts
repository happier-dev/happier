import { playAudioBytesWithStopper } from './playAudioBytesWithStopper';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';

/** A quiet finite earcon. These values shape the sound, not an operation deadline. */
export async function playWaitingCue(registerPlaybackStopper: VoicePlaybackStopperRegistrar): Promise<void> {
    const sampleRate = 16_000;
    const sampleCount = sampleRate / 4;
    const bytes = new ArrayBuffer(44 + sampleCount * 2);
    const wav = new DataView(bytes);
    const label = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) wav.setUint8(offset + i, text.charCodeAt(i));
    };
    label(0, 'RIFF'); wav.setUint32(4, bytes.byteLength - 8, true);
    label(8, 'WAVE'); label(12, 'fmt '); wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
    wav.setUint32(24, sampleRate, true); wav.setUint32(28, sampleRate * 2, true);
    wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
    label(36, 'data'); wav.setUint32(40, sampleCount * 2, true);
    for (let i = 0; i < sampleCount; i++) {
        const envelope = Math.sin(Math.PI * i / sampleCount) ** 2;
        const tone = Math.sin(2 * Math.PI * 440 * i / sampleRate);
        wav.setInt16(44 + i * 2, Math.round(0.08 * envelope * tone * 32767), true);
    }
    await playAudioBytesWithStopper({ bytes, format: 'wav', registerPlaybackStopper });
}
