import { randomBytes, randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { renderPrismaCompatibleSqliteDatabaseUrl } from '@happier-dev/cli-common/firstPartyRuntime';

import {
  assertPackedPackageIdentity,
  buildVerticalADaemonRestartArgs,
  loadPackedAuthorVerticalAArtifacts,
  materializePackedCli,
  parseJsonEnvelope,
  prepareVerticalAChildEnvironment,
  readPackedPackageManifest,
  runPackedCli,
  runPackedCliJson,
  runPackedReviewedPluginInstall,
  sha512Sri,
  startCandidateRegistry,
  type PackedAuthorArtifactAdmission,
  type PackedAuthorDirectArtifactsSmoke,
} from '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import { createTestAuth } from '../testkit/auth';
import { seedCliAuthForServer } from '../testkit/cliAuth';
import { sanitizeDaemonEnvForSpawn } from '../testkit/daemon/daemon';
import {
  decideAuthenticatedPluginInstallReview,
} from '../testkit/pluginPlatform/authenticatedInstallReview';
import { startServerLight, type StartedServer } from '../testkit/process/serverLight';
import { sleep, waitFor } from '../testkit/timing';
import {
  BACKGROUND_INDEXER_PLUGIN_ID,
  WORKSPACE_INDEX_HEARTBEAT_PATH,
  assertWorkspaceIndexerHeartbeat,
  resolveWorkspaceIndexerDatabasePath,
  type WorkspaceIndexerHeartbeat,
} from './backgroundIndexerEvidence';

const BACKGROUND_INDEXER_PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugin-sdk/examples/background-indexer',
);
const BACKGROUND_INDEXER_PACKAGE_NAME = '@example/happier-background-indexer';
const SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';
const MIGRATION_ARRAY_TAIL = '        })]),\n        incumbentQueryFixture:';
const V1_FIXTURE_ID = 'workspace-index-v1';
const V2_FIXTURE_ID = 'workspace-index-v2';
const V2_FIXTURE_QUERY = 'SELECT path, content_digest, label FROM workspace_documents ORDER BY path LIMIT 1';

type JsonObject = Record<string, unknown>;

type BackgroundIndexerMigration = Readonly<{
  version: number;
  id: string;
}>;

type PackedBackgroundIndexerResult = Readonly<{
  ok: true;
  scenario: 'background-indexer';
  candidate: Readonly<{
    runId: string;
    sdk: Readonly<{ packageName: string; version: string; integrity: string }>;
    cli: Readonly<{ packageName: string; version: string; integrity: string }>;
  }>;
  artifactAdmission: PackedAuthorArtifactAdmission | undefined;
  platform: Readonly<{ os: NodeJS.Platform; arch: string }>;
  evidence: Readonly<{
    initialHeartbeat: WorkspaceIndexerHeartbeat;
    reloadHeartbeat: WorkspaceIndexerHeartbeat;
    restartHeartbeat: WorkspaceIndexerHeartbeat;
    cancellationHeartbeat: WorkspaceIndexerHeartbeat;
    rejectedMigrationKinds: Readonly<{
      forcedFailure: string;
      fixtureIncompatible: string;
    }>;
    databaseRemovedAfterCancellation: true;
  }>;
  cleanup: Readonly<{ disposition: 'removed' }>;
}>;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label}_must_be_an_object`);
  return value;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

async function readJsonObject(path: string, label: string): Promise<JsonObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label}_invalid_json`, { cause: error });
  }
  return requireRecord(parsed, label);
}

async function writeJsonObject(path: string, value: JsonObject): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function replaceExactly(
  source: string,
  expected: string,
  replacement: string,
  label: string,
): string {
  const occurrences = source.split(expected).length - 1;
  if (occurrences !== 1) {
    throw new Error(`background_indexer_${label}_expected_one_match_received_${occurrences}`);
  }
  return source.replace(expected, replacement);
}

function appendMigration(
  source: string,
  migration: BackgroundIndexerMigration & Readonly<{ body: readonly string[] }>,
): string {
  const migrationSource = [
    '        }), Object.freeze({',
    `            version: ${migration.version},`,
    `            id: '${migration.id}',`,
    '            up: async (transaction: DaemonDatabaseMigrationTransaction) => {',
    ...migration.body.map((line) => `                ${line}`),
    '            },',
    '        })]),',
    '        incumbentQueryFixture:',
  ].join('\n');
  return replaceExactly(
    source,
    MIGRATION_ARRAY_TAIL,
    migrationSource,
    `migration_${migration.version}_insertion`,
  );
}

