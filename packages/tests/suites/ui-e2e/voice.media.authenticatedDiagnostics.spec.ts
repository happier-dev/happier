import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import {
  prepareVoiceBrowserQaPage,
  resolveVoiceBrowserQaBeforeAllTimeoutMs,
  startVoiceBrowserQaStack,
  type VoiceBrowserQaStack,
} from '../../src/testkit/uiE2e/voiceBrowserQaHarness';
import {
  waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { readKnownVoiceFixtureByPath } from '../../src/testkit/voice/voiceFixture';

const ZIPFORMER_PACK_ID = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
const ZIPFORMER_MANIFEST_URL =
  `https://github.com/happier-dev/happier-assets/releases/download/model-packs/${ZIPFORMER_PACK_ID}__manifest.json`;
const ARTIFACT_TEST_ID_PREFIX = 'settings-voice-diagnostics-artifact-';
const PRIVATE_AUDIO_FILE_PATTERN = /\.(?:aac|flac|m4a|mp3|mp4|mpeg|ogg|opus|pcm|pcm16|wav|webm)$/i;
const run = createRunDirs({ runLabel: 'ui-e2e-voice-authenticated-diagnostics' });

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function listPrivateAudioFiles(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && PRIVATE_AUDIO_FILE_PATTERN.test(entry.name)) paths.push(path);
    }
  };
  await visit(root);
  return paths.sort();
}

async function gotoVoiceSettings(page: Page): Promise<void> {
  const currentPathname = new URL(page.url()).pathname;
  if (currentPathname !== '/settings/voice') {
    if (currentPathname !== '/dev/voice-qa') {
      throw new Error(`voice_g6_3_unexpected_settings_origin:${currentPathname}`);
    }

    const settingsNavigation = page.getByTestId('nav-settings');
    await expect(settingsNavigation).toHaveCount(1, { timeout: 60_000 });
    await settingsNavigation.click();
    await waitForAuthenticatedRouteUi({
      page,
      expectedPathname: '/settings',
      requiredTestIds: ['settings-sidebar'],
      blockedTestIds: ['welcome-create-account'],
      timeoutMs: 120_000,
      reloadOnFailure: false,
    });

    const voiceSettingsNavigation = page.getByTestId('settings-sidebar.item.voice');
    await expect(voiceSettingsNavigation).toHaveCount(1, { timeout: 60_000 });
    await voiceSettingsNavigation.click();
  }

  await waitForAuthenticatedRouteUi({
    page,
    expectedPathname: '/settings/voice',
    requiredTestIds: [
      'settings-voice-diagnostics-enabled',
      'settings-voice-diagnostics-delete-all',
    ],
    blockedTestIds: ['welcome-create-account'],
    timeoutMs: 300_000,
    reloadOnFailure: false,
  });
}

async function gotoVoiceQaMedia(
  page: Page,
  stack: Pick<VoiceBrowserQaStack, 'machineId'>,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; new URL(page.url()).pathname !== '/dev/voice-qa' && attempt < 3; attempt += 1) {
    const previousUrl = page.url();
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(() => page.url(), { timeout: 60_000 }).not.toBe(previousUrl);
  }
  if (new URL(page.url()).pathname !== '/dev/voice-qa') {
    throw new Error(`voice_g6_3_qa_history_unavailable:${new URL(page.url()).pathname}`);
  }
  await waitForAuthenticatedRouteUi({
    page,
    expectedPathname: '/dev/voice-qa',
    requiredTestIds: [
      'voiceQa.sessionIdInput',
      'voiceQa.start',
      'voiceQa.stop',
      'voiceQa.media.snapshot',
    ],
    blockedTestIds: ['welcome-create-account'],
    timeoutMs: 300_000,
    reloadOnFailure: false,
  });
  await expect.poll(async () => {
    const raw = await page.getByTestId('voiceQa.media.snapshot').textContent();
    try {
      const snapshot = JSON.parse(raw ?? '{}') as Record<string, unknown>;
      return {
        executionMachineId: snapshot.executionMachineId,
        localSttProvider: snapshot.localSttProvider,
        status: snapshot.status,
      };
    } catch {
      return {};
    }
  }, { timeout: 180_000 }).toMatchObject({
    executionMachineId: stack.machineId,
    localSttProvider: 'local_neural',
  });
  await page.getByTestId('voiceQa.sessionIdInput').fill(sessionId);
}

