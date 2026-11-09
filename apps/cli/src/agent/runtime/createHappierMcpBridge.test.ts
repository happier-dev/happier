import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge'
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers'
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer'
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol'
import { buildCodexAppServerConfigOverrides } from '@happier-dev/plugins-codex/agent/runtime/appServer/config/overrides'
import { projectPath } from '@/projectPath'
import { createApiSessionClientFixture, createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures'
import { createEnvKeyScope } from '@/testkit/env/envScope'

const cliProjectRoot = projectPath()

const { requireJavaScriptRuntimeExecutableMock } = vi.hoisted(() => ({
  requireJavaScriptRuntimeExecutableMock: vi.fn(async (): Promise<string> => process.execPath),
}))
const { startHappyServerMock } = vi.hoisted(() => ({
  startHappyServerMock: vi.fn(async (_session: HappyMcpSessionClient) => ({
    url: 'http://127.0.0.1:12345',
    supportedSessionReadActions: [],
    readToolNames: async () => [],
    stop: vi.fn(),
  })),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  }
})

vi.mock('@/utils/spawnHappyCLI', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/spawnHappyCLI')>(),
  resolveTsxImportHookPath: vi.fn(() => '/repo/node_modules/tsx/dist/esm/index.mjs'),
  resolveCliTsxTsconfigPath: vi.fn(() => '/repo/tsconfig.json'),
}))

vi.mock('@/packagedRuntime/js/requireJavaScriptRuntimeExecutable', () => ({
  requireJavaScriptRuntimeExecutable: requireJavaScriptRuntimeExecutableMock,
}))

vi.mock('@/mcp/startHappyServer', () => ({
  startHappyServer: startHappyServerMock,
}))

const originalActionSettingsEnv = process.env.HAPPIER_ACTIONS_SETTINGS_V1
const toolEnvironmentScope = createEnvKeyScope(['AGENT_BROWSER_IDLE_TIMEOUT_MS', 'PRIVATE_BRIDGE_ENV'])

