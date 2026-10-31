import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveRelayRuntimeDefaults } from '../relayRuntime.js';
import { readSqliteMigrationCatalog } from '../sqliteMigrationCatalog.js';
import { resolveInstalledPersonalHomeSqliteMigrationPaths } from './stagedMigrationFrontier.js';
import { resolvePersonalHomeRuntimeLayout } from './layout.js';
import { normalizePersonalHomeRestorableConfigurationV1 } from './configuration.js';
import {
  applyPersonalHomeSanitizedConfiguration,
  claimPersonalHomeOwnerWithServerCommand,
  createCanonicalPersonalHomeOperations,
  createCanonicalPersonalHomeRelocationDestinationOwner,
  finalizePersonalHomeSanitizedConfiguration,
  materializePersonalHomeRelocationEndpointWithServerCommand,
  inspectPersonalHomeSanitizedConfigurationStorage,
  preparePersonalHomeSanitizedConfiguration,
  readPersonalHomeSanitizedConfiguration,
  readPersonalHomeIdentityFromSqlite,
  readPersonalHomeDataCountsFromSqlite,
  resolveCanonicalPersonalHomeRuntimeLayout,
} from './productionAdapters.js';

/** Seeds a real managed Personal Home: persisted configuration, installed migration
 * catalog, canonical SQLite identity, master secret and local file stores. */
async function seedPersonalHome(params: Readonly<{ homeDir: string; homeServerIdentityId: string; marker: string }>) {
  const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir: params.homeDir });
  await mkdir(defaults.configDir, { recursive: true });
  await writeFile(join(defaults.configDir, 'server.env'), [
    `HAPPIER_SERVER_LIGHT_DATA_DIR=${defaults.dataDir}`,
    'HAPPIER_PUBLIC_SERVER_URL=http://127.0.0.1:43110',
    'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=plaintext_only',
    'HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE=plain',
    '',
  ].join('\n'));
  const layout = await resolveCanonicalPersonalHomeRuntimeLayout({ homeDir: params.homeDir, platform: 'linux', mode: 'user' });
  const migrationPaths = resolveInstalledPersonalHomeSqliteMigrationPaths({ installRoot: layout.installRoot, platform: layout.platform });
  const migration = { name: '20260901000000_init', sql: 'CREATE TABLE relocation_fixture (id TEXT);' };
  await mkdir(join(migrationPaths.migrationsDir, migration.name), { recursive: true });
  await writeFile(join(migrationPaths.migrationsDir, migration.name, 'migration.sql'), migration.sql);
  await mkdir(layout.dataDir, { recursive: true });
  await mkdir(layout.publicFilesDir, { recursive: true });
  await mkdir(layout.privateFilesDir, { recursive: true });
  await writeFile(layout.masterSecretPath, `${params.marker}-master-secret`);
  await writeFile(join(layout.publicFilesDir, 'public.txt'), `${params.marker}-public`);
  await writeFile(join(layout.privateFilesDir, 'private.txt'), `${params.marker}-private`);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(layout.databasePath);
  database.exec('CREATE TABLE SimpleCache (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  database.exec('CREATE TABLE _prisma_migrations (migration_name TEXT NOT NULL, checksum TEXT NOT NULL, finished_at TEXT, rolled_back_at TEXT)');
  database.exec('CREATE TABLE "Account" (id TEXT PRIMARY KEY); CREATE TABLE "Session" (id TEXT PRIMARY KEY);');
  database.prepare('INSERT INTO SimpleCache (key, value) VALUES (?, ?)').run('server.identity.v1', params.homeServerIdentityId);
  database.prepare('INSERT INTO "Account" (id) VALUES (?)').run(`${params.marker}-account`);
  database.prepare('INSERT INTO _prisma_migrations (migration_name, checksum, finished_at) VALUES (?, ?, ?)')
    .run(migration.name, createHash('sha256').update(migration.sql).digest('hex'), '2026-01-01T00:00:00.000Z');
  database.close();
  return { defaults, layout, migrationsDir: migrationPaths.migrationsDir, schemaVersion: migration.name };
}

