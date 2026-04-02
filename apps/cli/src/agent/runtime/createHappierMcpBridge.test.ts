import { existsSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'

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

vi.mock('@/runtime/js/requireJavaScriptRuntimeExecutable', () => ({
  requireJavaScriptRuntimeExecutable: requireJavaScriptRuntimeExecutableMock,
}))

vi.mock('@/mcp/startHappyServer', () => ({
  startHappyServer: startHappyServerMock,
}))

describe('createHappierMcpBridge', () => {
  beforeEach(() => {
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

  it('uses direct script mode by default', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike)
      return path.endsWith('/package-dist/backends/codex/happyMcpStdioBridge.mjs')
    })

    const session = {} as any
    const { mcpServers } = await createHappierMcpBridge(session)

    expect(mcpServers.happier).toEqual({
      command: process.execPath,
      args: [
        '--no-warnings',
        '--no-deprecation',
        '/repo/package-dist/backends/codex/happyMcpStdioBridge.mjs',
        '--url',
        'http://127.0.0.1:12345',
      ],
    })
  })

  it('supports current-process mode', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike)
      return path.endsWith('/package-dist/backends/codex/happyMcpStdioBridge.mjs')
    })

    const session = {} as any
    const { mcpServers } = await createHappierMcpBridge(session, { commandMode: 'current-process' })

    expect(mcpServers.happier).toEqual({
      command: process.execPath,
      args: [
        '--no-warnings',
        '--no-deprecation',
        '/repo/package-dist/backends/codex/happyMcpStdioBridge.mjs',
        '--url',
        'http://127.0.0.1:12345',
      ],
    })
  })

  it('prefers the source entrypoint when the CLI source-entrypoint e2e flag is enabled', async () => {
    const previousFlag = process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT
    process.env.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT = '1'
    try {
      vi.mocked(existsSync).mockImplementation((pathLike) => {
        const path = String(pathLike)
        if (path.endsWith('/package-dist/backends/codex/happyMcpStdioBridge.mjs')) return true
        if (path.endsWith('/src/backends/codex/happyMcpStdioBridge.ts')) return true
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
          '/repo/src/backends/codex/happyMcpStdioBridge.ts',
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
      if (path.endsWith('/dist/backends/codex/happyMcpStdioBridge.mjs')) return false
      if (path.endsWith('/src/backends/codex/happyMcpStdioBridge.ts')) return true
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
        '/repo/src/backends/codex/happyMcpStdioBridge.ts',
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
      return path.endsWith('/package-dist/backends/codex/happyMcpStdioBridge.mjs')
    })

    const session = {} as any
    const { mcpServers } = await createHappierMcpBridge(session)

    expect(mcpServers.happier).toEqual({
      command: '/managed/js-runtime',
      args: [
        '--no-warnings',
        '--no-deprecation',
        '/repo/package-dist/backends/codex/happyMcpStdioBridge.mjs',
        '--url',
        'http://127.0.0.1:12345',
      ],
    })
  })

  it('fails closed when the bundled bridge script cannot resolve a JavaScript runtime', async () => {
    requireJavaScriptRuntimeExecutableMock.mockRejectedValue(new ReferenceError('Set HAPPIER_JS_RUNTIME_PATH'))
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike)
      if (path.endsWith('/dist/backends/codex/happyMcpStdioBridge.mjs')) return true
      return false
    })

    const session = {} as any

    await expect(createHappierMcpBridge(session)).rejects.toThrow(/HAPPIER_JS_RUNTIME_PATH/)
  })

  it('forwards credentials to the in-session Happier MCP server when provided', async () => {
    vi.mocked(existsSync).mockImplementation((pathLike) => {
      const path = String(pathLike)
      return path.endsWith('/package-dist/backends/codex/happyMcpStdioBridge.mjs')
    })

    const session = {} as any
    const credentials = {
      token: 'token_1',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
    }

    await createHappierMcpBridge(session, { credentials })

    expect(startHappyServerMock).toHaveBeenCalledWith(session, { credentials })
  })
})
