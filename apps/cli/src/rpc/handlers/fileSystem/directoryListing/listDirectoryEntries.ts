import { join } from 'node:path'

import { mapWithConcurrency } from '@/utils/async/mapWithConcurrency'
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog'
import type { ScmBackendRegistry } from '@/scm/registry'

import type { DirectoryListingEntry, DirectoryListingEntryType, DirectoryListingResult } from './directoryListingTypes'
import { sortDirectoryEntries } from './sortDirectoryEntries'
import { currentWorkspaceSource, type WorkspaceDirent } from '@/workspaces/source/workspaceSource'

type ListDirectoryEntriesInput = Readonly<{
  directoryPath: string
  includeFiles: boolean
  maxEntries: number | null
  statConcurrency: number
  includeGitIgnore?: boolean
  scmRegistry?: ScmBackendRegistry
}>

function resolveEntryType(entry: Pick<WorkspaceDirent, 'isDirectory' | 'isFile'>): DirectoryListingEntryType {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  return 'other'
}

export async function listDirectoryEntries(input: ListDirectoryEntriesInput): Promise<DirectoryListingResult> {
  const source = currentWorkspaceSource()
  const dirents = await source.readdir(input.directoryPath)

  const listedEntries = dirents
    .map((dirent) => {
      const type = resolveEntryType(dirent)
      return {
        name: dirent.name,
        absolutePath: join(input.directoryPath, dirent.name),
        type,
        stats: dirent.stats,
      }
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

  const entries = await mapWithConcurrency(visibleEntries, input.statConcurrency, async ({ stats: listedStats, ...entry }) => {
    if (listedStats === null) return entry
    try {
      const stats = listedStats ?? await source.stat(entry.absolutePath)
      return {
        ...entry,
        size: stats.size,
        modified: stats.mtime.getTime(),
      } satisfies DirectoryListingEntry
    } catch {
      return entry
    }
  })

  if (input.includeGitIgnore === true) {
    try {
      const ignored = await runWithScmBackendRegistryLease(input.scmRegistry, async (registry) => {
        const selected = await registry.selectBackend({ cwd: input.directoryPath, workingDirectory: input.directoryPath })
        const classify = selected?.backend.workspaceIntegration?.classifyDirectoryIgnores
        return classify ? await classify({ cwd: input.directoryPath, entries }) : null
      })
      if (ignored !== null) {
        return {
          entries: entries.map((entry) => ({ ...entry, gitIgnored: ignored.has(entry.name) })),
          truncated,
          gitIgnoreAvailable: true,
        }
      }
    } catch {
      // Availability is observable in the response; callers retain the complete raw listing.
    }
    return { entries, truncated, gitIgnoreAvailable: false }
  }
  return { entries, truncated }
}
