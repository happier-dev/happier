import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import {
  installDesktopPetOverlayBridgeProbe,
  readDesktopPetOverlayBridgeInvocations,
  type DesktopPetOverlayBridgeInvocation,
} from '../../src/testkit/pets/desktopPetOverlayBridgeProbe';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { createSessionFromNewSessionComposer } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { setSingleAccountPetsEnabled, setSingleAccountUiFeatureToggle } from '../../src/testkit/pets/uiPetsFeatureToggle';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function writeDelayedFakeClaudeWrapper(params: Readonly<{
  scriptPath: string;
  wrappedFixturePath: string;
  delayMs: number;
}>): Promise<void> {
  const script = [
    '#!/usr/bin/env node',
    'const { spawn } = require("node:child_process");',
    'const readline = require("node:readline");',
    `const wrappedFixturePath = ${JSON.stringify(params.wrappedFixturePath)};`,
    `const delayMs = ${JSON.stringify(params.delayMs)};`,
    'const child = spawn(process.execPath, [wrappedFixturePath, ...process.argv.slice(2)], {',
    '  stdio: ["pipe", "pipe", "inherit"],',
    '  env: process.env,',
    '});',
    'process.stdin.pipe(child.stdin);',
    'let outputChain = Promise.resolve();',
    'function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }',
    'const rl = readline.createInterface({ input: child.stdout });',
    'rl.on("line", (line) => {',
    '  outputChain = outputChain.then(async () => {',
    '    let messageType = null;',
    '    try { messageType = JSON.parse(line)?.type ?? null; } catch {}',
    '    if (messageType === "assistant" || messageType === "result") await sleep(delayMs);',
    '    process.stdout.write(`${line}\\n`);',
    '  });',
    '});',
    'function stop(signal) { child.kill(signal); }',
    'process.on("SIGTERM", () => stop("SIGTERM"));',
    'process.on("SIGINT", () => stop("SIGINT"));',
    'child.on("exit", (code, signal) => {',
    '  outputChain.then(() => {',
    '    if (typeof code === "number") process.exit(code);',
    '    process.exit(signal ? 1 : 0);',
    '  });',
    '});',
  ].join('\n');

  await writeFile(params.scriptPath, `${script}\n`, { encoding: 'utf8', mode: 0o755 });
}

function collectTrayInteractionIssues(params: Readonly<{
  sessionId: string;
  noDragValue: string | null;
  invocations: readonly DesktopPetOverlayBridgeInvocation[];
}>): string[] {
  const issues: string[] = [];
  if (params.noDragValue !== 'true') {
    issues.push('desktop overlay tray item is not marked data-pet-no-drag="true"');
  }

  const showMainWindow = params.invocations.find(
    (invocation) => invocation.command === 'desktop_pet_overlay_show_main_window',
  );
  if (!showMainWindow) {
    issues.push('missing desktop_pet_overlay_show_main_window bridge command after tray click');
    return issues;
  }

  const payload = showMainWindow.args?.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    issues.push('tray bridge command is missing object payload');
    return issues;
  }
  const fields = payload as Record<string, unknown>;
  if (fields.reason !== 'tray-action') {
    issues.push('tray bridge command does not use reason="tray-action"');
  }
  if (fields.targetSessionId !== params.sessionId) {
    issues.push('tray bridge command does not include the clicked session id');
  }

  return issues;
}

test.describe('ui e2e: pets desktop overlay tray session interaction', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('pets-overlay-tray-session-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
  const fakeClaudeActiveStateDelayMs = 5_000;

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let daemon: StartedDaemon | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    await mkdir(cliHomeDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-pets-overlay-tray-${run.runId}`,
        HAPPIER_E2E_UI_WEB_MODE: 'export',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('opens the active session from a no-drag desktop overlay tray item', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing fixtures');

    const testDir = resolve(join(suiteDir, 'tray-session-interaction'));
    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const delayedFakeClaudePath = resolve(join(testDir, 'fake-claude-delayed.cjs'));
    await mkdir(testDir, { recursive: true });
    await writeDelayedFakeClaudeWrapper({
      scriptPath: delayedFakeClaudePath,
      wrappedFixturePath: fakeClaudeFixturePath(),
      delayMs: fakeClaudeActiveStateDelayMs,
    });

    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
      extraEnv: {
        HAPPIER_CLAUDE_PATH: delayedFakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
      },
    });

    await setSingleAccountUiFeatureToggle({
      page,
      baseUrl: uiBaseUrl,
      featureId: 'pets.companion',
      enabled: true,
    });
    await setSingleAccountPetsEnabled({
      page,
      baseUrl: uiBaseUrl,
      enabled: true,
    });

    const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir, timeoutMs: 120_000 });
    const sessionId = await createSessionFromNewSessionComposer({
      page,
      uiBaseUrl,
      machineId,
      prompt: 'pets overlay tray e2e',
    });

    await installDesktopPetOverlayBridgeProbe(page);
    await gotoDomContentLoadedWithRetries(
      page,
      `${uiBaseUrl}/desktop/pet-overlay?happier_hmr=0&desktopPetOverlayWindow=1`,
      180_000,
    );
    await expect(page.getByTestId('desktop-pet-overlay-root')).toHaveCount(1, { timeout: 120_000 });
    const tray = page.getByTestId('desktop-pet-overlay-tray');
    await expect(tray).toHaveCount(1, { timeout: 120_000 });
    const sessionTrayItem = page.locator(`[data-testid^="desktop-pet-overlay-tray-item-${sessionId}"]`).first();
    await expect(sessionTrayItem).toHaveCount(1, { timeout: 120_000 });
    const noDragValue = await sessionTrayItem.getAttribute('data-pet-no-drag');

    await sessionTrayItem.click();
    const invocations = await readDesktopPetOverlayBridgeInvocations(page);

    expect(collectTrayInteractionIssues({ sessionId, noDragValue, invocations })).toEqual([]);
  });
});