async function setDiagnosticsEnabled(page: Page, enabled: boolean): Promise<void> {
  const control = page.getByTestId('settings-voice-diagnostics-enabled-switch');
  await expect(control).toHaveCount(1, { timeout: 60_000 });
  if (await control.isChecked() === enabled) return;
  await control.click({ force: true });
  if (enabled) {
    await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('web-modal-confirm').click();
  }
  if (enabled) await expect(control).toBeChecked({ timeout: 60_000 });
  else await expect(control).not.toBeChecked({ timeout: 60_000 });
}

async function waitForVoiceMediaStop(page: Page): Promise<void> {
  await expect.poll(async () => {
    const raw = await page.getByTestId('voiceQa.daemonSpeechTransport.snapshot').textContent();
    try {
      const snapshot = JSON.parse(raw ?? '{}') as {
        lastBinaryTunnelReceipt?: { relayEvidence?: unknown };
      };
      return snapshot.lastBinaryTunnelReceipt?.relayEvidence ?? null;
    } catch {
      return null;
    }
  }, { timeout: 180_000 }).toBe('finish_authenticated');
  await expect.poll(async () => page.evaluate(() => (
    (window as typeof window & { __happierVoiceMediaQa?: { activeTracks: number } })
      .__happierVoiceMediaQa?.activeTracks ?? -1
  )), { timeout: 60_000 }).toBe(0);
}

