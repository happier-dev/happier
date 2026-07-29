import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { buildBackendTargetKeyV2, SessionModelSelectionIntentV1Schema } from '@happier-dev/protocol';

import {
  accountScopedCryptoMaterialFromCliAccessKey,
  readCliAccessKey,
  type CliAccessKey,
} from '../../src/testkit/cliAccessKey';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import {
  countFakeClaudeEventsAfterCurrentRunSentinel,
  fakeClaudeFixturePath,
  waitForFakeClaudeInvocation,
} from '../../src/testkit/fakeClaude';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import {
  buildLmStudioProviderUiE2eSettings,
  hasProviderUiE2eConnectionGrant,
  PROVIDER_UI_E2E_MODEL_ID,
  replaceProviderUiE2eSettings,
  revokeProviderUiE2eConnectionGrants,
} from '../../src/testkit/providers/uiE2eProviderSettings';
import {
  startProviderUiE2eEndpoint,
  type StartedProviderUiE2eEndpoint,
} from '../../src/testkit/providers/uiE2eProviderEndpoint';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionMetadataV2 } from '../../src/testkit/sessionHandoffMetadata';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';
import { enableEnhancedSessionWizard } from '../../src/testkit/uiE2e/enableEnhancedSessionWizard';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const CONNECTION_ID = 'pc_e2e_lmstudio_1';
const CLAUDE_AGENT_TARGET_KEY = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });

function providerModelSelectionKey(): string {
  return JSON.stringify([CLAUDE_AGENT_TARGET_KEY, CONNECTION_ID, PROVIDER_UI_E2E_MODEL_ID]);
}

function machineKeysFromAccessKey(accessKey: CliAccessKey): Uint8Array[] {
  const material = accountScopedCryptoMaterialFromCliAccessKey(accessKey);
  return [material.type === 'legacy' ? material.secret : material.machineKey];
}

async function selectProviderModel(page: Page, options: Readonly<{
  expectExperimentalConfirmation: boolean;
}>): Promise<void> {
  const agentChip = page.getByTestId('agent-input-agent-chip');
  await expect(agentChip).toBeVisible({ timeout: 120_000 });
  await agentChip.click();
  await page.getByTestId('model-picker-overlay-search').fill('Provider E2E Model');
  const selectionKey = providerModelSelectionKey();
  const providerModel = page.getByTestId(`model-picker-overlay-option:${selectionKey}`);
  await expect(providerModel).toBeVisible({ timeout: 120_000 });
  await providerModel.click();
  if (options.expectExperimentalConfirmation) {
    const confirm = page.getByTestId('web-modal-confirm');
    await expect(confirm).toHaveCount(1, { timeout: 120_000 });
    await confirm.click();
  }
  // Deliberately do not add a post-confirmation settling delay here. The submit
  // owner must keep launch disabled until the exact selection transaction commits.
}

async function submitNewSession(page: Page, prompt: string): Promise<void> {
  await page.getByTestId('new-session-composer-input').fill(prompt);
  await page.getByTestId('new-session-composer-send').click();
}

