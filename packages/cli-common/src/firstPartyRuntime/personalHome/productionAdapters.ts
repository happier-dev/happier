import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix, win32 } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { resolveRelayRuntimeDefaults } from '../relayRuntime.js';
import { applyEnvOverridesToEnvText, parseEnvText } from '../selfHostServerEnv.js';
import { readSqliteMigrationCatalog, type SqliteMigrationCatalogEntry } from '../sqliteMigrationCatalog.js';
import { resolvePersonalHomeRuntimeLayout, type PersonalHomeRuntimeLayout } from './layout.js';
import {
  createPersonalHomeOperations,
  PersonalHomeOperationsError,
  type PersonalHomeIdentityFacts,
  type PersonalHomeOperations,
  type PersonalHomeOperationsDeps,
} from './operations.js';
import type { PersonalHomeSqliteMaintenance } from './backup.js';
import {
  PERSONAL_HOME_RESTORABLE_CONFIGURATION_ENV_KEYS,
  parsePersonalHomeRestorableConfigurationV1,
  personalHomeRestorableConfigurationEnvOverrides,
  resolveHomeDeviceApprovalRequiredFromEnv,
  type PersonalHomeRestorableConfigurationV1,
} from './configuration.js';
import { createPersonalHomePathProtection } from './protection.js';
import { removePathDurably, replacePersonalHomeFileDurably, syncPersonalHomeFileAndParent } from './durableFile.js';
import {
  assertRestoredPersonalHomeAllowlistedFilesReadable,
  finalizePersonalHomeRestoreWithLease,
  hasMeaningfulPersonalHomeData,
  inspectPersonalHomeRestoreRecovery,
  PersonalHomeRestoreError,
  recoverPersonalHomeRestoreWithLease,
  restorePersonalHomeBackupWithLease,
} from './restore.js';
import { verifyPersonalHomeArchive } from './archive.js';
import { fingerprintMasterSecret } from './manifest.js';
import {
  createPersonalHomeRelocationDestinationOwner,
  type PersonalHomeRelocationDestinationOwner,
} from './relocationDestination.js';
import { HOME_OWNER_CLAIM_COMMAND_ARGUMENT_V1, HomeOwnerClaimCommandOutputV1Schema } from '@happier-dev/protocol/home/governance/claim';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import type { HomeConnectionDescriptorV1, HomeOwnerClaimCommandOutputV1 } from '@happier-dev/protocol';
import { execFileWithDeadline } from '../../process/index.js';
import {
  parsePersonalHomeAuthenticatedReadiness,
  type PersonalHomeAuthenticatedReadiness,
} from './readiness.js';
import {
  inspectPersonalHomeSqliteMigrationFrontier,
  migrateStagedPersonalHomeSqliteDatabase,
  resolveInstalledPersonalHomeSqliteMigrationPaths,
  type PersonalHomeMigrationProcessRunner,
} from './stagedMigrationFrontier.js';
import { openPersonalHomeSqliteDatabase } from './sqlite.js';

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

/** The installed runtime's server executable, the same program the Home service runs. */
export function resolvePersonalHomeServerBinaryPath(installRoot: string, platform: NodeJS.Platform = process.platform): string {
  return pathApi(platform).join(installRoot, 'bin', platform === 'win32' ? 'happier-server.exe' : 'happier-server');
}

/** One wall-clock budget for every deployment-local Personal Home server one-shot. */
const PERSONAL_HOME_SERVER_COMMAND_TIMEOUT_MS = 120_000;

function canonicalPath(platform: NodeJS.Platform, value: string): string {
  return pathApi(platform).normalize(pathApi(platform).resolve(value));
}

