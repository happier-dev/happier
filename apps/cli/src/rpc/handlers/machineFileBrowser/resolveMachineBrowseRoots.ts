import { posix, win32 } from 'node:path'

import type { MachineFileBrowserRoot } from '@happier-dev/protocol'
import {
  OS_USER_FILESYSTEM_ACCESS_POLICY,
  type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy'

type ResolveMachineBrowseRootsInput = Readonly<{
  platform?: NodeJS.Platform
  workingDirectory: string
  accessPolicy?: FilesystemAccessPolicy
}>

export async function resolveMachineBrowseRoots(input: ResolveMachineBrowseRootsInput): Promise<MachineFileBrowserRoot[]> {
  const platform = input.platform ?? process.platform
  const accessPolicy = input.accessPolicy ?? OS_USER_FILESYSTEM_ACCESS_POLICY
  if (accessPolicy.kind === 'restrictedRoots') {
    return accessPolicy.roots.map((root) => ({
      id: root,
      label: root,
      path: root,
    }))
  }

  const rawWorkingDirectory = String(input.workingDirectory ?? '').trim()
  if (!rawWorkingDirectory) {
    throw new Error('Machine browse working directory is required')
  }

  const resolvedWorkingDirectory = platform === 'win32'
    ? win32.resolve(rawWorkingDirectory)
    : posix.resolve(rawWorkingDirectory)

  if (platform === 'win32') {
    if (!win32.isAbsolute(resolvedWorkingDirectory)) {
      throw new Error('Machine browse working directory must be absolute')
    }
  } else if (!posix.isAbsolute(resolvedWorkingDirectory)) {
    throw new Error('Machine browse working directory must be absolute')
  }

  const root = platform === 'win32'
    ? win32.parse(resolvedWorkingDirectory).root
    : '/'

  return [{ id: root, label: root, path: root }]
}
