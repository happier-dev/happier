import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ACP_SUBPROCESS_ENV_KEYS,
  createAcpSubprocessEnvScope,
  createAcpTestTransportHandler,
  readFileEventually,
  waitForFileToContain,
  writeAcpTestAgentScript,
} from './subprocessHarness'
import { withTempDir } from '@/testkit/fs/tempDir'

describe('ACP subprocess harness', () => {
  afterEach(() => {
    for (const key of ACP_SUBPROCESS_ENV_KEYS) {
      delete process.env[key]
    }
  })

  it('restores ACP subprocess env keys after patching', () => {
    process.env.HAPPIER_ACP_CAPTURE_IO = '0'
    const scope = createAcpSubprocessEnvScope()

    scope.patch({
      HAPPIER_ACP_CAPTURE_IO: '1',
      HAPPIER_STACK_TOOL_TRACE_FILE: '/tmp/happier.trace',
    })

    expect(process.env.HAPPIER_ACP_CAPTURE_IO).toBe('1')
    expect(process.env.HAPPIER_STACK_TOOL_TRACE_FILE).toBe('/tmp/happier.trace')

    scope.restore()

    expect(process.env.HAPPIER_ACP_CAPTURE_IO).toBe('0')
    expect(process.env.HAPPIER_STACK_TOOL_TRACE_FILE).toBeUndefined()
  })

  it('builds transport handlers with default and override ACP timings', () => {
    const transportHandler = createAcpTestTransportHandler({
      agentName: 'gemini',
      initDelayMs: 250,
      idleTimeoutMs: 50,
      postToolCallIdleTimeoutMs: 75,
      idleWithoutAssistantMessageTimeoutMs: 125,
      promptLivenessTimeoutMs: 900,
    })

    expect(transportHandler.agentName).toBe('gemini')
    expect(transportHandler.getInitTimeout()).toBe(5_000)
    expect(transportHandler.getInitDelayMs?.()).toBe(250)
    expect(transportHandler.getIdleTimeout?.()).toBe(50)
    expect(transportHandler.getPostToolCallIdleTimeoutMs?.()).toBe(75)
    expect(transportHandler.getIdleWithoutAssistantMessageTimeoutMs?.()).toBe(125)
    expect(transportHandler.getPromptLivenessTimeoutMs?.()).toBe(900)
    expect(transportHandler.getToolPatterns()).toEqual([])
  })

  it('writes ACP scripts and waits for their output files', async () => {
    await withTempDir('happier-acp-subprocess-harness-', async (dir) => {
      const scriptPath = writeAcpTestAgentScript({
        dir,
        fileName: 'fake-acp-agent.mjs',
        source: 'export {};\n',
      })
      const outputPath = join(dir, 'stdout.log')

      setTimeout(() => {
        writeFileSync(outputPath, 'hello from ACP\n', 'utf8')
      }, 25)

      expect(scriptPath).toBe(join(dir, 'fake-acp-agent.mjs'))
      await waitForFileToContain(outputPath, 'hello from ACP', { timeoutMs: 2_000, intervalMs: 10 })
      await expect(readFileEventually(outputPath, { timeoutMs: 2_000, intervalMs: 10 })).resolves.toContain(
        'hello from ACP',
      )
    })
  })
})
