import type { NormalizedMessage } from '@/sync/typesRaw';

import { scmStatusSync } from '@/scm/scmStatusSync';
import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';

import { createWorkspaceMutationIngestion } from './workspaceMutationIngestion';

const ingestion = createWorkspaceMutationIngestion({
    debounceMs: 200,
    minUnknownOnlyIntervalMs: 1500,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as any),
    invalidateKnownMutation: (sessionId, changedPaths) => {
        scmDiffCache.invalidatePaths({ sessionId, paths: new Set(changedPaths) });
        scmStatusSync.invalidateFromMutation(sessionId);
    },
    invalidateUnknownMutation: (sessionId) => {
        scmStatusSync.invalidateFromAutoRefresh(sessionId);
    },
});

export function ingestWorkspaceMutationMessages(sessionId: string, messages: readonly NormalizedMessage[]): void {
    ingestion.ingest(sessionId, messages);
}
