/**
 * Daemon spawn/stop stress tests.
 *
 * These are intentionally not part of the default integration lane because they are
 * resource-intensive and can be sensitive to CI machine load.
 *
 * Run with:
 * - `yarn workspace @happier/cli test:slow`
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { copyFile, mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';

import { configuration, reloadConfiguration } from '@/configuration';
import { listDaemonSessions, spawnDaemonSession, stopDaemonHttp, stopDaemonSession } from '@/daemon/controlClient';
import { readCredentials, readDaemonState } from '@/persistence';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

type WaitForOptions = {
  timeoutMs: number;
  intervalMs?: number;
  label: string;
};

type DaemonSessionRecord = {
  startedBy: string;
  happySessionId: string;
  pid: number;
};

const DAEMON_READY_WAIT: WaitForOptions = {
  timeoutMs: 45_000,
  intervalMs: 250,
  label: 'daemon startup state',
};

const SESSION_CONSISTENCY_WAIT: WaitForOptions = {
  timeoutMs: 60_000,
  intervalMs: 500,
  label: 'session list consistency',
};

type EnvSnapshot = {
  homeDir: string | undefined;
  activeServerId: string | undefined;
  serverUrl: string | undefined;
  webappUrl: string | undefined;
  publicServerUrl: string | undefined;
};

let isolatedHomeDir: string | null = null;
let daemonIntegrationSourceHomeDir: string | null = null;
let daemonPid: number;

const originalEnv: EnvSnapshot = {
  homeDir: process.env.HAPPIER_HOME_DIR,
  activeServerId: process.env.HAPPIER_ACTIVE_SERVER_ID,
  serverUrl: process.env.HAPPIER_SERVER_URL,
  webappUrl: process.env.HAPPIER_WEBAPP_URL,
  publicServerUrl: process.env.HAPPIER_PUBLIC_SERVER_URL,
};

async function waitFor(condition: () => Promise<boolean>, opts: WaitForOptions): Promise<void> {
  const intervalMs = opts.intervalMs ?? 100;
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${opts.label} after ${opts.timeoutMs}ms`);
}

async function listDaemonSessionsTyped(): Promise<DaemonSessionRecord[]> {
  return (await listDaemonSessions()) as DaemonSessionRecord[];
}

function startDaemonProcessForStartSync(): ReturnType<typeof spawn> {
  return spawnHappyCLI(['daemon', 'start-sync'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function copyIfExists(sourcePath: string, targetPath: string): Promise<void> {
  if (!existsSync(sourcePath)) {
    return;
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

async function copyLogsToSourceHomeBestEffort(): Promise<void> {
  if (!isolatedHomeDir) return;
  if (!daemonIntegrationSourceHomeDir) return;

  const srcLogsDir = join(isolatedHomeDir, 'logs');
  if (!existsSync(srcLogsDir)) return;
  const dstLogsDir = join(daemonIntegrationSourceHomeDir, 'logs');
  await mkdir(dstLogsDir, { recursive: true });

  const runPrefix = `daemon-slow-${basename(isolatedHomeDir)}`;
  const entries = readdirSync(srcLogsDir);
  for (const entry of entries) {
    if (!entry.endsWith('.log')) continue;
    const from = join(srcLogsDir, entry);
    const to = join(dstLogsDir, `${runPrefix}-${entry}`);
    try {
      await copyFile(from, to);
    } catch {
      // best-effort
    }
  }
}

async function prepareIsolatedHome(): Promise<void> {
  const sourceHome = configuration.happyHomeDir;
  daemonIntegrationSourceHomeDir = sourceHome;
  const sourceSettingsFile = configuration.settingsFile;
  const sourceLegacyKeyFile = configuration.legacyPrivateKeyFile;
  const sourceServerKeyFile = configuration.privateKeyFile;
  const sourceServerId = configuration.activeServerId;
  const sourceServerUrl = configuration.serverUrl;
  const sourceWebappUrl = configuration.webappUrl;
  const sourcePublicServerUrl = configuration.publicServerUrl;

  const parentDir = join(sourceHome, 'tmp');
  await mkdir(parentDir, { recursive: true });
  isolatedHomeDir = await mkdtemp(join(parentDir, 'happier-cli-daemon-slow-'));

  process.env.HAPPIER_HOME_DIR = isolatedHomeDir;
  process.env.HAPPIER_ACTIVE_SERVER_ID = sourceServerId;
  process.env.HAPPIER_SERVER_URL = sourceServerUrl;
  process.env.HAPPIER_WEBAPP_URL = sourceWebappUrl;
  process.env.HAPPIER_PUBLIC_SERVER_URL = sourcePublicServerUrl;
  reloadConfiguration();

  await copyIfExists(sourceSettingsFile, configuration.settingsFile);
  await copyIfExists(sourceLegacyKeyFile, configuration.legacyPrivateKeyFile);
  await copyIfExists(sourceServerKeyFile, configuration.privateKeyFile);
}

async function restoreEnvironment(): Promise<void> {
  if (originalEnv.homeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = originalEnv.homeDir;
  if (originalEnv.activeServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
  else process.env.HAPPIER_ACTIVE_SERVER_ID = originalEnv.activeServerId;
  if (originalEnv.serverUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
  else process.env.HAPPIER_SERVER_URL = originalEnv.serverUrl;
  if (originalEnv.webappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
  else process.env.HAPPIER_WEBAPP_URL = originalEnv.webappUrl;
  if (originalEnv.publicServerUrl === undefined) delete process.env.HAPPIER_PUBLIC_SERVER_URL;
  else process.env.HAPPIER_PUBLIC_SERVER_URL = originalEnv.publicServerUrl;
  reloadConfiguration();

  if (isolatedHomeDir) {
    await copyLogsToSourceHomeBestEffort();
    const expectedPrefix = daemonIntegrationSourceHomeDir
      ? join(daemonIntegrationSourceHomeDir, 'tmp', 'happier-cli-daemon-slow-')
      : null;
    const safeToDelete = expectedPrefix ? isolatedHomeDir.startsWith(expectedPrefix) : false;
    if (safeToDelete) {
      await rm(isolatedHomeDir, { recursive: true, force: true });
    }
    isolatedHomeDir = null;
  }
  daemonIntegrationSourceHomeDir = null;
}

async function waitForDaemonReady(): Promise<void> {
  await waitFor(async () => {
    const state = await readDaemonState();
    if (!state) return false;
    daemonPid = state.pid;
    // Best-effort: confirm credentials are readable for this isolated home.
    const creds = await readCredentials().catch(() => null);
    return Boolean(state.httpPort && state.controlToken && creds);
  }, DAEMON_READY_WAIT);
}

async function waitForSessionCount(expected: number, opts: WaitForOptions): Promise<void> {
  await waitFor(async () => {
    const sessions = await listDaemonSessionsTyped();
    const daemonSessions = sessions.filter((s) => s.startedBy === 'daemon');
    return daemonSessions.length === expected;
  }, opts);
}

describe('daemon spawn/stop stress (slow lane)', () => {
  beforeAll(async () => {
    await prepareIsolatedHome();
  });

  afterAll(async () => {
    await restoreEnvironment();
  });

  beforeEach(async () => {
    const child = startDaemonProcessForStartSync();
    child.unref?.();
    await waitForDaemonReady();
  });

  afterEach(async () => {
    try {
      await stopDaemonHttp();
    } catch {
      // best-effort
    }
  });

  it('spawns and stops multiple sessions', { timeout: 10 * 60_000 }, async () => {
    const sessionCount = 20;
    const results = await Promise.all(
      Array.from({ length: sessionCount }, () => spawnDaemonSession('/tmp')),
    );

    results.forEach((result) => {
      expect(result.success, `stress spawn result=${JSON.stringify(result)}`).toBe(true);
      expect(result.sessionId).toBeDefined();
    });

    const sessionIds = results.map((r) => r.sessionId);
    await waitForSessionCount(sessionCount, SESSION_CONSISTENCY_WAIT);

    const stopResults = await Promise.all(sessionIds.map((sessionId) => stopDaemonSession(sessionId)));
    expect(stopResults.every((r) => r), 'Not all sessions reported stopped').toBe(true);
    await waitForSessionCount(0, {
      ...SESSION_CONSISTENCY_WAIT,
      label: 'all stress sessions stopped',
    });
  });
});

