import { mkdtemp, rm } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export async function createTempDir(prefix: string, baseDir = tmpdir()): Promise<string> {
  return await mkdtemp(join(baseDir, prefix))
}

export function createTempDirSync(prefix: string, baseDir = tmpdir()): string {
  return mkdtempSync(join(baseDir, prefix))
}

export async function removeTempDir(dirPath: string): Promise<void> {
  await rm(dirPath, { recursive: true, force: true })
}

export function removeTempDirSync(dirPath: string): void {
  rmSync(dirPath, { recursive: true, force: true })
}

export async function withTempDir<T>(
  prefix: string,
  fn: (dirPath: string) => Promise<T> | T,
  baseDir = tmpdir(),
): Promise<T> {
  const dirPath = await createTempDir(prefix, baseDir)
  try {
    return await fn(dirPath)
  } finally {
    await removeTempDir(dirPath)
  }
}

export function withTempDirSync<T>(
  prefix: string,
  fn: (dirPath: string) => T,
  baseDir = tmpdir(),
): T {
  const dirPath = createTempDirSync(prefix, baseDir)
  try {
    return fn(dirPath)
  } finally {
    removeTempDirSync(dirPath)
  }
}
