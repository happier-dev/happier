import type { MachineFileBrowserRoot, DaemonFilesystemListRootsResponse } from '@happier-dev/protocol'

export async function listMachineBrowseRoots(input: Readonly<{
  resolveRoots: () => Promise<MachineFileBrowserRoot[]>
}>): Promise<DaemonFilesystemListRootsResponse> {
  try {
    const roots = await input.resolveRoots()
    return { ok: true, roots }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to list machine browse roots',
    }
  }
}
