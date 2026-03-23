import { join } from 'node:path'

import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace'
import { createEnvKeyScope } from '@/testkit/env/envScope'
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir'

const TOOL_TRACE_ENV_KEYS = [
  'HAPPIER_STACK_TOOL_TRACE',
  'HAPPIER_STACK_TOOL_TRACE_FILE',
  'HAPPIER_STACK_TOOL_TRACE_DIR',
  'HAPPIER_E2E_ACP_TRACE_MARKERS',
] as const

type ToolTraceEnvKey = (typeof TOOL_TRACE_ENV_KEYS)[number]

type ToolTraceFileOptions = {
  env?: Readonly<Partial<Record<ToolTraceEnvKey, string | undefined>>>
}

export async function withToolTraceFile(
  prefix: string,
  fn: (filePath: string) => Promise<void> | void,
  options: ToolTraceFileOptions = {},
): Promise<void> {
  const dir = await createTempDir(prefix)
  const filePath = join(dir, 'tool-trace.jsonl')
  const envScope = createEnvKeyScope(TOOL_TRACE_ENV_KEYS)

  envScope.patch({
    HAPPIER_STACK_TOOL_TRACE: '1',
    HAPPIER_STACK_TOOL_TRACE_FILE: filePath,
    HAPPIER_STACK_TOOL_TRACE_DIR: undefined,
    ...options.env,
  })
  __resetToolTraceForTests()

  try {
    await fn(filePath)
  } finally {
    envScope.restore()
    __resetToolTraceForTests()
    await removeTempDir(dir)
  }
}
