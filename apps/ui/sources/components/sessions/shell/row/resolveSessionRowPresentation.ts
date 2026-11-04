import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import type { CollectionSessionRequestRef } from '@/components/ui/lists/collection/collectionRequestRef';
import type { SessionListSecondaryLineMode } from '@/sync/domains/session/listing/deriveSessionListActivity';

export type SessionRowDensity = 'default' | 'compact' | 'minimal';
export type SessionRowTitleTone = 'quiet' | 'normal' | 'emphasized';
export type SessionRowSecondaryLine = 'none' | 'path' | 'status';

export type SessionRowPresentation = Readonly<{
    status: WorkStatusPresentation;
    requestRef: CollectionSessionRequestRef | null;
    titleTone: SessionRowTitleTone;
    secondaryLine: SessionRowSecondaryLine;
    statusText: string;
    accessibilityStatusText: string;
}>;

/** Row-only layout binding. Status, requests and availability have already been classified. */
export function resolveSessionRowPresentation(input: Readonly<{
    status: WorkStatusPresentation;
    requestRef?: CollectionSessionRequestRef | null;
    quietWhenOffline?: boolean;
    density: SessionRowDensity;
    requestedSecondaryLineMode: SessionListSecondaryLineMode;
    hasPathSubtitle: boolean;
    /** A readable headline already admitted by the Session awareness owner. */
    hasWorkHeadline?: boolean;
}>): SessionRowPresentation {
    const { status } = input;
    const quiet = status.state === 'waiting' || status.state === 'unknown'
        || status.state === 'stopped' || status.state === 'disconnected' || status.state === 'archived';
    const emphasized = status.tone !== 'neutral' || status.state === 'finished_unseen'
        || status.state === 'mentioned' || status.state === 'unread' || status.state === 'pending_input';

    return {
        status,
        requestRef: input.requestRef ?? null,
        titleTone: emphasized ? 'emphasized' : quiet ? 'quiet' : 'normal',
        secondaryLine: input.density === 'minimal' || input.quietWhenOffline === true && status.bucket === 'offline' ? 'none'
            : input.requestedSecondaryLineMode === 'path' && input.hasPathSubtitle
                && (status.state === 'waiting' || status.state === 'unknown')
                ? 'path'
                : input.hasWorkHeadline ? 'status'
                : status.state === 'waiting' || status.state === 'unknown' || !status.word.trim() ? 'none' : 'status',
        statusText: status.word,
        accessibilityStatusText: status.word,
    };
}
