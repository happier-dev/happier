import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { OpenProjectResultV1Schema, type OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createTestAuth, type TestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { fetchJson } from '../../src/testkit/http';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

// MATRIX-1110 rows 5 and 6: the mounted screens, beyond the Action-only Source journey.
const run = createRunDirs({ runLabel: 'ui-e2e-project-open-form' });
const suiteDir = run.testDir('project-open-form');
const storageScope = `e2e-${run.runId}`;

test.describe('Project Open recovery and native Form authoring', () => {
  let server: StartedServer;
  let ui: StartedUiWeb | undefined;
  let daemon: StartedDaemon | undefined;
  let auth: TestAuth;
  let serverId: string;
  let target: Readonly<{ serverId: string; machineId: string }>;
  const workspaceDir = join(suiteDir, 'workspace');
  let baseUrl: string;

  test.beforeAll(async () => {
    test.setTimeout(1_800_000);
    const sourceOptions = [process.env.NODE_OPTIONS, '--import',
      pathToFileURL(resolve(repoRootDir(), 'packages/cli-common/registerSourceRuntime.mjs')).href].filter(Boolean).join(' ');
    server = await startServerLight({ testDir: join(suiteDir, 'server'), dbProvider: 'postgres', extraEnv: {
      NODE_OPTIONS: sourceOptions, HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
    } });
    const features = await fetchJson<unknown>(`${server.baseUrl}/v1/features`);
    const identity = FeaturesResponseSchema.parse(features.data).capabilities.serverIdentity.serverIdentityId;
    if (!identity) throw new Error('Project UI Home identity unavailable');
    serverId = identity;
    auth = await createTestAuth(server.baseUrl);
    const homeDir = join(suiteDir, 'home');
    await mkdir(workspaceDir, { recursive: true });
    const enrollment = await seedCliAuthForTestAccount({ cliHome: homeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
    target = { serverId, machineId: enrollment.machineId };
    daemon = await startTestDaemon({ testDir: suiteDir, happyHomeDir: homeDir, env: {
      ...process.env, CI: '1', NODE_OPTIONS: sourceOptions, HAPPIER_HOME_DIR: homeDir,
      HAPPIER_SERVER_URL: server.baseUrl, HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_VARIANT: 'dev', HAPPIER_DISABLE_CAFFEINATE: '1', HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED: '0',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
    } });
    ui = await startUiWeb({ testDir: suiteDir, env: { ...process.env,
      EXPO_PUBLIC_DEBUG: '1', EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
      EXPO_PUBLIC_HAPPIER_SERVER_URL: server.baseUrl, EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope } });
    baseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    const results = await Promise.allSettled([ui?.stop(), daemon?.stop(), server?.stop()]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Project Open/Form fixture cleanup failed');
  });

  async function signIn(page: Page) {
    await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({
      serverUrl: server.baseUrl, serverIdentityId: serverId,
      auth, mode: 'dataKey', storageScope,
    }));
    await page.setViewportSize({ width: 1440, height: 900 });
  }

  async function openFolder(page: Page, path: string) {
    const input: OpenProjectInputV1 = { ...target, source: { kind: 'folder', path }, materialization: { kind: 'attach' } };
    await gotoDomContentLoadedWithRetries(page, `${baseUrl}/projects/open?${new URLSearchParams({
      serverId, openDraft: JSON.stringify(input),
    })}`);
    await expect(page.getByTestId('projects.open')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('projects.open.subject.folder')).toContainText(path);
    await expect(page.getByTestId('projects.open.submit')).toBeEnabled({ timeout: 120_000 });
  }

  test('retains a dropped Open acknowledgement across remount and reopens the accepted checkout without replay', async ({ page }) => {
    test.setTimeout(900_000);
    const diagnostics = collectBrowserDiagnostics({ page });
    try {
      await signIn(page);
      const controlPath = join(workspaceDir, 'known-good');
      const interruptedPath = join(workspaceDir, 'lost-ack');
      await Promise.all([mkdir(controlPath, { recursive: true }), mkdir(interruptedPath, { recursive: true })]);
      await writeFile(join(interruptedPath, 'unfinished.bin'), Buffer.from([0, 255, 13, 10, 128]));

      // The same browser/person/server/Postgres/daemon must first open successfully.
      await openFolder(page, controlPath);
      await page.getByTestId('projects.open.submit').click();
      await expect(page.getByTestId('project-shell-header.checkout')).toBeVisible({ timeout: 120_000 });

      let accepted: Extract<ReturnType<typeof OpenProjectResultV1Schema.parse>, { kind: 'opened' }> | undefined;
      let openRequests = 0;
      // Lose only the network acknowledgement after the real Action has settled.
      // No executor, draft repository, dispatch or result is injected.
      await page.route('**/v1/actions/projects.open', async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        openRequests += 1;
        const response = await route.fetch();
        const envelope: unknown = await response.json();
        const execution = envelope && typeof envelope === 'object' ? Reflect.get(envelope, 'execution') : undefined;
        const result = execution && typeof execution === 'object' ? Reflect.get(execution, 'result') : undefined;
        const parsed = OpenProjectResultV1Schema.parse(result);
        expect(parsed.kind, 'The lost acknowledgement must follow a real successful Open.').toBe('opened');
        if (parsed.kind === 'opened') accepted = parsed;
        await route.abort('failed');
      });
      await openFolder(page, interruptedPath);
      const draftUrl = page.url();
      expect(new URL(draftUrl).searchParams.get('draftId')).toBeTruthy();
      await page.getByTestId('projects.open.submit').click();
      await expect(page.getByTestId('projects.open.unknown')).toBeVisible({ timeout: 120_000 });
      await expect(page.getByTestId('projects.open.submit')).toBeDisabled();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('projects.open.unknown')).toBeVisible({ timeout: 120_000 });
      await expect(page.getByTestId('projects.open.subject.folder')).toContainText(interruptedPath);
      await expect(page.getByTestId('projects.open.submit')).toBeDisabled();
      expect(openRequests, 'Remount must observe the retained uncertainty instead of admitting another effect.').toBe(1);
      if (!accepted) throw new Error('No successful Open receipt reached the network boundary');

      expect(accepted).toMatchObject({ directory: interruptedPath, workspace: target });
      await gotoDomContentLoadedWithRetries(page,
        `${baseUrl}/projects/${encodeURIComponent(accepted.workspace.workspaceId)}?serverId=${encodeURIComponent(serverId)}`);
      await expect(page.getByTestId('project-shell-header.checkout')).toBeVisible({ timeout: 120_000 });
      expect(openRequests).toBe(1);
      expect(await readFile(join(interruptedPath, 'unfinished.bin'))).toEqual(Buffer.from([0, 255, 13, 10, 128]));
    } catch (error) { throw appendBrowserDiagnostics(error, diagnostics); }
  });

  test('imports a native task through the mounted Form, saves its reference, and reloads an exact-byte conflict', async ({ page }) => {
    test.setTimeout(900_000);
    const diagnostics = collectBrowserDiagnostics({ page });
    try {
      await signIn(page);
      const root = join(workspaceDir, 'native-form');
      const manifestPath = join(root, '.happier', 'project.json');
      await mkdir(join(root, '.happier'), { recursive: true });
      await writeFile(manifestPath, '{"version":1}\n');
      await writeFile(join(root, 'Makefile'), 'journey-task:\n\t@printf native-form-journey\n');
      await openFolder(page, root);
      await page.getByTestId('projects.open.submit').click();
      await expect(page.getByTestId('project-shell-header.checkout')).toBeVisible({ timeout: 120_000 });
      await page.getByTestId('project-shell-header.pages-scripts').click();
      await expect(page.getByTestId('project-scripts-screen.edit')).toBeVisible({ timeout: 120_000 });
      await page.getByTestId('project-scripts-screen.edit').click();
      await expect(page.getByTestId('project-manifest-editor')).toBeVisible();
      await page.getByTestId('project-manifest-editor.found.open').click();
      const native = page.getByTestId(/^project-manifest-editor\.found:\d+$/).filter({ hasText: 'journey-task' });
      await expect(native).toBeVisible({ timeout: 120_000 });
      await native.click();
      await expect(page.getByTestId('project-manifest-editor.save')).toBeEnabled();
      await page.getByTestId('project-manifest-editor.save').click();
      await expect(page.getByTestId('project-manifest-editor')).toHaveCount(0, { timeout: 120_000 });
      const savedBytes = await readFile(manifestPath, 'utf8');
      expect(JSON.parse(savedBytes)).toMatchObject({ version: 1, scripts: {
        'journey-task': { source: { kind: 'native', tool: 'make', file: 'Makefile', target: 'journey-task' } },
      } });
      expect(savedBytes).not.toContain('native-form-journey');

      await page.getByTestId('project-scripts-screen.edit').click();
      await page.getByTestId('project-manifest-editor.found.open').click();
      await native.click();
      await expect(page.getByTestId('project-manifest-editor.save')).toBeEnabled();
      const externalBytes = `${savedBytes}\n`;
      // Change the real filesystem after Save is pressed and before its request
      // reaches the daemon. A watcher cannot disable Save ahead of this race.
      await page.route('**/v1/actions/projects.manifest.update', async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        await writeFile(manifestPath, externalBytes);
        await route.continue();
      });
      await page.getByTestId('project-manifest-editor.save').click();
      await expect(page.getByTestId('project-manifest-editor.conflict')).toBeVisible({ timeout: 120_000 });
      expect(await readFile(manifestPath, 'utf8')).toBe(externalBytes);
      await page.getByTestId('project-manifest-editor.reload').click();
      await expect(page.getByTestId('project-manifest-editor.conflict')).toHaveCount(0);
      await expect(page.getByTestId('project-manifest-editor.save')).toBeDisabled();
      expect(await readFile(manifestPath, 'utf8')).toBe(externalBytes);
      await page.getByTestId('project-manifest-editor.back').click();
      await expect(page.getByTestId('project-scripts-screen.script:journey-task')).toBeVisible({ timeout: 120_000 });
    } catch (error) { throw appendBrowserDiagnostics(error, diagnostics); }
  });
});
