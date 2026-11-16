import { existsSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHappierMcpBridge } from '@/agent/runtime/createHappierMcpBridge'
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers'
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer'
import { buildCodexAppServerConfigOverrides } from '@happier-dev/plugins-codex/agent/runtime/appServer/config/overrides'
import { createApiSessionClientFixture, createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures'
import { createEnvKeyScope } from '@/testkit/env/envScope'

const BEARER = 'b'.repeat(43)
function liveServer() {
  return {
    url: 'http://localhost/mcp',
    localContext: { v: 1 as const, socketPath: '/run/happier-mcp-x/mcp.sock', bearerToken: BEARER },
    contextFilePath: '/run/happier-mcp-x/session-mcp.json' as string | undefined,
    supportedSessionReadActions: [],
    readToolNames: async () => [],
    stop: vi.fn(async () => undefined),
  }
}
const { startHappyServerMock } = vi.hoisted(() => ({
  startHappyServerMock: vi.fn(async (_session: HappyMcpSessionClient): Promise<unknown> => undefined),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  }
})

vi.mock('@/mcp/startHappyServer', () => ({
  startHappyServer: startHappyServerMock,
}))

const originalActionSettingsEnv = process.env.HAPPIER_ACTIONS_SETTINGS_V1
const toolEnvironmentScope = createEnvKeyScope(['AGENT_BROWSER_IDLE_TIMEOUT_MS', 'PRIVATE_BRIDGE_ENV'])

describe('createHappierMcpBridge', () => {
  it('omits native built-in tools after the Session opt-out', async () => {
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
    // The shipped holder is present (filesystem boundary); nothing else is.
    vi.mocked(existsSync).mockImplementation(pathLike => /happier-session-holder\./u.test(String(pathLike)))
    startHappyServerMock.mockReset()
    startHappyServerMock.mockResolvedValue(liveServer())
  })

  afterAll(() => {
    toolEnvironmentScope.restore()
    if (originalActionSettingsEnv === undefined) {
      delete process.env.HAPPIER_ACTIONS_SETTINGS_V1
    } else {
      process.env.HAPPIER_ACTIONS_SETTINGS_V1 = originalActionSettingsEnv
    }
  })

  it('binds the Run absolute depth without borrowing its parent Session depth', async () => {
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
      accountCredentials: null,
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

  it('passes account action settings to the in-session server only', async () => {
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
    // The relay reads only its context; Action policy stays in the in-session server.
    expect(mcpServers.happier.env).toEqual({ HAPPIER_SESSION_MCP_CONTEXT_FILE: '/run/happier-mcp-x/session-mcp.json',
      HAPPIER_SESSION_MCP_BEARER: BEARER })
  })

  it('launches the shipped holder relay with its private context path and registration bearer', async () => {
    toolEnvironmentScope.patch({ AGENT_BROWSER_IDLE_TIMEOUT_MS: '420000', PRIVATE_BRIDGE_ENV: 'must-not-leak' })
    const { mcpServers } = await createHappierMcpBridge(createApiSessionClientFixture())
    expect(mcpServers.happier).toEqual({
      command: expect.stringMatching(/happier-session-holder\.[a-z0-9]+-[a-z0-9]+(\.exe)?$/u),
      args: ['mcp-relay'],
      env: { HAPPIER_SESSION_MCP_CONTEXT_FILE: '/run/happier-mcp-x/session-mcp.json', HAPPIER_SESSION_MCP_BEARER: BEARER },
    })
    const overrides = buildCodexAppServerConfigOverrides(mcpServers).join('\n')
    expect(overrides).toContain('mcp-relay')
    expect(overrides).not.toContain('PRIVATE_BRIDGE_ENV')
    expect(overrides).toContain(BEARER)
  })

  it('gives the Windows loopback relay its bearer only in its MCP client config', async () => {
    startHappyServerMock.mockResolvedValue({ ...liveServer(),
      localContext: { v: 1 as const, url: 'http://127.0.0.1:4567', bearerToken: BEARER } })
    const { mcpServers } = await createHappierMcpBridge(createApiSessionClientFixture())
    expect(mcpServers.happier.env).toEqual({ HAPPIER_SESSION_MCP_CONTEXT_FILE: '/run/happier-mcp-x/session-mcp.json',
      HAPPIER_SESSION_MCP_BEARER: BEARER })
  })

  it('leaves an isolated Agent\'s context path to its launch materialization', async () => {
    startHappyServerMock.mockResolvedValue({ ...liveServer(), contextFilePath: undefined })
    const { mcpServers } = await createHappierMcpBridge(createApiSessionClientFixture())
    expect(mcpServers.happier).toEqual({ command: expect.stringMatching(/happier-session-holder/u), args: ['mcp-relay'],
      env: { HAPPIER_SESSION_MCP_BEARER: BEARER } })
  })

  it('refuses a launch without the shipped holder and stops the server', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const server = liveServer()
    startHappyServerMock.mockResolvedValue(server)
    await expect(createHappierMcpBridge(createApiSessionClientFixture())).rejects.toMatchObject({ code: 'session_holder_unavailable' })
    expect(server.stop).toHaveBeenCalled()
  })

  it('forwards credentials to the in-session Happier MCP server when provided', async () => {
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
