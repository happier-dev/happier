import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildProjectOpenRoute } from '../../../../apps/ui/sources/components/projects/activation/projectOpenRoute.mjs';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { resolveCanonicalServerIdForUi } from '../../src/testkit/uiE2e/sessionFoldersDrag';

// MATRIX-1110 row 111: qualified checkout names and the offline Project shell.
// The ended managed-Machine Archive journey is a separate lifecycle contract.
const run = createRunDirs({ runLabel: 'ui-e2e-checkout-reachability' });
const suiteDir = run.testDir('checkout-names-offline');
const storageScope = `e2e-${run.runId}`;

test.describe('Project checkout identity and offline recovery', () => {
  let server: StartedServer | undefined;
  const daemons: StartedDaemon[] = [];
  let ui: StartedUiWeb | undefined;

  test.afterAll(async () => {
    test.setTimeout(120_000);
    const results = await Promise.allSettled([...daemons.map(daemon => daemon.stop()), ui?.stop(), server?.stop()]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Checkout journey fixture cleanup failed');
  });

  test('keeps same-name Machines distinct in the checkout and shows waiting tabs until its daemon reconnects', async ({ page }) => {
    test.setTimeout(900_000);
    const diagnostics = collectBrowserDiagnostics({ page });
    try {
      const sourceOptions = [process.env.NODE_OPTIONS, '--import',
        pathToFileURL(resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
      server = await startServerLight({ testDir: suiteDir, dbProvider: 'postgres', extraEnv: { ...process.env,
        NODE_OPTIONS: sourceOptions, HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      } });
      const serverId = await resolveCanonicalServerIdForUi(server.baseUrl);
      const auth = await createTestAuth(server.baseUrl);
      const startMachine = async (name: string) => {
        const directory = join(suiteDir, name);
        const homeDir = join(directory, 'home');
        const workspaceDir = join(directory, 'workspace');
        await mkdir(workspaceDir, { recursive: true });
        const { machineId } = await seedCliAuthForTestAccount({ cliHome: homeDir,
          serverUrl: server!.baseUrl, auth, mode: 'dataKey' });
        const launch = async () => {
          const daemon = await startTestDaemon({ testDir: directory, happyHomeDir: homeDir, env: {
            ...process.env, CI: '1', NODE_OPTIONS: sourceOptions, HAPPIER_HOME_DIR: homeDir,
            HAPPIER_SERVER_URL: server!.baseUrl, HAPPIER_WEBAPP_URL: server!.baseUrl,
            HAPPIER_VARIANT: 'dev', HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1', HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED: '0',
          } });
          daemons.push(daemon);
          return daemon;
        };
        return { machineId, workspaceDir, daemon: await launch(), launch };
      };
      const primary = await startMachine('checkout-owner');
      // Two actual enrollments on the same computer publish the same hostname.
      // Their Home identities, credentials and daemon lifecycles are independent.
      const sibling = await startMachine('checkout-sibling');
      expect(primary.machineId).not.toBe(sibling.machineId);
      const projectPath = join(primary.workspaceDir, 'website');
      await mkdir(projectPath, { recursive: true });
      await writeFile(join(projectPath, 'README.md'), '# Website\n');
      ui = await startUiWeb({ testDir: suiteDir, env: { ...process.env,
        EXPO_PUBLIC_DEBUG: '1', EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPIER_SERVER_URL: server.baseUrl, EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope } });
      const baseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
      await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({
        serverUrl: server.baseUrl, serverIdentityId: serverId, auth, mode: 'dataKey', storageScope,
      }));
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${baseUrl}/machines`);
      for (const machine of [primary, sibling]) {
        await expect(page.getByTestId(`machines.index.row.machine:${serverId}:${machine.machineId}`))
          .toContainText(` · ${machine.machineId.slice(0, 4)}`, { timeout: 180_000 });
      }
      const entrance = buildProjectOpenRoute({ serverId, machineId: primary.machineId,
        source: { kind: 'folder', path: projectPath }, materialization: { kind: 'attach' } });
      await gotoDomContentLoadedWithRetries(page, `${baseUrl}${entrance.pathname}?${new URLSearchParams(entrance.params)}`);
      await expect(page.getByTestId('projects.open.submit')).toBeEnabled({ timeout: 120_000 });
      await page.getByTestId('projects.open.submit').click();
      const checkout = page.getByTestId('project-shell-header.checkout');
      await expect(checkout).toBeVisible({ timeout: 180_000 });
      const qualifiedName = (await checkout.getAttribute('aria-label')) ?? '';
      expect(qualifiedName, 'The header must retain the same-name Machine qualifier.').toContain(` · ${primary.machineId.slice(0, 4)}`);
      await expect(checkout.getByText(new RegExp(`· ${primary.machineId.slice(0, 4)}[a-f0-9-]*$`))).toBeVisible();

      await primary.daemon.stop();
      daemons.splice(daemons.indexOf(primary.daemon), 1);
      // The real disconnected socket, rather than a routed response or store edit,
      // drives the common reachability owner for every Project tab.
      for (const tab of ['scripts', 'services', 'code']) {
        await page.getByTestId(`project-shell-header.pages:${tab}`).click();
        await expect(page.locator('[data-testid$="-unreachable"]:visible, [data-testid$="-waiting"]:visible').first())
          .toContainText(/Waiting for|Shown when/, { timeout: 120_000 });
        await expect(checkout).toHaveAttribute('aria-label', qualifiedName);
      }
      await primary.launch();
      await expect(page.locator('[data-testid$="-unreachable"]:visible, [data-testid$="-waiting"]:visible'))
        .toHaveCount(0, { timeout: 120_000 });
      await expect(checkout).toHaveAttribute('aria-label', qualifiedName);
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });
});
