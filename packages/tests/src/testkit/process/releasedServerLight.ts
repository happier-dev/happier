import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { extractReleasePayloadRootFromArchive } from '@happier-dev/cli-common/firstPartyRuntime';

import { waitForOkHealth } from '../http';
import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { spawnLoggedProcess, type SpawnedProcess } from './spawnProcess';

export const RELEASED_SERVER_V0_2_1_VERSION = '0.2.1';
export const RELEASED_SERVER_V0_2_1_COMMIT = '4913c1e533c872a0712ba1c25b3104fd470aacc2';
export const RELEASED_SERVER_V0_2_1_DARWIN_ARM64_SHA256 =
  'b9f72dd17606e955cb2c66acc3f729561617ed46db34d4cf78b433f990c1870c';
export const RELEASED_SERVER_V0_2_1_LINUX_X64_SHA256 =
  'fe43480d40ab10e53a2743d5f87649b13421ef080a4c304f0dae9b26d4fd666f';

type ReleasedServerV021ArtifactTarget = Readonly<{
  releaseOs: 'darwin' | 'linux';
  arch: 'arm64' | 'x64';
  expectedArchiveSha256: string;
}>;

function resolveReleasedServerV021ArtifactTarget(
  platform: NodeJS.Platform | string,
  arch: string,
): ReleasedServerV021ArtifactTarget | null {
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      releaseOs: 'darwin',
      arch: 'arm64',
      expectedArchiveSha256: RELEASED_SERVER_V0_2_1_DARWIN_ARM64_SHA256,
    };
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      releaseOs: 'linux',
      arch: 'x64',
      expectedArchiveSha256: RELEASED_SERVER_V0_2_1_LINUX_X64_SHA256,
    };
  }
  return null;
}

const RELEASED_SERVER_V0_2_1_RELEASE_BASE_URL =
  'https://github.com/happier-dev/happier/releases/download/server-preview';

export type ReleasedServerV021ArtifactPrerequisite =
  | Readonly<{
    status: 'ready';
    archivePath: string;
    manifestPath: string;
    expectedArchiveSha256: string;
  }>
  | Readonly<{
    status: 'skipped';
    reason: string;
  }>;

export function resolveReleasedServerV021ArtifactPrerequisite(params: Readonly<{
  defaultArtifactDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Test-only system-boundary override. */
  fileExists?: (path: string) => boolean;
}>): ReleasedServerV021ArtifactPrerequisite {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  const fileExists = params.fileExists ?? existsSync;
  const configuredRaw = env.HAPPIER_E2E_RELEASED_SERVER_V0_2_1_DIR;
  const explicitlyConfigured = configuredRaw !== undefined;
  const configuredDir = configuredRaw?.trim();

  if (explicitlyConfigured && !configuredDir) {
    throw new Error('HAPPIER_E2E_RELEASED_SERVER_V0_2_1_DIR was set but is empty');
  }
  const target = resolveReleasedServerV021ArtifactTarget(platform, arch);
  if (!target) {
    const reason = `immutable server-v0.2.1 artifact is not pinned for ${platform}-${arch}`;
    if (explicitlyConfigured) throw new Error(reason);
    return { status: 'skipped', reason };
  }

  const artifactDir = resolve(configuredDir ?? params.defaultArtifactDir);
  const archivePath = resolve(
    artifactDir,
    `happier-server-v${RELEASED_SERVER_V0_2_1_VERSION}-${target.releaseOs}-${target.arch}.tar.gz`,
  );
  const manifestPath = resolve(artifactDir, `${target.releaseOs}-${target.arch}.json`);
  const missing = [
    fileExists(archivePath) ? null : archivePath,
    fileExists(manifestPath) ? null : manifestPath,
  ].filter((path): path is string => path !== null);

  if (missing.length > 0) {
    const reason = `immutable server-v0.2.1 artifact prerequisite is missing: ${missing.join(', ')}`;
    if (explicitlyConfigured) throw new Error(reason);
    return { status: 'skipped', reason };
  }

  return {
    status: 'ready',
    archivePath,
    manifestPath,
    expectedArchiveSha256: target.expectedArchiveSha256,
  };
}

