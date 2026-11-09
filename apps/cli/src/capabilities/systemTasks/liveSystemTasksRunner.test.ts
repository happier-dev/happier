import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  readSqliteMigrationCatalog,
  resolveInstalledPersonalHomeSqliteMigrationPaths,
  resolvePersonalHomeRuntimeArtifactPaths,
  resolvePersonalHomeRuntimeLayout,
  resolveRelayRuntimeDefaults,
  type PersonalHomeRelocationDestinationOwner,
} from '@happier-dev/cli-common/firstPartyRuntime';
import type { PersonalHomeSystemTaskOperations } from '@happier-dev/cli-common/systemTasks';
import { SYSTEM_TASK_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLiveSystemTasksRunnerAdapter } from './liveSystemTasksRunner';
import { createSystemTasksCapability } from '../registry/toolSystemTasks';
import { createCapabilitiesService } from '../service';

describe('getLiveSystemTasksRunnerAdapter', () => {
  it('binds an establishment response to the current prompt through the live capability owner', async () => {
    const adapter = getLiveSystemTasksRunnerAdapter();
    const delivered: unknown[] = [];
    const task = await adapter.startAdmitted({ async run(ctx) {
      delivered.push(await ctx.prompt({ kind: 'administrator.establish', message: 'Establish reviewed administrator',
        data: { promptId: 'live-administrator', administratorUsername: 'operator' } }));
      return { established: true };
    } });
    const service = createCapabilitiesService({ capabilities: [createSystemTasksCapability(adapter)],
      checklists: { 'new-session': [], 'machine-details': [] }, buildContext: async () => ({ cliSnapshot: null }) });
    const respond = (expectedPromptId?: string) => service.invoke({ id: 'tool.systemTasks', method: 'respond',
      params: { ...task, expectedPromptKind: 'administrator.establish', expectedPromptId, answer: { password: 'live-private-password' } } });
    try {
      expect(await respond()).toMatchObject({ ok: false, error: { code: 'no_prompt' } });
      expect(await respond('stale-administrator')).toMatchObject({ ok: false, error: { code: 'no_prompt' } });
      expect(delivered).toEqual([]);
      expect(await respond('live-administrator')).toMatchObject({ ok: true });
      expect(delivered).toEqual([{ password: 'live-private-password' }]);
      expect(await respond('live-administrator')).toMatchObject({ ok: false, error: { code: 'no_prompt' } });
      expect(await adapter.wait(task)).toMatchObject({ ok: true, data: { established: true } });
      expect(JSON.stringify(await adapter.poll({ ...task, cursor: 0 }))).not.toContain('live-private-password');
    } finally { await adapter.cancel(task); }
  });
  it('rejects an earlier prompt decision after the real task advances to sign-in', async () => {
    const adapter = getLiveSystemTasksRunnerAdapter();
    const task = await adapter.startAdmitted({ async run(ctx) {
      await ctx.prompt({ kind: 'ssh.trustHost', message: 'Trust guest', data: {} });
      const answer = await ctx.prompt({ kind: 'auth.approveRemoteProvisioning', message: 'Sign in to guest', data: {} });
      return { approved: answer !== null && typeof answer === 'object' && 'approved' in answer && answer.approved === true };
    } });
    const service = createCapabilitiesService({ capabilities: [createSystemTasksCapability(adapter)],
      checklists: { 'new-session': [], 'machine-details': [] },
      buildContext: async () => ({ cliSnapshot: null }) });
    try {
      expect(await service.invoke({ id: 'tool.systemTasks', method: 'respond',
        params: { ...task, expectedPromptKind: 'ssh.trustHost', answer: { trusted: true } } })).toMatchObject({ ok: true });
      expect(await service.invoke({ id: 'tool.systemTasks', method: 'respond',
        params: { ...task, expectedPromptKind: 'ssh.trustHost', answer: { approved: true } } }))
        .toMatchObject({ ok: false, error: { code: 'no_prompt' } });
      expect(await adapter.poll({ ...task, cursor: 0 })).toMatchObject({ pendingPrompt: { kind: 'auth.approveRemoteProvisioning' }, result: null });
      await adapter.respond({ ...task, expectedPromptKind: 'auth.approveRemoteProvisioning', answer: { approved: false } });
      expect(await adapter.wait(task)).toMatchObject({ ok: true, data: { approved: false } });
    } finally { await adapter.cancel(task); }
  });
  it('registers the single remote.ssh.manageHost.v1 coordinator', async () => {
    vi.resetModules();
    const run = vi.fn(async () => ({ action: 'personalHome.create', registered: true }));
    vi.doMock('./ssh/liveRemoteSshBootstrap', () => ({
      createLiveRemoteSshBootstrapTaskKind: () => ({ run: async () => ({}) }),
      createLiveRemoteSshManageHostTaskKind: () => ({ run }),
    }));
    const module = await import('./liveSystemTasksRunner');
    const adapter = module.getLiveSystemTasksRunnerAdapter();
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'remote.ssh.manageHost.v1',
        params: { action: 'personalHome.create' },
      },
    });
    const { result } = await waitForResult(adapter, String((started as { taskId?: unknown }).taskId ?? ''));
    expect(result).toMatchObject({ ok: true, data: { action: 'personalHome.create', registered: true } });
    expect(run).toHaveBeenCalledOnce();
    vi.doUnmock('./ssh/liveRemoteSshBootstrap');
  });

  it('keeps the default singleton isolated from an explicitly targeted Personal Home invocation', async () => {
    vi.resetModules();
    const operations: PersonalHomeSystemTaskOperations = {
      inspect: vi.fn(async () => ({ purpose: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123', running: false })),
      backup: vi.fn(async () => ({})),
      verifyBackup: vi.fn(async () => ({})),
      restore: vi.fn(async () => ({})),
      reconcileRestore: vi.fn(async () => undefined),
      recoverRestore: vi.fn(async () => ({})),
      erase: vi.fn(async () => ({})),
    };
    const createOperations = vi.fn(async () => operations);
    const destinationStatus = vi.fn(async (operationId: string) => ({ operationId, status: 'absent' as const }));
    const createRelocationDestination = vi.fn(async (): Promise<PersonalHomeRelocationDestinationOwner> => ({
      stage: async (_input) => { throw new Error('not used'); },
      status: destinationStatus,
      commit: async (_input) => { throw new Error('not used'); },
      abort: async (_operationId) => { throw new Error('not used'); },
    }));
    vi.doMock('./relayRuntime/liveRelayRuntime', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./relayRuntime/liveRelayRuntime')>();
      return {
        ...actual,
        createLivePersonalHomeSystemTaskOperations: createOperations,
        createLivePersonalHomeRelocationDestinationOwner: createRelocationDestination,
      };
    });
    const module = await import('./liveSystemTasksRunner');
    const defaultAdapter = module.getLiveSystemTasksRunnerAdapter();

    const explicitlyTargetedAdapter = module.getLiveSystemTasksRunnerAdapter({
      personalHomeRuntime: { channel: 'preview', mode: 'system' },
    });

    for (const adapter of [defaultAdapter, explicitlyTargetedAdapter]) {
      const started = await adapter.start({
        spec: {
          protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
          kind: 'relay.runtime.personal_home.inspect.v1',
          params: {
            target: { kind: 'local' },
            channel: adapter === explicitlyTargetedAdapter ? 'preview' : 'stable',
            mode: adapter === explicitlyTargetedAdapter ? 'system' : 'user',
            purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
          },
        },
      });
      await waitForResult(adapter, String((started as { taskId?: unknown }).taskId ?? ''));

      const relocationStatus = await adapter.start({
        spec: {
          protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
          kind: 'relay.runtime.personal_home.relocation_destination.status.v1',
          params: {
            target: { kind: 'local' },
            channel: adapter === explicitlyTargetedAdapter ? 'preview' : 'stable',
            mode: adapter === explicitlyTargetedAdapter ? 'system' : 'user',
            purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
            operationId: adapter === explicitlyTargetedAdapter ? 'operation-preview' : 'operation-stable',
          },
        },
      });
      await waitForResult(adapter, String((relocationStatus as { taskId?: unknown }).taskId ?? ''));
    }

    expect(explicitlyTargetedAdapter).not.toBe(defaultAdapter);
    expect(module.getLiveSystemTasksRunnerAdapter()).toBe(defaultAdapter);
    expect(createOperations.mock.calls).toEqual([
      [{ channel: 'stable', mode: 'user' }],
      [{ channel: 'preview', mode: 'system' }],
    ]);
    expect(createRelocationDestination.mock.calls).toEqual([
      [{ channel: 'stable', mode: 'user' }],
      [{ channel: 'preview', mode: 'system' }],
    ]);
    expect(destinationStatus).toHaveBeenCalledWith('operation-stable');
    expect(destinationStatus).toHaveBeenCalledWith('operation-preview');
    vi.doUnmock('./relayRuntime/liveRelayRuntime');
  });

  it('supports system.ping.v1', async () => {
    const adapter = getLiveSystemTasksRunnerAdapter();
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'system.ping.v1',
        params: { message: 'hello', n: 1 },
      },
    });

    const taskId = String((started as { taskId?: unknown }).taskId ?? '').trim();
    expect(taskId).toMatch(/^system-task:/u);

    const { events, result } = await waitForResult(adapter, taskId);
    expect(events.some((event) => event.type === 'progress' && event.stepId === 'ping')).toBe(true);
    expect(result?.ok).toBe(true);
    expect((result as { data?: unknown }).data).toEqual({
      acknowledged: true,
      kind: 'system.ping.v1',
      paramDigest: expect.any(String),
    });
  });

  it('supports system.noop.v1', async () => {
    const adapter = getLiveSystemTasksRunnerAdapter();
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'system.noop.v1',
        params: { delayMs: 1, source: 'test' },
      },
    });

    const taskId = String((started as { taskId?: unknown }).taskId ?? '').trim();
    expect(taskId).toMatch(/^system-task:/u);

    const { events, result } = await waitForResult(adapter, taskId);
    expect(events.some((event) => event.type === 'progress' && event.stepId === 'noop')).toBe(true);
    expect(result?.ok).toBe(true);
    expect((result as { data?: unknown }).data).toEqual({
      kind: 'system.noop.v1',
      status: 'completed',
    });
  });

  it('delivers adapter cancellation to the active task signal and returns its terminal cancelled result', async () => {
    const adapter = getLiveSystemTasksRunnerAdapter();
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'system.noop.v1',
        params: { delayMs: 60_000 },
      },
    });
    const taskId = String((started as { taskId?: unknown }).taskId ?? '');

    await adapter.cancel({ taskId });
    const { result } = await waitForResult(adapter, taskId);

    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });

  it('registers setup.thisComputer.v1 through the canonical CLI setup owner', async () => {
    const setupThisComputer = vi.fn(async (params: Record<string, unknown>) => ({
      machineId: 'machine-local',
      server: String(params.activeRelayUrl ?? ''),
    }));
    const adapter = getLiveSystemTasksRunnerAdapter({ setupThisComputer });
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'setup.thisComputer.v1',
        params: { activeRelayUrl: 'http://127.0.0.1:43123', installService: true },
      },
    });
    const { events, result } = await waitForResult(adapter, String((started as { taskId?: unknown }).taskId ?? ''));

    expect(setupThisComputer).toHaveBeenCalledWith({ activeRelayUrl: 'http://127.0.0.1:43123', installService: true });
    expect(events.some((event) => event.stepId === 'setup.thisComputer.run')).toBe(true);
    expect(result).toMatchObject({ ok: true, data: { machineId: 'machine-local', server: 'http://127.0.0.1:43123' } });
  });

});

