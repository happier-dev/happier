import type { DaemonFilesystemListDirectoryResponse } from '@happier-dev/protocol'
import { DaemonFilesystemListDirectoryRequestSchema } from '@happier-dev/protocol'

import { listDirectoryEntries } from '@/rpc/handlers/fileSystem/directoryListing/listDirectoryEntries'

import { validateMachineBrowsePath } from './machineBrowsePathPolicy'

export async function listMachineBrowseDirectory(input: Readonly<{
  raw: unknown
  roots: Awaited<ReturnType<typeof Promise.resolve<Array<{ id: string; label: string; path: string }>>>>
  platform?: NodeJS.Platform
  maxEntries: number
  statConcurrency: number
}>): Promise<DaemonFilesystemListDirectoryResponse> {
  const parsed = DaemonFilesystemListDirectoryRequestSchema.safeParse(input.raw)
  if (!parsed.success) {
    return { ok: false, error: 'Invalid machine file browser directory request', errorCode: 'invalid_request' }
  }

  const validation = validateMachineBrowsePath({
    targetPath: parsed.data.path,
    roots: input.roots,
    platform: input.platform,
  })
  if (!validation.valid) {
    return { ok: false, error: validation.error, errorCode: 'invalid_path' }
  }

  try {
    const result = await listDirectoryEntries({
      directoryPath: validation.resolvedPath,
      includeFiles: parsed.data.includeFiles !== false,
      maxEntries: parsed.data.maxEntries ?? input.maxEntries,
      statConcurrency: input.statConcurrency,
    })

    return {
      ok: true,
      path: validation.resolvedPath,
      entries: result.entries.map((entry) => ({
        name: entry.name,
        path: entry.absolutePath,
        type: entry.type,
        size: entry.size,
        modified: entry.modified,
      })),
      truncated: result.truncated,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to list directory',
    }
  }
}