type PrepareReleasedServerV021ArtifactDeps = Readonly<{
  downloadFile: (url: string, destinationPath: string) => Promise<void>;
  sha256File: (path: string) => Promise<string>;
}>;

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download immutable server-v0.2.1 artifact (${response.status} ${response.statusText}): ${url}`);
  }
  const partialPath = `${destinationPath}.partial-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const destination = await open(partialPath, 'wx');
    try {
      for await (const chunk of response.body) {
        await destination.writeFile(chunk);
      }
    } finally {
      await destination.close();
    }
    await rename(partialPath, destinationPath);
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function prepareReleasedServerV021Artifact(params: Readonly<{
  artifactDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Test-only system-boundary overrides. */
  __deps?: Partial<PrepareReleasedServerV021ArtifactDeps>;
}>): Promise<Extract<ReleasedServerV021ArtifactPrerequisite, { status: 'ready' }>> {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  const target = resolveReleasedServerV021ArtifactTarget(platform, arch);
  if (!target) {
    throw new Error(`immutable server-v0.2.1 artifact is not pinned for ${platform}-${arch}`);
  }

  const deps: PrepareReleasedServerV021ArtifactDeps = {
    downloadFile,
    sha256File,
    ...(params.__deps ?? {}),
  };
  const artifactDir = resolve(params.artifactDir);
  const archiveName =
    `happier-server-v${RELEASED_SERVER_V0_2_1_VERSION}-${target.releaseOs}-${target.arch}.tar.gz`;
  const manifestName = `${target.releaseOs}-${target.arch}.json`;
  const archivePath = resolve(artifactDir, archiveName);
  const manifestPath = resolve(artifactDir, manifestName);
  await mkdir(artifactDir, { recursive: true });

  if (!existsSync(manifestPath)) {
    await deps.downloadFile(`${RELEASED_SERVER_V0_2_1_RELEASE_BASE_URL}/${manifestName}`, manifestPath);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ReleasedServerArtifactManifest;
  verifyReleasedServerArtifactProvenance({
    manifest,
    archiveName,
    archiveSha256: target.expectedArchiveSha256,
    callerExpectedArchiveSha256: target.expectedArchiveSha256,
    expectedPlatform: platform,
    expectedArch: target.arch,
  });

  if (!existsSync(archivePath)) {
    await deps.downloadFile(`${RELEASED_SERVER_V0_2_1_RELEASE_BASE_URL}/${archiveName}`, archivePath);
  }
  const archiveSha256 = await deps.sha256File(archivePath);
  verifyReleasedServerArtifactProvenance({
    manifest,
    archiveName,
    archiveSha256,
    callerExpectedArchiveSha256: target.expectedArchiveSha256,
    expectedPlatform: platform,
    expectedArch: target.arch,
  });

  return {
    status: 'ready',
    archivePath,
    manifestPath,
    expectedArchiveSha256: target.expectedArchiveSha256,
  };
}

type ReleasedServerArtifactManifestRecord = Readonly<{
  schemaVersion?: unknown;
  product?: unknown;
  channel?: unknown;
  version?: unknown;
  os?: unknown;
  arch?: unknown;
  url?: unknown;
  sha256?: unknown;
  build?: Readonly<{ commitSha?: unknown; workflowRunId?: unknown }> | null;
  [key: string]: unknown;
}>;

export type ReleasedServerArtifactManifest = ReleasedServerArtifactManifestRecord & Readonly<{
  records?: readonly ReleasedServerArtifactManifestRecord[];
}>;

type ReleasedServerLightDeps = Readonly<{
  sha256File: (path: string) => Promise<string>;
  extractReleasePayloadRootFromArchive: typeof extractReleasePayloadRootFromArchive;
  reserveAvailablePort: typeof reserveAvailablePort;
  spawnLoggedProcess: typeof spawnLoggedProcess;
  waitForOkHealth: typeof waitForOkHealth;
}>;

const defaultDeps: ReleasedServerLightDeps = {
  sha256File,
  extractReleasePayloadRootFromArchive,
  reserveAvailablePort,
  spawnLoggedProcess,
  waitForOkHealth,
};

function normalizeSha256(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function releaseOsForPlatform(platform: NodeJS.Platform | string): string {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  return String(platform);
}

function archiveFilenameFromUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    return basename(new URL(value).pathname);
  } catch {
    return basename(value);
  }
}

function provenanceMismatch(detail: string): never {
  throw new Error(`Released server artifact provenance mismatch: ${detail}`);
}

