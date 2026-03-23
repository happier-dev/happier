import { access } from 'node:fs/promises'

import type { MachineFileBrowserRoot } from '@happier-dev/protocol'

type ResolveMachineBrowseRootsInput = Readonly<{
  platform?: NodeJS.Platform
  driveLetters?: readonly string[]
  canAccessRoot?: (rootPath: string) => Promise<boolean>
}>

const WINDOWS_DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export async function resolveMachineBrowseRoots(input: ResolveMachineBrowseRootsInput = {}): Promise<MachineFileBrowserRoot[]> {
  const platform = input.platform ?? process.platform
  if (platform !== 'win32') {
    return [{ id: '/', label: '/', path: '/' }]
  }

  const driveLetters = input.driveLetters ?? WINDOWS_DRIVE_LETTERS
  const canAccessRoot = input.canAccessRoot ?? (async (rootPath: string) => {
    try {
      await access(rootPath)
      return true
    } catch {
      return false
    }
  })

  const roots: MachineFileBrowserRoot[] = []
  for (const driveLetter of driveLetters) {
    const normalizedLetter = String(driveLetter ?? '').trim().toUpperCase()
    if (!/^[A-Z]$/.test(normalizedLetter)) continue
    const rootPath = `${normalizedLetter}:\\`
    if (!await canAccessRoot(rootPath)) continue
    roots.push({
      id: rootPath,
      label: `${normalizedLetter}:`,
      path: rootPath,
    })
  }

  return roots
}
