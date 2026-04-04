import { posix, win32 } from 'node:path'

import type { MachineFileBrowserRoot } from '@happier-dev/protocol'

type ResolveMachineBrowseRootsInput = Readonly<{
  platform?: NodeJS.Platform
  workingDirectory: string
}>

export async function resolveMachineBrowseRoots(input: ResolveMachineBrowseRootsInput): Promise<MachineFileBrowserRoot[]> {
  const platform = input.platform ?? process.platform
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

  return [{
    id: resolvedWorkingDirectory,
    label: resolvedWorkingDirectory,
    path: resolvedWorkingDirectory,
  }]
}