async function waitForResult(
  adapter: Readonly<{
    poll: (params: Record<string, unknown>) => Promise<unknown>;
  }>,
  taskId: string,
  maxAttempts = 400,
): Promise<Readonly<{ events: Array<{ type: string; stepId?: string }>; result: { ok: boolean } | null }>> {
  let lastPoll: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const polled = await adapter.poll({ taskId, cursor: 0 });
    lastPoll = polled;
    const events = (polled as { events?: unknown }).events;
    const result = (polled as { result?: unknown }).result;
    if (result && typeof result === 'object') {
      return {
        events: Array.isArray(events) ? (events as Array<{ type: string; stepId?: string }>) : [],
        result: result as { ok: boolean },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for system task result: ${taskId}; last poll: ${JSON.stringify(lastPoll)}`);
}

// Relay runtime tasks must delegate to the canonical cli-common relay host
// engine with the full parsed params (channel/mode/env/purpose/binary override
// intact) and must never reconstruct generic default params for health
// checks. The engine facade is the genuine boundary under test here.
type RelayEngineStub = Readonly<{
  readStatus: ReturnType<typeof vi.fn>;
  installOrUpdate: ReturnType<typeof vi.fn>;
  control: ReturnType<typeof vi.fn>;
}>;

type RelayRunnerHarness = Readonly<{
  engine: RelayEngineStub;
  ensureLocalFirstPartyComponentCommand: ReturnType<typeof vi.fn>;
  checkRelayRuntimeHealth: ReturnType<typeof vi.fn>;
}>;

let relayHarness: RelayRunnerHarness;
let relayTempHomeDir: string;
const relayPreviousEnv = new Map<string, string | undefined>();

function patchRelayEnv(key: string, value: string | undefined): void {
  if (!relayPreviousEnv.has(key)) {
    relayPreviousEnv.set(key, process.env[key]);
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createRelayHarness(): RelayRunnerHarness {
  return {
    engine: {
      readStatus: vi.fn(async () => ({
        installed: true,
        version: 'happier-server-v9',
        service: { active: null, enabled: null },
        baseUrl: 'http://127.0.0.1:59999',
        healthy: true,
        purpose: { kind: 'personal-home' as const, canonicalServerUrl: 'http://127.0.0.1:59999' },
        canonicalServerUrl: 'http://127.0.0.1:59999',
        anonymousSignupEnabled: false,
      })),
      installOrUpdate: vi.fn(async () => ({ relayUrl: 'http://127.0.0.1:4123', mode: 'system' as const })),
      control: vi.fn(async () => undefined),
    },
    ensureLocalFirstPartyComponentCommand: vi.fn(async (_params: Record<string, unknown>) => '/resolved/happier-server'),
    checkRelayRuntimeHealth: vi.fn(async (_params: Record<string, unknown>) => ({
      reachable: true,
      portOpen: true,
      pingOk: true,
      url: 'http://127.0.0.1:59999/health',
      statusCode: 200,
      version: null,
    })),
  };
}

type PersonalHomeFixtureOptions = Readonly<{
  identity?: string;
  canonicalServerUrl?: string;
  masterSecret?: string;
  publicFileBytes?: string;
  privateFileBytes?: string;
  transcriptRows?: ReadonlyArray<Readonly<{ id: string; body: string }>>;
  /** Skip Home data (database/files/master secret) and keep only the managed runtime config. */
  withData?: boolean;
  /** Install a real executable managed-server stand-in so staged migration spawns genuinely run. */
  stubServerBinary?: boolean;
}>;

async function preparePersonalHomeFixture(homeDir: string, options: PersonalHomeFixtureOptions = {}): Promise<Readonly<{
  backupPath: string;
  canonicalServerUrl: string;
  identity: string;
  masterSecret: string;
  publicFileBytes: string;
  privateFileBytes: string;
  transcriptRows: ReadonlyArray<Readonly<{ id: string; body: string }>>;
  layout: ReturnType<typeof resolvePersonalHomeRuntimeLayout>;
}>> {
  const identity = options.identity ?? 'live-registry-home';
  const canonicalServerUrl = options.canonicalServerUrl ?? 'http://127.0.0.1:59999';
  const masterSecret = options.masterSecret ?? 'live-registry-master-secret';
  const publicFileBytes = options.publicFileBytes ?? 'live-registry-public';
  const privateFileBytes = options.privateFileBytes ?? 'live-registry-private';
  const transcriptRows = options.transcriptRows ?? [
    { id: 'live-1', body: 'live-registry transcript row one' },
    { id: 'live-2', body: 'live-registry transcript row two \u2728' },
  ];
  const defaults = resolveRelayRuntimeDefaults({
    platform: process.platform,
    mode: 'user',
    channel: 'stable',
    homeDir,
  });
  await mkdir(defaults.configDir, { recursive: true });
  await writeFile(path.join(defaults.configDir, 'server.env'), [
    `HAPPIER_SERVER_LIGHT_DATA_DIR=${defaults.dataDir}`,
    `HAPPIER_PUBLIC_SERVER_URL=${canonicalServerUrl}`,
    'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=plaintext_only',
    'HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE=plain',
    'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
    '',
  ].join('\n'));

  const layout = resolvePersonalHomeRuntimeLayout({ homeDir, platform: process.platform, mode: 'user' });
  const migrationPaths = resolveInstalledPersonalHomeSqliteMigrationPaths({
    installRoot: layout.installRoot,
    platform: layout.platform,
  });
  const migration = {
    name: '20260830000000_live_registry',
    sql: 'CREATE TABLE live_registry_fixture (id TEXT);',
  } as const;
  const migrationDir = path.join(migrationPaths.migrationsDir, migration.name);
  await mkdir(migrationDir, { recursive: true });
  await writeFile(path.join(migrationDir, 'migration.sql'), migration.sql);
  const [installedMigration] = await readSqliteMigrationCatalog(migrationPaths.migrationsDir);
  if (!installedMigration) throw new Error('Personal Home fixture migration was not installed.');

  if (options.stubServerBinary === true) {
    // The staged-migration owner spawns the installed managed server with `--migrate-only`.
    // This real fixture executable satisfies that genuine process boundary; the migration
    // frontier already matches, so applying nothing is the correct migration outcome.
    const serverBinaryPath = path.join(layout.installRoot, 'bin', 'happier-server');
    await mkdir(path.dirname(serverBinaryPath), { recursive: true });
    await writeFile(serverBinaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await chmod(serverBinaryPath, 0o755);
  }

  if (options.withData === false) {
    return { backupPath: path.join(homeDir, 'live-registry-home.tar'), canonicalServerUrl, identity, masterSecret, publicFileBytes, privateFileBytes, transcriptRows, layout };
  }

  await mkdir(layout.publicFilesDir, { recursive: true });
  await mkdir(layout.privateFilesDir, { recursive: true });
  await writeFile(layout.masterSecretPath, masterSecret);
  await writeFile(path.join(layout.publicFilesDir, 'public.txt'), publicFileBytes);
  await writeFile(path.join(layout.privateFilesDir, 'private.txt'), privateFileBytes);

  const database = new DatabaseSync(layout.databasePath);
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('CREATE TABLE SimpleCache (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  database.exec('CREATE TABLE "Account" (id TEXT PRIMARY KEY)');
  database.exec('CREATE TABLE "Session" (id TEXT PRIMARY KEY)');
  database.exec('CREATE TABLE live_transcript (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  database.exec('CREATE TABLE _prisma_migrations (migration_name TEXT NOT NULL, checksum TEXT NOT NULL, finished_at TEXT, rolled_back_at TEXT)');
  database.prepare('INSERT INTO SimpleCache (key, value) VALUES (?, ?)').run(
    'server.identity.v1',
    identity,
  );
  database.prepare('INSERT INTO "Account" (id) VALUES (?)').run('live-account-1');
  database.prepare('INSERT INTO "Session" (id) VALUES (?)').run('live-session-1');
  for (const row of transcriptRows) {
    database.prepare('INSERT INTO live_transcript (id, body) VALUES (?, ?)').run(row.id, row.body);
  }
  database.prepare('INSERT INTO _prisma_migrations (migration_name, checksum, finished_at, rolled_back_at) VALUES (?, ?, ?, NULL)').run(
    migration.name,
    installedMigration.checksum,
    new Date().toISOString(),
  );
  database.close();

  return {
    backupPath: path.join(homeDir, 'live-registry-home.tar'),
    canonicalServerUrl,
    identity,
    masterSecret,
    publicFileBytes,
    privateFileBytes,
    transcriptRows,
    layout,
  };
}

// Installs the one genuine process/service boundary mock (the canonical relay host engine plus
// its local component/health resolvers) and loads `load()` in a fresh module graph so every
// dynamically imported production module resolves the mocked engine and its own singletons.
async function importWithRelayBoundaryMocks<T>(load: () => Promise<T>): Promise<T> {
  vi.doMock('@happier-dev/cli-common/systemTasks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/systemTasks')>();
    return {
      ...actual,
      createRelayHostEngine: ((deps: unknown) => relayHarness.engine) as unknown as typeof actual.createRelayHostEngine,
      ensureLocalFirstPartyComponentCommand:
        relayHarness.ensureLocalFirstPartyComponentCommand as unknown as typeof actual.ensureLocalFirstPartyComponentCommand,
    };
  });
  vi.doMock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
    return {
      ...actual,
      checkRelayRuntimeHealth: relayHarness.checkRelayRuntimeHealth as unknown as typeof actual.checkRelayRuntimeHealth,
    };
  });
  return await load();
}

function createNoopPersonalHomeSystemTaskOperations(): PersonalHomeSystemTaskOperations {
  return {
    reconcileRestore: async () => undefined,
    inspect: async () => ({}),
    backup: async () => ({}),
    verifyBackup: async () => ({}),
    restore: async () => ({}),
    recoverRestore: async () => ({}),
    erase: async () => ({}),
  };
}

async function importRelayRunnerAdapter(
  params: Parameters<typeof getLiveSystemTasksRunnerAdapter>[0] = {},
): Promise<ReturnType<typeof getLiveSystemTasksRunnerAdapter>> {
  const module = await importWithRelayBoundaryMocks(() => import('./liveSystemTasksRunner'));
  return module.getLiveSystemTasksRunnerAdapter(params);
}

async function importHomeCommand(): Promise<typeof import('../../cli/commands/home')> {
  return await importWithRelayBoundaryMocks(() => import('../../cli/commands/home'));
}

async function waitForPrompt(
  adapter: Awaited<ReturnType<typeof importRelayRunnerAdapter>>,
  taskId: string,
): Promise<Readonly<{ kind: string; data: Record<string, unknown> }>> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const polled = await adapter.poll({ taskId, cursor: 0 }) as {
      pendingPrompt?: { kind?: unknown; data?: unknown } | null;
      result?: unknown;
    };
    if (polled.pendingPrompt?.kind && polled.pendingPrompt.data && typeof polled.pendingPrompt.data === 'object') {
      return {
        kind: String(polled.pendingPrompt.kind),
        data: polled.pendingPrompt.data as Record<string, unknown>,
      };
    }
    if (polled.result) throw new Error(`System task ${taskId} completed before prompting.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for system task prompt: ${taskId}`);
}

async function readTranscriptRows(databasePath: string): Promise<Array<{ id: string; body: string }>> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare('SELECT id, body FROM live_transcript ORDER BY id').all() as Array<{ id: string; body: string }>;
  } finally {
    database.close();
  }
}

describe('relay runtime system tasks', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    relayHarness = createRelayHarness();
    relayTempHomeDir = await mkdtemp(path.join(await realpath(tmpdir()), 'happier-live-relay-runner-'));
    patchRelayEnv('HOME', relayTempHomeDir);
    patchRelayEnv('USERPROFILE', relayTempHomeDir);
  });

  afterEach(async () => {
    for (const [key, value] of relayPreviousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    relayPreviousEnv.clear();
    vi.resetModules();
    vi.clearAllMocks();
    await rm(relayTempHomeDir, { recursive: true, force: true });
  });

  it('status inspects the requested channel and mode instead of reconstructed defaults', async () => {
    const adapter = await importRelayRunnerAdapter({ personalHomeOperations: createNoopPersonalHomeSystemTaskOperations() });
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.status.v1',
        params: { target: { kind: 'local' }, channel: 'preview', mode: 'system' },
      },
    });
    const taskId = String((started as { taskId?: unknown }).taskId ?? '').trim();

    const { result } = await waitForResult(adapter, taskId);

    expect(result?.ok).toBe(true);
    expect((result as { data?: { relayUrl?: string; healthy?: boolean } }).data?.relayUrl).toBe('http://127.0.0.1:59999');
    expect((result as { data?: { relayUrl?: string; healthy?: boolean } }).data?.healthy).toBe(true);
    expect((result as { data?: { purpose?: unknown; anonymousSignupEnabled?: unknown } }).data).toMatchObject({
      purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:59999' },
      anonymousSignupEnabled: false,
    });
    expect(relayHarness.engine.readStatus).toHaveBeenCalledTimes(2);
    expect(relayHarness.engine.readStatus).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'local' },
      channel: 'preview',
      mode: 'system',
    }));
  });

  it('reconciles through the live CLI registry before returning generic Personal Home status', async () => {
    const reconcileRestore = vi.fn(async () => undefined);
    const module = await importWithRelayBoundaryMocks(() => import('./liveSystemTasksRunner'));
    const adapter = module.getLiveSystemTasksRunnerAdapter({
      personalHomeOperations: {
        reconcileRestore,
        inspect: async () => ({}),
        backup: async () => ({}),
        verifyBackup: async () => ({}),
        restore: async () => ({}),
        recoverRestore: async () => ({}),
        erase: async () => ({}),
      },
    });
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.status.v1',
        params: { target: { kind: 'local' }, channel: 'preview', mode: 'system' },
      },
    });

    const { result } = await waitForResult(adapter, String((started as { taskId?: unknown }).taskId ?? ''));

    expect(result?.ok).toBe(true);
    expect(reconcileRestore).toHaveBeenCalledWith(expect.objectContaining({
      requestedPurpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:59999' },
      runtimeTarget: { channel: 'preview', mode: 'system' },
    }));
  });

  it('installOrUpdate forwards env and the server binary override to the canonical engine', async () => {
    const adapter = await importRelayRunnerAdapter({ personalHomeOperations: createNoopPersonalHomeSystemTaskOperations() });
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.installOrUpdate.v1',
        params: {
          target: { kind: 'local' },
          channel: 'preview',
          mode: 'user',
          env: {
            HAPPIER_SERVER_HOST: '127.0.0.1',
            PORT: '4123',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
            AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
          },
          purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:4123' },
          selfHostRelayBinaryOverride: '/tmp/happier-server-override',
        },
      },
    });
    const taskId = String((started as { taskId?: unknown }).taskId ?? '').trim();

    const { result } = await waitForResult(adapter, taskId);

    expect(result?.ok).toBe(true);
    expect((result as { data?: unknown }).data).toEqual({
      relayUrl: 'http://127.0.0.1:4123',
      mode: 'system',
    });
    expect(relayHarness.engine.installOrUpdate).toHaveBeenCalledTimes(1);
    expect(relayHarness.engine.installOrUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'local' },
      channel: 'preview',
      mode: 'user',
      env: {
        HAPPIER_SERVER_HOST: '127.0.0.1',
        PORT: '4123',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
        AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
      },
      purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:4123' },
      selfHostRelayBinaryOverride: '/tmp/happier-server-override',
    }));
  });

  it('rejects arbitrary Personal Home environment keys on the registered install path before reaching the engine', async () => {
    const adapter = await importRelayRunnerAdapter({ personalHomeOperations: createNoopPersonalHomeSystemTaskOperations() });
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.installOrUpdate.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
          env: {
            PORT: '4123',
            // Home device approval is owned by the Home auth/enrollment path and is
            // inherited from the process environment by the managed installer; it
            // must never be injectable through Personal Home task env params.
            HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: '1',
          },
          purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:4123' },
        },
      },
    });
    const taskId = String((started as { taskId?: unknown }).taskId ?? '');

    const { result } = await waitForResult(adapter, taskId);

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
    expect(relayHarness.engine.installOrUpdate).not.toHaveBeenCalled();
  });

  it('start, restart, and stop delegate control actions with the requested params', async () => {
    const adapter = await importRelayRunnerAdapter({ personalHomeOperations: createNoopPersonalHomeSystemTaskOperations() });

    const startedStart = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.start.v1',
        params: { target: { kind: 'local' }, channel: 'dev', mode: 'user' },
      },
    });
    const startResult = await waitForResult(adapter, String((startedStart as { taskId?: unknown }).taskId ?? ''));
    expect(startResult.result?.ok).toBe(true);
    expect((startResult.result as { data?: { healthy?: boolean } }).data?.healthy).toBe(true);
    expect(relayHarness.engine.control).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'local' },
      channel: 'dev',
      mode: 'user',
      action: 'start',
    }));
    expect(relayHarness.engine.readStatus).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'dev',
      mode: 'user',
    }));

    const startedRestart = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.restart.v1',
        params: { target: { kind: 'local' }, channel: 'dev', mode: 'user' },
      },
    });
    const restartResult = await waitForResult(adapter, String((startedRestart as { taskId?: unknown }).taskId ?? ''));
    expect(restartResult.result?.ok).toBe(true);
    expect(relayHarness.engine.control).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: 'local' },
      channel: 'dev',
      mode: 'user',
      action: 'restart',
    }));

    const startedStop = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.stop.v1',
        params: { target: { kind: 'local' }, channel: 'dev', mode: 'user' },
      },
    });
    const stopResult = await waitForResult(adapter, String((startedStop as { taskId?: unknown }).taskId ?? ''));
    expect(stopResult.result?.ok).toBe(true);
    expect((stopResult.result as { data?: unknown }).data).toEqual({ stopped: true });
    expect(relayHarness.engine.control).toHaveBeenLastCalledWith(expect.objectContaining({
      channel: 'dev',
      mode: 'user',
      action: 'stop',
    }));

    const startedUninstall = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.uninstall.v1',
        params: { target: { kind: 'local' }, channel: 'dev', mode: 'user' },
      },
    });
    const uninstallResult = await waitForResult(adapter, String((startedUninstall as { taskId?: unknown }).taskId ?? ''));
    expect(uninstallResult.result?.ok).toBe(true);
    expect((uninstallResult.result as { data?: unknown }).data).toEqual({ uninstalled: true });
    expect(relayHarness.engine.control).toHaveBeenLastCalledWith(expect.objectContaining({
      channel: 'dev',
      mode: 'user',
      action: 'uninstall',
    }));
  });

  it('routes the real inspect kind through the one injected Personal Home operations boundary', async () => {
    const inspect = vi.fn(async () => ({
      purpose: 'personal-home',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      running: true,
    }));
    const module = await import('./liveSystemTasksRunner');
    const adapter = module.getLiveSystemTasksRunnerAdapter({
      personalHomeOperations: {
        inspect,
        backup: async () => ({}),
        verifyBackup: async () => ({}),
        restore: async () => ({}),
        reconcileRestore: async () => undefined,
        recoverRestore: async () => ({}),
        erase: async () => ({}),
      },
    });
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.inspect.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
          purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
        },
      },
    });

    const { result } = await waitForResult(adapter, String((started as { taskId?: unknown }).taskId ?? ''));

    expect(result).toMatchObject({
      ok: true,
      data: { purpose: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123', running: true },
    });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('routes a destination relocation status command through the injected local authority', async () => {
    const status = vi.fn(async () => ({
      operationId: 'operation-1',
      status: 'quarantined' as const,
      bundleSha256: 'a'.repeat(64),
      expectedHomeServerIdentityId: 'home-1',
      expectedCanonicalServerUrl: 'http://127.0.0.1:43123',
      sourceDescriptorRevision: 4,
      authenticated: true as const,
      accountCount: 1,
      sessionCount: 0,
    }));
    const module = await import('./liveSystemTasksRunner');
    const adapter = module.getLiveSystemTasksRunnerAdapter({
      loadPersonalHomeRelocationDestination: async (target) => {
        expect(target).toEqual({ channel: 'stable', mode: 'user' });
        return {
          stage: async (_input) => { throw new Error('not used'); },
          status,
          commit: async (_input) => { throw new Error('not used'); },
          abort: async (_operationId) => { throw new Error('not used'); },
        };
      },
    });
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.relocation_destination.status.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
          purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
          operationId: 'operation-1',
        },
      },
    });
    const { result } = await waitForResult(adapter, String((started as { taskId?: unknown }).taskId ?? ''));
    expect(result).toMatchObject({ ok: true, data: { operationId: 'operation-1', status: 'quarantined' } });
    expect(status).toHaveBeenCalledWith('operation-1');
  });

  it('backs up and verifies every owned Personal Home byte family through the default live registry', { timeout: 60_000 }, async () => {
    const fixture = await preparePersonalHomeFixture(relayTempHomeDir);
    let running = true;
    relayHarness.engine.readStatus.mockImplementation(async () => ({
      installed: true,
      version: 'happier-server-v9',
      service: { active: running, enabled: true },
      baseUrl: fixture.canonicalServerUrl,
      healthy: true,
      purpose: { kind: 'personal-home' as const, canonicalServerUrl: fixture.canonicalServerUrl },
      canonicalServerUrl: fixture.canonicalServerUrl,
      anonymousSignupEnabled: false,
    }));
    relayHarness.engine.control.mockImplementation(async (input: { action?: string }) => {
      if (input.action === 'stop') running = false;
      if (input.action === 'start') running = true;
    });
    const adapter = await importRelayRunnerAdapter();
    const baseParams = {
      target: { kind: 'local' as const },
      channel: 'stable' as const,
      mode: 'user' as const,
      purpose: {
        kind: 'personal-home' as const,
        canonicalServerUrl: fixture.canonicalServerUrl,
      },
    };

    const lockPath = path.join(fixture.layout.dataDir, '.operations', 'lock');
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, `${JSON.stringify({
      token: 'live-owner-lock',
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      operation: 'restore',
    })}\n`);
    const lockedBackupStarted = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.backup.v1',
        params: { ...baseParams, outputPath: fixture.backupPath },
      },
    });
    expect((await waitForResult(adapter, String((lockedBackupStarted as { taskId?: unknown }).taskId ?? ''))).result)
      .toMatchObject({ ok: false, error: { code: 'operation_in_progress' } });
    expect(relayHarness.engine.control).not.toHaveBeenCalled();
    await rm(lockPath);

    const backupStarted = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.backup.v1',
        params: { ...baseParams, outputPath: fixture.backupPath },
      },
    });
    const backup = await waitForResult(
      adapter,
      String((backupStarted as { taskId?: unknown }).taskId ?? ''),
    );

    expect(backup.result).toMatchObject({
      ok: true,
      data: {
        path: fixture.backupPath,
        manifest: {
          homeServerIdentityId: 'live-registry-home',
          entries: expect.arrayContaining([
            expect.objectContaining({ path: 'database/home.sqlite', size: expect.any(Number), sha256: expect.any(String) }),
            expect.objectContaining({ path: 'files/public/public.txt', size: 'live-registry-public'.length, sha256: expect.any(String) }),
            expect.objectContaining({ path: 'files/private/private.txt', size: 'live-registry-private'.length, sha256: expect.any(String) }),
            expect.objectContaining({ path: 'secrets/handy-master-secret.txt', size: 'live-registry-master-secret'.length, sha256: expect.any(String) }),
            expect.objectContaining({ path: 'configuration/home.env.json', size: expect.any(Number), sha256: expect.any(String) }),
          ]),
        },
      },
    });
    const backupEntries = new Map(
      ((backup.result as { data?: { manifest?: { entries?: Array<{ path: string; size: number; sha256: string }> } } })
        .data?.manifest?.entries ?? []).map((entry) => [entry.path, entry] as const),
    );
    expect(backupEntries.get('files/public/public.txt')).toMatchObject({
      size: 'live-registry-public'.length,
      sha256: sha256('live-registry-public'),
    });
    expect(backupEntries.get('files/private/private.txt')).toMatchObject({
      size: 'live-registry-private'.length,
      sha256: sha256('live-registry-private'),
    });
    expect(backupEntries.get('secrets/handy-master-secret.txt')).toMatchObject({
      size: 'live-registry-master-secret'.length,
      sha256: sha256('live-registry-master-secret'),
    });
    expect(backupEntries.get('database/home.sqlite')?.size).toBeGreaterThan(0);
    expect(backupEntries.get('configuration/home.env.json')?.size).toBeGreaterThan(0);

    const verifyStarted = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.verify_backup.v1',
        params: { ...baseParams, archivePath: fixture.backupPath },
      },
    });
    const verified = await waitForResult(
      adapter,
      String((verifyStarted as { taskId?: unknown }).taskId ?? ''),
    );

    expect(verified.result).toMatchObject({
      ok: true,
      data: {
        identityMatchesCurrentHome: 'match',
        manifest: {
          homeServerIdentityId: 'live-registry-home',
          entries: expect.arrayContaining([
            expect.objectContaining({ path: 'database/home.sqlite' }),
            expect.objectContaining({ path: 'files/public/public.txt' }),
            expect.objectContaining({ path: 'files/private/private.txt' }),
            expect.objectContaining({ path: 'secrets/handy-master-secret.txt' }),
            expect.objectContaining({ path: 'configuration/home.env.json' }),
          ]),
        },
      },
    });
    expect(relayHarness.engine.control).toHaveBeenCalledWith(expect.objectContaining({ action: 'stop' }));
    expect(relayHarness.engine.control).toHaveBeenCalledWith(expect.objectContaining({ action: 'start' }));
  });

  it('restores real bytes and authoritative configuration through the default live registry, and rolls back a failed activation', { timeout: 120_000 }, async () => {
    const fixture = await preparePersonalHomeFixture(relayTempHomeDir, { stubServerBinary: true });
    let running = true;
    let activationHealthy = true;
    relayHarness.engine.readStatus.mockImplementation(async () => ({
      installed: true,
      version: 'happier-server-v9',
      service: { active: running, enabled: true },
      baseUrl: fixture.canonicalServerUrl,
      healthy: activationHealthy,
      purpose: { kind: 'personal-home' as const, canonicalServerUrl: fixture.canonicalServerUrl },
      canonicalServerUrl: fixture.canonicalServerUrl,
      anonymousSignupEnabled: false,
    }));
    relayHarness.engine.control.mockImplementation(async (input: { action?: string }) => {
      if (input.action === 'stop') running = false;
      if (input.action === 'start') {
        running = true;
        await mkdir(fixture.layout.dataDir, { recursive: true });
        await writeFile(path.join(fixture.layout.dataDir, 'startup-receipt.json'), JSON.stringify({
          pid: process.pid,
          personalHomeReadiness: {
            authenticated: true,
            homeServerIdentityId: fixture.identity,
            accountCount: 1,
            sessionCount: 1,
          },
        }));
      }
    });
    const adapter = await importRelayRunnerAdapter();
    const baseParams = {
      target: { kind: 'local' as const },
      channel: 'stable' as const,
      mode: 'user' as const,
      purpose: { kind: 'personal-home' as const, canonicalServerUrl: fixture.canonicalServerUrl },
    };
    const backupStarted = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.backup.v1',
        params: { ...baseParams, outputPath: fixture.backupPath },
      },
    });
    expect((await waitForResult(adapter, String((backupStarted as { taskId?: unknown }).taskId ?? ''))).result?.ok).toBe(true);

    await rm(fixture.layout.databasePath, { force: true });
    await rm(`${fixture.layout.databasePath}-wal`, { force: true });
    await rm(`${fixture.layout.databasePath}-shm`, { force: true });
    await rm(fixture.layout.publicFilesDir, { recursive: true, force: true });
    await rm(fixture.layout.privateFilesDir, { recursive: true, force: true });
    await rm(fixture.layout.masterSecretPath, { force: true });
    running = false;
    const inspectStarted = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.inspect.v1',
        params: baseParams,
      },
    });
    const emptyInspection = await waitForResult(adapter, String((inspectStarted as { taskId?: unknown }).taskId ?? ''));
    expect(emptyInspection.result).toMatchObject({ ok: true, data: { storage: { destinationEmpty: true } } });

    const identityMismatchStarted = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.restore.v1',
        params: {
          ...baseParams,
          archivePath: fixture.backupPath,
          expectedHomeServerIdentityId: 'different-home-identity',
        },
      },
    });
    expect((await waitForResult(adapter, String((identityMismatchStarted as { taskId?: unknown }).taskId ?? ''))).result)
      .toMatchObject({ ok: false, error: { code: 'identity_mismatch' } });
    await expect(lstat(fixture.layout.databasePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const corruptArchivePath = path.join(relayTempHomeDir, 'live-registry-corrupt.tar');
    const corruptArchiveBytes = await readFile(fixture.backupPath);
    const corruptIndex = Math.floor(corruptArchiveBytes.length / 2);
    corruptArchiveBytes[corruptIndex] = (corruptArchiveBytes[corruptIndex] ?? 0) ^ 0xff;
    await writeFile(corruptArchivePath, corruptArchiveBytes);
    const corruptRestoreStarted = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.restore.v1',
        params: {
          ...baseParams,
          archivePath: corruptArchivePath,
          expectedHomeServerIdentityId: fixture.identity,
        },
      },
    });
    const corruptRestore = await waitForResult(adapter, String((corruptRestoreStarted as { taskId?: unknown }).taskId ?? ''));
    const corruptErrorCode = (corruptRestore.result as { ok: boolean; error?: { code?: string } }).error?.code;
    expect(['invalid_archive', 'hash_mismatch']).toContain(corruptErrorCode);
    await expect(lstat(fixture.layout.databasePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const emptyRestoreStarted = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.restore.v1',
        params: {
          ...baseParams,
          archivePath: fixture.backupPath,
          expectedHomeServerIdentityId: fixture.identity,
        },
      },
    });
    await vi.waitFor(async () => {
      await expect(readFile(path.join(fixture.layout.dataDir, 'startup-receipt.json'), 'utf8')).resolves.toContain(fixture.identity);
    });
    const emptyRestore = await waitForResult(adapter, String((emptyRestoreStarted as { taskId?: unknown }).taskId ?? ''));
    expect(emptyRestore.result, JSON.stringify(emptyRestore.result))
      .toMatchObject({ ok: true, data: { outcome: 'restored' } });
    expect(await readTranscriptRows(fixture.layout.databasePath)).toEqual(fixture.transcriptRows);
    await expect(readFile(path.join(fixture.layout.publicFilesDir, 'public.txt'), 'utf8')).resolves.toBe(fixture.publicFileBytes);
    await expect(readFile(path.join(fixture.layout.privateFilesDir, 'private.txt'), 'utf8')).resolves.toBe(fixture.privateFileBytes);
    await expect(readFile(fixture.layout.masterSecretPath, 'utf8')).resolves.toBe(fixture.masterSecret);
    expect(running).toBe(true);

    const rejectedFinalization = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.restore.v1',
        params: { ...baseParams, action: 'finalize' },
      },
    });
    expect((await waitForResult(adapter, String((rejectedFinalization as { taskId?: unknown }).taskId ?? ''))).result)
      .toMatchObject({ ok: false, error: { code: 'invalid_params' } });

    const destinationDatabase = new DatabaseSync(fixture.layout.databasePath);
    destinationDatabase.prepare('UPDATE live_transcript SET body = ? WHERE id = ?').run('destination-before-failed-restore', 'live-1');
    destinationDatabase.close();
    await writeFile(path.join(fixture.layout.publicFilesDir, 'public.txt'), 'destination-public-before-failed-restore');
    await writeFile(path.join(fixture.layout.publicFilesDir, 'destination-only.txt'), 'keep-on-rollback');
    await writeFile(path.join(fixture.layout.privateFilesDir, 'private.txt'), 'destination-private-before-failed-restore');
    await writeFile(fixture.layout.masterSecretPath, 'destination-secret-before-failed-restore');
    const destinationEnv = [
      `HAPPIER_SERVER_LIGHT_DATA_DIR=${fixture.layout.dataDir}`,
      'HAPPIER_PUBLIC_SERVER_URL=http://127.0.0.1:59998',
      'HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=plaintext_only',
      'HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE=plain',
      'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
      '',
    ].join('\n');
    await writeFile(path.join(fixture.layout.configDir, 'server.env'), destinationEnv);
    running = false;
    activationHealthy = false;

    const failedRestoreStarted = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.restore.v1',
        params: {
          ...baseParams,
          archivePath: fixture.backupPath,
          confirmOverwrite: true,
          expectedHomeServerIdentityId: fixture.identity,
        },
      },
    });
    const failedRestore = await waitForResult(adapter, String((failedRestoreStarted as { taskId?: unknown }).taskId ?? ''));
    expect(failedRestore.result).toMatchObject({ ok: true, data: { outcome: 'rolled_back' } });
    expect((await readTranscriptRows(fixture.layout.databasePath)).find((row) => row.id === 'live-1')?.body)
      .toBe('destination-before-failed-restore');
    await expect(readFile(path.join(fixture.layout.publicFilesDir, 'destination-only.txt'), 'utf8')).resolves.toBe('keep-on-rollback');
    await expect(readFile(fixture.layout.masterSecretPath, 'utf8')).resolves.toBe('destination-secret-before-failed-restore');
    await expect(readFile(path.join(fixture.layout.configDir, 'server.env'), 'utf8')).resolves.toBe(destinationEnv);

    activationHealthy = true;
    const restoreStarted = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'relay.runtime.personal_home.restore.v1',
        params: {
          ...baseParams,
          archivePath: fixture.backupPath,
          confirmOverwrite: true,
          expectedHomeServerIdentityId: fixture.identity,
        },
      },
    });
    const restored = await waitForResult(adapter, String((restoreStarted as { taskId?: unknown }).taskId ?? ''));

    expect(restored.result).toMatchObject({ ok: true, data: { outcome: 'restored' } });
    expect(await readTranscriptRows(fixture.layout.databasePath)).toEqual(fixture.transcriptRows);
    await expect(readFile(path.join(fixture.layout.publicFilesDir, 'public.txt'), 'utf8')).resolves.toBe(fixture.publicFileBytes);
    await expect(readFile(path.join(fixture.layout.privateFilesDir, 'private.txt'), 'utf8')).resolves.toBe(fixture.privateFileBytes);
    await expect(readFile(fixture.layout.masterSecretPath, 'utf8')).resolves.toBe(fixture.masterSecret);
    await expect(lstat(path.join(fixture.layout.publicFilesDir, 'destination-only.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const restoredEnv = await readFile(path.join(fixture.layout.configDir, 'server.env'), 'utf8');
    expect(restoredEnv).toContain(`HAPPIER_CANONICAL_SERVER_URL=${fixture.canonicalServerUrl}`);
    expect(restoredEnv).toContain('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=plaintext_only');
    expect(restoredEnv).toContain('HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE=plain');
    expect(restoredEnv).toContain('AUTH_ANONYMOUS_SIGNUP_ENABLED=0');
    expect(running).toBe(true);
    expect(relayHarness.engine.control).toHaveBeenCalledWith(expect.objectContaining({ action: 'stop' }));
    expect(relayHarness.engine.control).toHaveBeenCalledWith(expect.objectContaining({ action: 'start' }));
    await expect(lstat(path.join(fixture.layout.installRoot, 'bin', 'happier-server'))).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it('exposes exact owner-resolved erase facts, restarts after decline, and erases only canonical Home data after approval', { timeout: 60_000 }, async () => {
    const fixture = await preparePersonalHomeFixture(relayTempHomeDir, { stubServerBinary: true });
    const unrelatedInstallFile = path.join(fixture.layout.installRoot, 'runtime-preserved.txt');
    await writeFile(unrelatedInstallFile, 'runtime-is-not-home-data');
    let running = true;
    relayHarness.engine.readStatus.mockImplementation(async () => ({
      installed: true,
      version: 'happier-server-v9',
      service: { active: running, enabled: true },
      baseUrl: fixture.canonicalServerUrl,
      healthy: true,
      purpose: { kind: 'personal-home' as const, canonicalServerUrl: fixture.canonicalServerUrl },
      canonicalServerUrl: fixture.canonicalServerUrl,
      anonymousSignupEnabled: false,
    }));
    relayHarness.engine.control.mockImplementation(async (input: { action?: string }) => {
      if (input.action === 'stop') running = false;
      if (input.action === 'start') running = true;
    });
    const adapter = await importRelayRunnerAdapter();
    const spec = {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      kind: 'relay.runtime.personal_home.erase.v1',
      params: {
        target: { kind: 'local' as const },
        channel: 'stable' as const,
        mode: 'user' as const,
        purpose: { kind: 'personal-home' as const, canonicalServerUrl: fixture.canonicalServerUrl },
      },
    };
    const artifacts = resolvePersonalHomeRuntimeArtifactPaths(fixture.layout);
    const expectedPaths = [...new Set([
      fixture.layout.databasePath,
      `${fixture.layout.databasePath}-wal`,
      `${fixture.layout.databasePath}-shm`,
      fixture.layout.publicFilesDir,
      fixture.layout.privateFilesDir,
      fixture.layout.masterSecretPath,
      fixture.layout.backupsDir,
      fixture.layout.derivedDataDir,
      fixture.layout.irohEndpointKeyPath,
      artifacts.irohEndpointDescriptorPath,
      artifacts.homeConnectionDescriptorPath,
      artifacts.startupReceiptPath,
      artifacts.updateRecoveryPath,
      path.resolve(fixture.layout.dataDir, '.operations', 'restore-journal.json'),
      path.resolve(fixture.layout.dataDir, '.operations', 'relocation-source.json'),
      path.resolve(fixture.layout.dataDir, '.operations', 'relocation-destination.json'),
      path.resolve(fixture.layout.configDir, 'server.env'),
    ].map((value) => path.resolve(value)))];

    const declinedStarted = await adapter.start({ spec });
    const declinedTaskId = String((declinedStarted as { taskId?: unknown }).taskId ?? '');
    const declinedPrompt = await waitForPrompt(adapter, declinedTaskId);
    expect(declinedPrompt).toMatchObject({
      kind: 'personal_home.confirm_erase.v1',
      data: { paths: expectedPaths, estimatedBytes: expect.any(Number) },
    });
    expect(Number(declinedPrompt.data.estimatedBytes)).toBeGreaterThan(0);
    await adapter.respond({ taskId: declinedTaskId, answer: { confirmed: false } });
    expect((await waitForResult(adapter, declinedTaskId)).result).toMatchObject({
      ok: false,
      error: { code: 'confirmation_required' },
    });
    expect(running).toBe(true);
    await expect(readFile(fixture.layout.masterSecretPath, 'utf8')).resolves.toBe(fixture.masterSecret);
    await expect(readFile(path.join(fixture.layout.publicFilesDir, 'public.txt'), 'utf8')).resolves.toBe(fixture.publicFileBytes);

    const approvedStarted = await adapter.start({ spec });
    const approvedTaskId = String((approvedStarted as { taskId?: unknown }).taskId ?? '');
    const approvedPrompt = await waitForPrompt(adapter, approvedTaskId);
    expect(approvedPrompt.data.paths).toEqual(expectedPaths);
    await adapter.respond({ taskId: approvedTaskId, answer: { confirmed: true } });
    const approved = await waitForResult(adapter, approvedTaskId);
    expect(approved.result).toMatchObject({
      ok: true,
      data: {
        removedPaths: expect.arrayContaining([
          fixture.layout.databasePath,
          fixture.layout.publicFilesDir,
          fixture.layout.privateFilesDir,
          fixture.layout.masterSecretPath,
          path.join(fixture.layout.configDir, 'server.env'),
        ]),
        stoppedRunningHome: true,
      },
    });
    expect(running).toBe(false);
    for (const erasedPath of [
      fixture.layout.databasePath,
      fixture.layout.publicFilesDir,
      fixture.layout.privateFilesDir,
      fixture.layout.masterSecretPath,
      path.join(fixture.layout.configDir, 'server.env'),
    ]) {
      await expect(lstat(erasedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(readFile(unrelatedInstallFile, 'utf8')).resolves.toBe('runtime-is-not-home-data');
    await expect(lstat(path.join(fixture.layout.installRoot, 'bin', 'happier-server'))).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it('routes the real Home backup command through the singleton default live registry', { timeout: 60_000 }, async () => {
    const fixture = await preparePersonalHomeFixture(relayTempHomeDir);
    let running = true;
    relayHarness.engine.readStatus.mockImplementation(async () => ({
      installed: true,
      version: 'happier-server-v9',
      service: { active: running, enabled: true },
      baseUrl: fixture.canonicalServerUrl,
      healthy: true,
      purpose: { kind: 'personal-home' as const, canonicalServerUrl: fixture.canonicalServerUrl },
      canonicalServerUrl: fixture.canonicalServerUrl,
      anonymousSignupEnabled: false,
    }));
    relayHarness.engine.control.mockImplementation(async (input: { action?: string }) => {
      if (input.action === 'stop') running = false;
      if (input.action === 'start') running = true;
    });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const homeCommand = await importHomeCommand();

    await homeCommand.handleHomeCommand(['backup', '--output', fixture.backupPath]);

    expect((await lstat(fixture.backupPath)).size).toBeGreaterThan(0);
    expect(running).toBe(true);
    expect(relayHarness.engine.control).toHaveBeenCalledWith(expect.objectContaining({ action: 'stop' }));
    expect(relayHarness.engine.control).toHaveBeenCalledWith(expect.objectContaining({ action: 'start' }));
    expect(consoleLog).toHaveBeenCalled();
  });
});
