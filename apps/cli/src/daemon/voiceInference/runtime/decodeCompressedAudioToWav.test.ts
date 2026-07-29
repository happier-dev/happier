import { describe, expect, it } from 'vitest';

import { VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT } from '@happier-dev/protocol';

import { buildDaemonSttDecodeFfmpegArgs } from './decodeCompressedAudioToWav';

describe('buildDaemonSttDecodeFfmpegArgs', () => {
  it('decodes to the canonical daemon STT PCM format (16 kHz mono pcm_s16le)', () => {
    const args = buildDaemonSttDecodeFfmpegArgs({
      inputFilePath: '/tmp/in.webm',
      outputFilePath: '/tmp/out.wav',
    });

    // Channel count comes from the centralized format, not a per-call magic number.
    const channelIndex = args.indexOf('-ac');
    expect(channelIndex).toBeGreaterThanOrEqual(0);
    expect(args[channelIndex + 1]).toBe(String(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.channelCount));

    const sampleRateIndex = args.indexOf('-ar');
    expect(sampleRateIndex).toBeGreaterThanOrEqual(0);
    expect(args[sampleRateIndex + 1]).toBe(String(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.sampleRateHz));

    const codecIndex = args.indexOf('-c:a');
    expect(codecIndex).toBeGreaterThanOrEqual(0);
    expect(args[codecIndex + 1]).toBe(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.ffmpegCodec);

    // Input/output paths are wired through and video is stripped.
    expect(args).toContain('/tmp/in.webm');
    expect(args[args.length - 1]).toBe('/tmp/out.wav');
    expect(args).toContain('-vn');
  });
});
