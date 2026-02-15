import type { ExecutionRunsBackendSnapshotEntry } from '@/sync/domains/reviews/reviewEngineCatalog';

export function extractExecutionRunsBackendsFromMachineCapabilitiesState(state: any): Record<string, ExecutionRunsBackendSnapshotEntry> | null {
  const snapshot = state?.snapshot?.response;
  const entry = snapshot?.results?.['tool.executionRuns'];
  if (!entry || entry.ok !== true) return null;
  const backends = (entry.data as any)?.backends;
  if (!backends || typeof backends !== 'object') return null;
  return backends as any;
}

