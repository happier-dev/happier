import { existsSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge'

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
  })

  it('uses direct script mode by default', async () => {
    const session = {} as any
    const { mcpServers } = await createHappierMcpBridge(session)

    expect(mcpServers.happier).toEqual({
      command: '/repo/bin/happier-mcp.mjs',
      args: ['--url', 'http://127.0.0.1:12345'],
    })
  })

  it('supports current-process mode', async () => {
    const session = {} as any
    const { mcpServers } = await createHappierMcpBridge(session, { commandMode: 'current-process' })

    expect(mcpServers.happier).toEqual({
      command: process.execPath,
      args: ['/repo/bin/happier-mcp.mjs', '--url', 'http://127.0.0.1:12345'],
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
})
