import { useSharedInboxSummary } from './useInboxSummary';

/**
 * The navigation dot represents ready or response-required work. Recent
 * operation history can remain visible without making the navigation
 * look uncleared; feed, update, and outgoing-request history stay on their
 * owning surfaces.
 */
export function useInboxHasContent(): boolean {
    return useSharedInboxSummary().hasContent !== false;
}
