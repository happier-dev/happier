import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
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
import { runCliJson, writeRedactedResultArtifact, type JsonEnvelope } from '../../src/testkit/uiE2e/cliJson';
import { normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'packed-resources-browser' });
const PLUGIN_ID = 'acme.resources-browser';
const PLUGIN_VERSION = '1.0.0';

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
    packages: readonly Readonly<
      PreparedPackedCandidateBrowserQa['candidate']['sdk']
      & { bytes: Uint8Array; packageManifest?: Record<string, unknown> }
    >[];
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

function readProjectionFamilies(response: unknown): Readonly<Record<string, unknown>> {
  const responseRecord = asRecord(response);
  const projection = asRecord(responseRecord?.projection);
  const families = asRecord(projection?.familiesById);
  if (!projection || !families) {
    throw new Error('packed_resources_projection_missing');
  }
  return families;
}

test.describe('packed candidate: resources package vertical', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    process.env.HAPPIER_PACKED_RESOURCES_BROWSER_QA !== '1',
    'requires the dedicated packed resources runner',
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
    await candidate?.cleanup();
    candidate = null;
  });

  test('authors, installs, and uninstalls the exact candidate resources plugin', async ({}, testInfo) => {
    test.setTimeout(900_000);
    if (!candidate || !server || !uiBaseUrl || !ui) {
      throw new Error('packed_resources_browser_suite_not_ready');
    }
    const testDir = resolve(join(suiteDir, 'consumed-vertical'));
    const cliHomeDir = join(testDir, 'happier-home');
    const pluginRoot = join(testDir, 'external-plugin');
    const archivePath = join(testDir, `${PLUGIN_ID}.happier-plugin.tgz`);
    await mkdir(cliHomeDir, { recursive: true });

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
      packages: [{ ...candidate.candidate.sdk, bytes: sdkBytes, packageManifest: sdkPackageManifest }],
    });

    const auth = await createTestAuth(server.baseUrl);
    const machineKey = auth.accountMachineKey;
    const seeded = await seedCliAuthForTestAccount({
      cliHome: cliHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
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
        '--json',
      ],
      timeoutMs: 120_000,
    }), 'plugins_create');
    await configureExternalPlugin({ pluginRoot, fixture });
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
      'packed resources contribution projection',
    );
    try {
      const families = readProjectionFamilies(await readProjection());
      expect(families.pluginBrowser).toBeUndefined();

      const uninstallData = requireSuccessfulEnvelope(await runCliJson({
        ...cliParams,
        label: 'plugin-uninstall',
        args: ['plugins', 'uninstall', PLUGIN_ID, '--json'],
        timeoutMs: 180_000,
      }), 'plugins_uninstall');
      expect(uninstallData.pluginId).toBe(PLUGIN_ID);
      expect(uninstallData.desiredGeneration).toBeNull();
      expect(uninstallData.appliedGeneration).toBeNull();
      await expect.poll(
        async () => readProjectionFamilies(await readProjection()).pluginBrowser,
        { timeout: 120_000 },
      ).toBeUndefined();

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
          deferredBrowserProjectionAbsent: true,
          sourceFixtureUsed: false,
          sourceCliFallbackUsed: false,
          daemonPid: daemon.state.pid,
          serverPid: server.proc.child.pid ?? -1,
          uiPid: ui.proc?.child.pid ?? -1,
          serverUrl: server.baseUrl,
          uiUrl: uiBaseUrl,
          playwrightProject: testInfo.project.name,
        },
      });
    } finally {
      projectionSocket.close();
    }
  });
});