function replaceFixtureId(source: string, previous: string, next: string): string {
  return replaceExactly(
    source,
    `id: '${previous}'`,
    `id: '${next}'`,
    `fixture_${previous}_to_${next}`,
  );
}

export function createV2Source(source: string): string {
  const withMigration = appendMigration(source, {
    version: 2,
    id: 'add-workspace-index-label',
    body: [
      "await transaction.execute('ALTER TABLE workspace_documents ADD COLUMN label TEXT');",
    ],
  });
  const withFixtureId = replaceFixtureId(withMigration, V1_FIXTURE_ID, V2_FIXTURE_ID);
  return replaceExactly(
    withFixtureId,
    "'SELECT path, content_digest FROM workspace_documents ORDER BY path LIMIT 1'",
    `'${V2_FIXTURE_QUERY}'`,
    'v2_fixture_query',
  );
}

export function createV2SuccessorSource(params: Readonly<{
  source: string;
  version: number;
  id: string;
  fixtureId: string;
  body: readonly string[];
}>): string {
  return replaceFixtureId(
    appendMigration(params.source, {
      version: params.version,
      id: params.id,
      body: params.body,
    }),
    V2_FIXTURE_ID,
    params.fixtureId,
  );
}

export function makeCancellationObservable(source: string): string {
  const core = replaceExactly(
    source,
    'export const runWorkspaceIndexer: BackgroundServiceRunner = async (context) => {',
    'const runWorkspaceIndexerCore: BackgroundServiceRunner = async (context) => {',
    'runner_core_extraction',
  );
  const activate = "export function activate(api: Pick<PluginApi, 'backgroundServices'>): void {";
  return replaceExactly(
    core,
    activate,
    [
      '/**',
      ' * This candidate-only probe leaves the real one-shot indexer intact, then',
      ' * waits cooperatively for host retirement. It owns no scheduler or heartbeat.',
      ' */',
      'export const runWorkspaceIndexer: BackgroundServiceRunner = async (context) => {',
      '    await runWorkspaceIndexerCore(context);',
      '    if (context.signal.aborted) return;',
      '    await new Promise<void>((resolve) => {',
      '        const settle = (): void => {',
      "            context.signal.removeEventListener('abort', settle);",
      '            resolve();',
      '        };',
      "        context.signal.addEventListener('abort', settle, { once: true });",
      '        if (context.signal.aborted) settle();',
      '    });',
      '};',
      '',
      activate,
    ].join('\n'),
    'runner_cancellation_probe',
  );
}

async function prepareBackgroundIndexerProject(params: Readonly<{
  root: string;
  source: string;
  version: string;
  migrations: readonly BackgroundIndexerMigration[];
  fixtureId: string;
  sdkVersion: string;
}>): Promise<void> {
  await mkdir(dirname(params.root), { recursive: true });
  await cp(BACKGROUND_INDEXER_PROJECT_ROOT, params.root, {
    recursive: true,
    force: false,
  });
  await Promise.all([
    rm(join(params.root, 'dist'), { recursive: true, force: true }),
    rm(join(params.root, 'node_modules'), { recursive: true, force: true }),
  ]);

  const packagePath = join(params.root, 'package.json');
  const manifestPath = join(params.root, '.happier-plugin', 'plugin.json');
  const sourcePath = join(params.root, 'src', 'index.ts');
  const [packageJson, manifest] = await Promise.all([
    readJsonObject(packagePath, 'background_indexer_package'),
    readJsonObject(manifestPath, 'background_indexer_manifest'),
  ]);
  if (packageJson.name !== BACKGROUND_INDEXER_PACKAGE_NAME) {
    throw new Error('background_indexer_package_identity_changed');
  }
  if (manifest.id !== BACKGROUND_INDEXER_PLUGIN_ID) {
    throw new Error('background_indexer_manifest_identity_changed');
  }
  const dependencies = requireRecord(
    packageJson.dependencies,
    'background_indexer_package_dependencies',
  );
  const contributes = requireRecord(
    manifest.contributes,
    'background_indexer_manifest_contributes',
  );
  if (!Array.isArray(contributes.daemonDatabases) || contributes.daemonDatabases.length !== 1) {
    throw new Error('background_indexer_manifest_database_declaration_changed');
  }
  const databaseDeclaration = requireRecord(
    contributes.daemonDatabases[0],
    'background_indexer_manifest_database',
  );
  if (databaseDeclaration.id !== 'workspace-index') {
    throw new Error('background_indexer_manifest_database_identity_changed');
  }

  await Promise.all([
    writeJsonObject(packagePath, {
      ...packageJson,
      version: params.version,
      dependencies: {
        ...dependencies,
        [SDK_PACKAGE_NAME]: params.sdkVersion,
      },
    }),
    writeJsonObject(manifestPath, {
      ...manifest,
      version: params.version,
      contributes: {
        ...contributes,
        daemonDatabases: [{
          ...databaseDeclaration,
          migrations: params.migrations.map((migration) => ({
            version: migration.version,
            id: migration.id,
          })),
          incumbentQueryFixtureId: params.fixtureId,
        }],
      },
    }),
    writeFile(sourcePath, params.source, 'utf8'),
  ]);
}

