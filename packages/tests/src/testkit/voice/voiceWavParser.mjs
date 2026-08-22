function toBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Parse and validate the canonical WAV container used by Voice fixtures.
 *
 * The returned data offset is relative to the supplied byte view. Consumers
 * that need the original Buffer may instead use dataBytes, which is a view of
 * that same input without a copy.
 */
export function parseVoiceWavContainer(bytes, id = 'voice-wav') {
  const wav = toBuffer(bytes);
  if (
    wav.byteLength < 44
    || wav.subarray(0, 4).toString('ascii') !== 'RIFF'
    || wav.subarray(8, 12).toString('ascii') !== 'WAVE'
    || wav.readUInt32LE(4) !== wav.byteLength - 8
  ) {
    throw new Error(`voice fixture is not a WAV file: ${id}`);
  }

  let format = null;
  let dataBytes = null;
  let dataOffset = null;
  for (let offset = 12; offset < wav.byteLength;) {
    if (offset + 8 > wav.byteLength) {
      throw new Error(`invalid voice fixture WAV chunk: ${id}`);
    }
    const chunkId = wav.subarray(offset, offset + 4).toString('ascii');
    const chunkSize = wav.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + chunkSize;
    const paddedEnd = payloadEnd + (chunkSize % 2);
    if (payloadEnd > wav.byteLength || paddedEnd > wav.byteLength) {
      throw new Error(`invalid voice fixture WAV chunk: ${id}`);
    }
    if (chunkId === 'fmt ') {
      if (format || chunkSize !== 16) {
        throw new Error(`invalid voice fixture WAV format chunk: ${id}`);
      }
      format = {
        audioFormat: wav.readUInt16LE(payloadOffset),
        channelCount: wav.readUInt16LE(payloadOffset + 2),
        sampleRateHz: wav.readUInt32LE(payloadOffset + 4),
        byteRate: wav.readUInt32LE(payloadOffset + 8),
        blockAlign: wav.readUInt16LE(payloadOffset + 12),
        bitsPerSample: wav.readUInt16LE(payloadOffset + 14),
      };
    } else if (chunkId === 'data') {
      if (dataBytes) {
        throw new Error(`duplicate voice fixture WAV data chunk: ${id}`);
      }
      dataBytes = wav.subarray(payloadOffset, payloadEnd);
      dataOffset = payloadOffset;
    }
    offset = paddedEnd;
  }

  if (
    !format
    || format.audioFormat !== 1
    || format.channelCount !== 1
    || !Number.isInteger(format.sampleRateHz)
    || format.sampleRateHz <= 0
    || format.byteRate !== format.sampleRateHz * 2
    || format.blockAlign !== 2
    || format.bitsPerSample !== 16
    || !dataBytes
    || dataBytes.byteLength === 0
    || dataBytes.byteLength % 2 !== 0
  ) {
    throw new Error(`voice fixture is not canonical PCM16 mono WAV: ${id}`);
  }

  return Object.freeze({
    format: Object.freeze(format),
    dataBytes,
    dataOffset,
  });
}
