import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import {
  prepareVoiceBrowserQaPage,
  resolveVoiceBrowserQaBeforeAllTimeoutMs,
  startVoiceBrowserQaStack,
  startVoiceQaBoundaryServer,
  type VoiceBrowserQaStack,
  type VoiceQaBoundaryServer,
} from '../../src/testkit/uiE2e/voiceBrowserQaHarness';
import { readVoiceFixture } from '../../src/testkit/voice/voiceFixture';

const run = createRunDirs({ runLabel: 'ui-e2e-voice-openai-compat-canary' });
const accountCredentials = {
  stt_api_key: 'account-stt-decoy',
  chat_api_key: 'account-chat-decoy',
  tts_api_key: 'account-tts-decoy',
} as const;
const machineCredentials = {
  stt_api_key: 'machine-stt-key',
  chat_api_key: 'machine-chat-key',
  tts_api_key: 'machine-tts-key',
} as const;

type OutputArtifact = Readonly<{
  format: string;
  originalByteLength: number;
  capturedByteLength: number;
  truncated: boolean;
  lifecycle: string;
  errorCode: string | null;
}>;

test.describe('voice G5.1: OpenAI-compatible advertised-mode canary', () => {
  test.describe.configure({ mode: 'serial' });
  const suiteDir = run.testDir('voice-openai-compat-canary');
  let stack: VoiceBrowserQaStack | null = null;
  let boundary: VoiceQaBoundaryServer | null = null;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(resolveVoiceBrowserQaBeforeAllTimeoutMs());
    void browser;
    await mkdir(suiteDir, { recursive: true });
    boundary = await startVoiceQaBoundaryServer({
      requiredAuthorization: {
        transcription: `Bearer ${machineCredentials.stt_api_key}`,
        chat: `Bearer ${machineCredentials.chat_api_key}`,
        speech: `Bearer ${machineCredentials.tts_api_key}`,
      },
    });
    stack = await startVoiceBrowserQaStack({
      suiteDir,
      storageScope: `e2e-voice-openai-compat-${run.runId}`,
      routeProfile: 'direct',
      accountMode: 'data_key',
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

  test('runs generated speech through selected-daemon STT, chat, TTS, transcript, playback, and cleanup', async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    if (!stack || !boundary) throw new Error('voice OpenAI-compatible canary harness missing');
    const outputFixture = await readVoiceFixture('short-command-24k');
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepareVoiceBrowserQaPage({
      page,
      stack,
      openAiCompatCanary: {
        baseUrl: `${boundary.baseUrl}/v1`,
        accountCredentials,
        machineCredentials,
      },
      routeQuery: {
        voiceQaMode: 'media',
        voiceQaOutputCapture: '1',
      },
    });

    await page.getByTestId('voiceQa.start').click();
    await expect.poll(async () => {
      const raw = await page.getByTestId('voiceQa.media.snapshot').textContent();
      return JSON.parse(raw ?? '{}') as Record<string, unknown>;
    }, { timeout: 120_000 }).toMatchObject({
      status: 'connected',
      mode: 'listening',
      configuredProviderId: 'local_conversation',
      executionMachineId: stack.machineId,
      localSttProvider: 'openai_compat',
      localSttBaseUrlConfigured: true,
    });

    await page.waitForTimeout(3_000);
    await page.getByTestId('voiceQa.stop').click();

    await expect.poll(() => boundary?.getRequests().map((request) => request.operation) ?? [], {
      timeout: 120_000,
    }).toEqual(['transcription', 'chat', 'speech']);
    const requests = boundary.getRequests();
    expect(requests).toEqual([
      expect.objectContaining({
        operation: 'transcription',
        authorization: `Bearer ${machineCredentials.stt_api_key}`,
        contentType: expect.stringMatching(/^multipart\/form-data;\s*boundary=/iu),
        bodyByteLength: expect.any(Number),
      }),
      expect.objectContaining({
        operation: 'chat',
        authorization: `Bearer ${machineCredentials.chat_api_key}`,
        bodyText: expect.stringContaining('check repository status'),
      }),
      expect.objectContaining({
        operation: 'speech',
        authorization: `Bearer ${machineCredentials.tts_api_key}`,
        bodyText: expect.stringContaining('The repository status is ready.'),
      }),
    ]);
    expect(requests[0]?.bodyByteLength ?? 0).toBeGreaterThan(1_024);
    expect(JSON.stringify(requests)).not.toContain('account-');
    const settledSnapshot = JSON.parse(
      (await page.getByTestId('voiceQa.media.snapshot').textContent()) ?? '{}',
    ) as {
      machineRpcReceipts?: Array<{ method?: string }>;
    };
    const receiptedMethods = settledSnapshot.machineRpcReceipts?.map((receipt) => receipt.method) ?? [];
    expect(receiptedMethods).toContain('daemon.voiceOpenAiCompat.chat');
    expect(receiptedMethods).toContain('daemon.voiceOpenAiCompat.synthesize');

    await expect(page.getByText('check repository status', { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(page.getByText('The repository status is ready.', { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect.poll(async () => {
      const raw = await page.getByTestId('voiceQa.output.artifact').textContent();
      return JSON.parse(raw ?? 'null') as OutputArtifact | null;
    }, { timeout: 120_000 }).toMatchObject({
      format: 'wav',
      originalByteLength: outputFixture.bytes.byteLength,
      capturedByteLength: outputFixture.bytes.byteLength,
      truncated: false,
      lifecycle: 'completed',
      errorCode: null,
    });
    const outputBytesBase64 = await page.getByTestId('voiceQa.output.artifactBytes').textContent();
    expect(Buffer.from(outputBytesBase64 ?? '', 'base64').equals(outputFixture.bytes)).toBe(true);
    await expect.poll(async () => page.evaluate(() => {
      const qa = (window as typeof window & {
        __happierVoiceMediaQa?: { activeTracks: number; stoppedTracks: number };
      }).__happierVoiceMediaQa;
      return qa ? { activeTracks: qa.activeTracks, stoppedTracks: qa.stoppedTracks } : null;
    }), { timeout: 30_000 }).toMatchObject({ activeTracks: 0, stoppedTracks: 2 });

    await testInfo.attach('voice-openai-compat-canary.json', {
      body: Buffer.from(JSON.stringify({
        machineId: stack.machineId,
        requests: requests.map((request) => ({
          operation: request.operation,
          authorizationSource: request.authorization.startsWith('Bearer machine-')
            ? 'machine_override'
            : 'unexpected',
          contentType: request.contentType,
          bodyByteLength: request.bodyByteLength,
        })),
      }, null, 2)),
      contentType: 'application/json',
    });
  });
});
