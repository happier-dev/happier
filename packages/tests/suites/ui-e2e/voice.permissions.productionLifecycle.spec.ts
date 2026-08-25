import { expect, test, type BrowserContext, type Page } from '@playwright/test';
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

const run = createRunDirs({ runLabel: 'ui-e2e-voice-permissions' });

async function setMicrophonePermission(params: Readonly<{
  context: BrowserContext;
  page: Page;
  origin: string;
  setting: 'granted' | 'denied' | 'prompt';
}>): Promise<void> {
  const cdp = await params.context.newCDPSession(params.page);
  try {
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    if (!targetInfo.browserContextId) {
      throw new Error('voice permission QA requires the active Chromium browser context id');
    }
    await cdp.send('Browser.setPermission', {
      // Chromium 150 accepts the web Permissions API descriptor here; the
      // Playwright protocol type still exposes the retired internal spelling.
      permission: { name: 'microphone' as 'audioCapture' },
      setting: params.setting,
      origin: params.origin,
      browserContextId: targetInfo.browserContextId,
    });
  } finally {
    await cdp.detach();
  }
}

async function readMediaSnapshot(page: Page): Promise<Record<string, unknown>> {
  return JSON.parse((await page.getByTestId('voiceQa.media.snapshot').textContent()) ?? '{}') as Record<string, unknown>;
}

type ActiveMicrophonePermissionRevocationCapability = Readonly<{
  readyState: string | null;
  supported: boolean;
}>;

async function probeActiveMicrophonePermissionRevocationCapability(params: Readonly<{
  context: BrowserContext;
  page: Page;
  origin: string;
}>): Promise<ActiveMicrophonePermissionRevocationCapability> {
  await params.context.grantPermissions(['microphone'], { origin: params.origin });
  await expect.poll(() => params.page.evaluate(async () => (
    await navigator.permissions.query({ name: 'microphone' as PermissionName })
  ).state)).toBe('granted');

  await params.page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioTracks = stream.getAudioTracks();
    const [track] = audioTracks;
    if (!track || audioTracks.length !== 1 || track.readyState !== 'live') {
      for (const capturedTrack of stream.getTracks()) capturedTrack.stop();
      throw new Error('voice permission QA capability probe did not acquire one live audio track');
    }
    (window as typeof window & { __happierVoicePermissionRevocationProbe?: MediaStream })
      .__happierVoicePermissionRevocationProbe = stream;
  });

  try {
    await setMicrophonePermission({
      context: params.context,
      page: params.page,
      origin: params.origin,
      setting: 'denied',
    });
    await params.page.waitForTimeout(2_000);
    const current = await params.page.evaluate(() => {
      const stream = (window as typeof window & {
        __happierVoicePermissionRevocationProbe?: MediaStream;
      }).__happierVoicePermissionRevocationProbe;
      const audioTracks = stream?.getAudioTracks() ?? [];
      const [track] = audioTracks;
      return {
        audioTrackCount: audioTracks.length,
        readyState: track?.readyState ?? null,
        supported: track?.readyState === 'ended',
      };
    });
    return current;
  } finally {
    await params.page.evaluate(() => {
      const pageWindow = window as typeof window & {
        __happierVoicePermissionRevocationProbe?: MediaStream;
      };
      const stream = pageWindow.__happierVoicePermissionRevocationProbe;
      delete pageWindow.__happierVoicePermissionRevocationProbe;
      for (const track of stream?.getTracks() ?? []) track.stop();
    });
  }
}

