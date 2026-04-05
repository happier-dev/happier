import { useVisibleSessionListSummaryState } from './useVisibleSessionListSummaryState';
import type { VisibleSessionListSummary } from '@/sync/domains/session/listing/sessionListPresentation';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';

export function useVisibleSessionListSummary(storageFilter: SessionListStorageFilter = 'all'): VisibleSessionListSummary {
    return useVisibleSessionListSummaryState(storageFilter).summary;
}
