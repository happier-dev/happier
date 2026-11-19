import type { DaemonFilesystemListDirectoryResponse } from '@happier-dev/protocol'
import { DaemonFilesystemListDirectoryRequestSchema, type DaemonFilesystemListDirectoryRequest } from '@happier-dev/protocol/machines/fileBrowser';

import type { ScmBackendRegistry } from '@/scm/registry'

import { listDirectoryEntries } from '@/rpc/handlers/fileSystem/directoryListing/listDirectoryEntries'

import { validateMachineBrowsePath } from './machineBrowsePathPolicy'

export async function listMachineBrowseDirectory(input: Readonly<{
  raw: unknown
  roots: Awaited<ReturnType<typeof Promise.resolve<Array<{ id: string; label: string; path: string }>>>>
  platform?: NodeJS.Platform
  maxEntries: number
  statConcurrency: number
  scmRegistry?: ScmBackendRegistry
}>): Promise<DaemonFilesystemListDirectoryResponse> {
  const parsed = DaemonFilesystemListDirectoryRequestSchema.safeParse(input.raw)
  if (!parsed.success || typeof parsed.data.path !== 'string') {
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

  return listMachineDirectoryAt(validation.resolvedPath, parsed.data, input)
}

export async function listMachineDirectoryAt(
  directoryPath: string,
  request: DaemonFilesystemListDirectoryRequest,
  limits: Readonly<{ maxEntries: number; statConcurrency: number; scmRegistry?: ScmBackendRegistry }>,
): Promise<DaemonFilesystemListDirectoryResponse> {
  try {
    const result = await listDirectoryEntries({
      directoryPath,
      includeFiles: request.includeFiles !== false,
      maxEntries: request.maxEntries ?? limits.maxEntries,
      statConcurrency: limits.statConcurrency,
      includeGitIgnore: request.includeGitIgnore === true,
      scmRegistry: limits.scmRegistry,
    })

    return {
      ok: true,
      path: directoryPath,
      entries: result.entries.map((entry) => ({
        name: entry.name,
        path: entry.absolutePath,
        type: entry.type,
        size: entry.size,
        modified: entry.modified,
        ...(entry.gitIgnored !== undefined ? { gitIgnored: entry.gitIgnored } : {}),
      })),
      truncated: result.truncated,
      ...(result.gitIgnoreAvailable !== undefined ? { gitIgnoreAvailable: result.gitIgnoreAvailable } : {}),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to list directory',
      ...(error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? { errorCode: error.code } : {}),
    }
  }
}
