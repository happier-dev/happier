import { describe, expect, it, vi } from 'vitest'

import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge'

vi.mock('@/projectPath', () => ({
  projectPath: () => '/repo',
}))

vi.mock('@/mcp/startHappyServer', () => ({
  startHappyServer: vi.fn(async () => ({
    url: 'http://127.0.0.1:12345',
    stop: vi.fn(),
  })),
}))

describe('createHappierMcpBridge', () => {
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
})
