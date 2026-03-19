import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { DirectoryListingEntry, DirectoryListingEntryType, DirectoryListingResult } from './directoryListingTypes'
import { sortDirectoryEntries } from './sortDirectoryEntries'

type ListDirectoryEntriesInput = Readonly<{
  directoryPath: string
  includeFiles: boolean
  maxEntries: number | null
  statConcurrency: number
}>

function resolveEntryType(entry: Pick<Dirent, 'isDirectory' | 'isFile'>): DirectoryListingEntryType {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  return 'other'
}

async function mapWithConcurrency<TInput, TOutput>(
  entries: readonly TInput[],
  concurrency: number,
  mapper: (entry: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const limit = Math.max(1, Math.floor(concurrency))
  const output = new Array<TOutput>(entries.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= entries.length) return
      output[index] = await mapper(entries[index] as TInput)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, () => worker()))
  return output
}

export async function listDirectoryEntries(input: ListDirectoryEntriesInput): Promise<DirectoryListingResult> {
  const dirents = await readdir(input.directoryPath, { withFileTypes: true })

  const listedEntries = dirents
    .map((dirent) => {
      const type = resolveEntryType(dirent)
      return {
        name: dirent.name,
        absolutePath: join(input.directoryPath, dirent.name),
        type,
      } satisfies Pick<DirectoryListingEntry, 'name' | 'absolutePath' | 'type'>
    })
    .filter((entry) => {
      if (input.includeFiles) return true
      return entry.type === 'directory'
    })

  const sortedEntries = sortDirectoryEntries(listedEntries)
  const normalizedMaxEntries =
    typeof input.maxEntries === 'number' && Number.isFinite(input.maxEntries) && input.maxEntries > 0
      ? Math.floor(input.maxEntries)
      : null
  const truncated = normalizedMaxEntries != null && sortedEntries.length > normalizedMaxEntries
  const visibleEntries = truncated ? sortedEntries.slice(0, normalizedMaxEntries) : sortedEntries

  const entries = await mapWithConcurrency(visibleEntries, input.statConcurrency, async (entry) => {
    try {
      const stats = await stat(entry.absolutePath)
      return {
        ...entry,
        size: stats.size,
        modified: stats.mtime.getTime(),
      } satisfies DirectoryListingEntry
    } catch {
      return entry
    }
  })

  return { entries, truncated }
}