describe('createHappierMcpBridge', () => {
  it('omits native built-in tools after the Session opt-out', async () => {
    vi.mocked(existsSync).mockImplementation(pathLike => String(pathLike).endsWith('/package-dist/mcp/bridges/happierMcpStdioBridge.mjs'))
    const session = createMutableApiSessionClientFixture({ metadata: { mcpSelectionV1: {
      v: 1, managedServersEnabled: false, happierToolsEnabled: false,
      forceIncludeServerIds: [], forceExcludeServerIds: [],
    } } })
    const bridge = await createHappierMcpBridge(session)
    expect(bridge.mcpServers).toEqual({})
    expect(startHappyServerMock).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1
    toolEnvironmentScope.patch({ AGENT_BROWSER_IDLE_TIMEOUT_MS: undefined, PRIVATE_BRIDGE_ENV: undefined })
    vi.mocked(existsSync).mockReset()
    vi.mocked(existsSync).mockReturnValue(false)
    requireJavaScriptRuntimeExecutableMock.mockReset()
    requireJavaScriptRuntimeExecutableMock.mockResolvedValue(process.execPath)
    startHappyServerMock.mockReset()
    startHappyServerMock.mockResolvedValue({
      url: 'http://127.0.0.1:12345',
      supportedSessionReadActions: [],
      readToolNames: async () => [],
      stop: vi.fn(),
    })
  })

  afterAll(() => {
    toolEnvironmentScope.restore()
    if (originalActionSettingsEnv === undefined) {
      delete process.env.HAPPIER_ACTIONS_SETTINGS_V1
    } else {
      process.env.HAPPIER_ACTIONS_SETTINGS_V1 = originalActionSettingsEnv
    }
  })

  it.each([
    ['default', '300000'],
    ['custom', '420000'],
    ['authored override', '900000'],
    ['authored empty value', ''],
    ['Off', undefined],
  ] as const)('carries the captured %s tool idle value into the native MCP launch config', async (_label, value) => {
    toolEnvironmentScope.patch({ AGENT_BROWSER_IDLE_TIMEOUT_MS: value, PRIVATE_BRIDGE_ENV: 'must-not-leak' })
    vi.mocked(existsSync).mockImplementation(pathLike => (
      String(pathLike).endsWith('/package-dist/mcp/bridges/happierMcpStdioBridge.mjs')
    ))

    const { mcpServers } = await createHappierMcpBridge(createApiSessionClientFixture())
    const overrides = buildCodexAppServerConfigOverrides(mcpServers)
    if (value === undefined) {
      expect(mcpServers.happier.env).toBeUndefined()
      expect(overrides.some(override => override.startsWith('mcp_servers.happier.env='))).toBe(false)
    } else {
      expect(mcpServers.happier.env).toEqual({ AGENT_BROWSER_IDLE_TIMEOUT_MS: value })
      expect(overrides).toContain(`mcp_servers.happier.env={AGENT_BROWSER_IDLE_TIMEOUT_MS=${JSON.stringify(value)}}`)
    }
    expect(overrides.join('\n')).not.toContain('PRIVATE_BRIDGE_ENV')
  })

  it('preserves source runtime and Action settings alongside captured tool idle values', async () => {
    toolEnvironmentScope.patch({ AGENT_BROWSER_IDLE_TIMEOUT_MS: '420000' })
    vi.mocked(existsSync).mockImplementation(pathLike => (
      String(pathLike).endsWith('/src/mcp/bridges/happierMcpStdioBridge.ts')
    ))
    const actionsSettingsProvider = { getActionsSettings: () => normalizeActionsSettingsV1({
      v: 1, actions: { 'session.list': { enabled: false } },
    }) }
    const { mcpServers } = await createHappierMcpBridge(createApiSessionClientFixture(), { actionsSettingsProvider })
    expect(mcpServers.happier.env).toEqual({
      AGENT_BROWSER_IDLE_TIMEOUT_MS: '420000',
      TSX_TSCONFIG_PATH: '/repo/tsconfig.json',
      HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify(actionsSettingsProvider.getActionsSettings()),
    })
  })

  it('binds the Run absolute depth without borrowing its parent Session depth', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => (
      String(pathLike).endsWith('/package-dist/mcp/bridges/happierMcpStdioBridge.mjs')
    ))
    const sessionClient = createMutableApiSessionClientFixture({
      sessionId: 'session-a',
      serverBinding: { serverId: 'home-a', serverUrl: 'https://home-a.test' },
      overrides: { enqueueSessionEventCommitted: createApiSessionClientFixture().enqueueSessionEventCommitted },
    })
    const session = Object.assign(sessionClient, {
      getWorkDepth: () => 1,
    }) satisfies HappyMcpSessionClient
    const binding = await resolveRunnerMcpServers({
      session,
      credentials: { token: 'plain-token', encryption: null },
      accountSettings: null,
      machineId: 'machine-a',
      directory: '/repo',
      env: {},
      executionRun: {
        runId: 'run-a',
        workDepth: 4,
        cwd: '/run',
        signal: new AbortController().signal,
        isCurrent: () => true,
        readActiveTurnAdmissionWitness: () => null,
        readCurrentRunOccurrence: () => null,
      },
    })
    try {
      const boundClient = startHappyServerMock.mock.calls.at(-1)?.[0]
      expect(boundClient?.getWorkDepth?.()).toBe(4)
      expect(session.getWorkDepth()).toBe(1)
    } finally {
      binding.happierMcpServer.stop()
      await sessionClient.close()
    }
  })

  it('uses direct script mode by default', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike)
      return path.endsWith('/package-dist/mcp/bridges/happierMcpStdioBridge.mjs')
    })

    const session = {} as any
    const { mcpServers } = await createHappierMcpBridge(session)

    expect(mcpServers.happier).toEqual({
      command: process.execPath,
      args: [
        '--no-warnings',
        '--no-deprecation',
        join(cliProjectRoot, 'package-dist', 'mcp', 'bridges', 'happierMcpStdioBridge.mjs'),
        '--url',
        'http://127.0.0.1:12345',
      ],
    })
  })

  it('supports current-process mode', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike)
      return path.endsWith('/package-dist/mcp/bridges/happierMcpStdioBridge.mjs')
    })

    const session = {} as any
    const { mcpServers } = await createHappierMcpBridge(session, { commandMode: 'current-process' })

    expect(mcpServers.happier).toEqual({
      command: process.execPath,
      args: [
        '--no-warnings',
        '--no-deprecation',
        join(cliProjectRoot, 'package-dist', 'mcp', 'bridges', 'happierMcpStdioBridge.mjs'),
        '--url',
        'http://127.0.0.1:12345',
      ],
    })
  })

  it('retains the existing loopback URL launcher for non-isolated Windows Sessions', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    vi.mocked(existsSync).mockImplementation(pathLike => (
      String(pathLike).endsWith('/package-dist/mcp/bridges/happierMcpStdioBridge.mjs')
    ))
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      const session = createApiSessionClientFixture()
      const { mcpServers } = await createHappierMcpBridge(session)
      expect(mcpServers.happier.args?.slice(-2)).toEqual(['--url', 'http://127.0.0.1:12345'])
      expect(mcpServers.happier.env).toBeUndefined()
      expect(startHappyServerMock).toHaveBeenCalledWith(session,
        expect.not.objectContaining({ localTransport: expect.anything() }))
    } finally { Object.defineProperty(process, 'platform', platform) }
  })

  it('passes the action settings snapshot to the bridge stdio process', async () => {
    const previousActionSettings = process.env.HAPPIER_ACTIONS_SETTINGS_V1
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'session.list': { disabledSurfaces: [] },
      },
    })

    try {
      vi.mocked(existsSync).mockImplementation((pathLike) => {
        const path = String(pathLike)
        return path.endsWith('/package-dist/mcp/bridges/happierMcpStdioBridge.mjs')
      })

      const session = {} as any
      const { mcpServers } = await createHappierMcpBridge(session)

      expect(mcpServers.happier.env).toEqual({
        HAPPIER_ACTIONS_SETTINGS_V1: process.env.HAPPIER_ACTIONS_SETTINGS_V1,
      })
    } finally {
      if (previousActionSettings === undefined) {
        delete process.env.HAPPIER_ACTIONS_SETTINGS_V1
      } else {
        process.env.HAPPIER_ACTIONS_SETTINGS_V1 = previousActionSettings
      }
    }
  })

  it('passes account action settings to the in-session server and bridge stdio process', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike)
      return path.endsWith('/package-dist/mcp/bridges/happierMcpStdioBridge.mjs')
    })

    const session = {} as any
    const accountSettings = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.list': { disabledSurfaces: [] },
        },
      },
    } as any

    const { mcpServers } = await createHappierMcpBridge(session, { accountSettings })

    expect(startHappyServerMock).toHaveBeenCalledWith(session, expect.objectContaining({
      credentials: null,
      sessionCredentials: null,
      authorityScope: 'account',
      accountSettings,
      getAccountSettings: null,
    }))
    expect(mcpServers.happier.env).toEqual({
      HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify(accountSettings.actionsSettingsV1),
    })
  })

  it('uses the explicit scoped Action policy for stdio discovery instead of ambient settings', async () => {
    const ambient = process.env.HAPPIER_ACTIONS_SETTINGS_V1
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: { 'session.list': { enabled: true } },
    })
    try {
      vi.mocked(existsSync).mockImplementation((pathLike) => (
        String(pathLike).endsWith('/package-dist/mcp/bridges/happierMcpStdioBridge.mjs')
      ))
      const scoped = normalizeActionsSettingsV1({
        v: 1,
        actions: { 'session.list': { enabled: false } },
      })
      const actionsSettingsProvider = Object.freeze({
        getActionsSettings: () => scoped,
      })

      const { mcpServers } = await createHappierMcpBridge({} as any, {
        actionsSettingsProvider,
      })

      expect(mcpServers.happier.env).toEqual({
        HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify(scoped),
      })
    } finally {
      if (ambient === undefined) delete process.env.HAPPIER_ACTIONS_SETTINGS_V1
      else process.env.HAPPIER_ACTIONS_SETTINGS_V1 = ambient
    }
  })

  it('prefers the source entrypoint when the CLI source-entrypoint e2e flag is enabled', async () => {
    const previousFlag = process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT
    process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT = '1'
    try {
      vi.mocked(existsSync).mockImplementation((pathLike) => {
        const path = String(pathLike)
        if (path.endsWith('/package-dist/mcp/bridges/happierMcpStdioBridge.mjs')) return true
        if (path.endsWith('/src/mcp/bridges/happierMcpStdioBridge.ts')) return true
        return false
      })

      const session = {} as any
      const { mcpServers } = await createHappierMcpBridge(session)

      expect(mcpServers.happier).toEqual({
        command: process.execPath,
        args: [
          '--no-warnings',
          '--no-deprecation',
          '--conditions=happier-source',
          '--import',
          expect.stringMatching(/registerSourceRuntime\.mjs$/),
          join(cliProjectRoot, 'src', 'mcp', 'bridges', 'happierMcpStdioBridge.ts'),
          '--url',
          'http://127.0.0.1:12345',
        ],
        env: { TSX_TSCONFIG_PATH: '/repo/tsconfig.json' },
      })
    } finally {
      if (previousFlag === undefined) {
        delete process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT
      } else {
        process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT = previousFlag
      }
    }
  })

  it('falls back to TSX source entrypoint when dist bridge is unavailable', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike)
      if (path.endsWith('/dist/mcp/bridges/happierMcpStdioBridge.mjs')) return false
      if (path.endsWith('/src/mcp/bridges/happierMcpStdioBridge.ts')) return true
      return false
    })

    const session = {} as any
    const { mcpServers } = await createHappierMcpBridge(session)

    expect(mcpServers.happier).toEqual({
      command: process.execPath,
      args: [
        '--no-warnings',
        '--no-deprecation',
        '--conditions=happier-source',
        '--import',
        expect.stringMatching(/registerSourceRuntime\.mjs$/),
        join(cliProjectRoot, 'src', 'mcp', 'bridges', 'happierMcpStdioBridge.ts'),
        '--url',
        'http://127.0.0.1:12345',
      ],
      env: { TSX_TSCONFIG_PATH: '/repo/tsconfig.json' },
    })
  })

  it('uses the ensured JavaScript runtime for the bundled dist bridge when direct script mode runs under bun', async () => {
    requireJavaScriptRuntimeExecutableMock.mockResolvedValue('/managed/js-runtime')
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike)
      return path.endsWith('/package-dist/mcp/bridges/happierMcpStdioBridge.mjs')
    })

    const session = {} as any
    const { mcpServers } = await createHappierMcpBridge(session)

    expect(mcpServers.happier).toEqual({
      command: '/managed/js-runtime',
      args: [
        '--no-warnings',
        '--no-deprecation',
        join(cliProjectRoot, 'package-dist', 'mcp', 'bridges', 'happierMcpStdioBridge.mjs'),
        '--url',
        'http://127.0.0.1:12345',
      ],
    })
  })

  it('fails closed when the bundled bridge script cannot resolve a JavaScript runtime', async () => {
    requireJavaScriptRuntimeExecutableMock.mockRejectedValue(new ReferenceError('Set HAPPIER_JS_RUNTIME_PATH'))
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike)
      if (path.endsWith('/dist/mcp/bridges/happierMcpStdioBridge.mjs')) return true
      return false
    })

    const session = {} as any

    await expect(createHappierMcpBridge(session)).rejects.toThrow(/HAPPIER_JS_RUNTIME_PATH/)
  })

  it('forwards credentials to the in-session Happier MCP server when provided', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike)
      return path.endsWith('/package-dist/mcp/bridges/happierMcpStdioBridge.mjs')
    })

    const session = {} as any
    const credentials = {
      token: 'token_1',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
    }

    await createHappierMcpBridge(session, { credentials })

    expect(startHappyServerMock).toHaveBeenCalledWith(session, expect.objectContaining({
      credentials,
      sessionCredentials: credentials,
      authorityScope: 'account',
      accountSettings: null,
      getAccountSettings: null,
    }))
  })
})
