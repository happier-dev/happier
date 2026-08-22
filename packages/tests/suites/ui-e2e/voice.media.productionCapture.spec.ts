import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { resolveUiWebSourceFingerprint } from '../../src/testkit/process/uiWebSourceFingerprint';
import {
  prepareVoiceBrowserQaPage,
  resolveVoiceBrowserQaBeforeAllTimeoutMs,
  startVoiceBrowserQaStack,
  startVoiceQaBoundaryServer,
  type VoiceBrowserQaStack,
  type VoiceQaBoundaryServer,
} from '../../src/testkit/uiE2e/voiceBrowserQaHarness';

const run = createRunDirs({ runLabel: 'ui-e2e-voice-media' });

test.describe('voice Q2: production capture with file-backed microphone', () => {
  test.describe.configure({ mode: 'serial' });
  const suiteDir = run.testDir('voice-media-production-capture');
  let stack: VoiceBrowserQaStack | null = null;
  let boundary: VoiceQaBoundaryServer | null = null;
  let uiSourceFingerprint: string | null = null;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(resolveVoiceBrowserQaBeforeAllTimeoutMs());
    // Pin the worker browser before the cold source-entrypoint daemon/Metro
    // bootstrap. Launching a nested Chromium process only after several
    // minutes of child-process startup is rejected intermittently by macOS's
    // Mach rendezvous service, while the already-owned worker browser remains
    // stable throughout the same bootstrap.
    void browser;
    await mkdir(suiteDir, { recursive: true });
    boundary = await startVoiceQaBoundaryServer();
    const uiSourceFingerprintBeforeStart = resolveUiWebSourceFingerprint();
    stack = await startVoiceBrowserQaStack({
      suiteDir,
      storageScope: `e2e-voice-media-${run.runId}`,
      routeProfile: 'direct',
    });
    uiSourceFingerprint = resolveUiWebSourceFingerprint();
    if (uiSourceFingerprint !== uiSourceFingerprintBeforeStart) {
      throw new Error('ui_source_changed_during_voice_media_runtime_bootstrap');
    }
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await stack?.stopRunnableSessions().catch(() => {});
    await stack?.ui.stop().catch(() => {});
    await stack?.daemon.stop().catch(() => {});
    await stack?.server.stop().catch(() => {});
    await boundary?.stop().catch(() => {});
  });

  test('records fixture speech through production capture, transcribes at the provider boundary, and cleans up', async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    if (!stack || !boundary) throw new Error('voice media harness missing');
    await page.setViewportSize({ width: 1440, height: 900 });
    await testInfo.attach('voice-q2-runtime-identity.json', {
      body: Buffer.from(JSON.stringify({
        sourceFingerprint: uiSourceFingerprint,
        uiMode: stack.ui.mode,
      }, null, 2)),
      contentType: 'application/json',
    });
    const { sessionId } = await prepareVoiceBrowserQaPage({
      page,
      stack,
      sttBaseUrl: `${boundary.baseUrl}/v1`,
      routeQuery: { voiceQaMode: 'media' },
    });

    const stateSequence: Array<Record<string, unknown>> = [];
    const snapshot = page.getByTestId('voiceQa.media.snapshot');
    const readSnapshot = async () => JSON.parse((await snapshot.textContent()) ?? '{}') as Record<string, unknown>;
    stateSequence.push(await readSnapshot());
    expect(stateSequence.at(-1)).toMatchObject({
      configuredProviderId: 'local_conversation',
      executionMachineId: stack.machineId,
      localSttProvider: 'happier.voice.openai-compat/stt',
      localSttBaseUrlConfigured: true,
    });

    await page.getByTestId('voiceQa.start').click();
    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & { __happierVoiceMediaQa?: { calls: number } })
        .__happierVoiceMediaQa?.calls ?? 0
    )), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(async () => {
      const next = await readSnapshot();
      stateSequence.push(next);
      return next;
    }, { timeout: 120_000 }).toMatchObject({ status: 'connected', mode: 'listening' });

    await expect.poll(async () => page.evaluate(() => {
      const qa = (window as typeof window & {
        __happierVoiceMediaQa?: { calls: number; maxInputLevel: number; activeTracks: number };
      }).__happierVoiceMediaQa;
      return qa ? { calls: qa.calls, maxInputLevel: qa.maxInputLevel, activeTracks: qa.activeTracks } : null;
    }), { timeout: 30_000 }).toMatchObject({ calls: 1, activeTracks: 1 });

    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & { __happierVoiceMediaQa?: { maxInputLevel: number } })
        .__happierVoiceMediaQa?.maxInputLevel ?? 0
    )), { timeout: 30_000 }).toBeGreaterThan(0.005);

    // The default file-backed fixture contains 1.875s of speech followed by
    // 0.9s of silence. RMS becoming non-zero proves that playback started,
    // not that the utterance finished; stopping immediately produced a valid
    // but 110-byte WebM header and never exercised transcription. Preserve a
    // complete recorded utterance before asking the production owner to stop.
    await page.waitForTimeout(3_000);

    // The same control finishes the active production local turn through the
    // local runtime owner, allowing recording -> STT -> send to settle.
    await page.getByTestId('voiceQa.stop').click();
    const stoppedSnapshot = await readSnapshot();
    stateSequence.push(stoppedSnapshot);
    await testInfo.attach('voice-q2-stop-state.json', {
      body: Buffer.from(JSON.stringify({
        stoppedSnapshot,
        media: await page.evaluate(() => (
          (window as typeof window & { __happierVoiceMediaQa?: unknown }).__happierVoiceMediaQa ?? null
        )),
      }, null, 2)),
      contentType: 'application/json',
    });
    await expect.poll(() => boundary?.getTranscriptionRequestCount() ?? 0, {
      message: `voice transcription did not reach the provider boundary; stopEvidence=${JSON.stringify({
        stoppedSnapshot,
        media: await page.evaluate(() => (
          (window as typeof window & { __happierVoiceMediaQa?: unknown }).__happierVoiceMediaQa ?? null
        )),
      })}`,
      timeout: 60_000,
    }).toBe(1);
    expect(boundary.getLastTranscriptionRequest()).toMatchObject({
      contentType: expect.stringMatching(/^multipart\/form-data;\s*boundary=/i),
      bodyByteLength: expect.any(Number),
    });
    expect(boundary.getLastTranscriptionRequest()?.bodyByteLength ?? 0).toBeGreaterThan(1_024);
    await expect.poll(async () => page.evaluate(() => {
      const qa = (window as typeof window & {
        __happierVoiceMediaQa?: { activeTracks: number; stoppedTracks: number };
      }).__happierVoiceMediaQa;
      return qa ? { activeTracks: qa.activeTracks, stoppedTracks: qa.stoppedTracks } : null;
    }), { timeout: 30_000 }).toMatchObject({ activeTracks: 0, stoppedTracks: 1 });

    stateSequence.push(await readSnapshot());
    await page.getByTestId('voiceQa.openConversation').click({ timeout: 30_000 });
    await page.waitForURL((url) => url.pathname === `/session/${sessionId}`, { timeout: 120_000 });
    const transcriptChatList = page.getByTestId('transcript-chat-list');
    await expect(transcriptChatList).toHaveCount(1, { timeout: 120_000 });
    await expect(transcriptChatList.getByText('check repository status', { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await testInfo.attach('voice-q2-production-capture.json', {
      body: Buffer.from(JSON.stringify({ sessionId, stateSequence }, null, 2)),
      contentType: 'application/json',
    });
  });
});