export function verifyReleasedServerArtifactProvenance(params: Readonly<{
  manifest: ReleasedServerArtifactManifest;
  archiveName: string;
  archiveSha256: string;
  callerExpectedArchiveSha256: string;
  expectedPlatform: NodeJS.Platform | string;
  expectedArch: string;
}>): ReleasedServerArtifactManifestRecord {
  const expectedOs = releaseOsForPlatform(params.expectedPlatform);
  const expectedArch = params.expectedArch.trim();
  const archiveName = basename(params.archiveName);
  const expectedArchiveName = `happier-server-v${RELEASED_SERVER_V0_2_1_VERSION}-${expectedOs}-${expectedArch}.tar.gz`;
  const archiveSha256 = normalizeSha256(params.archiveSha256);
  const callerChecksum = normalizeSha256(params.callerExpectedArchiveSha256);

  if (!/^[a-f0-9]{64}$/u.test(callerChecksum)) {
    provenanceMismatch('caller checksum must be a 64-character SHA-256 digest');
  }
  if (archiveSha256 !== callerChecksum) {
    provenanceMismatch(`archive digest does not match caller checksum (caller checksum=${callerChecksum}, actual=${archiveSha256})`);
  }
  if (archiveName !== expectedArchiveName) {
    provenanceMismatch(`archive name must be ${expectedArchiveName}, got ${archiveName}`);
  }
  if (params.manifest.schemaVersion !== 'v1' || params.manifest.product !== 'happier-server') {
    provenanceMismatch('manifest must be schema v1 for happier-server');
  }
  if (params.manifest.version !== RELEASED_SERVER_V0_2_1_VERSION) {
    provenanceMismatch(`manifest version must be ${RELEASED_SERVER_V0_2_1_VERSION}`);
  }

  const records = Array.isArray(params.manifest.records) ? params.manifest.records : [params.manifest];
  const matches = records.filter((record) => (
    record.schemaVersion === 'v1'
    && record.product === 'happier-server'
    && record.version === RELEASED_SERVER_V0_2_1_VERSION
    && record.os === expectedOs
    && record.arch === expectedArch
    && archiveFilenameFromUrl(record.url) === archiveName
  ));
  if (matches.length !== 1) {
    provenanceMismatch(`manifest must contain exactly one ${expectedOs}-${expectedArch} record for ${archiveName}`);
  }

  const record = matches[0]!;
  if (typeof params.manifest.channel !== 'string' || record.channel !== params.manifest.channel) {
    provenanceMismatch('record channel must match the manifest channel');
  }
  if (record.build?.commitSha !== RELEASED_SERVER_V0_2_1_COMMIT) {
    provenanceMismatch(`record commit must be ${RELEASED_SERVER_V0_2_1_COMMIT}`);
  }
  if (normalizeSha256(record.sha256) !== callerChecksum) {
    provenanceMismatch('manifest checksum does not match caller checksum');
  }
  return record;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolveHash);
    stream.once('error', reject);
  });
  return hash.digest('hex');
}

function requireOwnedPath(ownerDir: string, candidate: string, label: string): string {
  const owner = resolve(ownerDir);
  const resolved = resolve(candidate);
  const rel = relative(owner, resolved);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Released server ${label} must be a child of testDir: ${resolved}`);
  }
  return resolved;
}

function renderSqliteDatabaseUrl(databasePath: string, platform: NodeJS.Platform | string): string {
  const normalized = databasePath.replaceAll('\\', '/');
  if (platform === 'win32') {
    return /^[A-Za-z]:\//u.test(normalized) ? `file:///${normalized}` : `file:${normalized}`;
  }
  return `file:${normalized}`;
}

function resolvePrismaEnginePath(runtimeRoot: string, platform: NodeJS.Platform | string, arch: string): string {
  const releaseOs = releaseOsForPlatform(platform);
  const engineNameByTarget: Record<string, string> = {
    'darwin-arm64': 'libquery_engine-darwin-arm64.dylib.node',
    'darwin-x64': 'libquery_engine-darwin.dylib.node',
    'linux-arm64': 'libquery_engine-linux-arm64-openssl-3.0.x.so.node',
    'linux-x64': 'libquery_engine-debian-openssl-3.0.x.so.node',
    'windows-x64': 'query_engine-windows.dll.node',
  };
  const engineName = engineNameByTarget[`${releaseOs}-${arch}`];
  if (!engineName) {
    throw new Error(`Released server v0.2.1 testkit does not know the Prisma engine for ${releaseOs}-${arch}`);
  }
  return resolve(runtimeRoot, 'generated', 'sqlite-client', engineName);
}