describe('Personal Home production adapters', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.skipIf(process.platform === 'win32')('consumes an exact stopped-server descriptor and never synthesizes one from unavailable endpoint facts', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-descriptor-command-'));
    try {
      const { layout } = await seedPersonalHome({ homeDir, homeServerIdentityId: 'srv_home_descriptor', marker: 'descriptor' });
      const connectionDescriptor = {
        v: 1, homeServerIdentityId: 'srv_home_descriptor', canonicalServerUrl: 'https://home.example.test', revision: 27,
        endpoints: [{ kind: 'https', url: 'https://destination.example.test' },
          { kind: 'iroh', endpointId: 'ab'.repeat(32), relayUrls: ['https://relay.example.test'] }],
      };
      // A real child process is the server-maintenance boundary; all identity,
      // configuration, parser, and deadline logic below it remains real.
      const serverBinary = join(homeDir, 'maintenance-server');
      const respond = async (value: unknown) => await writeFile(serverBinary,
        `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(value)}'\n`, { mode: 0o700 });
      const input = { layout, serverBinary, operationId: 'move-1', canonicalServerUrl: 'https://home.example.test', sourceDescriptorRevision: 7 };
      await respond({ status: 'ready', connectionDescriptor });
      await expect(materializePersonalHomeRelocationEndpointWithServerCommand(input)).resolves.toEqual({ connectionDescriptor });
      await respond({ status: 'unavailable' });
      await expect(materializePersonalHomeRelocationEndpointWithServerCommand(input)).rejects.toThrow();
      await respond({ status: 'ready', connectionDescriptor: { ...connectionDescriptor, homeServerIdentityId: 'srv_other' } });
      await expect(materializePersonalHomeRelocationEndpointWithServerCommand(input)).rejects.toThrow();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('runs the owner claim one-shot against the Home database and returns its structured result, including refusals', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-claim-command-'));
    try {
      const { layout } = await seedPersonalHome({ homeDir, homeServerIdentityId: 'srv_home_claim', marker: 'claim' });
      // A real child process is the server boundary; argument, environment, exit-code and
      // output parsing below it stay real. The fake echoes what it received so the test can
      // prove the one-shot targets this Home's persisted runtime environment.
      const serverBinary = join(homeDir, 'claim-server');
      const respond = async (status: string, exitCode: number, extraResult = '') => await writeFile(serverBinary, [
        '#!/bin/sh',
        `[ "$#" = 1 ] && [ "$HAPPIER_SERVER_LIGHT_DATA_DIR" = '${layout.dataDir}' ] || { echo 'wrong one-shot invocation' >&2; exit 3; }`,
        'account="${1#--claim-home-owner=}"',
        `printf 'log line\\n'`,
        `printf '{"v":1,"command":"claim-home-owner","intent":"initial_claim","homeServerIdentityId":"srv_home_claim","targetAccountId":"%s","result":{"status":"${status}"${extraResult}}}\\n' "$account"`,
        `exit ${exitCode}`,
        '',
      ].join('\n'), { mode: 0o700 });

      await respond('claimed', 0, ',"ownerAccountId":"acct_1"');
      await expect(claimPersonalHomeOwnerWithServerCommand({ layout, serverBinary, targetAccountId: 'acct_1' })).resolves.toEqual({
        v: 1,
        command: 'claim-home-owner',
        intent: 'initial_claim',
        homeServerIdentityId: 'srv_home_claim',
        targetAccountId: 'acct_1',
        result: { status: 'claimed', ownerAccountId: 'acct_1' },
      });

      // The claim exits nonzero for every refusal while still printing the exact reason.
      await respond('already_owned', 1, ',"activeOwnerCount":1');
      await expect(claimPersonalHomeOwnerWithServerCommand({ layout, serverBinary, targetAccountId: 'acct_1' }))
        .resolves.toMatchObject({ result: { status: 'already_owned', activeOwnerCount: 1 } });

      // The output must answer the Account the caller asked about.
      await writeFile(serverBinary, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({
        v: 1, command: 'claim-home-owner', intent: 'initial_claim', homeServerIdentityId: 'srv_home_claim',
        targetAccountId: 'acct_other', result: { status: 'claimed', ownerAccountId: 'acct_other' },
      })}'\n`, { mode: 0o700 });
      await expect(claimPersonalHomeOwnerWithServerCommand({ layout, serverBinary, targetAccountId: 'acct_1' }))
        .rejects.toMatchObject({ code: 'claim_owner_failed' });

      // A crashed or blocked one-shot (for example boot admission refusing) is a typed failure.
      await writeFile(serverBinary, "#!/bin/sh\necho 'Personal Home restore requires recovery' >&2\nexit 1\n", { mode: 0o700 });
      await expect(claimPersonalHomeOwnerWithServerCommand({ layout, serverBinary, targetAccountId: 'acct_1' }))
        .rejects.toMatchObject({ code: 'claim_owner_failed', message: expect.stringContaining('Personal Home restore requires recovery') });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('binds the relocation destination owner to the explicitly selected runtime target', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-relocation-target-'));
    try {
      const stable = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir });
      const preview = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'preview', homeDir });
      await mkdir(stable.configDir, { recursive: true });
      await mkdir(preview.configDir, { recursive: true });
      await writeFile(join(stable.configDir, 'server.env'), `HAPPIER_SERVER_LIGHT_DATA_DIR=${stable.dataDir}\nAUTH_ANONYMOUS_SIGNUP_ENABLED=0\n`);
      await writeFile(join(preview.configDir, 'server.env'), `HAPPIER_SERVER_LIGHT_DATA_DIR=${preview.dataDir}\nAUTH_ANONYMOUS_SIGNUP_ENABLED=0\n`);
      const archivePath = join(homeDir, 'bad-transfer.tar');
      await writeFile(archivePath, 'not the transferred bytes');
      const owner = await createCanonicalPersonalHomeRelocationDestinationOwner({
        homeDir,
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        quarantine: async () => undefined,
        activate: async () => undefined,
        readServiceStatus: async () => ({ running: false, quarantined: true }),
        attestActivatedHome: async () => ({ authenticated: true, homeServerIdentityId: 'srv_home_1', accountCount: 1, sessionCount: 0 }),
        attestStagedHome: async () => ({ authenticated: true, homeServerIdentityId: 'srv_home_1', accountCount: 1, sessionCount: 0 }),
        runMigrationProcess: async () => undefined,
        materializeEndpoint: async () => ({
          connectionDescriptor: {
            v: 1, homeServerIdentityId: 'srv_home_1', canonicalServerUrl: 'https://destination.example.test',
            revision: 8, endpoints: [{ kind: 'https', url: 'https://destination.example.test' }],
          },
        }),
      });
      await expect(owner.stage({
        operationId: 'operation-1',
        archivePath,
        bundleSha256: '0'.repeat(64),
        expectedHomeServerIdentityId: 'srv_home_1',
        expectedCanonicalServerUrl: 'https://source.example.test',
        sourceDescriptorRevision: 7,
      })).rejects.toMatchObject({ code: 'relocation_bundle_mismatch' });
      await expect(stat(join(preview.dataDir, '.operations', 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(stable.dataDir, '.operations'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('keeps an interrupted partial relocation restore in typed recovery with its journal intact', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-relocation-recovery-'));
    try {
      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'preview', homeDir });
      await mkdir(defaults.configDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), `HAPPIER_SERVER_LIGHT_DATA_DIR=${defaults.dataDir}\nAUTH_ANONYMOUS_SIGNUP_ENABLED=0\n`);
      const archivePath = join(homeDir, 'interrupted-transfer.tar');
      const archiveBytes = Buffer.from('reserved relocation archive');
      await writeFile(archivePath, archiveBytes);
      const bundleSha256 = createHash('sha256').update(archiveBytes).digest('hex');
      const operationId = 'operation-interrupted';
      const operationsDir = join(defaults.dataDir, '.operations');
      const restoreJournalPath = join(operationsDir, 'restore-journal.json');
      await mkdir(operationsDir, { recursive: true });
      await writeFile(join(operationsDir, 'relocation-destination.json'), `${JSON.stringify({
        version: 1,
        operationId,
        status: 'receiving',
        bundleSha256,
        expectedHomeServerIdentityId: 'srv_home_1',
        expectedCanonicalServerUrl: 'https://source.example.test',
        sourceDescriptorRevision: 7,
      })}\n`);
      await writeFile(restoreJournalPath, '{"invalid":"partial restore journal"}\n');
      const owner = await createCanonicalPersonalHomeRelocationDestinationOwner({
        homeDir,
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        quarantine: async () => undefined,
        activate: async () => undefined,
        readServiceStatus: async () => ({ running: false, quarantined: true }),
        attestActivatedHome: async () => ({ authenticated: true, homeServerIdentityId: 'srv_home_1', accountCount: 1, sessionCount: 0 }),
        attestStagedHome: async () => ({ authenticated: true, homeServerIdentityId: 'srv_home_1', accountCount: 1, sessionCount: 0 }),
        runMigrationProcess: async () => undefined,
        materializeEndpoint: async () => ({
          connectionDescriptor: {
            v: 1, homeServerIdentityId: 'srv_home_1', canonicalServerUrl: 'https://destination.example.test',
            revision: 8, endpoints: [{ kind: 'https', url: 'https://destination.example.test' }],
          },
        }),
      });

      await expect(owner.stage({
        operationId,
        archivePath,
        bundleSha256,
        expectedHomeServerIdentityId: 'srv_home_1',
        expectedCanonicalServerUrl: 'https://source.example.test',
        sourceDescriptorRevision: 7,
      })).rejects.toMatchObject({ code: 'relocation_destination_recovery_required' });
      await expect(readFile(restoreJournalPath, 'utf8')).resolves.toBe('{"invalid":"partial restore journal"}\n');
      await expect(owner.status(operationId)).resolves.toMatchObject({ status: 'recovery_required' });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('never erases an unrelated destination Home when a relocation stage is refused', { timeout: 120_000 }, async () => {
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-home-relocation-unrelated-source-'));
    const destinationHomeDir = await mkdtemp(join(tmpdir(), 'happier-home-relocation-unrelated-destination-'));
    try {
      await seedPersonalHome({ homeDir: sourceHomeDir, homeServerIdentityId: 'srv_home_source', marker: 'source' });
      const destination = await seedPersonalHome({ homeDir: destinationHomeDir, homeServerIdentityId: 'srv_home_unrelated', marker: 'unrelated' });
      let sourceRunning = true;
      const sourceOperations = await createCanonicalPersonalHomeOperations({
        homeDir: sourceHomeDir,
        platform: 'linux',
        mode: 'user',
        readHappierVersion: async () => '0.0.0-test',
        readPurpose: async () => ({ kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43110' }),
        lifecycle: {
          isRunning: async () => sourceRunning,
          stop: async () => { sourceRunning = false; },
          start: async () => { sourceRunning = true; },
          healthCheck: async () => true,
        },
      });
      const bundle = await sourceOperations.backup();
      expect(bundle.manifest.homeServerIdentityId).toBe('srv_home_source');

      const owner = await createCanonicalPersonalHomeRelocationDestinationOwner({
        homeDir: destinationHomeDir,
        platform: 'linux',
        mode: 'user',
        quarantine: async () => undefined,
        activate: async () => undefined,
        readServiceStatus: async () => ({ running: false, quarantined: true }),
        attestActivatedHome: async () => ({ authenticated: true, homeServerIdentityId: 'srv_home_source', accountCount: 1, sessionCount: 0 }),
        attestStagedHome: async () => ({ authenticated: true, homeServerIdentityId: 'srv_home_source', accountCount: 1, sessionCount: 0 }),
        runMigrationProcess: async () => undefined,
        materializeEndpoint: async () => ({
          connectionDescriptor: {
            v: 1, homeServerIdentityId: 'srv_home_source', canonicalServerUrl: 'https://destination.example.test',
            revision: 5, endpoints: [{ kind: 'https', url: 'https://destination.example.test' }],
          },
        }),
      });
      const stageInput = {
        operationId: 'operation-unrelated-destination',
        archivePath: bundle.path,
        bundleSha256: bundle.sha256,
        expectedHomeServerIdentityId: 'srv_home_source',
        expectedCanonicalServerUrl: 'http://127.0.0.1:43110',
        sourceDescriptorRevision: 3,
      };

      await expect(owner.status(stageInput.operationId)).rejects.toMatchObject({ code: 'destination_not_empty' });
      await expect(owner.stage(stageInput)).rejects.toMatchObject({ code: 'destination_not_empty' });
      await expect(owner.abort(stageInput.operationId)).rejects.toMatchObject({ code: 'relocation_destination_not_staged' });

      await expect(readFile(destination.layout.masterSecretPath, 'utf8')).resolves.toBe('unrelated-master-secret');
      await expect(readFile(join(destination.layout.publicFilesDir, 'public.txt'), 'utf8')).resolves.toBe('unrelated-public');
      await expect(readFile(join(destination.layout.privateFilesDir, 'private.txt'), 'utf8')).resolves.toBe('unrelated-private');
      await expect(readPersonalHomeIdentityFromSqlite(
        destination.layout.databasePath,
        await readSqliteMigrationCatalog(destination.migrationsDir),
      )).resolves.toMatchObject({ homeServerIdentityId: 'srv_home_unrelated' });
      await expect(readPersonalHomeDataCountsFromSqlite(destination.layout.databasePath)).resolves.toEqual({
        accountCount: 1,
        sessionCount: 0,
      });
    } finally {
      await rm(sourceHomeDir, { recursive: true, force: true });
      await rm(destinationHomeDir, { recursive: true, force: true });
    }
  });

  it('aborts only the verified relocation candidate and preserves pre-existing config and backups', { timeout: 120_000 }, async () => {
    const sourceHomeDir = await mkdtemp(join(tmpdir(), 'happier-home-relocation-candidate-source-'));
    const destinationHomeDir = await mkdtemp(join(tmpdir(), 'happier-home-relocation-candidate-destination-'));
    try {
      await seedPersonalHome({ homeDir: sourceHomeDir, homeServerIdentityId: 'srv_home_source', marker: 'source' });
      const sourceOperations = await createCanonicalPersonalHomeOperations({
        homeDir: sourceHomeDir, platform: 'linux', mode: 'user', readHappierVersion: async () => '0.0.0-test',
        readPurpose: async () => ({ kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43110' }),
        lifecycle: { isRunning: async () => false, stop: async () => undefined, start: async () => undefined, healthCheck: async () => true },
      });
      const bundle = await sourceOperations.backup();
      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir: destinationHomeDir });
      const destinationMigrations = resolveInstalledPersonalHomeSqliteMigrationPaths({ installRoot: defaults.installRoot, platform: 'linux' });
      await mkdir(join(destinationMigrations.migrationsDir, '20260901000000_init'), { recursive: true });
      await writeFile(join(destinationMigrations.migrationsDir, '20260901000000_init', 'migration.sql'), 'CREATE TABLE relocation_fixture (id TEXT);');
      const configText = `HAPPIER_SERVER_LIGHT_DATA_DIR=${defaults.dataDir}\nAUTH_ANONYMOUS_SIGNUP_ENABLED=0\n`;
      await mkdir(defaults.configDir, { recursive: true });
      await mkdir(join(defaults.dataDir, 'backups'), { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), configText);
      await writeFile(join(defaults.dataDir, 'backups', 'preexisting.tar'), 'preexisting-backup');
      const owner = await createCanonicalPersonalHomeRelocationDestinationOwner({
        homeDir: destinationHomeDir, platform: 'linux', mode: 'user', channel: 'stable',
        quarantine: async () => undefined, activate: async () => undefined,
        readServiceStatus: async () => ({ running: false, quarantined: true }),
        attestActivatedHome: async () => ({ authenticated: true, homeServerIdentityId: 'srv_home_source', accountCount: 1, sessionCount: 0 }),
        attestStagedHome: async () => ({ authenticated: true, homeServerIdentityId: 'srv_home_source', accountCount: 1, sessionCount: 0 }),
        runMigrationProcess: async () => undefined,
        materializeEndpoint: async () => ({ connectionDescriptor: { v: 1, homeServerIdentityId: 'srv_home_source', canonicalServerUrl: 'https://destination.example.test', revision: 3, endpoints: [{ kind: 'https', url: 'https://destination.example.test' }] } }),
      });
      const input = {
        operationId: 'operation-candidate-abort', archivePath: bundle.path, bundleSha256: bundle.sha256,
        expectedHomeServerIdentityId: 'srv_home_source', expectedCanonicalServerUrl: 'http://127.0.0.1:43110', sourceDescriptorRevision: 1,
      };
      await expect(owner.stage(input)).resolves.toMatchObject({ status: 'quarantined' });
      await expect(owner.abort(input.operationId)).resolves.toMatchObject({ status: 'aborted' });
      await expect(readFile(join(defaults.configDir, 'server.env'), 'utf8')).resolves.toBe(configText);
      await expect(readFile(join(defaults.dataDir, 'backups', 'preexisting.tar'), 'utf8')).resolves.toBe('preexisting-backup');
      await expect(stat(resolvePersonalHomeRuntimeLayout({ homeDir: destinationHomeDir }).databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(sourceHomeDir, { recursive: true, force: true });
      await rm(destinationHomeDir, { recursive: true, force: true });
    }
  });

  it('reads exact nonnegative Account and Session counts from the canonical SQLite database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-production-counts-'));
    const databasePath = join(root, 'home.sqlite');
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(databasePath);
      database.exec('CREATE TABLE "Account" (id TEXT PRIMARY KEY); CREATE TABLE "Session" (id TEXT PRIMARY KEY);');
      database.prepare('INSERT INTO "Account" (id) VALUES (?)').run('account-1');
      database.prepare('INSERT INTO "Session" (id) VALUES (?)').run('session-1');
      database.prepare('INSERT INTO "Session" (id) VALUES (?)').run('session-2');
      database.close();

      await expect(readPersonalHomeDataCountsFromSqlite(databasePath)).resolves.toEqual({
        accountCount: 1,
        sessionCount: 2,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves configuration and data from the explicitly selected runtime channel', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-channel-'));
    try {
      const stable = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir });
      const preview = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'preview', homeDir });
      await mkdir(stable.configDir, { recursive: true });
      await mkdir(preview.configDir, { recursive: true });
      await writeFile(join(stable.configDir, 'server.env'), `HAPPIER_SERVER_LIGHT_DATA_DIR=${stable.dataDir}\nAUTH_ANONYMOUS_SIGNUP_ENABLED=0\n`);
      await writeFile(join(preview.configDir, 'server.env'), `HAPPIER_SERVER_LIGHT_DATA_DIR=${preview.dataDir}\nAUTH_ANONYMOUS_SIGNUP_ENABLED=0\n`);

      await expect(resolveCanonicalPersonalHomeRuntimeLayout({
        homeDir,
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
      })).resolves.toMatchObject({
        installRoot: preview.installRoot,
        configDir: preview.configDir,
        dataDir: preview.dataDir,
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('accepts an immutable filesystem alias above the caller-controlled Home boundary', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'happier-home-production-platform-alias-'));
    const physicalPlatformRoot = join(testRoot, 'physical-platform-root');
    const platformAlias = join(testRoot, 'platform-alias');
    await mkdir(physicalPlatformRoot, { recursive: true });
    await symlink(physicalPlatformRoot, platformAlias, 'dir');
    const homeDir = join(platformAlias, 'user-home');
    const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir });
    await mkdir(defaults.configDir, { recursive: true });
    await writeFile(join(defaults.configDir, 'server.env'), [
      `HAPPIER_SERVER_LIGHT_DATA_DIR=${defaults.dataDir}`,
      'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
      '',
    ].join('\n'));

    await expect(resolveCanonicalPersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' })).resolves.toMatchObject({
      configDir: defaults.configDir,
      dataDir: defaults.dataDir,
    });
  });

  it('rejects a symbolic-link ancestor between the controlled Home boundary and its data root', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-controlled-link-'));
    const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir });
    const outside = await mkdtemp(join(tmpdir(), 'happier-home-production-controlled-link-outside-'));
    const linkedRoot = join(homeDir, 'linked-root');
    await symlink(outside, linkedRoot, 'dir');
    await mkdir(defaults.configDir, { recursive: true });
    await writeFile(join(defaults.configDir, 'server.env'), [
      `HAPPIER_SERVER_LIGHT_DATA_DIR=${join(linkedRoot, 'data')}`,
      'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
      '',
    ].join('\n'));

    await expect(resolveCanonicalPersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' })).rejects.toThrow(/symbolic-link ancestor/u);
  });

  it('rejects a symbolic-link config directory before erase can reach an outside server.env', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-config-link-'));
    const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir });
    const outside = join(homeDir, 'outside-config');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'server.env'), `HAPPIER_SERVER_LIGHT_DATA_DIR=${defaults.dataDir}\nAUTH_ANONYMOUS_SIGNUP_ENABLED=0\n`);
    await mkdir(defaults.installRoot, { recursive: true });
    await rm(defaults.configDir, { recursive: true, force: true });
    await symlink(outside, defaults.configDir, 'dir');
    await expect(resolveCanonicalPersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' })).rejects.toThrow(/symbolic-link ancestor/u);
    await expect(readFile(join(outside, 'server.env'), 'utf8')).resolves.toContain('AUTH_ANONYMOUS_SIGNUP_ENABLED=0');
  });

  it('round-trips disabled anonymous signup through the semantic backup configuration value', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-config-roundtrip-'));
    const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir });
    await mkdir(defaults.configDir, { recursive: true });
    await writeFile(join(defaults.configDir, 'server.env'), [
      `HAPPIER_SERVER_LIGHT_DATA_DIR=${defaults.dataDir}`,
      'HAPPIER_PUBLIC_SERVER_URL=http://127.0.0.1:43110',
      'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
      '',
    ].join('\n'));
    const layout = await resolveCanonicalPersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' });
    const configuration = await readPersonalHomeSanitizedConfiguration(layout);
    expect(configuration.anonymousSignupPhase).toBe('loopback-bootstrap-then-disabled');
    expect(configuration.homeDeviceApprovalRequired).toBe(false);
    const applied = await applyPersonalHomeSanitizedConfiguration(layout, normalizePersonalHomeRestorableConfigurationV1(configuration, 'home-identity'));
    await expect(readFile(join(layout.configDir, 'server.env'), 'utf8')).resolves.toContain('AUTH_ANONYMOUS_SIGNUP_ENABLED=0');
    await applied.rollback();
  });

  it.each([
    ['enabled', '1', '0'],
    ['disabled', '0', '1'],
  ] as const)('applies and rolls back the %s Home device-approval policy without weakening destination state', async (_label, restoredValue, previousValue) => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-approval-policy-'));
    try {
      const layout = resolvePersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' });
      const envPath = join(layout.configDir, 'server.env');
      await mkdir(layout.configDir, { recursive: true });
      await writeFile(envPath, [
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${layout.dataDir}`,
        `HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED=${previousValue}`,
        'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
        '',
      ].join('\n'));
      const configuration = await readPersonalHomeSanitizedConfiguration(layout);
      expect(configuration.homeDeviceApprovalRequired).toBe(previousValue === '1');
      const prepared = await preparePersonalHomeSanitizedConfiguration(
        layout,
        normalizePersonalHomeRestorableConfigurationV1({
          ...configuration,
          homeDeviceApprovalRequired: restoredValue === '1',
        }, 'home-identity'),
      );

      await prepared.apply();
      await expect(readFile(envPath, 'utf8')).resolves.toContain(`HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED=${restoredValue}`);
      await prepared.rollback();
      await expect(readFile(envPath, 'utf8')).resolves.toContain(`HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED=${previousValue}`);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('applies direct-only relay configuration without retaining destination custom URLs and restores them on rollback', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-relay-policy-'));
    const layout = resolvePersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' });
    const envPath = join(layout.configDir, 'server.env');
    await mkdir(layout.configDir, { recursive: true });
    await writeFile(envPath, [
      `HAPPIER_SERVER_LIGHT_DATA_DIR=${layout.dataDir}`,
      'HAPPIER_IROH_RELAY_POLICY=automatic',
      'HAPPIER_IROH_RELAY_URLS=https://relay.example.test',
      'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
      '',
    ].join('\n'));

    const prepared = await preparePersonalHomeSanitizedConfiguration(
      layout,
      normalizePersonalHomeRestorableConfigurationV1({ irohRelayPolicy: 'disabled' }, 'home-identity'),
    );
    await prepared.apply();
    const applied = await readFile(envPath, 'utf8');
    expect(applied).toContain('HAPPIER_IROH_RELAY_POLICY=disabled');
    expect(applied).not.toContain('HAPPIER_IROH_RELAY_URLS=');

    await prepared.rollback();
    await expect(readFile(envPath, 'utf8')).resolves.toContain('HAPPIER_IROH_RELAY_URLS=https://relay.example.test');

    const automaticWithoutCustomRelay = await preparePersonalHomeSanitizedConfiguration(
      layout,
      normalizePersonalHomeRestorableConfigurationV1({ irohRelayPolicy: 'automatic' }, 'home-identity'),
    );
    await automaticWithoutCustomRelay.apply();
    const automaticApplied = await readFile(envPath, 'utf8');
    expect(automaticApplied).toContain('HAPPIER_IROH_RELAY_POLICY=automatic');
    expect(automaticApplied).not.toContain('HAPPIER_IROH_RELAY_URLS=');
    await automaticWithoutCustomRelay.rollback();
  });

  it.each([
    ['direct-only', ['HAPPIER_IROH_RELAY_POLICY=disabled']],
    ['custom relay', [
      'HAPPIER_IROH_RELAY_POLICY=automatic',
      'HAPPIER_IROH_RELAY_URLS=https://destination-relay.example.test',
    ]],
  ] as const)('restores implicit Iroh defaults over destination %s configuration and rolls the destination values back', async (_label, destinationIrohAssignments) => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-implicit-relay-policy-'));
    try {
      const layout = resolvePersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' });
      const envPath = join(layout.configDir, 'server.env');
      await mkdir(layout.configDir, { recursive: true });
      await writeFile(envPath, [
        '# Preserve destination-local and newer configuration.',
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${layout.dataDir}`,
        ...destinationIrohAssignments,
        'HAPPIER_FEATURE_TEAMS__ENABLED=1',
        'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
        '',
      ].join('\n'));

      const prepared = await preparePersonalHomeSanitizedConfiguration(
        layout,
        normalizePersonalHomeRestorableConfigurationV1({}, 'home-identity'),
      );
      await prepared.apply();
      const applied = await readFile(envPath, 'utf8');
      expect(applied).not.toContain('HAPPIER_IROH_RELAY_POLICY=');
      expect(applied).not.toContain('HAPPIER_IROH_RELAY_URLS=');
      expect(applied).toContain('# Preserve destination-local and newer configuration.');
      expect(applied).toContain('HAPPIER_FEATURE_TEAMS__ENABLED=1');

      await prepared.rollback();
      const rolledBack = await readFile(envPath, 'utf8');
      for (const assignment of destinationIrohAssignments) {
        expect(rolledBack).toContain(assignment);
      }
      expect(rolledBack).toContain('# Preserve destination-local and newer configuration.');
      expect(rolledBack).toContain('HAPPIER_FEATURE_TEAMS__ENABLED=1');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('reports exact configuration temporary and rollback storage for upgrade recovery preflight', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-config-storage-'));
    try {
      const layout = resolvePersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' });
      const envPath = join(layout.configDir, 'server.env');
      const previous = 'HAPPIER_PUBLIC_SERVER_URL=http://127.0.0.1:43110\nAUTH_ANONYMOUS_SIGNUP_ENABLED=0\n';
      await mkdir(layout.configDir, { recursive: true }); await writeFile(envPath, previous);
      const storage = await inspectPersonalHomeSanitizedConfigurationStorage(layout, normalizePersonalHomeRestorableConfigurationV1({ canonicalServerUrl: 'http://127.0.0.1:43111' }, 'home-identity'));
      expect(storage.targetPath).toBe(envPath);
      expect(storage.rollbackBytes).toBe(Buffer.byteLength(previous));
      expect(storage.incomingBytes).toBeGreaterThan(0);
    } finally { await rm(homeDir, { recursive: true, force: true }); }
  });

  it('durably finalizes the configuration rollback artifact before restore completion', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-config-finalize-'));
    try {
      const layout = resolvePersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' });
      const envPath = join(layout.configDir, 'server.env');
      await mkdir(layout.configDir, { recursive: true });
      await writeFile(envPath, [
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${layout.dataDir}`,
        'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
        '',
      ].join('\n'));
      const prepared = await preparePersonalHomeSanitizedConfiguration(
        layout,
        normalizePersonalHomeRestorableConfigurationV1({ canonicalServerUrl: 'http://127.0.0.1:43111' }, 'home-identity'),
      );
      await expect(readFile(prepared.rollbackArtifact)).resolves.toBeInstanceOf(Buffer);

      await finalizePersonalHomeSanitizedConfiguration(layout, prepared.rollbackArtifact);

      await expect(readFile(prepared.rollbackArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(layout.configDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
  it('rejects file roots that alias Home runtime, backup, derived, or credential paths', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-overlap-'));
    const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir });
    await mkdir(defaults.configDir, { recursive: true });
    await writeFile(join(defaults.configDir, 'server.env'), [`HAPPIER_SERVER_LIGHT_DATA_DIR=${defaults.dataDir}`, `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(defaults.dataDir, 'backups')}`, 'HAPPIER_PUBLIC_SERVER_URL=http://127.0.0.1:43110', ''].join('\n'));
    await expect(resolveCanonicalPersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' })).rejects.toThrow(/overlaps runtime/u);
  });

  it.each([
    ['data root', (homeDir: string) => ({ HAPPIER_SERVER_LIGHT_DATA_DIR: join(homeDir, '.happier') })],
    ['public files root', (homeDir: string) => ({ HAPPIER_SERVER_LIGHT_FILES_DIR: join(homeDir, '.happier') })],
    ['private files root', (homeDir: string) => ({ HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: join(homeDir, '.happier') })],
    ['public files log ancestor', (homeDir: string) => ({
      HAPPIER_SERVER_LIGHT_FILES_DIR: join(homeDir, 'logs-parent'),
      HAPPIER_SELF_HOST_LOG_DIR: join(homeDir, 'logs-parent', 'current'),
    })],
  ])('rejects a destructive %s that contains the managed install or log root', async (_label, override) => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-ancestor-'));
    try {
      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir });
      await mkdir(defaults.configDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), [
        ...Object.entries({
          HAPPIER_SERVER_LIGHT_DATA_DIR: defaults.dataDir,
          ...override(homeDir),
        }).map(([key, value]) => `${key}=${value}`),
        'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
        '',
      ].join('\n'));
      await expect(resolveCanonicalPersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' })).rejects.toThrow(/Unsafe Personal Home data root/u);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('supports dedicated external public/private roots which do not overlap managed runtime paths', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-external-roots-'));
    try {
      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir });
      const publicRoot = join(homeDir, 'dedicated-public');
      const privateRoot = join(homeDir, 'dedicated-private');
      await mkdir(defaults.configDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), [
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${defaults.dataDir}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${publicRoot}`,
        `HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR=${privateRoot}`,
        'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
        '',
      ].join('\n'));
      await expect(resolveCanonicalPersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' })).resolves.toMatchObject({
        publicFilesDir: publicRoot,
        privateFilesDir: privateRoot,
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('uses persisted server.env rather than ambient process env and applies sanitized config transactionally', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-config-'));
    const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir });
    const persistedDataDir = join(homeDir, 'persisted-data');
    await mkdir(defaults.configDir, { recursive: true });
    const originalEnv = [
      `HAPPIER_SERVER_LIGHT_DATA_DIR=${persistedDataDir}`,
      'HAPPIER_PUBLIC_SERVER_URL=http://127.0.0.1:43110',
      'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=plaintext_only',
      'HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE=plain',
      'AUTH_ANONYMOUS_SIGNUP_ENABLED=1',
      'AUTH_ANONYMOUS_SIGNUP_ENABLED=1',
      '',
    ].join('\n');
    await writeFile(join(defaults.configDir, 'server.env'), originalEnv);

    vi.stubEnv('HAPPIER_SERVER_LIGHT_DATA_DIR', join(homeDir, 'ambient-data'));
    const layout = await resolveCanonicalPersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' });
    expect(layout.dataDir).toBe(persistedDataDir);
    const applied = await applyPersonalHomeSanitizedConfiguration(layout, normalizePersonalHomeRestorableConfigurationV1({
      canonicalServerUrl: 'http://127.0.0.1:43111',
      encryptionStoragePolicy: 'plaintext_only',
      defaultAccountMode: 'plain',
      anonymousSignupPhase: 'loopback-bootstrap-then-disabled',
    }, 'home-identity'));
    await expect(readFile(join(defaults.configDir, 'server.env'), 'utf8')).resolves.toContain(
      'HAPPIER_CANONICAL_SERVER_URL=http://127.0.0.1:43111',
    );
    expect((await readFile(join(defaults.configDir, 'server.env'), 'utf8')).match(/^AUTH_ANONYMOUS_SIGNUP_ENABLED=0$/gmu)).toHaveLength(1);
    await applied.rollback();
    await expect(readFile(join(defaults.configDir, 'server.env'), 'utf8')).resolves.toBe(originalEnv);
  });

  it('uses the same current-over-legacy persisted path precedence as the runtime layout owner', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-path-precedence-'));
    try {
      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir });
      const currentDataDir = join(homeDir, 'current-data');
      const legacyDataDir = join(homeDir, 'legacy-data');
      await mkdir(defaults.configDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), [
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${currentDataDir}`,
        `HAPPY_SERVER_LIGHT_DATA_DIR=${legacyDataDir}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(currentDataDir, 'current-public')}`,
        `HAPPY_SERVER_LIGHT_FILES_DIR=${join(legacyDataDir, 'legacy-public')}`,
        `HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR=${join(currentDataDir, 'current-private')}`,
        `HAPPY_SERVER_LIGHT_PRIVATE_FILES_DIR=${join(legacyDataDir, 'legacy-private')}`,
        'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
        '',
      ].join('\n'));

      const direct = resolvePersonalHomeRuntimeLayout({
        homeDir,
        platform: 'linux',
        mode: 'user',
        env: {
          HAPPIER_SERVER_LIGHT_DATA_DIR: currentDataDir,
          HAPPY_SERVER_LIGHT_DATA_DIR: legacyDataDir,
          HAPPIER_SERVER_LIGHT_FILES_DIR: join(currentDataDir, 'current-public'),
          HAPPY_SERVER_LIGHT_FILES_DIR: join(legacyDataDir, 'legacy-public'),
          HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: join(currentDataDir, 'current-private'),
          HAPPY_SERVER_LIGHT_PRIVATE_FILES_DIR: join(legacyDataDir, 'legacy-private'),
        },
      });
      const persisted = await resolveCanonicalPersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' });

      expect(persisted).toMatchObject({
        dataDir: currentDataDir,
        publicFilesDir: join(currentDataDir, 'current-public'),
        privateFilesDir: join(currentDataDir, 'current-private'),
      });
      expect(persisted).toMatchObject({
        dataDir: direct.dataDir,
        publicFilesDir: direct.publicFilesDir,
        privateFilesDir: direct.privateFilesDir,
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('reads identity/schema and backs up a real WAL SQLite database through checkpoint, quick_check, and close', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-home-production-sqlite-'));
    const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'stable', homeDir });
    await mkdir(defaults.configDir, { recursive: true });
    await writeFile(join(defaults.configDir, 'server.env'), [
      `HAPPIER_SERVER_LIGHT_DATA_DIR=${defaults.dataDir}`,
      'HAPPIER_PUBLIC_SERVER_URL=http://127.0.0.1:43110',
      'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=plaintext_only',
      'HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE=plain',
      '',
    ].join('\n'));
    const layout = await resolveCanonicalPersonalHomeRuntimeLayout({ homeDir, platform: 'linux', mode: 'user' });
    const migrationPaths = resolveInstalledPersonalHomeSqliteMigrationPaths({ installRoot: layout.installRoot, platform: layout.platform });
    const migrations = [
      { name: '20260830000000_first', sql: 'CREATE TABLE first_table (id TEXT);' },
      { name: '20260830000001_catalog_frontier', sql: 'CREATE TABLE frontier_table (id TEXT);' },
    ] as const;
    for (const migration of migrations) {
      const directory = join(migrationPaths.migrationsDir, migration.name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'migration.sql'), migration.sql);
    }
    const catalog = await readSqliteMigrationCatalog(migrationPaths.migrationsDir);
    await mkdir(layout.dataDir, { recursive: true });
    await mkdir(layout.publicFilesDir, { recursive: true });
    await mkdir(layout.privateFilesDir, { recursive: true });
    await writeFile(layout.masterSecretPath, 'master-secret');
    await writeFile(join(layout.publicFilesDir, 'public.txt'), 'public');
    await writeFile(join(layout.privateFilesDir, 'private.txt'), 'private');

    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(layout.databasePath);
    database.exec('PRAGMA journal_mode=WAL');
    database.exec('CREATE TABLE SimpleCache (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    database.exec('CREATE TABLE _prisma_migrations (migration_name TEXT NOT NULL, checksum TEXT NOT NULL, finished_at TEXT, rolled_back_at TEXT)');
    database.prepare('INSERT INTO SimpleCache (key, value) VALUES (?, ?)').run('server.identity.v1', 'home-production');
    // Completion timestamps deliberately disagree with installed catalog order.
    database.prepare('INSERT INTO _prisma_migrations (migration_name, checksum, finished_at) VALUES (?, ?, ?)')
      .run(migrations[0].name, createHash('sha256').update(migrations[0].sql).digest('hex'), '2099-01-01T00:00:00.000Z');
    database.prepare('INSERT INTO _prisma_migrations (migration_name, checksum, finished_at) VALUES (?, ?, ?)')
      .run(migrations[1].name, createHash('sha256').update(migrations[1].sql).digest('hex'), '2000-01-01T00:00:00.000Z');
    database.close();

    await expect(readPersonalHomeIdentityFromSqlite(layout.databasePath, catalog)).resolves.toEqual({
      homeServerIdentityId: 'home-production',
      schemaVersion: migrations[1].name,
    });

    let running = true;
    const operations = await createCanonicalPersonalHomeOperations({
      homeDir,
      platform: 'linux',
      mode: 'user',
      readHappierVersion: async () => '0.0.0-test',
      readPurpose: async () => ({ kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43110' }),
      lifecycle: {
        isRunning: async () => running,
        stop: async () => { running = false; },
        start: async () => { running = true; },
        healthCheck: async () => true,
      },
    });
    const backup = await operations.backup();
    expect(backup.manifest.homeServerIdentityId).toBe('home-production');
    expect(backup.manifest.schemaVersion).toBe(migrations[1].name);
    expect(running).toBe(true);
    const wal = await stat(`${layout.databasePath}-wal`).catch(() => null);
    const shm = await stat(`${layout.databasePath}-shm`).catch(() => null);
    expect(wal === null || wal.size === 0).toBe(true);
    expect(shm === null || shm.size === 0).toBe(true);
  });
});
