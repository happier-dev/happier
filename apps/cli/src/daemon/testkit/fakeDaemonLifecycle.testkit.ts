import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { reloadConfiguration } from '@/configuration'
import { createEnvKeyScope } from '@/testkit/env/envScope'
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir'
import {
  spawnDetachedInlineNodeTestProcess,
  spawnDetachedTestProcess,
  waitForProcessExit,
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
} = {}) {
  return {
    schemaVersion: 5,
    onboardingCompleted: false,
    activeServerId: options.activeServerId ?? 'cloud',
    servers: options.servers ?? baselineServers,
    machineIdByServerId: {},
    machineIdConfirmedByServerByServerId: {},
    lastChangesCursorByServerIdByAccountId: {},
  }
}

export async function writeDaemonSettingsFixture(homeDir: string, options: {
  activeServerId?: string
  servers?: Readonly<Record<string, unknown>>
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
}): Promise<string> {
  const serverDir = join(homeDir, 'servers', serverId)
  const statePath = join(serverDir, 'daemon.state.json')

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
  const envKeys = ['HAPPIER_HOME_DIR', ...Object.keys(options.env ?? {})]
  const envScope = createEnvKeyScope(envKeys)

  try {
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
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

export function spawnSleepyDetachedProcess(): { pid: number; kill: () => Promise<boolean> } {
  const child = spawnDetachedTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  const pid = child.pid

  if (!pid) {
    throw new Error('Failed to spawn test process')
  }

  return {
    pid,
    async kill() {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // ignore
      }
      return await waitForProcessExit(pid, { timeoutMs: 2_000 })
    },
  }
}

export function spawnStoppableHttpDaemon(port: number): { pid: number; kill: () => Promise<boolean> } {
  const child = spawnDetachedInlineNodeTestProcess(
    [
      'const http = require("http");',
      'const server = http.createServer((req, res) => {',
      '  if (req.method === "POST" && req.url === "/stop") {',
      '    res.writeHead(200, { "content-type": "application/json" });',
      '    res.end(JSON.stringify({ ok: true }));',
      '    setTimeout(() => process.exit(0), 10);',
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
    async kill() {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // ignore
      }
      return await waitForProcessExit(pid, { timeoutMs: 2_000 })
    },
  }
}