function comparablePath(platform: NodeJS.Platform, value: string): string {
  const normalized = canonicalPath(platform, value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = pathApi(platform);
  const child = api.relative(canonicalPath(platform, root), canonicalPath(platform, candidate));
  return child === '' || (!child.startsWith('..') && !api.isAbsolute(child));
}

export async function validateCanonicalPersonalHomeLayout(
  layout: PersonalHomeRuntimeLayout,
  trusted: Readonly<{ homeDir: string; installRoot: string; configDir: string }>,
): Promise<void> {
  const platform = layout.platform;
  const api = pathApi(platform);
  const canonical = (value: string): string => canonicalPath(platform, value);
  const comparable = (value: string): string => comparablePath(platform, value);
  const homeDir = canonical(trusted.homeDir);
  const installRoot = canonical(layout.installRoot);
  const configDir = canonical(layout.configDir);
  const logsDir = canonical(layout.logsDir);
  if (comparable(layout.installRoot) !== comparable(trusted.installRoot) || comparable(layout.configDir) !== comparable(trusted.configDir)) {
    throw new Error('Personal Home layout is not owned by the managed runtime defaults');
  }
  const destructiveDirectories = [layout.dataDir, layout.publicFilesDir, layout.privateFilesDir, layout.backupsDir, layout.derivedDataDir];
  const protectedAncestors = [homeDir, installRoot, configDir, logsDir];
  for (const target of destructiveDirectories) {
    const normalized = canonical(target);
    if (!api.isAbsolute(normalized)
      || comparable(normalized) === comparable(api.parse(normalized).root)
      || comparable(normalized) === comparable(homeDir)
      || protectedAncestors.some((protectedRoot) => isWithin(normalized, protectedRoot, platform))) {
      throw new Error('Unsafe Personal Home data root: destructive target overlaps a filesystem, user-home, install, config, or log root');
    }
  }
  if (!isWithin(layout.dataDir, layout.databasePath, platform) || !isWithin(layout.dataDir, layout.masterSecretPath, platform)) {
    throw new Error('Personal Home database and master secret must remain inside the canonical data root');
  }
  const roots = [layout.publicFilesDir, layout.privateFilesDir].map(canonical);
  if (comparable(roots[0]!) === comparable(roots[1]!) || isWithin(roots[0]!, roots[1]!, platform) || isWithin(roots[1]!, roots[0]!, platform)) {
    throw new Error('Personal Home public and private file roots must not overlap');
  }
  const reserved = [layout.databasePath, layout.masterSecretPath, layout.backupsDir, layout.derivedDataDir, api.join(layout.dataDir, 'runtime'), layout.configDir];
  for (const root of roots) {
    if (comparable(root) === comparable(layout.dataDir) || comparable(root) === comparable(layout.installRoot) || comparable(root) === comparable(layout.configDir)) throw new Error('Unsafe Personal Home file root');
    for (const path of reserved) if (isWithin(root, path, platform) || isWithin(path, root, platform)) throw new Error('Personal Home file root overlaps runtime, credentials, backups, or derived data');
  }
  const controlledRoots = [
    { target: layout.configDir, fallbackBoundary: layout.configDir },
    { target: layout.dataDir, fallbackBoundary: layout.dataDir },
    { target: layout.publicFilesDir, fallbackBoundary: isWithin(layout.dataDir, layout.publicFilesDir, platform) ? layout.dataDir : layout.publicFilesDir },
    { target: layout.privateFilesDir, fallbackBoundary: isWithin(layout.dataDir, layout.privateFilesDir, platform) ? layout.dataDir : layout.privateFilesDir },
  ];
  for (const { target, fallbackBoundary } of controlledRoots) {
    const boundary = isWithin(homeDir, target, platform) ? homeDir : fallbackBoundary;
    await rejectSymbolicLinksAtOrBelowBoundary(boundary, target, platform);
  }
}

async function rejectSymbolicLinksAtOrBelowBoundary(boundary: string, target: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const api = pathApi(platform);
  const resolvedBoundary = canonicalPath(platform, boundary);
  const resolvedTarget = canonicalPath(platform, target);
  if (!isWithin(resolvedBoundary, resolvedTarget, platform)) throw new Error('Personal Home path escapes its trusted boundary');
  // Platform-owned aliases above this explicit boundary are trusted; every component the caller
  // controls at or below it must remain a real directory/path rather than a link.
  const child = api.relative(resolvedBoundary, resolvedTarget);
  const paths = [resolvedBoundary];
  if (child) {
    let cursor = resolvedBoundary;
    for (const segment of child.split(/[\\/]+/u)) {
      cursor = api.join(cursor, segment);
      paths.push(cursor);
    }
  }
  for (const path of paths) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) throw new Error('Personal Home path uses a symbolic-link ancestor');
  }
}

export async function resolveCanonicalPersonalHomeRuntimeLayout(params: Readonly<{
  homeDir: string;
  platform?: NodeJS.Platform;
  mode?: 'user' | 'system';
  channel?: PublicReleaseRingId;
}>): Promise<PersonalHomeRuntimeLayout> {
  const platform = params.platform ?? process.platform;
  const mode = params.mode ?? 'user';
  const channel = params.channel ?? 'stable';
  const defaults = resolveRelayRuntimeDefaults({ platform, mode, channel, homeDir: params.homeDir });
  const envPath = join(defaults.configDir, 'server.env');
  const envText = await readFile(envPath, 'utf8');
  const persisted = parseEnvText(envText);
  const layout = resolvePersonalHomeRuntimeLayout({ env: persisted, homeDir: params.homeDir, platform, mode, channel });
  await validateCanonicalPersonalHomeLayout(layout, { ...defaults, homeDir: params.homeDir });
  return layout;
}

