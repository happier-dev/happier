import {
    DatabaseStatsCounterSampleV1Schema,
    type DatabaseStatsCounterSampleV1,
    type DatabaseStatsObservationV1,
    type DatabaseTargetV1,
} from '@happier-dev/plugin-sdk/database';
import { compareDatabaseStatsCountersV1 } from '@happier-dev/databases/stats-comparisons';

import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createPersistentUiState, UiStatePersistenceError } from '@/sync/domains/state/persistentUiState';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

// One record per selected resource. Time and basis are the minimal metadata needed to make
// an honest comparison after reopening; SQL, full observations and history never enter it.
const lastLook = createPersistentUiState<DatabaseStatsCounterSampleV1 | undefined>('database-statements-last-look-v1', value => {
    const parsed = DatabaseStatsCounterSampleV1Schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
});

type StatementsObservation = Extract<DatabaseStatsObservationV1, { status: 'available'; group: 'statements' }>
    | Extract<DatabaseStatsObservationV1, { status: 'unavailable' }>;

/** The selected Resource creates this lifetime on open and calls observe only for a displayed result. */
export function createDatabaseStatsLastLook(scope: ServerAccountScope, target: DatabaseTargetV1) {
    let viewKey: string | undefined;
    let baseline: DatabaseStatsCounterSampleV1 | undefined;
    let recorded = false;
    return {
        observe(observation: StatementsObservation, shownKeys: readonly string[]) {
            if (observation.status === 'unavailable') return {
                comparison: { status: 'unavailable', reason: observation.reason } as const,
                persistenceError: null,
            };
            const selected = new Set(shownKeys);
            const current: DatabaseStatsCounterSampleV1 = {
                engineId: observation.engineId,
                observedAtMs: observation.observedAtMs,
                coverage: observation.coverage,
                intervalBasis: {
                    ...observation.intervalBasis,
                    ...(observation.intervalBasis.rowResetMarkers ? {
                        rowResetMarkers: Object.fromEntries(Object.entries(observation.intervalBasis.rowResetMarkers)
                            .filter(([key]) => selected.has(key))),
                    } : {}),
                },
                rows: observation.data.filter(row => selected.has(row.key))
                    .map(({ key, calls, totalTimeMs, rows }) => ({ key, calls, totalTimeMs, rows })),
            };
            // MMKV web keys cannot contain backslashes from Windows structured target paths.
            const key = encodeURIComponent(serverAccountScopedResourceKey(scope, stableJsonStringify(target),
                current.intervalBasis.bindingKey, current.intervalBasis.databaseIdentity, current.intervalBasis.selectionKey));
            if (key !== viewKey) {
                viewKey = key;
                baseline = lastLook.read(key);
                recorded = false;
            }
            const comparison = compareDatabaseStatsCountersV1(baseline, current);
            let persistenceError: UiStatePersistenceError | null = null;
            // More pages are not partial coverage: the baseline contains only the displayed keys.
            if (!recorded && current.coverage.status === 'complete') {
                try {
                    lastLook.set(key, current);
                    recorded = true;
                } catch (error) {
                    if (!(error instanceof UiStatePersistenceError)) throw error;
                    persistenceError = error;
                }
            }
            return { comparison, persistenceError };
        },
    };
}
