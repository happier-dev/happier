import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';

const run = createRunDirs({ runLabel: 'core' });

type UnknownRecord = Record<string, unknown>;

type SpawnResponse = {
  success: boolean;
  sessionId?: string;
  error?: string;
  errorCode?: string;
};

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function getNumber(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') {
    throw new Error(`Expected numeric ${key}`);
  }
  return value;
}

async function writeAccountSettings(params: Readonly<{
  baseUrl: string;
  token: string;
  settings: Record<string, unknown>;
}>): Promise<number> {
  const getRes = await fetch(`${params.baseUrl}/v1/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
  });
  expect(getRes.ok).toBe(true);
  const getJson: unknown = await getRes.json().catch(() => null);
  const getRow = asRecord(getJson);
  if (!getRow) throw new Error('Expected account settings response object');
  const settingsVersion = getNumber(getRow, 'settingsVersion');

  const postRes = await fetch(`${params.baseUrl}/v1/account/settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      settings: JSON.stringify(params.settings),
      expectedVersion: settingsVersion,
    }),
  });
  expect(postRes.ok).toBe(true);
  const postJson: unknown = await postRes.json().catch(() => null);
  const postRow = asRecord(postJson);
  if (!postRow) throw new Error('Expected account settings write response object');
  expect(postRow.success).toBe(true);
  return getNumber(postRow, 'version');
}

async function spawnClaudeSession(params: Readonly<{
  daemon: StartedDaemon;
  workspaceDir: string;
  environmentVariables: NodeJS.ProcessEnv;
  accountSettingsVersionHint?: number;
}>): Promise<SpawnResponse> {
  const body: UnknownRecord = {
    directory: params.workspaceDir,
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    terminal: { mode: 'plain' },
    environmentVariables: params.environmentVariables,
  };
  if (typeof params.accountSettingsVersionHint === 'number') {
    body.accountSettingsVersionHint = params.accountSettingsVersionHint;
  }

  const spawnRes = await daemonControlPostJson<SpawnResponse>({
    port: params.daemon.state.httpPort,
    path: '/spawn-session',
    controlToken: params.daemon.state.controlToken,
    body,
    timeoutMs: 90_000,
  });

  expect(spawnRes.status).toBe(200);
  return spawnRes.data;
}

async function findDaemonAccountSettingsCachePath(daemonHomeDir: string): Promise<string> {
  const matches: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === 'account.settings.cache.json') {
        matches.push(fullPath);
      }
    }
  }

  await visit(join(daemonHomeDir, 'servers'));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one daemon account settings cache file under ${daemonHomeDir}; found ${matches.length}`);
  }
  return matches[0]!;
}

async function readDaemonCachedAccountSettings(daemonHomeDir: string): Promise<UnknownRecord> {
  const cachePath = await findDaemonAccountSettingsCachePath(daemonHomeDir);
  const raw = await readFile(cachePath, 'utf8');
  const parsed = asRecord(JSON.parse(raw) as unknown);
  if (!parsed) throw new Error(`Expected daemon account settings cache object at ${cachePath}`);
  return parsed;
}

describe('core e2e: daemon spawn account settings version hints', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  it('continues daemon spawn when the requested account settings version is unavailable', async () => {
    const testDir = run.testDir(`daemon-spawn-account-settings-version-hint-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret,
    });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const daemonEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
      HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE: 'testdir',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });

    const spawnRes = await spawnClaudeSession({
      daemon,
      workspaceDir,
      environmentVariables: daemonEnv,
      accountSettingsVersionHint: 1_000_000,
    });

    expect(spawnRes.success).toBe(true);
    expect(typeof spawnRes.sessionId).toBe('string');
  }, 240_000);

  it('refreshes the daemon account settings cache before spawning with a settings version hint', async () => {
    const testDir = run.testDir(`daemon-spawn-account-settings-prompt-personalization-${randomUUID()}`);
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
    const auth = await createTestAuth(server.baseUrl);

    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    const secret = Uint8Array.from(randomBytes(32));
    await seedCliAuthForServer({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      token: auth.token,
      secret,
    });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const daemonEnv = {
      ...process.env,
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_CLAUDE_PATH: fakeClaudePath,
      HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLogPath,
      HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE: 'testdir',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });

    const settingsVersion = await writeAccountSettings({
      baseUrl: server.baseUrl,
      token: auth.token,
      settings: {
        schemaVersion: 2,
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'disabled',
          responseOptions: 'disabled',
        },
      },
    });

    const spawnRes = await spawnClaudeSession({
      daemon,
      workspaceDir,
      accountSettingsVersionHint: settingsVersion,
      environmentVariables: daemonEnv,
    });

    expect(spawnRes.success).toBe(true);
    expect(typeof spawnRes.sessionId).toBe('string');

    const cache = await readDaemonCachedAccountSettings(daemonHomeDir);
    expect(cache.settingsVersion).toBe(settingsVersion);
    const settingsContent = asRecord(cache.settingsContent);
    if (!settingsContent) throw new Error('Expected cached settingsContent object');
    expect(settingsContent.t).toBe('encrypted');
    const cachedSettings = asRecord(JSON.parse(String(settingsContent.c)) as unknown);
    if (!cachedSettings) throw new Error('Expected cached account settings JSON');
    expect(cachedSettings.codingPromptBehaviorV1).toEqual({
      v: 1,
      sessionTitleUpdates: 'disabled',
      responseOptions: 'disabled',
    });
  }, 240_000);
});