export async function createPersonalHomeSqliteMaintenance(databasePath: string): Promise<PersonalHomeSqliteMaintenance> {
  const database = openPersonalHomeSqliteDatabase(databasePath);
  let closed = false;
  return {
    checkpoint: async () => {
      const row = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Record<string, unknown> | undefined;
      return { busy: Number(row?.busy ?? 1) };
    },
    quickCheck: async () => {
      const row = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
      return Object.values(row ?? {})[0] === 'ok';
    },
    close: async () => {
      if (!closed) {
        closed = true;
        database.close();
        for (const suffix of ['-wal', '-shm']) {
          const path = `${databasePath}${suffix}`;
          const info = await stat(path).catch(() => null);
          if (info && (suffix === '-shm' || info.size === 0)) await unlink(path).catch(() => undefined);
        }
      }
    },
  };
}

export async function readPersonalHomeIdentityValueFromSqlite(databasePath: string): Promise<Pick<PersonalHomeIdentityFacts, 'homeServerIdentityId'>> {
  const database = openPersonalHomeSqliteDatabase(databasePath, { readOnly: true });
  try {
    const identity = database.prepare('SELECT value FROM SimpleCache WHERE key = ?').get('server.identity.v1') as
      | Readonly<{ value?: unknown }>
      | undefined;
    if (typeof identity?.value !== 'string' || !identity.value) throw new Error('Personal Home identity is unavailable');
    return { homeServerIdentityId: identity.value };
  } finally {
    database.close();
  }
}

export async function readPersonalHomeDataCountsFromSqlite(databasePath: string): Promise<Readonly<{ accountCount: number; sessionCount: number }>> {
  const database = openPersonalHomeSqliteDatabase(databasePath, { readOnly: true });
  try {
    const account = database.prepare('SELECT COUNT(*) AS count FROM "Account"').get() as Readonly<{ count?: unknown }> | undefined;
    const session = database.prepare('SELECT COUNT(*) AS count FROM "Session"').get() as Readonly<{ count?: unknown }> | undefined;
    const accountCount = Number(account?.count);
    const sessionCount = Number(session?.count);
    if (!Number.isSafeInteger(accountCount) || accountCount < 0 || !Number.isSafeInteger(sessionCount) || sessionCount < 0) {
      throw new Error('Personal Home account/session counts are invalid');
    }
    return { accountCount, sessionCount };
  } finally {
    database.close();
  }
}

export async function readPersonalHomeIdentityFromSqlite(
  databasePath: string,
  catalog: readonly SqliteMigrationCatalogEntry[],
): Promise<PersonalHomeIdentityFacts> {
  const [identity, frontier] = await Promise.all([
    readPersonalHomeIdentityValueFromSqlite(databasePath),
    inspectPersonalHomeSqliteMigrationFrontier({ databasePath, catalog }),
  ]);
  return { ...identity, schemaVersion: frontier.schemaVersion };
}

async function readInstalledMigrationCatalog(layout: PersonalHomeRuntimeLayout): Promise<readonly SqliteMigrationCatalogEntry[]> {
  const paths = resolveInstalledPersonalHomeSqliteMigrationPaths({ installRoot: layout.installRoot, platform: layout.platform });
  return readSqliteMigrationCatalog(paths.migrationsDir);
}

export async function readCanonicalPersonalHomeIdentity(layout: PersonalHomeRuntimeLayout, databasePath = layout.databasePath): Promise<PersonalHomeIdentityFacts> {
  return readPersonalHomeIdentityFromSqlite(databasePath, await readInstalledMigrationCatalog(layout));
}

export async function readPersonalHomeSanitizedConfiguration(layout: PersonalHomeRuntimeLayout): Promise<Record<string, unknown>> {
  const env = parseEnvText(await readFile(join(layout.configDir, 'server.env'), 'utf8'));
  const result: Record<string, unknown> = {};
  for (const [field, envKey] of Object.entries(PERSONAL_HOME_RESTORABLE_CONFIGURATION_ENV_KEYS)) {
    const value = env[envKey];
    if (field === 'anonymousSignupPhase') {
      if (value !== undefined && value !== '0') throw new Error('Personal Home anonymous signup must be disabled before backup');
      if (value === '0') result[field] = 'loopback-bootstrap-then-disabled';
    } else if (field === 'homeDeviceApprovalRequired') {
      result[field] = resolveHomeDeviceApprovalRequiredFromEnv(env);
    } else if (typeof value === 'string' && value) result[field] = value;
  }
  if (!result.canonicalServerUrl) {
    const legacyCanonicalServerUrl = String(env.HAPPIER_PUBLIC_SERVER_URL ?? '').trim();
    if (legacyCanonicalServerUrl && String(env.HAPPIER_PUBLIC_SERVER_URL_INFERRED ?? '').trim() !== '1') {
      result.canonicalServerUrl = legacyCanonicalServerUrl;
    }
  }
  return result;
}

export async function applyPersonalHomeSanitizedConfiguration(
  layout: PersonalHomeRuntimeLayout,
  configuration: PersonalHomeRestorableConfigurationV1,
): Promise<Readonly<{ rollback(): Promise<void> }>> {
  const prepared = await preparePersonalHomeSanitizedConfiguration(layout, configuration);
  await prepared.apply();
  return { rollback: prepared.rollback };
}

