import { describe, expect, it } from 'vitest';

import { encodeWavPcm16 } from '@/voice/kokoro/audio/encodeWavPcm16';

function bytesToAscii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

describe('encodeWavPcm16', () => {
  it('encodes a valid mono PCM16 WAV header', () => {
    const wav = encodeWavPcm16({ samples: new Float32Array([0]), sampleRate: 24000 });
    const u8 = new Uint8Array(wav);

    expect(bytesToAscii(u8.slice(0, 4))).toBe('RIFF');
    expect(bytesToAscii(u8.slice(8, 12))).toBe('WAVE');
    expect(bytesToAscii(u8.slice(12, 16))).toBe('fmt ');
    expect(bytesToAscii(u8.slice(36, 40))).toBe('data');

    const dv = new DataView(wav);
    const chunkSize = dv.getUint32(4, true);
    const audioFormat = dv.getUint16(20, true);
    const numChannels = dv.getUint16(22, true);
    const sampleRate = dv.getUint32(24, true);
    const byteRate = dv.getUint32(28, true);
    const blockAlign = dv.getUint16(32, true);
    const bitsPerSample = dv.getUint16(34, true);
    const dataSize = dv.getUint32(40, true);

    expect(audioFormat).toBe(1);
    expect(numChannels).toBe(1);
    expect(sampleRate).toBe(24000);
    expect(bitsPerSample).toBe(16);
    expect(blockAlign).toBe(2);
    expect(byteRate).toBe(24000 * 2);
    expect(dataSize).toBe(2);

    expect(u8.length).toBe(44 + 2);
    expect(chunkSize).toBe(u8.length - 8);
  });

  it('clamps and scales float samples to PCM16', () => {
    const wav = encodeWavPcm16({ samples: new Float32Array([-2, -1, 0, 1, 2]), sampleRate: 24000 });
    const dv = new DataView(wav);

    const s0 = dv.getInt16(44 + 0, true);
    const s1 = dv.getInt16(44 + 2, true);
    const s2 = dv.getInt16(44 + 4, true);
    const s3 = dv.getInt16(44 + 6, true);
    const s4 = dv.getInt16(44 + 8, true);

    expect(s0).toBe(-32768);
    expect(s1).toBe(-32768);
    expect(s2).toBe(0);
    expect(s3).toBe(32767);
    expect(s4).toBe(32767);
  });
});

