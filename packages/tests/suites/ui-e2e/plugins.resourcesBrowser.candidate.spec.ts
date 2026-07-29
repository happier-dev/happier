import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import {
  sanitizeDaemonEnvForSpawn,
  startTestDaemon,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import {
  resolveUiWebBeforeAllTimeoutMs,
  startUiWeb,
  type StartedUiWeb,
} from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSessionWithCiphertexts } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import {
  preparePackedCandidateBrowserQa,
  requirePackedCandidateManifestPath,
  resolvePackedCandidateBrowserQaBeforeAllTimeoutMs,
  type PreparedPackedCandidateBrowserQa,
} from '../../src/testkit/pluginPlatform/packedCandidateBrowserQa';
import {
  decideAuthenticatedPluginInstallReview,
  readPluginInstallReviewRequiredEnvelope,
} from '../../src/testkit/pluginPlatform/authenticatedInstallReview';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { runCliJson, writeRedactedResultArtifact, type JsonEnvelope } from '../../src/testkit/uiE2e/cliJson';
import {
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
  waitForAuthenticatedHomeUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { encryptDataKeyBase64 } from '../../src/testkit/rpcCrypto';

const run = createRunDirs({ runLabel: 'packed-resources-browser' });
const PLUGIN_ID = 'acme.resources-browser';
const PLUGIN_VERSION = '1.0.0';
const TARGET_ENTRY_ID = `browserTarget:${PLUGIN_ID}:preview`;
const ACTION_ENTRY_IDS = [
  `browserAction:${PLUGIN_ID}:preview-toolbar`,
  `browserAction:${PLUGIN_ID}:preview-details`,
  `browserAction:${PLUGIN_ID}:preview-context`,
] as const;

type CandidateRegistry = Readonly<{
  origin: string;
  close: () => Promise<void>;
}>;

type CandidateRunnerModule = Readonly<{
  readPackedPackageManifest: (
    tarballPath: string,
    extractionRoot: string,
  ) => Promise<Record<string, unknown>>;
  startCandidateRegistry: (params: Readonly<{
    sdk: PreparedPackedCandidateBrowserQa['candidate']['sdk'];
    sdkBytes: Uint8Array;
    packageManifest: Record<string, unknown>;
  }>) => Promise<CandidateRegistry>;
}>;

type FixtureModule = Readonly<{
  buildPackedResourcesBrowserManifest: (params: Readonly<{
    manifest: Record<string, unknown>;
    pluginId: string;
    version: string;
  }>) => Record<string, unknown>;
  buildPackedResourcesBrowserRuntimeSource: (params: Readonly<{
    pluginId: string;
    version: string;
  }>) => string;
  packedResourcesBrowserPayloads: (version: string) => Readonly<Record<
    'prompt' | 'skill' | 'template' | 'asset' | 'config',
    string
  >>;
}>;

type InvocationMarker = Readonly<{
  pluginId: string;
  version: string;
  resources: Readonly<Record<string, string>>;
  input: unknown;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function requireSuccessfulEnvelope(envelope: JsonEnvelope, expectedKind: string): Readonly<Record<string, unknown>> {
  if (envelope.ok !== true || envelope.kind !== expectedKind) {
    throw new Error(`packed_resources_browser_${expectedKind}_failed:${JSON.stringify(envelope)}`);
  }
  const data = asRecord(envelope.data);
  if (!data) {
    throw new Error(`packed_resources_browser_${expectedKind}_data_missing`);
  }
  return data;
}

function buildServerScopedUiUrl(uiBaseUrl: string, serverBaseUrl: string, path: string): string {
  const url = new URL(path, uiBaseUrl.endsWith('/') ? uiBaseUrl : `${uiBaseUrl}/`);
  url.searchParams.set('server', serverBaseUrl);
  return url.toString();
}

async function configureExternalPlugin(params: Readonly<{
  pluginRoot: string;
  fixture: FixtureModule;
}>): Promise<Readonly<Record<string, string>>> {
  const manifestPath = join(params.pluginRoot, '.happier-plugin', 'plugin.json');
  const packagePath = join(params.pluginRoot, 'package.json');
  const [manifestRaw, packageRaw] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(packagePath, 'utf8'),
  ]);
  const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  const packageJson = JSON.parse(packageRaw) as Record<string, unknown>;
  const files = Array.isArray(packageJson.files)
    ? packageJson.files.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const payloads = params.fixture.packedResourcesBrowserPayloads(PLUGIN_VERSION);
  const resourceRoot = join(params.pluginRoot, 'resources');
  await mkdir(resourceRoot, { recursive: true });
  await Promise.all([
    writeFile(
      manifestPath,
      `${JSON.stringify(params.fixture.buildPackedResourcesBrowserManifest({
        manifest,
        pluginId: PLUGIN_ID,
        version: PLUGIN_VERSION,
      }), null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      packagePath,
      `${JSON.stringify({
        ...packageJson,
        version: PLUGIN_VERSION,
        files: [...new Set([...files, 'resources'])],
      }, null, 2)}\n`,
      'utf8',
    ),
    writeFile(
      join(params.pluginRoot, 'src', 'index.ts'),
      params.fixture.buildPackedResourcesBrowserRuntimeSource({
        pluginId: PLUGIN_ID,
        version: PLUGIN_VERSION,
      }),
      'utf8',
    ),
    writeFile(join(resourceRoot, 'prompt.md'), payloads.prompt, 'utf8'),
    writeFile(join(resourceRoot, 'skill.md'), payloads.skill, 'utf8'),
    writeFile(join(resourceRoot, 'template.txt'), payloads.template, 'utf8'),
    writeFile(join(resourceRoot, 'asset.json'), payloads.asset, 'utf8'),
    writeFile(join(resourceRoot, 'config.json'), payloads.config, 'utf8'),
  ]);
  return payloads;
}

function readProjectionEntries(response: unknown): Readonly<Record<string, unknown>> {
  const responseRecord = asRecord(response);
  const projection = asRecord(responseRecord?.projection);
  const families = asRecord(projection?.familiesById);
  const pluginBrowser = asRecord(families?.pluginBrowser);
  const entries = asRecord(pluginBrowser?.entriesById);
  if (!projection || !entries) {
    throw new Error('packed_resources_browser_projection_missing');
  }
  return entries;
}

async function readInvocationMarkers(markerPath: string): Promise<readonly InvocationMarker[]> {
  const raw = await readFile(markerPath, 'utf8').catch(() => '');
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as InvocationMarker);
}

async function clickPackedBrowserActions(page: Page): Promise<void> {
  const shell = 'browser-view-details-surface';
  await page.getByTestId(`${shell}-overflow`).click();
  await page.getByTestId(`${shell}-overflow-item-${ACTION_ENTRY_IDS[0]}`).click();
  await page.getByTestId(`${shell}-plugin-action-detailsPanel-${ACTION_ENTRY_IDS[1]}`).click();
  await page.getByTestId(`${shell}-plugin-action-contextMenu-trigger`).click();
  await page.getByTestId(`${shell}-plugin-action-contextMenu-${ACTION_ENTRY_IDS[2]}`).click();
}

async function attachEvidenceScreenshot(
  page: Page,
  testInfo: TestInfo,
  testDir: string,
): Promise<string> {
  const screenshotPath = join(testDir, 'packed-resources-browser-live.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('packed-resources-browser-live', {
    path: screenshotPath,
    contentType: 'image/png',
  });
  return screenshotPath;
}

test.describe('packed candidate: resources and browser consumed vertical', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    process.env.HAPPIER_PACKED_RESOURCES_BROWSER_QA !== '1',
    'requires the dedicated packed resources/browser runner',
  );

  const suiteDir = run.testDir('resources-browser-suite');
  const storageScope = `e2e-packed-resources-browser-${run.runId}`;
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let candidate: PreparedPackedCandidateBrowserQa | null = null;
  let registry: CandidateRegistry | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    const candidateManifestPath = requirePackedCandidateManifestPath(process.env);
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
    };
    test.setTimeout(resolvePackedCandidateBrowserQaBeforeAllTimeoutMs({
      candidateManifestPath,
      uiBeforeAllTimeoutMs: resolveUiWebBeforeAllTimeoutMs(uiWebEnv),
    }));
    candidate = await preparePackedCandidateBrowserQa({
      candidateManifestPath,
      materializationRoot: join(suiteDir, 'exact-candidate-cli'),
    });
    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        HAPPIER_FEATURE_BROWSER__ENABLED: '1',
        HAPPIER_FEATURE_BROWSER_VIEW_TARGETS__ENABLED: '1',
      },
    });
    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
      },
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterEach(async () => {
    await daemon?.stop().catch(() => undefined);
    daemon = null;
    await registry?.close().catch(() => undefined);
    registry = null;
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => undefined);
    await registry?.close().catch(() => undefined);
    await ui?.stop().catch(() => undefined);
    await server?.stop().catch(() => undefined);
  });

  test('authors, installs, invokes, renders, and uninstalls the exact candidate plugin', async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    if (!candidate || !server || !uiBaseUrl || !ui) {
      throw new Error('packed_resources_browser_suite_not_ready');
    }
    const testDir = resolve(join(suiteDir, 'consumed-vertical'));
    const cliHomeDir = join(testDir, 'happier-home');
    const pluginRoot = join(testDir, 'external-plugin');
    const archivePath = join(testDir, `${PLUGIN_ID}.happier-plugin.tgz`);
    const markerPath = join(testDir, 'action-invocations.jsonl');
    await mkdir(cliHomeDir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    const candidateModule = await import(
      '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs'
    ) as unknown as CandidateRunnerModule;
    const fixture = await import(
      '../../scripts/plugin-platform/packed-resources-browser-fixture.mjs'
    ) as unknown as FixtureModule;
    const sdkBytes = await readFile(candidate.candidate.sdk.tarballPath);
    const sdkPackageManifest = await candidateModule.readPackedPackageManifest(
      candidate.candidate.sdk.tarballPath,
      join(testDir, 'verify-sdk'),
    );
    registry = await candidateModule.startCandidateRegistry({
      sdk: candidate.candidate.sdk,
      sdkBytes,
      packageManifest: sdkPackageManifest,
    });

    const auth = await createTestAuth(server.baseUrl);
    const machineKey = Uint8Array.from(randomBytes(32));
    const seeded = await seedCliDataKeyAuthForServer({
      cliHome: cliHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      machineKey,
    });
    const cliParams = {
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      env: sanitizeDaemonEnvForSpawn(process.env),
      cliLaunchSpec: candidate.cliLaunchSpec,
    } as const;

    requireSuccessfulEnvelope(await runCliJson({
      ...cliParams,
      label: 'plugin-create',
      args: [
        'plugins',
        'create',
        pluginRoot,
        '--id',
        PLUGIN_ID,
        '--sdk-version',
        candidate.candidate.sdk.version,
        '--json',
      ],
      timeoutMs: 120_000,
    }), 'plugins_create');
    const expectedResources = await configureExternalPlugin({ pluginRoot, fixture });
    const authoredSource = await readFile(join(pluginRoot, 'src', 'index.ts'), 'utf8');
    expect(authoredSource).not.toMatch(/packages\/plugin-sdk|@\/|HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT/u);

    requireSuccessfulEnvelope(await runCliJson({
      ...cliParams,
      label: 'author-install',
      args: [
        'plugins',
        'author',
        'install',
        pluginRoot,
        '--sdk-registry',
        registry.origin,
        '--json',
      ],
      timeoutMs: 300_000,
    }), 'plugins_author_install');
    for (const operation of ['typecheck', 'build'] as const) {
      requireSuccessfulEnvelope(await runCliJson({
        ...cliParams,
        label: `author-${operation}`,
        args: ['plugins', 'author', operation, pluginRoot, '--json'],
        timeoutMs: 300_000,
      }), `plugins_author_${operation}`);
    }
    requireSuccessfulEnvelope(await runCliJson({
      ...cliParams,
      label: 'plugin-pack',
      args: ['plugins', 'pack', pluginRoot, '--out', archivePath, '--json'],
      timeoutMs: 180_000,
    }), 'plugins_pack');
    await access(archivePath);
    const archiveBytes = await readFile(archivePath);
    const pluginIntegrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`;

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: cliHomeDir,
      cliLaunchSpec: candidate.cliLaunchSpec,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_PACKED_RESOURCES_BROWSER_MARKER: markerPath,
      },
    });
    expect(daemon.state.startedWithCliVersion).toBe(candidate.attestation.cliVersion);

    const installEnvelope = await runCliJson({
      ...cliParams,
      label: 'plugin-install',
      args: ['plugins', 'install', archivePath, '--json'],
      timeoutMs: 180_000,
      acceptedExitCodes: [1],
    });
    const installReview = readPluginInstallReviewRequiredEnvelope(installEnvelope);
    expect(installReview.review.pluginId).toBe(PLUGIN_ID);
    const installOutcome = await decideAuthenticatedPluginInstallReview({
      cliHomeDir,
      serverUrl: server.baseUrl,
      pendingChangeId: installReview.pendingChangeId,
      optionalSelections: installReview.review.optionalHostAccess.map((entry) => ({
        accessId: entry.id,
        selected: false,
      })),
      confirmPresentUser: async () => true,
    });
    expect(installOutcome).toMatchObject({ kind: 'committed', pluginId: PLUGIN_ID });
    expect(installOutcome.appliedGeneration).toBe(installOutcome.desiredGeneration);
    expect(typeof installOutcome.appliedGeneration).toBe('string');
    const installedGeneration = String(installOutcome.appliedGeneration);

    const projectionSocket = createUserScopedSocketCollector(server.baseUrl, auth.token, {
      captureEvents: false,
    });
    projectionSocket.connect();
    const projectionClient = createDataKeyRpcClient(projectionSocket, machineKey);
    const readProjection = async (): Promise<unknown> => unwrapDataKeyRpcResult(
      await projectionClient.call(
        `${seeded.machineId}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`,
        { machineId: seeded.machineId },
        60_000,
      ),
      'packed resources/browser contribution projection',
    );
    try {
      const installedEntries = readProjectionEntries(await readProjection());
      expect(asRecord(installedEntries[TARGET_ENTRY_ID])).toMatchObject({
        id: TARGET_ENTRY_ID,
        pluginId: PLUGIN_ID,
        contributionKind: 'browserTarget',
        currentUrl: 'https://preview.example.test/',
        launchMode: 'currentView',
        profileMode: 'user',
      });
      expect(ACTION_ENTRY_IDS.map((id) => asRecord(installedEntries[id])?.placement)).toEqual([
        'toolbar',
        'detailsPanel',
        'contextMenu',
      ]);
      for (const actionId of ACTION_ENTRY_IDS) {
        expect(asRecord(installedEntries[actionId])).toMatchObject({
          pluginId: PLUGIN_ID,
          contributionKind: 'browserAction',
          qualifiedActionId: `${PLUGIN_ID}/roundtrip`,
          targetId: TARGET_ENTRY_ID,
        });
      }

      await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({
        serverUrl: server.baseUrl,
        credentials: {
          token: auth.token,
          encryption: {
            publicKey: Buffer.from(seeded.publicKey).toString('base64'),
            machineKey: Buffer.from(machineKey).toString('base64'),
          },
        },
        storageScope,
      }));
      const sessionDataKey = Uint8Array.from(randomBytes(32));
      const sessionDataKeyEnvelope = sealEncryptedDataKeyEnvelopeV1({
        dataKey: sessionDataKey,
        recipientPublicKey: seeded.publicKey,
        randomBytes: (length) => Uint8Array.from(randomBytes(length)),
      });
      const session = await createSessionWithCiphertexts({
        baseUrl: server.baseUrl,
        token: auth.token,
        metadataCiphertextBase64: encryptDataKeyBase64({
          machineId: seeded.machineId,
          path: testDir,
        }, sessionDataKey),
        dataEncryptionKeyBase64: Buffer.from(sessionDataKeyEnvelope).toString('base64'),
      });

      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
        180_000,
      );
      await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });
      await gotoDomContentLoadedWithRetries(
        page,
        buildServerScopedUiUrl(
          uiBaseUrl,
          server.baseUrl,
          `/session/${encodeURIComponent(session.sessionId)}?happier_hmr=0`,
        ),
        180_000,
      );
      const openBrowser = page.getByTestId('session-header-browser-button');
      await expect(openBrowser).toBeVisible({ timeout: 180_000 });
      await openBrowser.click();

      const shell = 'browser-view-details-surface';
      const targetRow = `${shell}-launchpad-card:pluginExternalUrl:${TARGET_ENTRY_ID}`;
      await expect(page.getByTestId(`${targetRow}-available`)).toBeVisible({ timeout: 180_000 });
      await page.getByTestId(targetRow).click();
      await expect(page.getByTestId(`${shell}-overflow`)).toBeVisible({ timeout: 120_000 });
      await expect(page.getByTestId(
        `${shell}-plugin-action-detailsPanel-${ACTION_ENTRY_IDS[1]}`,
      )).toBeEnabled();
      await expect(page.getByTestId(
        `${shell}-plugin-action-contextMenu-trigger`,
      )).toBeEnabled();

      await clickPackedBrowserActions(page);
      await expect.poll(
        async () => (await readInvocationMarkers(markerPath)).length,
        { timeout: 120_000 },
      ).toBe(3);
      const invocations = await readInvocationMarkers(markerPath);
      for (const invocation of invocations) {
        expect(invocation.pluginId).toBe(PLUGIN_ID);
        expect(invocation.version).toBe(PLUGIN_VERSION);
        expect(invocation.resources).toEqual(expectedResources);
        const browser = asRecord(invocation.input);
        expect(browser).toMatchObject({
          targetId: TARGET_ENTRY_ID,
          currentUrl: 'https://preview.example.test/',
        });
        expect(typeof browser?.browserSessionId).toBe('string');
        expect(typeof browser?.viewId).toBe('string');
      }
      const screenshotPath = await attachEvidenceScreenshot(page, testInfo, testDir);

      const uninstallData = requireSuccessfulEnvelope(await runCliJson({
        ...cliParams,
        label: 'plugin-uninstall',
        args: ['plugins', 'uninstall', PLUGIN_ID, '--json'],
        timeoutMs: 180_000,
      }), 'plugins_uninstall');
      expect(uninstallData.pluginId).toBe(PLUGIN_ID);
      expect(uninstallData.desiredGeneration).toBeNull();
      expect(uninstallData.appliedGeneration).toBeNull();
      await expect.poll(async () => {
        const entries = readProjectionEntries(await readProjection());
        return [TARGET_ENTRY_ID, ...ACTION_ENTRY_IDS].every((id) => entries[id] === undefined);
      }, { timeout: 120_000 }).toBe(true);
      await expect(page.getByTestId(
        `${shell}-plugin-action-detailsPanel-${ACTION_ENTRY_IDS[1]}`,
      )).toHaveCount(0, { timeout: 120_000 });

      await writeRedactedResultArtifact({
        testDir,
        artifactName: 'packed-resources-browser.result.json',
        label: 'packed-resources-browser',
        outcome: {
          candidateRunId: candidate.attestation.runId,
          sdkVersion: candidate.attestation.sdkVersion,
          sdkIntegrity: candidate.attestation.sdkIntegrity,
          cliVersion: candidate.attestation.cliVersion,
          cliIntegrity: candidate.attestation.cliIntegrity,
          pluginIntegrity,
          installedGeneration,
          resourceKinds: 'prompt,skill,template,asset,config',
          placements: 'toolbar,detailsPanel,contextMenu',
          actionInvocationCount: invocations.length,
          projectionUninstallAbsence: true,
          sourceFixtureUsed: false,
          sourceCliFallbackUsed: false,
          daemonPid: daemon.state.pid,
          serverPid: server.proc.child.pid ?? -1,
          uiPid: ui.proc?.child.pid ?? -1,
          serverUrl: server.baseUrl,
          uiUrl: uiBaseUrl,
          productProfileMode: 'user',
          playwrightProject: testInfo.project.name,
          screenshotPath,
        },
      });
    } finally {
      projectionSocket.close();
    }
  });
});