export async function preparePersonalHomeSanitizedConfiguration(
  layout: PersonalHomeRuntimeLayout,
  configuration: PersonalHomeRestorableConfigurationV1,
): Promise<Readonly<{ rollbackArtifact: string; apply(): Promise<void>; rollback(): Promise<void> }>> {
  const { envPath, previous, next } = await renderPersonalHomeSanitizedConfiguration(layout, configuration);
  const id = randomUUID();
  const temporary = `${envPath}.${id}.restore.tmp`;
  const rollbackArtifact = `${envPath}.${id}.restore-rollback`;
  const protect = createPersonalHomePathProtection({ platform: layout.platform });
  await mkdir(dirname(envPath), { recursive: true });
  try {
    await writeFile(temporary, next, { mode: 0o600 });
    await protect(temporary, 'file');
    await writeFile(rollbackArtifact, previous, { mode: 0o600 });
    await protect(rollbackArtifact, 'file');
    await syncPersonalHomeFileAndParent(rollbackArtifact);
  } catch (error) {
    await Promise.all([
      rm(temporary, { force: true }).catch(() => undefined),
      rm(rollbackArtifact, { force: true }).catch(() => undefined),
    ]);
    throw error;
  }
  return {
    rollbackArtifact,
    apply: async () => { await replacePersonalHomeFileDurably(temporary, envPath); await protect(envPath, 'file'); },
    rollback: async () => recoverPersonalHomeSanitizedConfiguration(layout, rollbackArtifact),
  };
}

function removeEnvironmentAssignment(envText: string, key: string): string {
  const next = envText.split('\n').filter((line) => {
    const trimmed = line.trim();
    const separatorIndex = trimmed.indexOf('=');
    return separatorIndex < 0 || trimmed.slice(0, separatorIndex).trim() !== key;
  }).join('\n');
  return next.endsWith('\n') ? next : `${next}\n`;
}

async function renderPersonalHomeSanitizedConfiguration(layout: PersonalHomeRuntimeLayout, configuration: PersonalHomeRestorableConfigurationV1): Promise<Readonly<{ envPath: string; previous: Buffer; next: string }>> {
  const envPath = join(layout.configDir, 'server.env'); const previous = await readFile(envPath);
  const validated = parsePersonalHomeRestorableConfigurationV1(configuration);
  const overrides = personalHomeRestorableConfigurationEnvOverrides(validated);
  const previousWithoutIrohRelayPolicy = removeEnvironmentAssignment(
    previous.toString('utf8'),
    PERSONAL_HOME_RESTORABLE_CONFIGURATION_ENV_KEYS.irohRelayPolicy,
  );
  const previousText = removeEnvironmentAssignment(
    previousWithoutIrohRelayPolicy,
    PERSONAL_HOME_RESTORABLE_CONFIGURATION_ENV_KEYS.irohRelayUrls,
  );
  const next = applyEnvOverridesToEnvText(previousText, overrides);
  return { envPath, previous, next };
}

export async function inspectPersonalHomeSanitizedConfigurationStorage(layout: PersonalHomeRuntimeLayout, configuration: PersonalHomeRestorableConfigurationV1): Promise<Readonly<{ targetPath: string; incomingBytes: number; rollbackBytes: number }>> {
  const rendered = await renderPersonalHomeSanitizedConfiguration(layout, configuration);
  return { targetPath: rendered.envPath, incomingBytes: Buffer.byteLength(rendered.next), rollbackBytes: rendered.previous.byteLength };
}

export async function recoverPersonalHomeSanitizedConfiguration(layout: PersonalHomeRuntimeLayout, rollbackArtifact: string): Promise<void> {
  const envPath = join(layout.configDir, 'server.env');
  assertPersonalHomeConfigurationRollbackArtifact(envPath, rollbackArtifact);
  const previous = await readFile(rollbackArtifact);
  const temporary = `${envPath}.${randomUUID()}.rollback.tmp`;
  const protect = createPersonalHomePathProtection({ platform: layout.platform });
  await writeFile(temporary, previous, { mode: 0o600 }); await protect(temporary, 'file'); await replacePersonalHomeFileDurably(temporary, envPath); await protect(envPath, 'file');
}

function assertPersonalHomeConfigurationRollbackArtifact(envPath: string, rollbackArtifact: string): void {
  const prefix = `${envPath}.`;
  const suffix = '.restore-rollback';
  const id = rollbackArtifact.startsWith(prefix) && rollbackArtifact.endsWith(suffix)
    ? rollbackArtifact.slice(prefix.length, -suffix.length)
    : '';
  if (dirname(rollbackArtifact) !== dirname(envPath) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new Error('Invalid Personal Home configuration rollback artifact');
  }
}