function assertPackedCommandSucceeded(result: unknown, label: string): void {
  const command = requireRecord(result, `${label}_command`);
  if (command.code === 0 && command.signal === null) return;
  const stdout = typeof command.stdout === 'string' ? command.stdout : '';
  const stderr = typeof command.stderr === 'string' ? command.stderr : '';
  throw new Error(`${label}_failed:${stdout}${stderr}`);
}

function requirePluginInstallChange(result: unknown, label: string): JsonObject {
  return requireRecord(
    requireRecord(result, `${label}_result`).change,
    `${label}_change`,
  );
}

function assertCommittedPluginInstall(
  result: unknown,
  label: string,
): string {
  const change = requirePluginInstallChange(result, label);
  const desiredGeneration = change.desiredGeneration;
  if (
    change.kind !== 'committed'
    || change.pluginId !== BACKGROUND_INDEXER_PLUGIN_ID
    || typeof desiredGeneration !== 'string'
    || desiredGeneration.length === 0
    || change.appliedGeneration !== desiredGeneration
  ) {
    throw new Error(`${label}_did_not_commit:${JSON.stringify(change)}`);
  }
  return desiredGeneration;
}

function assertFailedPluginInstall(result: unknown, label: string): string {
  const change = requirePluginInstallChange(result, label);
  if (change.kind !== 'failed') {
    throw new Error(`${label}_did_not_fail:${JSON.stringify(change)}`);
  }
  return typeof change.code === 'string' ? change.code : 'failed_without_code';
}

function assertInstalledPlugin(
  envelope: unknown,
  params: Readonly<{ version: string; generation: string; label: string }>,
): void {
  const data = requireRecord(
    requireRecord(envelope, `${params.label}_envelope`).data,
    `${params.label}_data`,
  );
  const plugin = requireRecord(data.plugin, `${params.label}_plugin`);
  if (
    plugin.pluginId !== BACKGROUND_INDEXER_PLUGIN_ID
    || plugin.version !== params.version
    || plugin.enabled !== true
    || plugin.desiredGeneration !== params.generation
    || plugin.appliedGeneration !== params.generation
  ) {
    throw new Error(`${params.label}_unexpected_plugin_state:${JSON.stringify(plugin)}`);
  }
}

function readWorkspaceIndexerHeartbeat(
  databasePath: string,
  minimumIndexedAtMs?: number,
): WorkspaceIndexerHeartbeat {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(
      'SELECT path, content_digest AS contentDigest, indexed_at_ms AS indexedAtMs FROM workspace_documents WHERE path = ?',
    ).all(WORKSPACE_INDEX_HEARTBEAT_PATH);
    return assertWorkspaceIndexerHeartbeat(rows, minimumIndexedAtMs);
  } finally {
    database.close();
  }
}

async function waitForWorkspaceIndexerHeartbeat(params: Readonly<{
  databasePath: string;
  label: string;
  minimumIndexedAtMs?: number;
}>): Promise<WorkspaceIndexerHeartbeat> {
  let observed: WorkspaceIndexerHeartbeat | null = null;
  await waitFor(() => {
    observed = readWorkspaceIndexerHeartbeat(
      params.databasePath,
      params.minimumIndexedAtMs,
    );
    return true;
  }, {
    timeoutMs: 30_000,
    intervalMs: 100,
    context: `packed Background Indexer ${params.label}`,
  });
  if (!observed) throw new Error(`background_indexer_${params.label}_not_observed`);
  return observed;
}

