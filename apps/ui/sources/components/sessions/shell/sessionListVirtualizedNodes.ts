import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRowViewModel } from './sessionListRowViewModels';

export type SessionListVirtualizedNode = Readonly<{
    id: string;
    kind: SessionListIndexItem['type'] | 'supporting_sections';
    headerKind?: Extract<SessionListIndexItem, { type: 'header' }>['headerKind'];
    rowViewModel?: SessionListRowViewModel | null;
    isGroupTail?: boolean;
}>;

/** A measured presentation cell, never a Session or a selectable entity. */
export const SESSION_LIST_SUPPORTING_SECTIONS_NODE: SessionListVirtualizedNode = Object.freeze({
    id: 'session-list-supporting-sections', kind: 'supporting_sections',
});