export async function finalizePersonalHomeSanitizedConfiguration(layout: PersonalHomeRuntimeLayout, rollbackArtifact: string): Promise<void> {
  const envPath = join(layout.configDir, 'server.env');
  assertPersonalHomeConfigurationRollbackArtifact(envPath, rollbackArtifact);
  await removePathDurably(rollbackArtifact);
}

export async function createCanonicalPersonalHomeOperations(params: Readonly<{
  homeDir: string;
  platform?: NodeJS.Platform;
  mode?: 'user' | 'system';
  channel?: PublicReleaseRingId;
  lifecycle: PersonalHomeOperationsDeps['lifecycle'] & Readonly<{ healthCheck(): Promise<boolean> }>;
  attestActivatedHome?(): Promise<import('./readiness.js').PersonalHomeAuthenticatedReadiness>;
  readHappierVersion(): Promise<string>;
  readPurpose: PersonalHomeOperationsDeps['readPurpose'];
  runMigrationProcess?: PersonalHomeMigrationProcessRunner;
}>): Promise<PersonalHomeOperations> {
  const defaults = resolveRelayRuntimeDefaults({
    platform: params.platform ?? process.platform,
    mode: params.mode ?? 'user',
    channel: params.channel ?? 'stable',
    homeDir: params.homeDir,
  });
  return createPersonalHomeOperations({
    readPurpose: params.readPurpose,
    readIdentity: (layout) => readCanonicalPersonalHomeIdentity(layout),
    readIdentityForErase: (layout) => readPersonalHomeIdentityValueFromSqlite(layout.databasePath),
    resolveLayout: () => resolveCanonicalPersonalHomeRuntimeLayout(params),
    validateLayout: (candidate) => validateCanonicalPersonalHomeLayout(candidate, { ...defaults, homeDir: params.homeDir }),
    lifecycle: params.lifecycle,
    sqliteMaintenance: createPersonalHomeSqliteMaintenance,
    ...(params.runMigrationProcess ? {
      migrateStagedDatabase: (layout, databasePath, manifest) => migrateStagedPersonalHomeSqliteDatabase({
        layout,
        databasePath,
        manifestSchemaVersion: manifest.schemaVersion,
        runProcess: params.runMigrationProcess!,
      }).then(() => undefined),
    } : {}),
    readIdentityFromDatabase: (layout, databasePath) => readCanonicalPersonalHomeIdentity(layout, databasePath),
    readDataCountsFromDatabase: (_layout, databasePath) => readPersonalHomeDataCountsFromSqlite(databasePath),
    readConfiguration: (layout) => readPersonalHomeSanitizedConfiguration(layout),
    prepareConfiguration: (layout, configuration) => preparePersonalHomeSanitizedConfiguration(layout, configuration),
    inspectConfigurationStorage: (layout, configuration) => inspectPersonalHomeSanitizedConfigurationStorage(layout, configuration),
    recoverConfiguration: (layout, artifact) => recoverPersonalHomeSanitizedConfiguration(layout, artifact),
    finalizeConfiguration: (layout, artifact) => finalizePersonalHomeSanitizedConfiguration(layout, artifact),
    ...(params.attestActivatedHome ? { attestActivatedHome: params.attestActivatedHome } : {}),
    readHappierVersion: params.readHappierVersion,
    isSchemaSupported: async (layout, schemaVersion) => (await readInstalledMigrationCatalog(layout)).some((entry) => entry.name === schemaVersion),
    runOwnerClaimCommand: (layout, targetAccountId) => claimPersonalHomeOwnerWithServerCommand({
      layout,
      serverBinary: resolvePersonalHomeServerBinaryPath(defaults.installRoot, params.platform ?? process.platform),
      targetAccountId,
    }),
  });
}

/** Composes the destination-local relocation authority from the same canonical
 * layout, restore, SQLite, configuration and deletion owners used by ordinary
 * Personal Home operations. Remote coordinators never receive local paths. */