async function assertReleasedPayloadLayout(params: Readonly<{
  runtimeRoot: string;
  platform: NodeJS.Platform | string;
  arch: string;
}>): Promise<Readonly<{ binaryPath: string; migrationsDir: string; prismaEnginePath: string }>> {
  const binaryName = params.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
  const binaryPath = resolve(params.runtimeRoot, binaryName);
  const migrationsDir = resolve(params.runtimeRoot, 'prisma', 'sqlite', 'migrations');
  const prismaEnginePath = resolvePrismaEnginePath(params.runtimeRoot, params.platform, params.arch);

  const [binaryStat, engineStat, migrationEntries] = await Promise.all([
    lstat(binaryPath).catch(() => null),
    lstat(prismaEnginePath).catch(() => null),
    readdir(migrationsDir, { withFileTypes: true }).catch(() => []),
  ]);
  if (!binaryStat?.isFile()) {
    throw new Error(`Released server v0.2.1 archive is missing its binary: ${binaryPath}`);
  }
  if (!engineStat?.isFile()) {
    throw new Error(`Released server v0.2.1 archive is missing its bundled Prisma engine: ${prismaEnginePath}`);
  }
  const migrationDirs = migrationEntries.filter((entry) => entry.isDirectory());
  const hasMigrationSql = (await Promise.all(
    migrationDirs.map(async (entry) => (
      await lstat(join(migrationsDir, entry.name, 'migration.sql')).catch(() => null)
    )?.isFile() === true),
  )).some(Boolean);
  if (!hasMigrationSql) {
    throw new Error(`Released server v0.2.1 archive is missing bundled SQLite migrations: ${migrationsDir}`);
  }
  if (params.platform !== 'win32') {
    await chmod(binaryPath, 0o755);
  }
  return { binaryPath, migrationsDir, prismaEnginePath };
}

async function waitForHealthOrEarlyExit(params: Readonly<{
  proc: SpawnedProcess;
  baseUrl: string;
  waitForOkHealth: typeof waitForOkHealth;
}>): Promise<void> {
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  const exitedEarly = new Promise<never>((_, reject) => {
    onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = signal ? `signal=${signal}` : `code=${code ?? 'null'}`;
      reject(new Error(`released server v0.2.1 exited before /health was ready (${detail})`));
    };
    params.proc.child.once('exit', onExit);
    if (params.proc.child.exitCode !== null || params.proc.child.signalCode !== null) {
      params.proc.child.off('exit', onExit);
      onExit(params.proc.child.exitCode, params.proc.child.signalCode as NodeJS.Signals | null);
    }
  });
  try {
    await Promise.race([
      params.waitForOkHealth(params.baseUrl, { timeoutMs: 90_000 }),
      exitedEarly,
    ]);
  } finally {
    if (onExit) params.proc.child.off('exit', onExit);
  }
}

export type StartedReleasedServerLight = Readonly<{
  baseUrl: string;
  port: number;
  dataDir: string;
  runtimeRoot: string;
  runtimeExtractDir: string;
  proc: SpawnedProcess;
  stop: () => Promise<void>;
}>;

