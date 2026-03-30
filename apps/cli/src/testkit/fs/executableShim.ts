import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { chmodSync } from 'node:fs'
import { chmod } from 'node:fs/promises'

import { createTempDir } from './tempDir'
import { writeTextFile, writeTextFileSync } from './fileHelpers'

export type ExecutableShimOptions = Readonly<{
  dirPrefix: string
  fileName: string
  contents: string
  baseDir?: string
  mode?: number
}>

export async function createExecutableShim(options: ExecutableShimOptions): Promise<string> {
  const dirPath = await createTempDir(options.dirPrefix, options.baseDir)
  return await writeExecutableShim({
    dir: dirPath,
    fileName: options.fileName,
    contents: options.contents,
    mode: options.mode,
  })
}

export type WriteExecutableShimOptions = Readonly<{
  dir: string
  fileName: string
  contents: string
  mode?: number
}>

export async function writeExecutableShim(options: WriteExecutableShimOptions): Promise<string> {
  const filePath = join(options.dir, options.fileName)
  const mode = options.mode ?? 0o755

  await writeTextFile(filePath, options.contents, { mode })

  if (process.platform !== 'win32') {
    await chmod(filePath, mode)
  }

  return filePath
}

export function writeExecutableShimSync(options: WriteExecutableShimOptions): string {
  const filePath = join(options.dir, options.fileName)
  const mode = options.mode ?? 0o755

  writeTextFileSync(filePath, options.contents, { mode })

  if (process.platform !== 'win32') {
    chmodSync(filePath, mode)
  }

  return filePath
}

export function resolveSystemJavaScriptRuntimeBinary(pathLookup?: string): string {
  const output = process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'where bun || where node'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: pathLookup ?? process.env.PATH ?? '' },
      })
    : execFileSync('/bin/sh', ['-lc', 'command -v bun || command -v node'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: pathLookup ?? process.env.PATH ?? '' },
      })

  const [first] = String(output)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)

  if (!first) {
    throw new Error('missing JavaScript runtime binary for test')
  }

  return first
}

export async function writePnpmNodeBridge(options: Readonly<{
  dir: string
  pathLookup?: string
}>): Promise<string> {
  const runtimeBinary = resolveSystemJavaScriptRuntimeBinary(options.pathLookup)
  const fileName = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const contents = process.platform === 'win32'
    ? `@echo off\r\nif "%1"=="node" (\r\n  shift\r\n  "${runtimeBinary}" %*\r\n  exit /b %errorlevel%\r\n)\r\nexit /b 1\r\n`
    : `#!/bin/sh\nif [ "$1" = "node" ]; then\n  shift\n  exec "${runtimeBinary}" "$@"\nfi\nexit 1\n`

  return await writeExecutableShim({
    dir: options.dir,
    fileName,
    contents,
  })
}
