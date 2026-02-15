function clampSample(x: number): number {
  if (x > 1) return 1;
  if (x < -1) return -1;
  return x;
}

function floatToPcm16(x: number): number {
  const clamped = clampSample(x);
  // PCM16: map [-1, 1] -> [-32768, 32767]
  if (clamped <= -1) return -32768;
  if (clamped >= 1) return 32767;
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
}

export function encodeWavPcm16(opts: { samples: Float32Array; sampleRate: number }): ArrayBuffer {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = opts.sampleRate * blockAlign;
  const dataSize = opts.samples.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      u8[offset + i] = text.charCodeAt(i) & 0xff;
    }
  };

  // RIFF header
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');

  // fmt chunk
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, opts.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  // samples
  let cursor = 44;
  for (let i = 0; i < opts.samples.length; i += 1) {
    view.setInt16(cursor, floatToPcm16(opts.samples[i] ?? 0), true);
    cursor += 2;
  }

  return buffer;
}

