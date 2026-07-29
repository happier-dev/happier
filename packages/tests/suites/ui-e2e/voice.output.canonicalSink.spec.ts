import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { readVoiceFixture } from '../../src/testkit/voice/voiceFixture';
import {
  prepareVoiceBrowserQaPage,
  resolveVoiceBrowserQaBeforeAllTimeoutMs,
  startVoiceBrowserQaStack,
  startVoiceQaBoundaryServer,
  type VoiceBrowserQaStack,
  type VoiceQaBoundaryServer,
} from '../../src/testkit/uiE2e/voiceBrowserQaHarness';

const run = createRunDirs({ runLabel: 'ui-e2e-voice-output' });

type OutputArtifact = Readonly<{
  id: number;
  format: string;
  originalByteLength: number;
  capturedByteLength: number;
  truncated: boolean;
  lifecycle: string;
  errorCode: string | null;
}>;

type WavEvidence = Readonly<{
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataLength: number;
  durationMs: number;
  rms: number;
}>;

function parseOutputArtifactText(value: string | null): OutputArtifact | null {
  if (!value) return null;
  const parsed = JSON.parse(value) as OutputArtifact | null;
  return parsed;
}

function parsePcmWavEvidence(bytes: Buffer): WavEvidence {
  if (
    bytes.byteLength < 44
    || bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
    || bytes.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    throw new Error('voice_q4_artifact_invalid_wave');
  }

  let offset = 12;
  let format: Readonly<{
    audioFormat: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
  }> | null = null;
  let data: Buffer | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = bytes.subarray(offset, offset + 4).toString('ascii');
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > bytes.byteLength) throw new Error('voice_q4_artifact_truncated_chunk');
    if (chunkId === 'fmt ') {
      if (chunkLength < 16) throw new Error('voice_q4_artifact_invalid_format');
      format = {
        audioFormat: bytes.readUInt16LE(chunkStart),
        channels: bytes.readUInt16LE(chunkStart + 2),
        sampleRate: bytes.readUInt32LE(chunkStart + 4),
        bitsPerSample: bytes.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      data = bytes.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd + (chunkLength % 2);
  }
  if (!format || !data || format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new Error('voice_q4_artifact_requires_pcm16');
  }

  let squared = 0;
  const sampleCount = Math.floor(data.byteLength / 2);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const normalized = data.readInt16LE(sample * 2) / 32_768;
    squared += normalized * normalized;
  }
  const bytesPerSecond = format.sampleRate * format.channels * (format.bitsPerSample / 8);
  return {
    ...format,
    dataLength: data.byteLength,
    durationMs: (data.byteLength / bytesPerSecond) * 1_000,
    rms: Math.sqrt(squared / Math.max(sampleCount, 1)),
  };
}

async function readOutputArtifact(page: Page): Promise<Readonly<{
  artifact: OutputArtifact;
  bytes: Buffer;
}>> {
  const locator = page.getByTestId('voiceQa.output.artifact');
  const [artifactText, base64] = await Promise.all([
    locator.textContent(),
    page.getByTestId('voiceQa.output.artifactBytes').textContent(),
  ]);
  if (!artifactText || !base64) throw new Error('voice_q4_artifact_missing');
  return {
    artifact: JSON.parse(artifactText) as OutputArtifact,
    bytes: Buffer.from(base64, 'base64'),
  };
}