export async function createCanonicalPersonalHomeRelocationDestinationOwner(params: Readonly<{
  homeDir: string;
  platform?: NodeJS.Platform;
  mode?: 'user' | 'system';
  channel?: PublicReleaseRingId;
  quarantine(): Promise<void>;
  activate(): Promise<void>;
  readServiceStatus(): Promise<Readonly<{ running: boolean; quarantined: boolean }>>;
  attestActivatedHome(): Promise<import('./readiness.js').PersonalHomeAuthenticatedReadiness>;
  attestStagedHome(input: Readonly<{ layout: PersonalHomeRuntimeLayout; operationId: string }>): Promise<PersonalHomeAuthenticatedReadiness>;
  runMigrationProcess: PersonalHomeMigrationProcessRunner;
  materializeEndpoint(input: Readonly<{
    layout: PersonalHomeRuntimeLayout;
    operationId: string;
    sourceDescriptorRevision: number;
  }>): Promise<Readonly<{
    connectionDescriptor: HomeConnectionDescriptorV1;
  }>>;
}>): Promise<PersonalHomeRelocationDestinationOwner> {
  const platform = params.platform ?? process.platform;
  const mode = params.mode ?? 'user';
  const channel = params.channel ?? 'stable';
  const defaults = resolveRelayRuntimeDefaults({ platform, mode, channel, homeDir: params.homeDir });
  const initialLayout = await resolveCanonicalPersonalHomeRuntimeLayout({
    homeDir: params.homeDir,
    platform,
    mode,
    channel,
  });
  const resolveAttestedLayout = async (): Promise<PersonalHomeRuntimeLayout> => {
    const layout = await resolveCanonicalPersonalHomeRuntimeLayout({
      homeDir: params.homeDir,
      platform,
      mode,
      channel,
    });
    await validateCanonicalPersonalHomeLayout(layout, { ...defaults, homeDir: params.homeDir });
    if (JSON.stringify(layout) !== JSON.stringify(initialLayout)) {
      throw new Error('Personal Home relocation destination layout changed while the operation was pending');
    }
    return layout;
  };

  return createPersonalHomeRelocationDestinationOwner({
    dataDir: initialLayout.dataDir,
    readValidatedTarget: async () => {
      const layout = await resolveAttestedLayout();
      const configuration = await readPersonalHomeSanitizedConfiguration(layout);
      const database = await lstat(layout.databasePath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
      return {
        layout,
        canonicalServerUrl: typeof configuration.canonicalServerUrl === 'string' ? configuration.canonicalServerUrl : null,
        homeServerIdentityId: database ? (await readPersonalHomeIdentityValueFromSqlite(layout.databasePath)).homeServerIdentityId : null,
      };
    },
    preflightDestination: async () => {
      const layout = await resolveAttestedLayout();
      if (await hasMeaningfulPersonalHomeData(layout)) {
        throw new PersonalHomeRestoreError(
          'destination_not_empty',
          'Relocation destination contains unrelated Personal Home data',
        );
      }
    },
    quarantine: params.quarantine,
    readServiceStatus: params.readServiceStatus,
    activate: params.activate,
    attestActive: params.attestActivatedHome,
    stageCandidate: async (input) => {
      const layout = await resolveAttestedLayout();
      const restored = await restorePersonalHomeBackupWithLease({
        layout,
        archivePath: input.archivePath,
        operationLeaseHeld: true,
        expectedHomeServerIdentityId: input.expectedHomeServerIdentityId,
        confirmOverwrite: false,
        isSchemaSupported: async (schemaVersion) => (await readInstalledMigrationCatalog(layout)).some((entry) => entry.name === schemaVersion),
        isHomeRunning: async () => (await params.readServiceStatus()).running,
        stopHome: params.quarantine,
        sqliteMaintenance: createPersonalHomeSqliteMaintenance,
        runMigrations: async (databasePath, manifest) => await migrateStagedPersonalHomeSqliteDatabase({
          layout,
          databasePath,
          manifestSchemaVersion: manifest.schemaVersion,
          runProcess: params.runMigrationProcess,
        }).then(() => undefined),
        verifyStagedIdentity: async (databasePath, manifest) =>
          (await readCanonicalPersonalHomeIdentity(layout, databasePath)).homeServerIdentityId === manifest.homeServerIdentityId,
        prepareConfiguration: (configuration) => preparePersonalHomeSanitizedConfiguration(layout, configuration),
        inspectConfigurationStorage: (configuration) => inspectPersonalHomeSanitizedConfigurationStorage(layout, configuration),
        requireDataCountVerification: true,
        readDataCountsFromDatabase: (databasePath) => readPersonalHomeDataCountsFromSqlite(databasePath),
        verifyIdentity: async (manifest) =>
          (await readCanonicalPersonalHomeIdentity(layout)).homeServerIdentityId === manifest.homeServerIdentityId,
      });
      if (restored.outcome !== 'restored') {
        throw new Error(restored.error ?? 'Personal Home relocation destination restore failed');
      }
      const authenticatedReadiness = await params.attestStagedHome({ layout, operationId: input.operationId });
      if (authenticatedReadiness.homeServerIdentityId !== input.expectedHomeServerIdentityId) {
        throw new Error('Stopped relocation authentication attestation identity does not match the restored Home');
      }
      const endpoint = await params.materializeEndpoint({
        layout,
        operationId: input.operationId,
        sourceDescriptorRevision: input.sourceDescriptorRevision,
      });
      if (endpoint.connectionDescriptor.homeServerIdentityId !== input.expectedHomeServerIdentityId) {
        throw new Error('Materialized relocation endpoint identity does not match the restored Home');
      }
      return { ...endpoint, ...authenticatedReadiness };
    },
    inspectReceivedCandidate: async (input) => {
      const layout = await resolveAttestedLayout();
      let recovery: Awaited<ReturnType<typeof inspectPersonalHomeRestoreRecovery>>;
      try {
        recovery = await inspectPersonalHomeRestoreRecovery(layout);
      } catch (error) {
        return {
          outcome: 'ambiguous',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (recovery.status === 'rollback_available' || recovery.status === 'ambiguous') {
        return {
          outcome: 'ambiguous',
          reason: `the canonical restore journal is ${recovery.status}${recovery.phase ? ` (${recovery.phase})` : ''}`,
        };
      }
      if (recovery.status === 'none' && !(await hasMeaningfulPersonalHomeData(layout))) {
        return { outcome: 'absent' };
      }

      try {
        const manifest = await verifyPersonalHomeArchive(input.archivePath);
        if (manifest.homeServerIdentityId !== input.expectedHomeServerIdentityId) {
          throw new Error('Interrupted relocation archive identity does not match the reserved Home');
        }
        if (!(await readInstalledMigrationCatalog(layout)).some((entry) => entry.name === manifest.schemaVersion)) {
          throw new Error('Interrupted relocation archive schema is not supported by this runtime');
        }
        const [identity, counts, authenticatedReadiness, configuration, secret] = await Promise.all([
          readCanonicalPersonalHomeIdentity(layout),
          readPersonalHomeDataCountsFromSqlite(layout.databasePath),
          params.attestStagedHome({ layout, operationId: input.operationId }),
          readPersonalHomeSanitizedConfiguration(layout),
          readFile(layout.masterSecretPath),
        ]);
        if (identity.homeServerIdentityId !== manifest.homeServerIdentityId
          || fingerprintMasterSecret(secret) !== manifest.masterSecretFingerprint
          || authenticatedReadiness.authenticated !== true
          || authenticatedReadiness.homeServerIdentityId !== manifest.homeServerIdentityId
          || authenticatedReadiness.accountCount !== counts.accountCount
          || authenticatedReadiness.sessionCount !== counts.sessionCount
          || counts.accountCount < 1 || counts.sessionCount < 0) {
          throw new Error('Interrupted relocation identity, secret, authentication, or data-count facts do not match');
        }
        const normalizedConfiguration = parsePersonalHomeRestorableConfigurationV1({
          ...configuration,
          homeServerIdentityId: identity.homeServerIdentityId,
        });
        if (normalizedConfiguration.homeServerIdentityId !== manifest.homeServerIdentityId) {
          throw new Error('Interrupted relocation configuration identity does not match');
        }
        await assertRestoredPersonalHomeAllowlistedFilesReadable(layout, manifest);
        const endpoint = await params.materializeEndpoint({
          layout,
          operationId: input.operationId,
          sourceDescriptorRevision: input.sourceDescriptorRevision,
        });
        if (endpoint.connectionDescriptor.homeServerIdentityId !== manifest.homeServerIdentityId) {
          throw new Error('Interrupted relocation endpoint identity does not match the restored Home');
        }
        return { outcome: 'restored', ...endpoint, ...authenticatedReadiness };
      } catch (error) {
        return {
          outcome: 'ambiguous',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    abortCandidate: async () => {
      const layout = await resolveAttestedLayout();
      const recovery = await recoverPersonalHomeRestoreWithLease({
        layout,
        operationLeaseHeld: true,
        isHomeRunning: async () => (await params.readServiceStatus()).running,
        stopHome: params.quarantine,
        startHome: async () => { throw new Error('A relocation destination abort must not activate the destination.'); },
        healthCheck: async () => false,
        recoverConfiguration: (artifact) => recoverPersonalHomeSanitizedConfiguration(layout, artifact),
      });
      if (recovery.outcome !== 'rolled_back') {
        throw new Error(recovery.error ?? 'Personal Home relocation candidate rollback was incomplete.');
      }
    },
    finalizeCandidate: async () => {
      const layout = await resolveAttestedLayout();
      const finalization = await finalizePersonalHomeRestoreWithLease({
        layout,
        operationLeaseHeld: true,
        finalizeConfiguration: (artifact) => finalizePersonalHomeSanitizedConfiguration(layout, artifact),
      });
      if (finalization.outcome === 'recovery_required') {
        throw new Error(finalization.error ?? 'Personal Home relocation candidate cleanup requires attention.');
      }
    },
  });
}

export async function attestPersonalHomeRelocationDestinationWithServerCommand(params: Readonly<{
  layout: PersonalHomeRuntimeLayout;
  serverBinary: string;
  operationId: string;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<PersonalHomeAuthenticatedReadiness> {
  const envText = await readFile(join(params.layout.configDir, 'server.env'), 'utf8');
  const { stdout } = await execFileWithDeadline(params.serverBinary, [
    '--attest-personal-home-readiness',
  ], {
    env: {
      ...(params.processEnv ?? process.env),
      ...parseEnvText(envText),
      HAPPIER_SERVER_LOG_LEVEL: 'silent',
      HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: params.operationId,
    },
    encoding: 'utf8',
    timeout: PERSONAL_HOME_SERVER_COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  const lastLine = String(stdout).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  let value: unknown;
  try {
    value = JSON.parse(lastLine) as unknown;
  } catch {
    throw new Error('Stopped Personal Home authentication attestation returned invalid JSON');
  }
  const readiness = parsePersonalHomeAuthenticatedReadiness(value);
  if (!readiness) throw new Error('Stopped Personal Home authentication attestation returned invalid facts');
  const identity = await readCanonicalPersonalHomeIdentity(params.layout);
  if (readiness.homeServerIdentityId !== identity.homeServerIdentityId) {
    throw new Error('Stopped Personal Home authentication attestation returned an inconsistent identity');
  }
  return readiness;
}

export async function materializePersonalHomeRelocationEndpointWithServerCommand(params: Readonly<{
  layout: PersonalHomeRuntimeLayout;
  serverBinary: string;
  operationId: string;
  canonicalServerUrl: string;
  sourceDescriptorRevision: number;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{
  connectionDescriptor: HomeConnectionDescriptorV1;
}>> {
  const envText = await readFile(join(params.layout.configDir, 'server.env'), 'utf8');
  const { stdout } = await execFileWithDeadline(params.serverBinary, [
    '--materialize-iroh-endpoint-descriptor',
    `--source-descriptor-revision=${params.sourceDescriptorRevision}`,
  ], {
    env: {
      ...(params.processEnv ?? process.env),
      ...parseEnvText(envText),
      HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: params.operationId,
    },
    encoding: 'utf8',
    timeout: PERSONAL_HOME_SERVER_COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  const value = JSON.parse(String(stdout).trim()) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stopped endpoint materialization result');
  const result = value as Record<string, unknown>;
  const identity = await readCanonicalPersonalHomeIdentity(params.layout);
  const descriptor = HomeConnectionDescriptorV1Schema.safeParse(result.connectionDescriptor);
  if (result.status !== 'ready' || !descriptor.success
    || descriptor.data.homeServerIdentityId !== identity.homeServerIdentityId
    || descriptor.data.canonicalServerUrl !== params.canonicalServerUrl
    || descriptor.data.revision <= params.sourceDescriptorRevision) {
    throw new Error('Stopped endpoint materialization failed or returned inconsistent facts');
  }
  return {
    connectionDescriptor: descriptor.data,
  };
}

function lastNonEmptyLine(value: unknown): string {
  return String(value ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
}

/**
 * Runs `happier-server --claim-home-owner=<accountId>` against this Home's persisted runtime
 * environment and returns its structured result. Every refusal exits 1 while still printing its
 * exact reason, so a refusal is returned as data; only a missing or inconsistent result fails.
 */
export async function claimPersonalHomeOwnerWithServerCommand(params: Readonly<{
  layout: PersonalHomeRuntimeLayout;
  serverBinary: string;
  targetAccountId: string;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<HomeOwnerClaimCommandOutputV1> {
  const envText = await readFile(join(params.layout.configDir, 'server.env'), 'utf8');
  let stdout: unknown;
  let stderr: unknown;
  let exitCode: unknown = 0;
  try {
    ({ stdout, stderr } = await execFileWithDeadline(params.serverBinary, [
      `${HOME_OWNER_CLAIM_COMMAND_ARGUMENT_V1}=${params.targetAccountId}`,
    ], {
      env: {
        ...(params.processEnv ?? process.env),
        ...parseEnvText(envText),
        HAPPIER_SERVER_LOG_LEVEL: 'silent',
      },
      encoding: 'utf8',
      timeout: PERSONAL_HOME_SERVER_COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    exitCode = failure.code;
    stdout = failure.stdout;
    stderr = failure.stderr;
  }
  const failed = (reason: string): PersonalHomeOperationsError => {
    const detail = lastNonEmptyLine(stderr);
    return new PersonalHomeOperationsError(
      'claim_owner_failed',
      `The Personal Home owner claim did not complete: ${detail || reason}`,
    );
  };
  if (exitCode !== 0 && exitCode !== 1) throw failed(`the server command exited with ${String(exitCode)}.`);
  let value: unknown;
  try {
    value = JSON.parse(lastNonEmptyLine(stdout)) as unknown;
  } catch {
    throw failed('the server command printed no result.');
  }
  const output = HomeOwnerClaimCommandOutputV1Schema.safeParse(value);
  if (!output.success || output.data.targetAccountId !== params.targetAccountId) {
    throw failed('the server command returned an inconsistent result.');
  }
  // Exit 0 means claimed and nothing else; any disagreement is not a trustworthy result.
  if ((exitCode === 0) !== (output.data.result.status === 'claimed')) {
    throw failed('the server command exit status disagrees with its result.');
  }
  return output.data;
}
