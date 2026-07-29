import { existsSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge'

const { requireJavaScriptRuntimeExecutableMock } = vi.hoisted(() => ({
  requireJavaScriptRuntimeExecutableMock: vi.fn(async (): Promise<string> => process.execPath),
}))
const { startHappyServerMock } = vi.hoisted(() => ({
  startHappyServerMock: vi.fn(async () => ({
    url: 'http://127.0.0.1:12345',
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

vi.mock('@/projectPath', () => ({
  projectPath: () => '/repo',
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
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

describe('createHappierMcpBridge', () => {
  beforeEach(() => {
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1
    vi.mocked(existsSync).mockReset()
    vi.mocked(existsSync).mockReturnValue(false)
    requireJavaScriptRuntimeExecutableMock.mockReset()
    requireJavaScriptRuntimeExecutableMock.mockResolvedValue(process.execPath)
    startHappyServerMock.mockReset()
    startHappyServerMock.mockResolvedValue({
      url: 'http://127.0.0.1:12345',
      stop: vi.fn(),
    })
  })

  afterAll(() => {
    if (originalActionSettingsEnv === undefined) {
      delete process.env.HAPPIER_ACTIONS_SETTINGS_V1
    } else {
      process.env.HAPPIER_ACTIONS_SETTINGS_V1 = originalActionSettingsEnv
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
        '/repo/package-dist/mcp/bridges/happierMcpStdioBridge.mjs',
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
        '/repo/package-dist/mcp/bridges/happierMcpStdioBridge.mjs',
        '--url',
        'http://127.0.0.1:12345',
      ],
    })
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

    expect(startHappyServerMock).toHaveBeenCalledWith(session, {
      credentials: null,
      accountSettings,
      getAccountSettings: null,
    })
    expect(mcpServers.happier.env).toEqual({
      HAPPIER_ACTIONS_SETTINGS_V1: JSON.stringify(accountSettings.actionsSettingsV1),
    })
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
          '--import',
          '/repo/node_modules/tsx/dist/esm/index.mjs',
          '/repo/src/mcp/bridges/happierMcpStdioBridge.ts',
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
        '--import',
        '/repo/node_modules/tsx/dist/esm/index.mjs',
        '/repo/src/mcp/bridges/happierMcpStdioBridge.ts',
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
        '/repo/package-dist/mcp/bridges/happierMcpStdioBridge.mjs',
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

    expect(startHappyServerMock).toHaveBeenCalledWith(session, {
      credentials,
      accountSettings: null,
      getAccountSettings: null,
    })
  })
})
