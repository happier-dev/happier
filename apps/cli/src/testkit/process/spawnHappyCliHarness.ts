import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createEnvKeyScope } from '@/testkit/env/envScope'
import { withTempDir } from '@/testkit/fs/tempDir'

const SPAWN_HAPPY_CLI_ENV_KEYS = [
  'HAPPIER_CLI_SUBPROCESS_RUNTIME',
  'HAPPIER_CLI_SUBPROCESS_ENTRYPOINT',
  'HAPPIER_MANAGED_NODE_BIN',
  'HAPPIER_VARIANT',
  'HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK',
  'HAPPIER_CLI_SUBPROCESS_PREFER_TSX',
  'HAPPIER_WINDOWS_SESSION_RUNNER_BINARY',
  'HAPPIER_STACK_REPO_DIR',
  'HAPPIER_STACK_CLI_ROOT_DIR',
  'HAPPIER_STACK_STACK',
  'TSX_TSCONFIG_PATH',
] as const

export function createSpawnHappyCliEnvScope() {
  return createEnvKeyScope(SPAWN_HAPPY_CLI_ENV_KEYS)
}

export async function withTempHappyCliEntrypoint<T>(
  fn: (entrypoint: string) => Promise<T> | T,
  prefix = 'happier-cli-entrypoint-',
): Promise<T> {
  return await withTempDir(prefix, async (dir) => {
    const entrypoint = join(dir, 'index.mjs')
    writeFileSync(entrypoint, 'export {};\n', 'utf8')
    return await fn(entrypoint)
  })
}
