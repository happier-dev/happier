import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { useVisibleSessionListViewState } from './useVisibleSessionListViewState';

export function useVisibleSessionListViewData(storageFilter: SessionListStorageFilter = 'all'): SessionListViewItem[] | null {
    const { visibleSessionListViewData } = useVisibleSessionListViewState(storageFilter);
    return visibleSessionListViewData;
}
