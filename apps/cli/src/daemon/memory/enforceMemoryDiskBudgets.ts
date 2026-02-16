import type { SummaryShardIndexDbHandle } from './summaryShardIndexDb';
import type { DeepIndexDbHandle } from './deepIndex/deepIndexDb';

import { stat } from 'node:fs/promises';

async function getFileSizeBytes(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return typeof s.size === 'number' && Number.isFinite(s.size) ? Math.max(0, Math.trunc(s.size)) : 0;
  } catch {
    return 0;
  }
}

async function enforceSqliteBudget(params: Readonly<{
  dbPath: string;
  budgetBytes: number;
  deleteBatch: (limit: number) => number;
  vacuum: () => void;
}>): Promise<void> {
  const budget = Number.isFinite(params.budgetBytes) ? Math.max(0, Math.trunc(params.budgetBytes)) : 0;
  if (budget === 0) {
    for (;;) {
      const deleted = params.deleteBatch(50);
      if (deleted <= 0) break;
      params.vacuum();
    }
    return;
  }

  for (;;) {
    const size = await getFileSizeBytes(params.dbPath);
    if (size <= budget) return;
    const deleted = params.deleteBatch(50);
    if (deleted <= 0) return;
    params.vacuum();
  }
}

export async function enforceMemoryDiskBudgets(params: Readonly<{
  tier1: SummaryShardIndexDbHandle;
  deep: DeepIndexDbHandle | null;
  tier1DbPath: string;
  deepDbPath: string;
  budgets: Readonly<{ tier1Bytes: number; deepBytes: number }>;
}>): Promise<void> {
  await enforceSqliteBudget({
    dbPath: params.tier1DbPath,
    budgetBytes: params.budgets.tier1Bytes,
    deleteBatch: (limit) => params.tier1.deleteOldestSummaryShards({ limit }),
    vacuum: () => params.tier1.checkpointAndVacuum(),
  });

  if (params.deep) {
    await enforceSqliteBudget({
      dbPath: params.deepDbPath,
      budgetBytes: params.budgets.deepBytes,
      deleteBatch: (limit) => params.deep!.deleteOldestChunks({ limit }),
      vacuum: () => params.deep!.checkpointAndVacuum(),
    });
  }
}