test.describe('voice Q3: browser permission lifecycle', () => {
  test.describe.configure({ mode: 'serial' });
  const suiteDir = run.testDir('voice-permissions-production-lifecycle');
  let stack: VoiceBrowserQaStack | null = null;
  let boundary: VoiceQaBoundaryServer | null = null;

  test.beforeAll(async () => {
    test.setTimeout(resolveVoiceBrowserQaBeforeAllTimeoutMs());
    await mkdir(suiteDir, { recursive: true });
    boundary = await startVoiceQaBoundaryServer();
    stack = await startVoiceBrowserQaStack({
      suiteDir,
      storageScope: `e2e-voice-permissions-${run.runId}`,
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

  test('explicit denial settles with the canonical preflight permission error and no active track', async ({ context, page }, testInfo) => {
    test.setTimeout(360_000);
    if (!stack || !boundary) throw new Error('voice permission harness missing');
    await prepareVoiceBrowserQaPage({
      page,
      stack,
      sttBaseUrl: `${boundary.baseUrl}/v1`,
      routeQuery: { voiceQaMode: 'media' },
    });
    await setMicrophonePermission({
      context,
      page,
      origin: new URL(page.url()).origin,
      setting: 'denied',
    });

    await page.getByTestId('voiceQa.start').click();
    await expect.poll(async () => (await readMediaSnapshot(page)).errorCode, { timeout: 30_000 }).toBe(
      'mic_permission_denied',
    );
    const snapshot = await readMediaSnapshot(page);
    expect(snapshot.runtimeError).toMatchObject({
      kind: 'mic_permission_denied',
      phase: 'preflight',
      retryPolicy: 'user_action',
      recoveryAction: 'open_settings',
      presentation: 'permission_required',
    });
    const instrumentation = await page.evaluate(() => (
      (window as typeof window & { __happierVoiceMediaQa?: unknown }).__happierVoiceMediaQa ?? null
    ));
    expect(instrumentation).toMatchObject({ calls: 1, activeTracks: 0 });
    await testInfo.attach('voice-q3-denied.json', {
      body: Buffer.from(JSON.stringify({ snapshot, instrumentation }, null, 2)),
      contentType: 'application/json',
    });
  });

  test('explicit grant acquires one production track and releases it after the turn', async ({ context, page }, testInfo) => {
    test.setTimeout(360_000);
    if (!stack || !boundary) throw new Error('voice permission harness missing');
    await prepareVoiceBrowserQaPage({
      page,
      stack,
      sttBaseUrl: `${boundary.baseUrl}/v1`,
      routeQuery: { voiceQaMode: 'media' },
    });
    await context.grantPermissions(['microphone'], { origin: new URL(page.url()).origin });
    await expect.poll(() => page.evaluate(async () => (
      await navigator.permissions.query({ name: 'microphone' as PermissionName })
    ).state)).toBe('granted');
    await page.getByTestId('voiceQa.start').click();
    await expect.poll(async () => `${String((await readMediaSnapshot(page)).status)}:${String((await readMediaSnapshot(page)).mode)}`, {
      timeout: 60_000,
    }).toBe('connected:listening');
    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & { __happierVoiceMediaQa?: { activeTracks: number } })
        .__happierVoiceMediaQa?.activeTracks ?? 0
    )), { timeout: 30_000 }).toBe(1);
    await page.getByTestId('voiceQa.stop').click();
    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & { __happierVoiceMediaQa?: { activeTracks: number } })
        .__happierVoiceMediaQa?.activeTracks ?? -1
    )), { timeout: 30_000 }).toBe(0);
    await testInfo.attach('voice-q3-granted.json', {
      body: Buffer.from(JSON.stringify({ snapshot: await readMediaSnapshot(page) }, null, 2)),
      contentType: 'application/json',
    });
  });

  test('revoking permission after capture surfaces active-session recovery', async ({ context, page }, testInfo) => {
    test.setTimeout(360_000);
    if (!stack || !boundary) throw new Error('voice permission harness missing');
    await prepareVoiceBrowserQaPage({
      page,
      stack,
      sttBaseUrl: `${boundary.baseUrl}/v1`,
      routeQuery: { voiceQaMode: 'media' },
    });
    const origin = new URL(page.url()).origin;
    const revocationCapability = await probeActiveMicrophonePermissionRevocationCapability({ context, page, origin });
    await testInfo.attach('voice-q3-revocation-capability.json', {
      body: Buffer.from(JSON.stringify(revocationCapability, null, 2)),
      contentType: 'application/json',
    });
    test.skip(
      !revocationCapability.supported,
      `Chromium did not propagate active microphone permission revocation in the capability probe (track: ${revocationCapability.readyState ?? 'missing'}).`,
    );

    await context.grantPermissions(['microphone'], { origin });
    await expect.poll(() => page.evaluate(async () => (
      await navigator.permissions.query({ name: 'microphone' as PermissionName })
    ).state)).toBe('granted');
    await page.getByTestId('voiceQa.start').click();
    await expect.poll(async () => (await readMediaSnapshot(page)).mode, { timeout: 60_000 }).toBe('listening');
    await setMicrophonePermission({ context, page, origin, setting: 'denied' });
    await page.waitForTimeout(2_000);
    const snapshot = await readMediaSnapshot(page);
    const instrumentation = await page.evaluate(() => (
      (window as typeof window & { __happierVoiceMediaQa?: unknown }).__happierVoiceMediaQa ?? null
    ));
    await testInfo.attach('voice-q3-revoked.json', {
      body: Buffer.from(JSON.stringify({ snapshot, instrumentation }, null, 2)),
      contentType: 'application/json',
    });
    expect(snapshot).toMatchObject({
      status: 'error',
      errorCode: 'mic_permission_revoked',
      runtimeError: {
        kind: 'mic_permission_revoked',
        phase: 'active_session',
        retryPolicy: 'user_action',
        recoveryAction: 'open_settings_then_reconnect',
        presentation: 'error',
      },
    });
    expect(instrumentation).toMatchObject({ activeTracks: 0, stoppedTracks: 1 });
  });

  test.skip('prompt/unknown is browser-manual because headless Chromium cannot expose a user-operable permission prompt', () => {});
  test.skip('device removal is device-gated because fake-media Chromium does not expose a removable input device', () => {});
  test.skip('contention is device-gated because Chromium fake media intentionally permits concurrent tab capture', () => {});
});