function snapshotWorkspaceIndexerDatabase(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const schema = database.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'table') ORDER BY type, name",
    ).all();
    const ledger = database.prepare(
      'SELECT version, id FROM _happier_plugin_schema ORDER BY version',
    ).all();
    const documents = database.prepare(
      'SELECT path, content_digest, indexed_at_ms, label FROM workspace_documents ORDER BY path',
    ).all();
    return JSON.stringify({ schema, ledger, documents });
  } finally {
    database.close();
  }
}

async function waitForWorkspaceIndexerDatabaseRemoval(databasePath: string): Promise<void> {
  await waitFor(async () => {
    try {
      await stat(databasePath);
      return false;
    } catch (error) {
      if (isNotFound(error)) return true;
      throw error;
    }
  }, {
    timeoutMs: 30_000,
    intervalMs: 100,
    context: 'packed Background Indexer database removal after cancellation',
  });
}

async function assertInstalledCandidateSdk(params: Readonly<{
  projectRoot: string;
  candidate: PackedAuthorDirectArtifactsSmoke;
}>): Promise<void> {
  const sdkRoot = await realpath(join(
    params.projectRoot,
    'node_modules',
    ...params.candidate.sdk.packageName.split('/'),
  ));
  const sdkManifest = await readJsonObject(
    join(sdkRoot, 'package.json'),
    'background_indexer_installed_sdk',
  );
  assertPackedPackageIdentity(
    sdkManifest,
    params.candidate.sdk,
    'Background Indexer external author SDK',
  );
}

async function authorAndPackBackgroundIndexer(params: Readonly<{
  archivePath: string;
  candidate: PackedAuthorDirectArtifactsSmoke;
  cliEntrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  projectRoot: string;
  registryOrigin: string;
}>): Promise<void> {
  const install = await runPackedCliJson({
    cliEntrypoint: params.cliEntrypoint,
    cwd: params.cwd,
    env: params.env,
    args: [
      'plugins', 'author', 'install', params.projectRoot,
      '--sdk-registry', params.registryOrigin,
      '--json',
    ],
  }, 'plugins_author_install');
  const installData = requireRecord(
    requireRecord(install, 'background_indexer_author_install').data,
    'background_indexer_author_install_data',
  );
  if (installData.operation !== 'install' || installData.projectRoot !== params.projectRoot) {
    throw new Error('background_indexer_author_install_did_not_admit_project');
  }
  await assertInstalledCandidateSdk({
    projectRoot: params.projectRoot,
    candidate: params.candidate,
  });

  for (const operation of ['typecheck', 'test', 'build'] as const) {
    const result = await runPackedCliJson({
      cliEntrypoint: params.cliEntrypoint,
      cwd: params.cwd,
      env: params.env,
      args: ['plugins', 'author', operation, params.projectRoot, '--json'],
    }, `plugins_author_${operation}`);
    const data = requireRecord(
      requireRecord(result, `background_indexer_author_${operation}`).data,
      `background_indexer_author_${operation}_data`,
    );
    if (data.operation !== operation || data.projectRoot !== params.projectRoot) {
      throw new Error(`background_indexer_author_${operation}_did_not_complete`);
    }
  }

  await mkdir(dirname(params.archivePath), { recursive: true });
  await runPackedCliJson({
    cliEntrypoint: params.cliEntrypoint,
    cwd: params.cwd,
    env: params.env,
    args: [
      'plugins', 'pack', params.projectRoot,
      '--out', params.archivePath,
      '--json',
    ],
  }, 'plugins_pack');
  const archive = await readFile(params.archivePath);
  if (archive.byteLength === 0) {
    throw new Error('background_indexer_pack_produced_empty_archive');
  }
}

