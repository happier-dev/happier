import { existsSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge'

const { requireJavaScriptRuntimeExecutableMock } = vi.hoisted(() => ({
  requireJavaScriptRuntimeExecutableMock: vi.fn(async (): Promise<string> => process.execPath),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
}))

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
  startHappyServer: vi.fn(async () => ({
    url: 'http://127.0.0.1:12345',
    stop: vi.fn(),
  })),
}))

describe('createHappierMcpBridge', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset()
    vi.mocked(existsSync).mockReturnValue(false)
    requireJavaScriptRuntimeExecutableMock.mockReset()
    requireJavaScriptRuntimeExecutableMock.mockResolvedValue(process.execPath)
  })

  it('uses direct script mode by default', async () => {
    const session = {} as any
    const { mcpServers } = await createHappierMcpBridge(session)

    expect(mcpServers.happier).toEqual({
      command: process.execPath,
      args: [
        '--no-warnings',
        '--no-deprecation',
        '/repo/dist/backends/codex/happyMcpStdioBridge.mjs',
        '--url',
        'http://127.0.0.1:12345',
      ],
    })
  })

  it('supports current-process mode', async () => {
    const session = {} as any
    const { mcpServers } = await createHappierMcpBridge(session, { commandMode: 'current-process' })

    expect(mcpServers.happier).toEqual({
      command: process.execPath,
      args: [
        '--no-warnings',
        '--no-deprecation',
        '/repo/dist/backends/codex/happyMcpStdioBridge.mjs',
        '--url',
        'http://127.0.0.1:12345',
      ],
    })
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

    const session = {} as any
    const { mcpServers } = await createHappierMcpBridge(session)

    expect(mcpServers.happier).toEqual({
      command: '/managed/js-runtime',
      args: [
        '--no-warnings',
        '--no-deprecation',
        '/repo/dist/backends/codex/happyMcpStdioBridge.mjs',
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
})