function sessionIdFromUrl(url: string): string | null {
  const match = new URL(url).pathname.match(/\/session\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test.describe('ui e2e: Provider model selection', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-provider-model-selection-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
  const fakeClaudeLogPath = resolve(join(suiteDir, 'fake-claude.jsonl'));
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let daemon: StartedDaemon | null = null;
  let providerEndpoint: StartedProviderUiE2eEndpoint | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    await mkdir(cliHomeDir, { recursive: true });
    providerEndpoint = await startProviderUiE2eEndpoint();
    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        ...process.env,
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_FEATURE_PROVIDERS__ENABLED: '1',
      },
    });
    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-provider-model-selection-${run.runId}`,
      },
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
    await providerEndpoint?.stop().catch(() => {});
  });

  test('threads the exact Provider connection through primary launch and refuses revoked binding without native fallback', async ({ page }) => {
    test.setTimeout(720_000);
    if (!server || !uiBaseUrl || !providerEndpoint) throw new Error('missing server/ui/provider fixtures');
    await page.setViewportSize({ width: 1440, height: 900 });
    daemon = await authenticateAndStartDaemon({
      page,
      testDir: suiteDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
      daemonStartupTimeoutMs: 180_000,
      extraEnv: {
        ...process.env,
        HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `provider-session-${run.runId}`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `provider-invocation-${run.runId}`,
        HAPPIER_E2E_FAKE_CLAUDE_CAPTURE_ENV_KEYS: 'ANTHROPIC_BASE_URL,ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN',
        // Deliberately make native Claude credentials available to the daemon. A revoked
        // Provider-bound launch must still refuse instead of borrowing either credential.
        ANTHROPIC_API_KEY: `native-api-key-must-not-fallback-${run.runId}`,
        ANTHROPIC_AUTH_TOKEN: `native-auth-token-must-not-fallback-${run.runId}`,
      },
    });
    const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir, timeoutMs: 120_000 });
    const accessKey = await readCliAccessKey(cliHomeDir);
    if (!accessKey) throw new Error('expected CLI access key after terminal connect');
    await replaceProviderUiE2eSettings({
      baseUrl: server.baseUrl,
      accessKey,
      providerSettings: buildLmStudioProviderUiE2eSettings({
        machineId,
        connectionBaseUrls: [providerEndpoint.baseUrl],
      }),
    });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/providers?happier_hmr=0`, 180_000);
    const enabledSwitch = page.getByTestId(`settings-provider-connection-enabled:${CONNECTION_ID}`);
    await expect(enabledSwitch).toHaveCount(1, { timeout: 120_000 });
    await enabledSwitch.click();
    await expect(enabledSwitch).toBeChecked({ timeout: 120_000 });
    await expect.poll(() => hasProviderUiE2eConnectionGrant({
      baseUrl: server!.baseUrl,
      accessKey,
      connectionId: CONNECTION_ID,
      machineId,
    }), { timeout: 120_000 }).toBe(true);

    await enableEnhancedSessionWizard({ page, baseUrl: uiBaseUrl });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?happier_hmr=0`, 180_000);
    await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 120_000 });
    await selectProviderModel(page, { expectExperimentalConfirmation: true });
    await submitNewSession(page, `provider launch ${run.runId}`);
    await page.waitForURL((url) => sessionIdFromUrl(url.toString()) !== null, { timeout: 180_000 });
    const sessionId = sessionIdFromUrl(page.url());
    if (!sessionId) throw new Error(`expected session id in URL: ${page.url()}`);
    const invocation = await waitForFakeClaudeInvocation(
      fakeClaudeLogPath,
      (candidate) => candidate.invocationId === `provider-invocation-${run.runId}`
        && candidate.mode === 'sdk',
      { timeoutMs: 120_000 },
    );
    const normalizedProviderBaseUrl = new URL(providerEndpoint.baseUrl).toString();
    expect(invocation.environmentAttestation).toEqual({
      ANTHROPIC_BASE_URL: {
        present: true,
        sha256: sha256(normalizedProviderBaseUrl),
        byteLength: Buffer.byteLength(normalizedProviderBaseUrl, 'utf8'),
      },
      ANTHROPIC_API_KEY: { present: false },
      ANTHROPIC_AUTH_TOKEN: { present: false },
    });

    await expect.poll(async () => {
      const metadata = await fetchSessionMetadataV2({
        baseUrl: server!.baseUrl,
        token: accessKey.token,
        sessionId,
        machineKeys: machineKeysFromAccessKey(accessKey),
      });
      const intent = SessionModelSelectionIntentV1Schema.safeParse(metadata.modelSelectionIntentV1);
      return intent.success ? intent.data.selection : null;
    }, { timeout: 120_000 }).toEqual({
      agentTargetKey: CLAUDE_AGENT_TARGET_KEY,
      providerConnectionId: CONNECTION_ID,
      modelId: PROVIDER_UI_E2E_MODEL_ID,
    });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?happier_hmr=0`, 180_000);
    await selectProviderModel(page, { expectExperimentalConfirmation: false });
    await revokeProviderUiE2eConnectionGrants({
      baseUrl: server.baseUrl,
      accessKey,
      connectionId: CONNECTION_ID,
    });
    await expect.poll(() => hasProviderUiE2eConnectionGrant({
      baseUrl: server!.baseUrl,
      accessKey,
      connectionId: CONNECTION_ID,
      machineId,
    }), { timeout: 120_000 }).toBe(false);
    const revokedAttemptStartedAt = Date.now();
    await submitNewSession(page, `revoked provider launch ${run.runId}`);
    await expect(page.getByTestId('provider-error:provider_not_enabled_on_machine')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('provider-error-action:provider_not_enabled_on_machine')).toBeVisible();
    expect(await countFakeClaudeEventsAfterCurrentRunSentinel({
      logPath: fakeClaudeLogPath,
      sinceMs: revokedAttemptStartedAt,
      predicate: (event) => event.type === 'invocation'
        && event.mode === 'sdk',
    })).toBe(0);
  });
});
