import { join } from 'node:path';

import { configuration } from '@/configuration';

export type MemoryIndexPaths = Readonly<{
  memoryDir: string;
  tier1DbPath: string;
  deepDbPath: string;
  modelsDir: string;
}>;

export function resolveMemoryIndexPaths(): MemoryIndexPaths {
  const memoryDir = join(configuration.activeServerDir, 'memory');
  return {
    memoryDir,
    tier1DbPath: join(memoryDir, 'memory.sqlite'),
    deepDbPath: join(memoryDir, 'deep.sqlite'),
    modelsDir: join(memoryDir, 'models'),
  };
}

