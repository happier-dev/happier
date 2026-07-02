import { isActionEnabledByEnv } from '../../../settings/actionsSettings';
import { resolveMemoryIndexPaths } from '../../../daemon/memory/memoryIndexPaths';
import { stat } from 'node:fs/promises';
import { openDeepIndexDb } from '../../../daemon/memory/deepIndex/deepIndexDb';
import { openSummaryShardIndexDb } from '../../../daemon/memory/summaryShardIndexDb';
import {
  isMemoryRecallGuidanceSupported,
  type MemoryRecallGuidanceSurface,
  type MemorySettingsV1,
} from '@happier-dev/protocol';

type MemoryRecallIndexStat = Readonly<Pick<Awaited<ReturnType<typeof stat>>, 'size'>>;
type MemoryRecallIndexStatReader = (path: string) => Promise<MemoryRecallIndexStat>;
type MemoryRecallIndexContentReader = (path: string, mode: 'hints' | 'deep') => boolean;

function defaultHasSearchableContent(path: string, mode: 'hints' | 'deep'): boolean {
  if (mode === 'deep') {
    const db = openDeepIndexDb({ dbPath: path });
    try {
      return db.getDeepIndexStats().deepChunkCount > 0;
    } finally {
      db.close();
    }
  }
  const db = openSummaryShardIndexDb({ dbPath: path });
  try {
    return db.getSummaryIndexStats().lightShardCount > 0;
  } finally {
    db.close();
  }
}

export async function resolveCliMemoryRecallGuidanceEnabled(args?: Readonly<{
  surfaces?: readonly MemoryRecallGuidanceSurface[];
  deps?: Readonly<{
    isActionEnabledByEnv?: typeof isActionEnabledByEnv;
    readMemorySettingsFromDisk?: () => Promise<MemorySettingsV1>;
    resolveMemoryIndexPaths?: typeof resolveMemoryIndexPaths;
    stat?: MemoryRecallIndexStatReader;
    hasSearchableContent?: MemoryRecallIndexContentReader;
  }>;
}>): Promise<boolean> {
  const readActionEnabled = args?.deps?.isActionEnabledByEnv ?? isActionEnabledByEnv;
  if (!isMemoryRecallGuidanceSupported({
    surfaces: args?.surfaces,
    isActionEnabled: (actionId, surface) => readActionEnabled(actionId, { surface }),
  })) {
    return false;
  }

  try {
    const readMemorySettingsFromDisk =
      args?.deps?.readMemorySettingsFromDisk
      ?? (await import('../../../settings/memorySettings')).readMemorySettingsFromDisk;
    const settings = await readMemorySettingsFromDisk();
    if (settings.enabled !== true) return false;

    const resolvePaths = args?.deps?.resolveMemoryIndexPaths ?? resolveMemoryIndexPaths;
    const paths = resolvePaths();
    const activeDbPath = settings.indexMode === 'deep' ? paths.deepDbPath : paths.tier1DbPath;
    if (typeof activeDbPath !== 'string' || activeDbPath.trim().length === 0) return false;

    const readStat: MemoryRecallIndexStatReader = args?.deps?.stat ?? ((path) => stat(path));
    const info = await readStat(activeDbPath);
    if (!(typeof info?.size === 'number' && Number.isFinite(info.size) && info.size >= 0)) return false;
    const hasSearchableContent = args?.deps?.hasSearchableContent ?? defaultHasSearchableContent;
    return hasSearchableContent(activeDbPath, settings.indexMode);
  } catch {
    return false;
  }
}