test.describe('voice Q4: canonical encoded-audio output sink', () => {
  test.describe.configure({ mode: 'serial' });
  const suiteDir = run.testDir('voice-output-canonical-sink');
  let stack: VoiceBrowserQaStack | null = null;
  let boundary: VoiceQaBoundaryServer | null = null;

  test.beforeAll(async () => {
    test.setTimeout(resolveVoiceBrowserQaBeforeAllTimeoutMs());
    await mkdir(suiteDir, { recursive: true });
    boundary = await startVoiceQaBoundaryServer();
    stack = await startVoiceBrowserQaStack({
      suiteDir,
      storageScope: `e2e-voice-output-${run.runId}`,
      routeProfile: 'direct',
    });
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await stack?.stopRunnableSessions().catch(() => {});
    await stack?.ui.stop().catch(() => {});
    await stack?.daemon.stop().catch(() => {});
    await stack?.server.stop().catch(() => {});
    await boundary?.stop().catch(() => {});
  });

  test('captures the completed WAV at the real local sink with format, duration, and energy evidence', async ({ page }, testInfo) => {
    test.setTimeout(360_000);
    if (!stack || !boundary) throw new Error('voice output harness missing');
    const fixture = await readVoiceFixture('short-command-24k');
    await prepareVoiceBrowserQaPage({
      page,
      stack,
      routeQuery: {
        voiceQaOutputCapture: '1',
        voiceQaOutputFixtureUrl: `${boundary.baseUrl}/audio.wav`,
      },
    });
    await page.getByTestId('voiceQa.output.playFixture').click();

    await expect.poll(async () => {
      const text = await page.getByTestId('voiceQa.output.artifact').textContent();
      return parseOutputArtifactText(text)?.lifecycle ?? null;
    }, { timeout: 120_000 }).toBe('completed');
    const captured = await readOutputArtifact(page);
    const wav = parsePcmWavEvidence(captured.bytes);

    expect(captured.artifact).toMatchObject({
      format: 'wav',
      originalByteLength: fixture.bytes.byteLength,
      capturedByteLength: fixture.bytes.byteLength,
      truncated: false,
      lifecycle: 'completed',
      errorCode: null,
    });
    expect(captured.bytes.equals(fixture.bytes)).toBe(true);
    expect(wav).toMatchObject({
      audioFormat: 1,
      channels: fixture.metadata.channels,
      sampleRate: fixture.metadata.sampleRate,
      bitsPerSample: 16,
    });
    expect(Math.abs(wav.durationMs - fixture.metadata.durationMs)).toBeLessThanOrEqual(1);
    expect(wav.rms).toBeGreaterThan(0.005);

    await testInfo.attach('voice-q4-completed.wav', {
      body: captured.bytes,
      contentType: 'audio/wav',
    });
    await testInfo.attach('voice-q4-completed.json', {
      body: Buffer.from(JSON.stringify({ artifact: captured.artifact, wav }, null, 2)),
      contentType: 'application/json',
    });
  });

  test('captures the same sink bytes and settles cancellation after playback has actually started', async ({ page }, testInfo) => {
    test.setTimeout(360_000);
    if (!stack || !boundary) throw new Error('voice output harness missing');
    const fixture = await readVoiceFixture('short-command-24k');
    await prepareVoiceBrowserQaPage({
      page,
      stack,
      routeQuery: {
        voiceQaOutputCapture: '1',
        voiceQaOutputFixtureUrl: `${boundary.baseUrl}/audio.wav`,
        voiceQaOutputCancelMs: '150',
      },
    });
    await page.getByTestId('voiceQa.output.playFixture').click();

    await expect.poll(async () => {
      const text = await page.getByTestId('voiceQa.output.artifact').textContent();
      return parseOutputArtifactText(text)?.lifecycle ?? null;
    }, { timeout: 120_000 }).toBe('cancelled');
    const captured = await readOutputArtifact(page);
    const wav = parsePcmWavEvidence(captured.bytes);

    expect(captured.artifact).toMatchObject({
      originalByteLength: fixture.bytes.byteLength,
      capturedByteLength: fixture.bytes.byteLength,
      truncated: false,
      lifecycle: 'cancelled',
      errorCode: null,
    });
    expect(captured.bytes.equals(fixture.bytes)).toBe(true);
    expect(wav.rms).toBeGreaterThan(0.005);

    await testInfo.attach('voice-q4-cancelled.wav', {
      body: captured.bytes,
      contentType: 'audio/wav',
    });
    await testInfo.attach('voice-q4-cancelled.json', {
      body: Buffer.from(JSON.stringify({ artifact: captured.artifact, wav }, null, 2)),
      contentType: 'application/json',
    });
  });
});
