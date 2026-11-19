import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import type { CollectionSessionRequestRef } from '@/components/ui/lists/collection/collectionRequestRef';

export type SessionRowDensity = 'default' | 'compact' | 'minimal';
export type SessionRowTitleTone = 'quiet' | 'normal' | 'emphasized';

export type SessionRowPresentation = Readonly<{
    status: WorkStatusPresentation;
    requestRef: CollectionSessionRequestRef | null;
    titleTone: SessionRowTitleTone;
    statusText: string;
    accessibilityStatusText: string;
}>;

/**
 * Row-only binding. Status, requests and availability have already been classified; the row's lines come from the
 * awareness owner's now line and count (`SessionItem`), never from the status word.
 */
export function resolveSessionRowPresentation(input: Readonly<{
    status: WorkStatusPresentation;
    requestRef?: CollectionSessionRequestRef | null;
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
        statusText: status.word,
        accessibilityStatusText: status.word,
    };
}