test.describe('voice G6.3: authenticated diagnostics settings to daemon filesystem', () => {
  test.describe.configure({ mode: 'serial' });
  const suiteDir = run.testDir('voice-authenticated-diagnostics-relay');
  let stack: VoiceBrowserQaStack | null = null;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(Math.max(resolveVoiceBrowserQaBeforeAllTimeoutMs(), 600_000));
    void browser;
    await mkdir(suiteDir, { recursive: true });
    stack = await startVoiceBrowserQaStack({
      suiteDir,
      storageScope: `e2e-voice-authenticated-diagnostics-${run.runId}`,
      routeProfile: 'relay',
      accountMode: 'data_key',
      daemonSttModel: {
        packId: ZIPFORMER_PACK_ID,
        manifestUrl: ZIPFORMER_MANIFEST_URL,
      },
    });
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    await stack?.stopRunnableSessions().catch(() => {});
    await stack?.ui.stop().catch(() => {});
    await stack?.daemon.stop().catch(() => {});
    await stack?.server.stop().catch(() => {});
  });

  test('uses authenticated SPA navigation between the Voice QA and diagnostics settings routes', async ({ page }) => {
    test.setTimeout(480_000);
    if (!stack) throw new Error('voice authenticated diagnostics harness missing');
    await page.setViewportSize({ width: 1440, height: 900 });

    const { sessionId } = await prepareVoiceBrowserQaPage({
      page,
      stack,
      daemonSttModelPackId: ZIPFORMER_PACK_ID,
      routeQuery: { voiceQaMode: 'media' },
    });

    await gotoVoiceSettings(page);
    await expect(page.getByTestId('settings-voice-diagnostics-enabled')).toHaveCount(1);
    await gotoVoiceQaMedia(page, stack, sessionId);
    await expect(page.getByTestId('voiceQa.sessionIdInput')).toHaveValue(sessionId);
  });

  test('consents in production settings, captures generated STT input, reconciles restart, exports, revokes, and deletes', async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    if (!stack) throw new Error('voice authenticated diagnostics harness missing');
    const fixturePath = testInfo.project.metadata.voiceQaFixturePath;
    if (typeof fixturePath !== 'string' || !isAbsolute(fixturePath)) {
      throw new Error('voice_g6_3_fixture_path_missing');
    }
    const fixture = await readKnownVoiceFixtureByPath(fixturePath);
    const captureDurationMs = Math.min((fixture?.metadata.durationMs ?? 8_000) + 500, 9_000);
    const expectedDiagnosticsRoot = join(stack.daemon.happyHomeDir, 'voice', 'diagnostics', 'v1');
    await page.setViewportSize({ width: 1440, height: 900 });

    const { sessionId } = await prepareVoiceBrowserQaPage({
      page,
      stack,
      daemonSttModelPackId: ZIPFORMER_PACK_ID,
      routeQuery: { voiceQaMode: 'media' },
    });

    await gotoVoiceSettings(page);
    await expect(page.getByTestId('settings-voice-diagnostics-status-inactive'))
      .toHaveCount(1, { timeout: 120_000 });
    await setDiagnosticsEnabled(page, true);
    await expect(page.getByTestId('settings-voice-diagnostics-status-active'))
      .toHaveCount(1, { timeout: 120_000 });

    await gotoVoiceQaMedia(page, stack, sessionId);
    await page.getByTestId('voiceQa.start').click();
    await expect.poll(async () => {
      const raw = await page.getByTestId('voiceQa.media.snapshot').textContent();
      try {
        const snapshot = JSON.parse(raw ?? '{}') as Record<string, unknown>;
        return { status: snapshot.status, mode: snapshot.mode };
      } catch {
        return {};
      }
    }, { timeout: 120_000 }).toMatchObject({ status: 'connected', mode: 'listening' });
    await expect.poll(async () => page.evaluate(() => (
      (window as typeof window & { __happierVoiceMediaQa?: { maxInputLevel: number } })
        .__happierVoiceMediaQa?.maxInputLevel ?? 0
    )), { timeout: 60_000 }).toBeGreaterThan(0.005);
    await page.waitForTimeout(captureDurationMs);
    await page.getByTestId('voiceQa.stop').click();
    await waitForVoiceMediaStop(page);
    await expect.poll(async () => {
      const [audioPath] = await listPrivateAudioFiles(expectedDiagnosticsRoot);
      if (!audioPath || !audioPath.toLowerCase().endsWith('.wav')) return false;
      try {
        return (await stat(audioPath.slice(0, -'.wav'.length) + '.json')).isFile();
      } catch {
        return false;
      }
    }, {
      message: 'diagnostics capture did not commit to the real daemon filesystem',
      timeout: 120_000,
    }).toBe(true);

    await gotoVoiceSettings(page);
    await expect(page.getByTestId('settings-voice-diagnostics-status-active'))
      .toHaveCount(1, { timeout: 120_000 });
    const artifact = page.locator(`[data-testid^="${ARTIFACT_TEST_ID_PREFIX}"]`).first();
    await expect(artifact).toHaveCount(1, { timeout: 180_000 });
    const artifactTestId = await artifact.getAttribute('data-testid');
    if (!artifactTestId?.startsWith(ARTIFACT_TEST_ID_PREFIX)) {
      throw new Error('voice_g6_3_artifact_test_id_missing');
    }
    const artifactId = artifactTestId.slice(ARTIFACT_TEST_ID_PREFIX.length);
    const root = (await page.getByTestId('settings-voice-diagnostics-root').textContent())?.trim() ?? '';
    if (!isAbsolute(root)) throw new Error('voice_g6_3_diagnostics_root_missing');
    expect(root).toBe(expectedDiagnosticsRoot);
    const sourcePath = join(root, `${artifactId}.wav`);
    const sourceBytesBeforeRestart = await readFile(sourcePath);
    expect(sourceBytesBeforeRestart.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(sourceBytesBeforeRestart.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(sourceBytesBeforeRestart.byteLength).toBeGreaterThan(44);

    const daemonPidBeforeRestart = stack.daemon.state.pid;
    const restartedDaemon = await stack.restartDaemon();
    expect(restartedDaemon.state.pid).not.toBe(daemonPidBeforeRestart);
    // Remount the production settings screen so the following status and
    // artifact assertions come from the restarted daemon, not retained React
    // state from the pre-restart status request.
    await gotoVoiceQaMedia(page, stack, sessionId);
    await gotoVoiceSettings(page);
    await expect(page.getByTestId('settings-voice-diagnostics-status-active'))
      .toHaveCount(1, { timeout: 180_000 });
    await expect(page.getByTestId(artifactTestId)).toHaveCount(1, { timeout: 180_000 });
    expect((await stat(sourcePath)).isFile()).toBe(true);
    expect(await listPrivateAudioFiles(stack.daemon.happyHomeDir)).toEqual([sourcePath]);

    await page.getByTestId(artifactTestId).click();
    await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 });
    await page.getByTestId('web-modal-confirm').click();
    const download = await downloadPromise;
    const downloadedPath = await download.path();
    if (!downloadedPath) throw new Error('voice_g6_3_download_path_missing');
    const exportedBytes = await readFile(downloadedPath);
    expect(exportedBytes.equals(sourceBytesBeforeRestart)).toBe(true);

    await setDiagnosticsEnabled(page, false);
    await expect(page.getByTestId('settings-voice-diagnostics-status-inactive'))
      .toHaveCount(1, { timeout: 120_000 });
    await gotoVoiceQaMedia(page, stack, sessionId);
    await page.getByTestId('voiceQa.start').click();
    await expect.poll(async () => {
      const raw = await page.getByTestId('voiceQa.media.snapshot').textContent();
      try {
        const snapshot = JSON.parse(raw ?? '{}') as Record<string, unknown>;
        return { status: snapshot.status, mode: snapshot.mode };
      } catch {
        return {};
      }
    }, { timeout: 120_000 }).toMatchObject({ status: 'connected', mode: 'listening' });
    await page.waitForTimeout(1_500);
    await page.getByTestId('voiceQa.stop').click();
    await waitForVoiceMediaStop(page);
    // A revoked capture would be published asynchronously if the daemon still
    // admitted it, so give that boundary a short settlement window before
    // asserting the retained-filesystem cardinality remains unchanged.
    await page.waitForTimeout(2_000);
    expect(await listPrivateAudioFiles(stack.daemon.happyHomeDir)).toEqual([sourcePath]);

    await gotoVoiceSettings(page);
    await expect(page.getByTestId('settings-voice-diagnostics-status-inactive'))
      .toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(artifactTestId)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.locator(`[data-testid^="${ARTIFACT_TEST_ID_PREFIX}"]`)).toHaveCount(1);
    const deleteAll = page.getByTestId('settings-voice-diagnostics-delete-all');
    await expect(deleteAll).toBeEnabled({ timeout: 60_000 });
    await deleteAll.click();
    await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('web-modal-confirm').click();
    await expect(page.locator(`[data-testid^="${ARTIFACT_TEST_ID_PREFIX}"]`))
      .toHaveCount(0, { timeout: 120_000 });
    await expect.poll(async () => {
      try {
        await stat(sourcePath);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
    }, { timeout: 60_000 }).toBe(true);
    expect(await listPrivateAudioFiles(stack.daemon.happyHomeDir)).toEqual([]);

    expect(await page.evaluate((absoluteFixturePath) => {
      const serializedStorage = Object.keys(window.localStorage)
        .map((key) => window.localStorage.getItem(key) ?? '')
        .join('\n');
      return {
        urlContainsFixture: window.location.href.includes(absoluteFixturePath),
        storageContainsFixture: serializedStorage.includes(absoluteFixturePath),
      };
    }, fixturePath)).toEqual({
      urlContainsFixture: false,
      storageContainsFixture: false,
    });

    await testInfo.attach('voice-g6.3-authenticated-diagnostics.json', {
      body: Buffer.from(JSON.stringify({
        runtimeIdentity: {
          serverBaseUrl: stack.server.baseUrl,
          serverPid: stack.server.proc.child.pid ?? null,
          uiBaseUrl: stack.uiBaseUrl,
          uiPid: stack.ui.proc?.child.pid ?? null,
          daemonPidBeforeRestart,
          daemonPidAfterRestart: restartedDaemon.state.pid,
          daemonStartTimeAfterRestart: restartedDaemon.state.startTime ?? null,
          daemonCliVersion: restartedDaemon.state.startedWithCliVersion ?? null,
          machineId: stack.machineId,
          accountMode: 'data_key',
          routeProfile: stack.routeProfile,
          modelPackId: stack.daemonSttModelPackId,
        },
        fixture: {
          id: fixture?.metadata.id ?? null,
          sha256: fixture?.metadata.sha256 ?? sha256Hex(await readFile(fixturePath)),
          captureDurationMs,
        },
        artifact: {
          id: artifactId,
          byteLength: sourceBytesBeforeRestart.byteLength,
          sha256: sha256Hex(sourceBytesBeforeRestart),
          exportedSha256: sha256Hex(exportedBytes),
        },
      }, null, 2)),
      contentType: 'application/json',
    });
  });
});