export function installReviewOptionalSelections(review: unknown): readonly Readonly<{
  accessId: string;
  selected: boolean;
}>[] {
  const facts = requireRecord(review, 'background_indexer_install_review');
  if (
    facts.pluginId !== BACKGROUND_INDEXER_PLUGIN_ID
    || typeof facts.displayName !== 'string'
    || facts.displayName.length === 0
    || typeof facts.version !== 'string'
    || facts.version.length === 0
    || !Array.isArray(facts.optionalHostAccess)
  ) {
    throw new Error('background_indexer_install_review_facts_invalid');
  }
  return facts.optionalHostAccess.map((access) => {
    const item = requireRecord(access, 'background_indexer_install_review_optional_access');
    if (typeof item.id !== 'string' || item.id.length === 0) {
      throw new Error('background_indexer_install_review_optional_access_invalid');
    }
    return { accessId: item.id, selected: false };
  });
}

export async function runPackedBackgroundIndexer(
  candidate: PackedAuthorDirectArtifactsSmoke,
  options: Readonly<{
    artifactAdmission?: PackedAuthorArtifactAdmission;
  }> = {},
): Promise<PackedBackgroundIndexerResult> {
  const tempRoot = await mkdtemp(join(tmpdir(), `happier-packed-background-indexer-${candidate.runId}-`));
  let server: StartedServer | null = null;
  let registry: Awaited<ReturnType<typeof startCandidateRegistry>> | null = null;
  let cliEntrypoint: string | null = null;
  let childEnv: NodeJS.ProcessEnv | null = null;
  let daemonStopped = false;
  try {
    const [sdkBytes, cliBytes] = await Promise.all([
      readFile(candidate.sdk.tarballPath),
      readFile(candidate.cli.tarballPath),
    ]);
    if (sha512Sri(sdkBytes) !== candidate.sdk.integrity) {
      throw new Error('background_indexer_sdk_artifact_integrity_mismatch');
    }
    if (sha512Sri(cliBytes) !== candidate.cli.integrity) {
      throw new Error('background_indexer_cli_artifact_integrity_mismatch');
    }
    const sdkManifest = await readPackedPackageManifest(
      candidate.sdk.tarballPath,
      join(tempRoot, 'sdk-artifact'),
    );
    assertPackedPackageIdentity(sdkManifest, candidate.sdk, 'Background Indexer packed SDK');
    const candidateRegistry = await startCandidateRegistry({
      packages: [{
        ...candidate.sdk,
        bytes: sdkBytes,
        packageManifest: sdkManifest,
      }],
    });
    registry = candidateRegistry;
    const packedCliEntrypoint = await materializePackedCli({
      cliArtifact: candidate.cli,
      installRoot: join(tempRoot, 'cli-install'),
      env: sanitizeDaemonEnvForSpawn(process.env),
    });
    cliEntrypoint = packedCliEntrypoint;

    const databaseUrl = renderPrismaCompatibleSqliteDatabaseUrl({
      dbPath: join(tempRoot, 'server-light-data', 'happier-server-light.sqlite'),
      platform: process.platform,
      sqlite: { connectionLimit: 4 },
    });
    const startedServer = await startServerLight({
      testDir: tempRoot,
      dbProvider: 'sqlite',
      extraEnv: { DATABASE_URL: databaseUrl },
    });
    server = startedServer;
    const serverBaseUrl = startedServer.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);
    const secret = Uint8Array.from(randomBytes(32));
    const happyHomeDir = join(tempRoot, 'happier-home');
    const isolatedChildEnv = await prepareVerticalAChildEnvironment({
      happyHomeDir,
      markerPath: join(tempRoot, 'background-indexer.marker'),
      baseEnv: sanitizeDaemonEnvForSpawn(process.env),
      prepareHome: async ({ happyHomeDir: isolatedHome }) => {
        const packedBinDir = join(isolatedHome, 'packed-background-indexer-bin');
        await mkdir(packedBinDir, { recursive: true });
        await seedCliAuthForServer({
          cliHome: isolatedHome,
          serverUrl: serverBaseUrl,
          token: auth.token,
          secret,
        });
        return {
          CI: '1',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          PATH: packedBinDir,
          HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID:
            `packed-background-indexer-${randomUUID()}`.slice(0, 64),
        };
      },
    });
    childEnv = isolatedChildEnv;
    const authorEnv = { ...isolatedChildEnv };
    delete authorEnv.HAPPIER_VERTICAL_A_MARKER;
    const fixtureRoot = join(tempRoot, 'external-author');
    await mkdir(fixtureRoot, { recursive: true });
    const databasePath = resolveWorkspaceIndexerDatabasePath(happyHomeDir);
    const installArchive = async (archivePath: string): Promise<unknown> => await runPackedReviewedPluginInstall({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      args: ['plugins', 'install', archivePath, '--json'],
      decideInstallReview: async ({ happyHomeDir: reviewHome, pendingChangeId, review }) => (
        await decideAuthenticatedPluginInstallReview({
          cliHomeDir: reviewHome,
          serverUrl: serverBaseUrl,
          pendingChangeId,
          optionalSelections: installReviewOptionalSelections(review),
          confirmPresentUser: async () => true,
        })
      ),
    });
    const showInstalledPlugin = async (): Promise<unknown> => await runPackedCliJson({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      args: ['plugins', 'show', BACKGROUND_INDEXER_PLUGIN_ID, '--json'],
    }, 'plugins_show');

    const v1Source = await readFile(join(BACKGROUND_INDEXER_PROJECT_ROOT, 'src', 'index.ts'), 'utf8');
    const v1Migrations = [{ version: 1, id: 'create-workspace-index' }] as const;
    const v1Root = join(fixtureRoot, 'background-indexer-v1');
    await prepareBackgroundIndexerProject({
      root: v1Root,
      source: v1Source,
      version: '0.1.0',
      migrations: v1Migrations,
      fixtureId: V1_FIXTURE_ID,
      sdkVersion: candidate.sdk.version,
    });
    const v1Archive = join(tempRoot, 'archives', 'background-indexer-v1.happier-plugin.tgz');
    await authorAndPackBackgroundIndexer({
      archivePath: v1Archive,
      candidate,
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: authorEnv,
      projectRoot: v1Root,
      registryOrigin: candidateRegistry.origin,
    });
    const v1Generation = assertCommittedPluginInstall(
      await installArchive(v1Archive),
      'background_indexer_v1_install',
    );
    const initialHeartbeat = await waitForWorkspaceIndexerHeartbeat({
      databasePath,
      label: 'initial install',
    });
    assertInstalledPlugin(await showInstalledPlugin(), {
      version: '0.1.0',
      generation: v1Generation,
      label: 'background_indexer_v1',
    });

    const v2Source = createV2Source(v1Source);
    const v2Migrations = [
      ...v1Migrations,
      { version: 2, id: 'add-workspace-index-label' },
    ] as const;
    const v2Root = join(fixtureRoot, 'background-indexer-v2');
    await prepareBackgroundIndexerProject({
      root: v2Root,
      source: v2Source,
      version: '0.2.0',
      migrations: v2Migrations,
      fixtureId: V2_FIXTURE_ID,
      sdkVersion: candidate.sdk.version,
    });
    const v2Archive = join(tempRoot, 'archives', 'background-indexer-v2.happier-plugin.tgz');
    await authorAndPackBackgroundIndexer({
      archivePath: v2Archive,
      candidate,
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: authorEnv,
      projectRoot: v2Root,
      registryOrigin: candidateRegistry.origin,
    });
    const v2Generation = assertCommittedPluginInstall(
      await installArchive(v2Archive),
      'background_indexer_v2_reload',
    );
    const reloadHeartbeat = await waitForWorkspaceIndexerHeartbeat({
      databasePath,
      minimumIndexedAtMs: initialHeartbeat.indexedAtMs,
      label: 'compatible reload',
    });
    assertInstalledPlugin(await showInstalledPlugin(), {
      version: '0.2.0',
      generation: v2Generation,
      label: 'background_indexer_v2',
    });
    const v2Snapshot = snapshotWorkspaceIndexerDatabase(databasePath);

    await sleep(5);
    const restart = await runPackedCli({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      args: buildVerticalADaemonRestartArgs(),
    });
    assertPackedCommandSucceeded(restart, 'background_indexer_daemon_restart');
    const restartResult = requireRecord(restart, 'background_indexer_daemon_restart_result');
    if (typeof restartResult.stdout !== 'string') {
      throw new Error('background_indexer_daemon_restart_stdout_invalid');
    }
    const restartEnvelope = requireRecord(
      parseJsonEnvelope(restartResult.stdout, 'background_indexer_daemon_restart'),
      'background_indexer_daemon_restart_envelope',
    );
    if (restartEnvelope.ok !== true || restartEnvelope.status !== 'restarted') {
      throw new Error('background_indexer_daemon_restart_did_not_replace_runtime');
    }
    const restartHeartbeat = await waitForWorkspaceIndexerHeartbeat({
      databasePath,
      minimumIndexedAtMs: reloadHeartbeat.indexedAtMs,
      label: 'daemon restart',
    });
    assertInstalledPlugin(await showInstalledPlugin(), {
      version: '0.2.0',
      generation: v2Generation,
      label: 'background_indexer_after_restart',
    });

    const failedV3Source = createV2SuccessorSource({
      source: v2Source,
      version: 3,
      id: 'forced-migration-failure',
      fixtureId: 'workspace-index-v3-failed',
      body: [
        "await transaction.execute('CREATE TABLE workspace_index_failed_candidate (id INTEGER PRIMARY KEY)');",
        "throw new Error('background_indexer_forced_migration_failure');",
      ],
    });
    const failedV3Root = join(fixtureRoot, 'background-indexer-v3-failed');
    await prepareBackgroundIndexerProject({
      root: failedV3Root,
      source: failedV3Source,
      version: '0.3.0',
      migrations: [
        ...v2Migrations,
        { version: 3, id: 'forced-migration-failure' },
      ],
      fixtureId: 'workspace-index-v3-failed',
      sdkVersion: candidate.sdk.version,
    });
    const failedV3Archive = join(tempRoot, 'archives', 'background-indexer-v3-failed.happier-plugin.tgz');
    await authorAndPackBackgroundIndexer({
      archivePath: failedV3Archive,
      candidate,
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: authorEnv,
      projectRoot: failedV3Root,
      registryOrigin: candidateRegistry.origin,
    });
    const forcedFailure = assertFailedPluginInstall(
      await installArchive(failedV3Archive),
      'background_indexer_forced_migration_failure',
    );
    if (snapshotWorkspaceIndexerDatabase(databasePath) !== v2Snapshot) {
      throw new Error('background_indexer_forced_migration_failure_mutated_incumbent_database');
    }
    assertInstalledPlugin(await showInstalledPlugin(), {
      version: '0.2.0',
      generation: v2Generation,
      label: 'background_indexer_after_forced_failure',
    });

    const incompatibleV4Source = createV2SuccessorSource({
      source: v2Source,
      version: 4,
      id: 'drop-workspace-index',
      fixtureId: 'workspace-index-v4-incompatible',
      body: [
        "await transaction.execute('DROP TABLE workspace_documents');",
      ],
    });
    const incompatibleV4Root = join(fixtureRoot, 'background-indexer-v4-incompatible');
    await prepareBackgroundIndexerProject({
      root: incompatibleV4Root,
      source: incompatibleV4Source,
      version: '0.4.0',
      migrations: [
        ...v2Migrations,
        { version: 4, id: 'drop-workspace-index' },
      ],
      fixtureId: 'workspace-index-v4-incompatible',
      sdkVersion: candidate.sdk.version,
    });
    const incompatibleV4Archive = join(tempRoot, 'archives', 'background-indexer-v4-incompatible.happier-plugin.tgz');
    await authorAndPackBackgroundIndexer({
      archivePath: incompatibleV4Archive,
      candidate,
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: authorEnv,
      projectRoot: incompatibleV4Root,
      registryOrigin: candidateRegistry.origin,
    });
    const fixtureIncompatible = assertFailedPluginInstall(
      await installArchive(incompatibleV4Archive),
      'background_indexer_fixture_incompatible_migration',
    );
    if (snapshotWorkspaceIndexerDatabase(databasePath) !== v2Snapshot) {
      throw new Error('background_indexer_fixture_incompatible_migration_mutated_incumbent_database');
    }
    assertInstalledPlugin(await showInstalledPlugin(), {
      version: '0.2.0',
      generation: v2Generation,
      label: 'background_indexer_after_fixture_failure',
    });

    const v5Source = makeCancellationObservable(createV2SuccessorSource({
      source: v2Source,
      version: 5,
      id: 'add-workspace-index-runtime',
      fixtureId: 'workspace-index-v5',
      body: [
        "await transaction.execute('CREATE TABLE workspace_index_runtime (state TEXT PRIMARY KEY)');",
      ],
    }));
    const v5Root = join(fixtureRoot, 'background-indexer-v5-cancellation');
    await prepareBackgroundIndexerProject({
      root: v5Root,
      source: v5Source,
      version: '0.5.0',
      migrations: [
        ...v2Migrations,
        { version: 5, id: 'add-workspace-index-runtime' },
      ],
      fixtureId: 'workspace-index-v5',
      sdkVersion: candidate.sdk.version,
    });
    const v5Archive = join(tempRoot, 'archives', 'background-indexer-v5-cancellation.happier-plugin.tgz');
    await authorAndPackBackgroundIndexer({
      archivePath: v5Archive,
      candidate,
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: authorEnv,
      projectRoot: v5Root,
      registryOrigin: candidateRegistry.origin,
    });
    const v5Generation = assertCommittedPluginInstall(
      await installArchive(v5Archive),
      'background_indexer_cancellation_probe_reload',
    );
    const cancellationHeartbeat = await waitForWorkspaceIndexerHeartbeat({
      databasePath,
      minimumIndexedAtMs: restartHeartbeat.indexedAtMs,
      label: 'cancellation probe reload',
    });
    assertInstalledPlugin(await showInstalledPlugin(), {
      version: '0.5.0',
      generation: v5Generation,
      label: 'background_indexer_cancellation_probe',
    });
    const uninstall = await runPackedCliJson({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      args: [
        'plugins', 'uninstall', BACKGROUND_INDEXER_PLUGIN_ID,
        '--delete-data', '--yes', '--json',
      ],
    }, 'plugins_uninstall');
    const uninstallData = requireRecord(
      requireRecord(uninstall, 'background_indexer_cancellation_uninstall').data,
      'background_indexer_cancellation_uninstall_data',
    );
    if (
      uninstallData.pluginId !== BACKGROUND_INDEXER_PLUGIN_ID
      || uninstallData.desiredGeneration !== null
      || uninstallData.appliedGeneration !== null
    ) {
      throw new Error('background_indexer_cancellation_uninstall_did_not_retire_generation');
    }
    await waitForWorkspaceIndexerDatabaseRemoval(databasePath);

    const stop = await runPackedCli({
      cliEntrypoint: packedCliEntrypoint,
      cwd: fixtureRoot,
      env: isolatedChildEnv,
      args: ['daemon', 'stop'],
    });
    assertPackedCommandSucceeded(stop, 'background_indexer_daemon_stop');
    daemonStopped = true;

    return {
      ok: true,
      scenario: 'background-indexer',
      candidate: {
        runId: candidate.runId,
        sdk: {
          packageName: candidate.sdk.packageName,
          version: candidate.sdk.version,
          integrity: candidate.sdk.integrity,
        },
        cli: {
          packageName: candidate.cli.packageName,
          version: candidate.cli.version,
          integrity: candidate.cli.integrity,
        },
      },
      artifactAdmission: options.artifactAdmission,
      platform: { os: process.platform, arch: process.arch },
      evidence: {
        initialHeartbeat,
        reloadHeartbeat,
        restartHeartbeat,
        cancellationHeartbeat,
        rejectedMigrationKinds: { forcedFailure, fixtureIncompatible },
        databaseRemovedAfterCancellation: true,
      },
      cleanup: { disposition: 'removed' },
    };
  } finally {
    if (cliEntrypoint && childEnv && !daemonStopped) {
      await runPackedCli({
        cliEntrypoint,
        cwd: tempRoot,
        env: childEnv,
        args: ['daemon', 'stop'],
      }).catch(() => undefined);
    }
    await registry?.close().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const startedAt = new Date().toISOString();
  let candidate: PackedAuthorDirectArtifactsSmoke | null = null;
  let artifactAdmission: PackedAuthorArtifactAdmission | undefined;
  try {
    // This companion consumes the established candidate admission grammar. Its
    // scenario value is intentionally the shared Vertical-A input token, not a
    // second candidate format.
    const loaded = await loadPackedAuthorVerticalAArtifacts(argv);
    candidate = loaded.candidate;
    artifactAdmission = loaded.admission;
    const result = await runPackedBackgroundIndexer(candidate, { artifactAdmission });
    process.stdout.write(`${JSON.stringify({
      ...result,
      startedAt,
      completedAt: new Date().toISOString(),
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      scenario: 'background-indexer',
      candidate: candidate === null ? null : {
        runId: candidate.runId,
        sdk: candidate.sdk,
        cli: candidate.cli,
      },
      artifactAdmission,
      error: {
        code: 'packed_background_indexer_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      cleanup: { disposition: 'attempted' },
      startedAt,
      completedAt: new Date().toISOString(),
    })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await main();
}
