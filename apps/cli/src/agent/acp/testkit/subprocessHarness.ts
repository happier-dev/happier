import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ToolPattern, TransportHandler } from '@/agent/transport/TransportHandler'
import { waitForCondition } from '@/testkit/async/waitFor'
import { createEnvKeyScope } from '@/testkit/env/envScope'

const DEFAULT_TOOL_PATTERNS: ToolPattern[] = []

export const ACP_SUBPROCESS_ENV_KEYS = [
  'HAPPIER_ACP_CAPTURE_IO',
  'HAPPIER_ACP_PROMPT_LIVENESS_TIMEOUT_MS',
  'HAPPIER_DEBUG_ARTIFACTS_DIR',
  'HAPPIER_STACK_TOOL_TRACE_FILE',
  'HAPPIER_SUBPROCESS_STDERR_MAX_BYTES',
] as const

export type AcpTestTransportHandlerOptions = {
  agentName?: string
  initTimeoutMs?: number
  initDelayMs?: number
  idleTimeoutMs?: number
  postToolCallIdleTimeoutMs?: number
  idleWithoutAssistantMessageTimeoutMs?: number
  preToolCallIdleTimeoutMs?: number
  postPromptNoUpdatesTimeoutMs?: number
  promptLivenessTimeoutMs?: number
  toolPatterns?: ToolPattern[]
  filterStdoutLine?: TransportHandler['filterStdoutLine']
  handleStderr?: TransportHandler['handleStderr']
  isInvestigationTool?: TransportHandler['isInvestigationTool']
  getToolCallTimeout?: TransportHandler['getToolCallTimeout']
  extractToolNameFromId?: TransportHandler['extractToolNameFromId']
  determineToolName?: TransportHandler['determineToolName']
}

export function createAcpSubprocessEnvScope(): ReturnType<typeof createEnvKeyScope> {
  return createEnvKeyScope(ACP_SUBPROCESS_ENV_KEYS)
}

export function createAcpTestTransportHandler(
  options: AcpTestTransportHandlerOptions = {},
): TransportHandler {
  const transportHandler: TransportHandler = {
    agentName: options.agentName ?? 'test',
    getInitTimeout: () => options.initTimeoutMs ?? 5_000,
    getToolPatterns: () => options.toolPatterns ?? DEFAULT_TOOL_PATTERNS,
  }

  if (options.initDelayMs !== undefined) {
    const initDelayMs = options.initDelayMs
    transportHandler.getInitDelayMs = () => initDelayMs
  }
  if (options.idleTimeoutMs !== undefined) {
    const idleTimeoutMs = options.idleTimeoutMs
    transportHandler.getIdleTimeout = () => idleTimeoutMs
  }
  if (options.postToolCallIdleTimeoutMs !== undefined) {
    const postToolCallIdleTimeoutMs = options.postToolCallIdleTimeoutMs
    transportHandler.getPostToolCallIdleTimeoutMs = () => postToolCallIdleTimeoutMs
  }
  if (options.idleWithoutAssistantMessageTimeoutMs !== undefined) {
    const idleWithoutAssistantMessageTimeoutMs = options.idleWithoutAssistantMessageTimeoutMs
    transportHandler.getIdleWithoutAssistantMessageTimeoutMs = () => idleWithoutAssistantMessageTimeoutMs
  }
  if (options.preToolCallIdleTimeoutMs !== undefined) {
    const preToolCallIdleTimeoutMs = options.preToolCallIdleTimeoutMs
    transportHandler.getPreToolCallIdleTimeoutMs = () => preToolCallIdleTimeoutMs
  }
  if (options.postPromptNoUpdatesTimeoutMs !== undefined) {
    const postPromptNoUpdatesTimeoutMs = options.postPromptNoUpdatesTimeoutMs
    transportHandler.getPostPromptNoUpdatesTimeoutMs = () => postPromptNoUpdatesTimeoutMs
  }
  if (options.promptLivenessTimeoutMs !== undefined) {
    const promptLivenessTimeoutMs = options.promptLivenessTimeoutMs
    transportHandler.getPromptLivenessTimeoutMs = () => promptLivenessTimeoutMs
  }
  if (options.filterStdoutLine) {
    transportHandler.filterStdoutLine = options.filterStdoutLine
  }
  if (options.handleStderr) {
    transportHandler.handleStderr = options.handleStderr
  }
  if (options.isInvestigationTool) {
    transportHandler.isInvestigationTool = options.isInvestigationTool
  }
  if (options.getToolCallTimeout) {
    transportHandler.getToolCallTimeout = options.getToolCallTimeout
  }
  if (options.extractToolNameFromId) {
    transportHandler.extractToolNameFromId = options.extractToolNameFromId
  }
  if (options.determineToolName) {
    transportHandler.determineToolName = options.determineToolName
  }

  return transportHandler
}

export function writeAcpTestAgentScript(params: {
  dir: string
  fileName: string
  source: string
}): string {
  const scriptPath = join(params.dir, params.fileName)
  writeFileSync(scriptPath, params.source, 'utf8')
  return scriptPath
}

export async function waitForAcpArtifactsFile(
  dir: string,
  opts: {
    timeoutMs: number
    fileNameIncludes?: string
  },
): Promise<string> {
  let matchedPath: string | undefined

  await waitForCondition(
    () => {
      const entries = readdirSync(dir, { withFileTypes: true })
      const matchedEntry = entries.find(
        (entry) =>
          entry.isFile()
          && entry.name.endsWith('.log')
          && entry.name.includes(opts.fileNameIncludes ?? 'stderr'),
      )
      if (!matchedEntry) return false
      matchedPath = join(dir, matchedEntry.name)
      return true
    },
    {
      timeoutMs: opts.timeoutMs,
      intervalMs: 25,
      label: `ACP artifacts file in ${dir}`,
    },
  )

  return matchedPath!
}

export async function readFileEventually(
  filePath: string,
  opts: {
    timeoutMs: number
    intervalMs?: number
  },
): Promise<string> {
  let content = ''

  await waitForCondition(
    () => {
      try {
        content = readFileSync(filePath, 'utf8')
        return true
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false
        }
        throw error
      }
    },
    {
      timeoutMs: opts.timeoutMs,
      intervalMs: opts.intervalMs ?? 25,
      label: `file ${filePath}`,
    },
  )

  return content
}

export async function waitForFileToContain(
  filePath: string,
  needle: string,
  opts: {
    timeoutMs: number
    intervalMs?: number
  },
): Promise<void> {
  let content = ''

  await waitForCondition(
    () => {
      try {
        content = readFileSync(filePath, 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false
        }
        throw error
      }
      return content.includes(needle)
    },
    {
      timeoutMs: opts.timeoutMs,
      intervalMs: opts.intervalMs ?? 25,
      label: `${filePath} to contain ${JSON.stringify(needle)}`,
      debug: () => `Current content length: ${content.length}`,
    },
  )
}
