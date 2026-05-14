import { expect, type Page, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { enableEnhancedSessionWizard } from '../../src/testkit/uiE2e/enableEnhancedSessionWizard';
import { gotoDomContentLoadedWithRetries } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { fetchMachineIdentities, registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { readCliAccessKey } from '../../src/testkit/cliAccessKey';
import { seedCliAuthForServer, seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function machineLaunchOption(page: Page, machineId: string) {
  return page.locator(
    `[data-testid="new-session-machine-option:${machineId}"], [data-testid="new-session-machine:${machineId}"]`,
  );
}

async function recentPathRows(page: Page): Promise<string[]> {
  const popover = page.getByTestId('agent-input-content-popover');
  const explicitRows = popover.locator('[data-testid^="path-selection-list:path-root:option:recent:"]');
  if ((await explicitRows.count()) > 0) {
    return await explicitRows.evaluateAll((elements) => elements.map((element) => element.textContent ?? ''));
  }

  return await popover.locator('[role="button"]').evaluateAll((elements) => {
    return elements
      .map((element) => element.textContent?.trim() ?? '')
      .filter((text) => text.includes('/') || text.startsWith('~'));
  });
}

function agentInputPathSelectionSurface(page: Page) {
  return page.locator('[data-testid="path-selection-list"], [data-testid="path-selector-input"]').first();
}

async function expectMachineReadyIfExposed(params: Readonly<{ page: Page; machineId: string }>): Promise<void> {
  const readiness = params.page.getByTestId(`new-session-machine-readiness:${params.machineId}`);
  if ((await readiness.count()) > 0) {
    await expect(readiness).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
    return;
  }

  await expect(machineLaunchOption(params.page, params.machineId).first()).toHaveCount(1, { timeout: 90_000 });
}

async function waitForMachineActive(params: Readonly<{
  baseUrl: string;
  token: string;
  machineId: string;
  label: string;
}>): Promise<void> {
  await expect
    .poll(
      async () => {
        const machines = await fetchMachineIdentities({ baseUrl: params.baseUrl, token: params.token });
        const machine = machines.find((row) => row.id === params.machineId);
        if (!machine) return `${params.label}:missing`;
        return machine.active ? `${params.label}:active` : `${params.label}:inactive`;
      },
      { timeout: 180_000 },
    )
    .toBe(`${params.label}:active`);
}

async function waitForMachineReplacement(params: Readonly<{
  baseUrl: string;
  token: string;
  oldMachineId: string;
  replacementMachineId: string;
}>): Promise<void> {
  await expect
    .poll(
      async () => {
        const machines = await fetchMachineIdentities({ baseUrl: params.baseUrl, token: params.token });
        const machine = machines.find((row) => row.id === params.oldMachineId);
        if (!machine) return 'missing';
        return `${machine.replacedByMachineId ?? 'unreplaced'}:${machine.active ? 'active' : 'inactive'}`;
      },
      { timeout: 180_000 },
    )
    .toBe(`${params.replacementMachineId}:inactive`);
}

async function copyInstallationIdentityForReplacement(params: Readonly<{
  sourceHomeDir: string;
  targetHomeDir: string;
}>): Promise<void> {
  const sourcePath = join(params.sourceHomeDir, 'installation-identity.json');
  const targetPath = join(params.targetHomeDir, 'installation-identity.json');
  await copyFile(sourcePath, targetPath);
  await expect(readFile(targetPath, 'utf8')).resolves.toBe(await readFile(sourcePath, 'utf8'));
}

test.describe('ui e2e: machine identity and replacement surfaces', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('new-session-machine-identity-suite');
  const firstHomeDir = resolve(join(suiteDir, 'cli-home-primary'));
  const secondHomeDir = resolve(join(suiteDir, 'cli-home-replacement'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let firstDaemon: StartedDaemon | null = null;
  let secondDaemon: StartedDaemon | null = null;
  let uiBaseUrl: string | null = null;
  let serverBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(540_000);
    await mkdir(firstHomeDir, { recursive: true });
    await mkdir(secondHomeDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
      },
    });
    serverBaseUrl = server.baseUrl;
    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        HAPPIER_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPIER_SERVER_URL: server.baseUrl,
      },
    });
    uiBaseUrl = ui.baseUrl;
  });

  test.afterAll(async () => {
    try { await secondDaemon?.stop?.(); } catch { /* best-effort */ }
    try { await firstDaemon?.stop?.(); } catch { /* best-effort */ }
    try { await ui?.stop?.(); } catch { /* best-effort */ }
    try { await server?.stop?.(); } catch { /* best-effort */ }
  });

  test('keeps recent paths stable while same-host machines heartbeat and hides replaced machines from launch selection', async ({ page }) => {
    if (!serverBaseUrl || !uiBaseUrl) throw new Error('test infra failed to start');
    const serverUrl = serverBaseUrl;
    const webUrl = uiBaseUrl;
    test.setTimeout(540_000);

    await gotoDomContentLoadedWithRetries(page, webUrl, 420_000);
    await waitForInitialAppUi({ page, timeoutMs: 420_000 });

    firstDaemon = await authenticateAndStartDaemon({
      page,
      testDir: suiteDir,
      cliHomeDir: firstHomeDir,
      serverUrl,
      uiBaseUrl: webUrl,
      daemonStartupTimeoutMs: 180_000,
    });
    const firstMachineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir: firstHomeDir });
    const accessKey = await readCliAccessKey(firstHomeDir);
    if (!accessKey) throw new Error('expected CLI access key after terminal connect');
    await waitForMachineActive({
      baseUrl: serverUrl,
      token: accessKey.token,
      machineId: firstMachineId,
      label: 'primary',
    });
    await copyInstallationIdentityForReplacement({
      sourceHomeDir: firstHomeDir,
      targetHomeDir: secondHomeDir,
    });
    if ('secret' in accessKey) {
      await seedCliAuthForServer({
        cliHome: secondHomeDir,
        serverUrl,
        token: accessKey.token,
        secret: Buffer.from(accessKey.secret, 'base64'),
        replacementCandidate: {
          machineId: firstMachineId,
          replacementReason: 'reauth',
        },
      });
    } else {
      await seedCliDataKeyAuthForServer({
        cliHome: secondHomeDir,
        serverUrl,
        token: accessKey.token,
        publicKey: Buffer.from(accessKey.encryption.publicKey, 'base64'),
        machineKey: Buffer.from(accessKey.encryption.machineKey, 'base64'),
        replacementCandidate: {
          machineId: firstMachineId,
          replacementReason: 'reauth',
        },
      });
    }

    secondDaemon = await startTestDaemon({
      testDir: suiteDir,
      happyHomeDir: secondHomeDir,
      startupTimeoutMs: 180_000,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_HOME_DIR: secondHomeDir,
        HAPPIER_SERVER_URL: serverUrl,
        HAPPIER_WEBAPP_URL: webUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });
    const secondMachineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir: secondHomeDir });

    await waitForMachineActive({
      baseUrl: serverUrl,
      token: accessKey.token,
      machineId: secondMachineId,
      label: 'replacement',
    });
    await waitForMachineReplacement({
      baseUrl: serverUrl,
      token: accessKey.token,
      oldMachineId: firstMachineId,
      replacementMachineId: secondMachineId,
    });

    await enableEnhancedSessionWizard({ page, baseUrl: webUrl });
    await gotoDomContentLoadedWithRetries(page, `${webUrl}/new?happier_hmr=0`, 60_000);
    await page.getByTestId('agent-input-path-chip').click();
    await expect(agentInputPathSelectionSurface(page)).toBeVisible({ timeout: 30_000 });

    const before = await recentPathRows(page);
    await page.waitForTimeout(22_000);
    const after = await recentPathRows(page);
    expect(after).toEqual(before);

    const machines = await fetchMachineIdentities({ baseUrl: serverUrl, token: accessKey.token });
    expect(machines.find((machine) => machine.id === firstMachineId)?.replacedByMachineId).toBe(secondMachineId);
    await expect(machineLaunchOption(page, firstMachineId)).toHaveCount(0);
    await expect(machineLaunchOption(page, secondMachineId)).toHaveCount(1);
    await expectMachineReadyIfExposed({ page, machineId: secondMachineId });

    const legacyMachineId = `manual-old-${randomUUID()}`;
    const registration = await registerMachineIdentity({
      baseUrl: serverUrl,
      token: accessKey.token,
      machineId: legacyMachineId,
      metadata: `manual-repair-legacy:${legacyMachineId}`,
    });
    expect(registration.status).toBe(200);

    await gotoDomContentLoadedWithRetries(page, `${webUrl}/machine/${legacyMachineId}?happier_hmr=0`, 60_000);
    const repairOption = page.getByTestId(`machine-replacement-repair-option:${secondMachineId}`);
    await expect(repairOption).toHaveCount(1, { timeout: 60_000 });
    await repairOption.click();

    await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('web-modal-confirm').click();

    await expect
      .poll(
        async () => {
          const refreshed = await fetchMachineIdentities({ baseUrl: serverUrl, token: accessKey.token });
          const machine = refreshed.find((row) => row.id === legacyMachineId);
          return `${machine?.replacedByMachineId ?? 'unreplaced'}:${machine?.replacementSource ?? 'none'}`;
        },
        { timeout: 90_000 },
      )
      .toBe(`${secondMachineId}:manual`);

    await enableEnhancedSessionWizard({ page, baseUrl: webUrl });
    await gotoDomContentLoadedWithRetries(page, `${webUrl}/new?happier_hmr=0`, 60_000);
    await expect(machineLaunchOption(page, legacyMachineId)).toHaveCount(0);
  });
});
