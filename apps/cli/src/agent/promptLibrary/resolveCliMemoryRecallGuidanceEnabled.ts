import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import { resolveMemoryIndexPaths } from '@/daemon/memory/memoryIndexPaths';
import { stat } from 'node:fs/promises';
import type { ActionSurfaces, MemorySettingsV1 } from '@happier-dev/protocol';

type MemoryRecallGuidanceSurface = keyof Pick<ActionSurfaces, 'mcp' | 'voice_tool' | 'voice_action_block'>;
type MemoryRecallIndexStat = Readonly<Pick<Awaited<ReturnType<typeof stat>>, 'size'>>;
type MemoryRecallIndexStatReader = (path: string) => Promise<MemoryRecallIndexStat>;

const DEFAULT_MEMORY_RECALL_GUIDANCE_SURFACES = ['mcp'] as const satisfies readonly MemoryRecallGuidanceSurface[];

export async function resolveCliMemoryRecallGuidanceEnabled(args?: Readonly<{
  surfaces?: readonly MemoryRecallGuidanceSurface[];
  deps?: Readonly<{
    isActionEnabledByEnv?: typeof isActionEnabledByEnv;
    readMemorySettingsFromDisk?: () => Promise<MemorySettingsV1>;
    resolveMemoryIndexPaths?: typeof resolveMemoryIndexPaths;
    stat?: MemoryRecallIndexStatReader;
  }>;
}>): Promise<boolean> {
  const surfaces: readonly MemoryRecallGuidanceSurface[] =
    args?.surfaces && args.surfaces.length > 0 ? args.surfaces : DEFAULT_MEMORY_RECALL_GUIDANCE_SURFACES;
  const readActionEnabled = args?.deps?.isActionEnabledByEnv ?? isActionEnabledByEnv;
  if (!surfaces.some((surface) => readActionEnabled('memory.search', { surface }))) {
    return false;
  }

  try {
    const readMemorySettingsFromDisk =
      args?.deps?.readMemorySettingsFromDisk
      ?? (await import('@/settings/memorySettings')).readMemorySettingsFromDisk;
    const settings = await readMemorySettingsFromDisk();
    if (settings.enabled !== true) return false;

    const resolvePaths = args?.deps?.resolveMemoryIndexPaths ?? resolveMemoryIndexPaths;
    const paths = resolvePaths();
    const activeDbPath = settings.indexMode === 'deep' ? paths.deepDbPath : paths.tier1DbPath;
    if (typeof activeDbPath !== 'string' || activeDbPath.trim().length === 0) return false;

    const readStat: MemoryRecallIndexStatReader = args?.deps?.stat ?? ((path) => stat(path));
    const info = await readStat(activeDbPath);
    return typeof info?.size === 'number' && Number.isFinite(info.size) && info.size >= 0;
  } catch {
    return false;
  }
}
