import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { configuration, reloadConfiguration } from '@/configuration'
import { resolveDaemonStateBasenameForRing } from '@/cli/runtime/publicReleaseChannel'
import { createEnvKeyScope } from '@/testkit/env/envScope'
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir'
import {
  spawnDetachedInlineNodeTestProcess,
  spawnDetachedTestProcess,
} from '@/testkit/process/spawn'

const baselineServers = {
  cloud: {
    id: 'cloud',
    name: 'Happier Cloud',
    serverUrl: 'https://api.happier.dev',
    webappUrl: 'https://app.happier.dev',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: 0,
  },
  company: {
    id: 'company',
    name: 'Company',
    serverUrl: 'https://company.example.test',
    webappUrl: 'https://company.example.test',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: 0,
  },
}

export function createDaemonSettingsFixture(options: {
  activeServerId?: string
  servers?: Readonly<Record<string, unknown>>
  machineIdByServerId?: Readonly<Record<string, string | undefined>>
  machineIdByServerIdByAccountId?: Readonly<Record<string, Record<string, string | undefined> | undefined>>
  machineIdConfirmedByServerByServerId?: Readonly<Record<string, boolean | undefined>>
  lastTokenSubByServerId?: Readonly<Record<string, string | undefined>>
} = {}) {
  return {
    schemaVersion: 5,
    onboardingCompleted: false,
    activeServerId: options.activeServerId ?? 'cloud',
    servers: options.servers ?? baselineServers,
    machineIdByServerId: options.machineIdByServerId ?? {},
    machineIdByServerIdByAccountId: options.machineIdByServerIdByAccountId ?? {},
    machineIdConfirmedByServerByServerId: options.machineIdConfirmedByServerByServerId ?? {},
    lastTokenSubByServerId: options.lastTokenSubByServerId ?? {},
  }
}

export async function writeDaemonSettingsFixture(homeDir: string, options: {
  activeServerId?: string
  servers?: Readonly<Record<string, unknown>>
  machineIdByServerId?: Readonly<Record<string, string | undefined>>
  machineIdByServerIdByAccountId?: Readonly<Record<string, Record<string, string | undefined> | undefined>>
  machineIdConfirmedByServerByServerId?: Readonly<Record<string, boolean | undefined>>
  lastTokenSubByServerId?: Readonly<Record<string, string | undefined>>
} = {}): Promise<void> {
  await writeFile(
    join(homeDir, 'settings.json'),
    JSON.stringify(createDaemonSettingsFixture(options), null, 2),
    'utf-8',
  )
}

export async function writeDaemonStateFixture(homeDir: string, serverId: string, state: {
  pid: number
  httpPort: number
  startedAt?: number
  startedWithCliVersion?: string
  controlToken?: string
  machineId?: string
}): Promise<string> {
  const serverDir = join(homeDir, 'servers', serverId)
  const statePath = join(serverDir, resolveDaemonStateBasenameForRing(configuration.publicReleaseRing))

  mkdirSync(serverDir, { recursive: true })
  await writeFile(
    statePath,
    JSON.stringify(
      {
        startedAt: state.startedAt ?? Date.now(),
        startedWithCliVersion: state.startedWithCliVersion ?? '0.0.0-test',
        ...state,
      },
      null,
      2,
    ),
    'utf-8',
  )

  return statePath
}

export async function withConfiguredDaemonTestHome<T>(
  options: {
    prefix: string
    env?: Readonly<Record<string, string | undefined>>
  },
  fn: (context: { homeDir: string }) => Promise<T>,
): Promise<T> {
  const homeDir = await createTempDir(options.prefix)
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_PLATFORM',
    'HAPPIER_DAEMON_SERVICE_UID',
    'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
    'HAPPIER_DAEMON_SERVICE_SERVER_URL',
    'HAPPIER_DAEMON_SERVICE_WEBAPP_URL',
    'HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL',
    'HAPPIER_DAEMON_SERVICE_NODE_PATH',
    'HAPPIER_DAEMON_SERVICE_ENTRY_PATH',
    'HAPPIER_DAEMON_SERVICE_CHANNEL',
    'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
    'HAPPIER_DAEMON_SERVICE_MODE',
    'HAPPIER_DAEMON_SERVICE_SYSTEM_USER',
    ...Object.keys(options.env ?? {}),
  ]
  const envScope = createEnvKeyScope(envKeys)

  try {
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: homeDir,
      ...(options.env ?? {}),
    })
    reloadConfiguration()
    return await fn({ homeDir })
  } finally {
    envScope.restore()
    reloadConfiguration()
    await removeTempDir(homeDir)
  }
}

async function killOwnedTestProcess(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  // A census can report a zombie before libuv has reaped this owned child.
  // Stop assertions need the ChildProcess exit, not merely non-running state.
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  return true
}

export function spawnSleepyDetachedProcess(args: string[] = []): { pid: number; kill: () => Promise<boolean> } {
  const child = spawnDetachedTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...args])
  const pid = child.pid

  if (!pid) {
    throw new Error('Failed to spawn test process')
  }

  return {
    pid,
    kill: () => killOwnedTestProcess(child),
  }
}

export function spawnStoppableHttpDaemon(
  port: number,
  stopStatus = 200,
  options: Readonly<{ controlToken?: string; exitOnStop?: boolean; pingStatus?: number; lockFile?: string; stateFile?: string; retainLockAfterControlClose?: boolean; successorLockPid?: number }> = {},
): { pid: number; kill: () => Promise<boolean> } {
  const child = spawnDetachedInlineNodeTestProcess(
    [
      'const http = require("http");',
      'const fs = require("fs");',
      `const lockFile = ${JSON.stringify(options.lockFile ?? null)};`,
      `const stateFile = ${JSON.stringify(options.stateFile ?? null)};`,
      'if (lockFile) { fs.mkdirSync(require("path").dirname(lockFile), { recursive: true }); fs.writeFileSync(lockFile, String(process.pid)); }',
      'const server = http.createServer((req, res) => {',
      ...(options.controlToken ? [
        `  if (req.method === "POST" && req.headers["x-happier-daemon-token"] !== ${JSON.stringify(options.controlToken)}) { res.writeHead(401); res.end(); return; }`,
        `  if (req.method === "POST" && req.url === "/ping") { res.writeHead(${options.pingStatus ?? 200}, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "ok" })); return; }`,
      ] : []),
      '  if (req.method === "POST" && req.url === "/stop") {',
      `    res.writeHead(${stopStatus}, { "content-type": "application/json" });`,
      '    res.end(JSON.stringify({ ok: true }));',
      ...(stopStatus === 200 && options.exitOnStop !== false ? [
        options.lockFile
          ? `    setTimeout(() => { if (stateFile) { try { fs.unlinkSync(stateFile); } catch {} } server.close(() => { ${options.retainLockAfterControlClose ? 'return;' : `try { fs.unlinkSync(lockFile); } catch {} ${options.successorLockPid ? `fs.writeFileSync(lockFile, String(${options.successorLockPid}));` : ''} process.exit(0);`} }); }, 10);`
          : '    setTimeout(() => process.exit(0), 10);',
      ] : []),
      '    return;',
      '  }',
      '  res.writeHead(404);',
      '  res.end();',
      '});',
      `server.listen(${port}, "127.0.0.1");`,
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  )
  const pid = child.pid

  if (!pid) {
    throw new Error('Failed to spawn http daemon')
  }

  return {
    pid,
    kill: () => killOwnedTestProcess(child),
  }
}
