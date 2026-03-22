import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export async function ensureDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

export function ensureDirectorySync(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

export async function writeTextFile(
  filePath: string,
  contents: string,
  options: { mode?: number } = {},
): Promise<void> {
  await ensureDirectory(dirname(filePath))
  await writeFile(filePath, contents, {
    mode: options.mode,
    encoding: 'utf8',
  })
}

export async function readTextFile(filePath: string): Promise<string> {
  return await readFile(filePath, 'utf8')
}

export function writeTextFileSync(
  filePath: string,
  contents: string,
  options: { mode?: number } = {},
): void {
  ensureDirectorySync(dirname(filePath))
  writeFileSync(filePath, contents, {
    mode: options.mode,
    encoding: 'utf8',
  })
}
