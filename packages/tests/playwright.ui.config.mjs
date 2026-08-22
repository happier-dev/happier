// @ts-check
import { defineConfig } from '@playwright/test';
import {
  resolvePlaywrightUiHtmlReportDir,
  resolvePlaywrightUiTestResultsDir,
} from './scripts/playwrightUiArtifacts.shared.mjs';

const outputDir = resolvePlaywrightUiTestResultsDir(process.env);
const htmlReportDir = resolvePlaywrightUiHtmlReportDir(process.env);
const packedNovelHandoffEnabled = Boolean(
  process.env.HAPPIER_E2E_PACKED_NOVEL_QA_HANDOFF_MANIFEST?.trim(),
);
const triageGithubVoiceHandoffEnabled = Boolean(
  process.env.HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_HANDOFF_MANIFEST?.trim(),
);
const triageGithubVoiceMicrophoneFixturePath =
  process.env.HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_MICROPHONE_FIXTURE_PATH?.trim()
  || null;
if (
  triageGithubVoiceHandoffEnabled
  && !triageGithubVoiceMicrophoneFixturePath
) {
  throw new Error(
    'packed_triage_github_voice_browser_qa_blocked_microphone_fixture_required',
  );
}
if (
  !triageGithubVoiceHandoffEnabled
  && triageGithubVoiceMicrophoneFixturePath
) {
  throw new Error(
    'packed_triage_github_voice_browser_qa_blocked_microphone_fixture_requires_handoff',
  );
}
const credentialedHandoffEnabled = packedNovelHandoffEnabled
  || triageGithubVoiceHandoffEnabled;
const voiceLaunchArgs = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  ...(triageGithubVoiceHandoffEnabled
    ? [
      '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox',
      `--use-file-for-fake-audio-capture=${triageGithubVoiceMicrophoneFixturePath}`,
    ]
    : []),
  '--mute-audio',
];

export default defineConfig({
  testDir: 'suites/ui-e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: htmlReportDir }]]
    : [['list'], ['html', { outputFolder: htmlReportDir }]],
  outputDir,
  use: {
    testIdAttribute: 'data-testid',
    // The packed novel Connected Account lane owns one ephemeral HTTPS
    // authorization origin. Limit Chromium's fixture-CA trust exception to
    // the explicit handoff-backed exact-candidate invocation.
    ignoreHTTPSErrors: packedNovelHandoffEnabled,
    // Voice UI flows can touch `getUserMedia()` (mic checks, hands-free STT, realtime adapters).
    // In headless CI this can stall on permission prompts unless we pre-grant permissions and
    // force Chromium to use deterministic fake media devices.
    permissions: ['microphone'],
    launchOptions: {
      args: voiceLaunchArgs,
    },
    // Keep UI e2e deterministic by avoiding responsive split-view layouts.
    // A phone-sized viewport ensures a single primary navigation stack on Expo web.
    viewport: { width: 390, height: 844 },
    actionTimeout: 15_000,
    navigationTimeout: 90_000,
    trace: credentialedHandoffEnabled
      ? 'off'
      : process.env.HAPPIER_E2E_TRACE === '1'
        ? 'retain-on-failure'
        : 'on-first-retry',
    screenshot: credentialedHandoffEnabled ? 'off' : 'only-on-failure',
    // Video finalization can stall long enough that the heartbeat wrapper hits its global timeout,
    // which prevents teardown and leaks server/daemon processes. Use traces/screenshots for debugging in CI.
    video: credentialedHandoffEnabled
      ? 'off'
      : process.env.CI
        ? 'off'
        : 'retain-on-failure',
  },
});