export async function startReleasedServerLight(params: Readonly<{
  testDir: string;
  archivePath: string;
  manifestPath: string;
  expectedArchiveSha256: string;
  extraEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Test-only system-boundary overrides. */
  __deps?: Partial<ReleasedServerLightDeps>;
}>): Promise<StartedReleasedServerLight> {
  const deps: ReleasedServerLightDeps = { ...defaultDeps, ...(params.__deps ?? {}) };
  const testDir = resolve(params.testDir);
  const platform = params.platform ?? process.platform;
  const arch = (params.arch ?? process.arch).trim();
  const archivePath = resolve(params.archivePath);
  const manifestPath = resolve(params.manifestPath);
  const archiveName = basename(archivePath);
  const runtimeExtractDir = requireOwnedPath(testDir, resolve(testDir, 'released-server-v0.2.1-runtime'), 'extraction root');
  const dataDir = requireOwnedPath(testDir, resolve(testDir, 'released-server-v0.2.1-data'), 'data root');
  const authDir = requireOwnedPath(testDir, resolve(testDir, 'released-server-v0.2.1-auth'), 'auth root');

  const [manifestRaw, archiveSha256] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    deps.sha256File(archivePath),
  ]);
  let manifest: ReleasedServerArtifactManifest;
  try {
    manifest = JSON.parse(manifestRaw) as ReleasedServerArtifactManifest;
  } catch (error) {
    throw new Error(`Released server artifact provenance mismatch: manifest is not valid JSON: ${String(error)}`);
  }
  verifyReleasedServerArtifactProvenance({
    manifest,
    archiveName,
    archiveSha256,
    callerExpectedArchiveSha256: params.expectedArchiveSha256,
    expectedPlatform: platform,
    expectedArch: arch,
  });

  await Promise.all([
    rm(runtimeExtractDir, { recursive: true, force: true }),
    rm(dataDir, { recursive: true, force: true }),
    rm(authDir, { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(runtimeExtractDir, { recursive: true }),
    mkdir(resolve(dataDir, 'files'), { recursive: true }),
    mkdir(resolve(dataDir, 'pglite'), { recursive: true }),
    mkdir(resolve(authDir, 'home'), { recursive: true }),
    mkdir(resolve(authDir, 'config'), { recursive: true }),
  ]);

  let proc: SpawnedProcess | null = null;
  try {
    const extractedRoot = await deps.extractReleasePayloadRootFromArchive({
      archivePath,
      archiveName,
      extractDir: runtimeExtractDir,
    });
    const runtimeRoot = requireOwnedPath(runtimeExtractDir, extractedRoot, 'payload root');
    const layout = await assertReleasedPayloadLayout({ runtimeRoot, platform, arch });
    const port = await deps.reserveAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const databasePath = resolve(dataDir, 'happier-server-light.sqlite');
    const homeDir = resolve(authDir, 'home');
    const configDir = resolve(authDir, 'config');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...params.extraEnv,
      CI: '1',
      PORT: String(port),
      PUBLIC_URL: baseUrl,
      HAPPIER_SERVER_HOST: '127.0.0.1',
      HAPPY_SERVER_HOST: '127.0.0.1',
      METRICS_ENABLED: 'false',
      HAPPIER_DB_PROVIDER: 'sqlite',
      HAPPY_DB_PROVIDER: 'sqlite',
      DATABASE_URL: renderSqliteDatabaseUrl(databasePath, platform),
      HAPPIER_FILES_BACKEND: 'local',
      HAPPY_SERVER_LIGHT_DATA_DIR: dataDir,
      HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
      HAPPY_SERVER_LIGHT_FILES_DIR: resolve(dataDir, 'files'),
      HAPPIER_SERVER_LIGHT_FILES_DIR: resolve(dataDir, 'files'),
      HAPPY_SERVER_LIGHT_DB_DIR: resolve(dataDir, 'pglite'),
      HAPPIER_SERVER_LIGHT_DB_DIR: resolve(dataDir, 'pglite'),
      HAPPIER_SQLITE_AUTO_MIGRATE: '1',
      HAPPY_SQLITE_AUTO_MIGRATE: '1',
      HAPPIER_SQLITE_MIGRATIONS_DIR: layout.migrationsDir,
      HAPPY_SQLITE_MIGRATIONS_DIR: layout.migrationsDir,
      PRISMA_CLIENT_ENGINE_TYPE: 'library',
      PRISMA_QUERY_ENGINE_LIBRARY: layout.prismaEnginePath,
      NODE_PATH: resolve(runtimeRoot, 'node_modules'),
      HOME: homeDir,
      USERPROFILE: homeDir,
      XDG_CONFIG_HOME: configDir,
      HANDY_MASTER_SECRET: randomBytes(32).toString('base64url'),
      AUTH_ANONYMOUS_SIGNUP_ENABLED: 'true',
    };

    proc = deps.spawnLoggedProcess({
      command: layout.binaryPath,
      args: [],
      cwd: runtimeRoot,
      env,
      stdoutPath: resolve(testDir, 'released-server-v0.2.1.stdout.log'),
      stderrPath: resolve(testDir, 'released-server-v0.2.1.stderr.log'),
    });
    await waitForHealthOrEarlyExit({ proc, baseUrl, waitForOkHealth: deps.waitForOkHealth });

    let stopped = false;
    return {
      baseUrl,
      port,
      dataDir,
      runtimeRoot,
      runtimeExtractDir,
      proc,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        try {
          await proc?.stop();
        } finally {
          await rm(runtimeExtractDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await proc?.stop().catch(() => {});
    await rm(runtimeExtractDir, { recursive: true, force: true });
    throw error;
  }
}
