import type {
  DatabaseStatsCounterComparisonV1,
  DatabaseStatsObservationV1,
  DatabaseTargetV1,
} from '@happier-dev/plugin-sdk';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

/** One selected Resource's host-owned presented-demand lifetime. */
export type HostDatabaseActivityResource<T> = Readonly<{
  getSnapshot(): Readonly<{ value: T | null; loading: boolean; error: unknown }>;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  retainAutoRefresh(demand: Readonly<{ intervalMs: number }>): () => void;
  invalidate(): void;
  dispose(): void;
}>;

/** Viewer-device-local counter comparisons; the host retains parsing and persistence. */
export type HostDatabaseLastLook = Readonly<{
  observe(
    observation: Extract<DatabaseStatsObservationV1, { status: 'available'; group: 'statements' }>
      | Extract<DatabaseStatsObservationV1, { status: 'unavailable' }>,
    shownKeys: readonly string[],
  ): Readonly<{ comparison: DatabaseStatsCounterComparisonV1; persistenceError: Error | null }>;
}>;

export type HostDatabaseWorkbench = Readonly<{
  activityResource<T>(source: Readonly<{
    read(options: Readonly<{ signal: AbortSignal }>): Promise<T>;
  }>): HostDatabaseActivityResource<T>;
  /** Scope is the mounted viewer's explicit Home/Account, never the focused tab. */
  lastLook(scope: Readonly<{ serverId: string; accountId: string }>, target: DatabaseTargetV1): HostDatabaseLastLook;
}>;

/** Same-realm factories; unsupported hosts expose no replacement controller or persistence. */
export function useHostDatabaseWorkbench(): HostDatabaseWorkbench | null {
  return useOptionalPluginUiPresentationHost()?.databaseWorkbench ?? null;
}
