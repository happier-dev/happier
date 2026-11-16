import * as React from 'react';

import { useActiveGatedExternalStore, type ActiveSignal } from '@/utils/react/activeGatedExternalStore';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    getExistingSessionDraftProjection,
    subscribeSessionDraft,
    type ExistingSessionDraftProjection,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

function subscribeToNothing(): () => void {
    return () => undefined;
}

/**
 * What the row's structure depends on. The preview text changes with every key and is read by its
 * own leaf; the sync status is not shown on a row and flips with every remote flush while typing.
 */
export type SessionListRowDraft = Readonly<{
    hasPreview: boolean;
}>;

/** The row's draft preview text, observed by the leaf that renders it. */
export type SessionListRowDraftPreviewSource = Readonly<{
    /** The list surface's data demand: while off, the leaf keeps the preview it last showed. */
    gate: ActiveSignal;
    subscribe: (listener: () => void) => () => void;
    getPreview: () => string;
}>;

function readNoDraft(): SessionListRowDraft | null {
    return null;
}

function readListedDraft(scope: ServerAccountScope, sessionId: string): ExistingSessionDraftProjection | null {
    const projection = getExistingSessionDraftProjection(scope, sessionId);
    return projection?.listed ? projection : null;
}

function readListedRowDraft(scope: ServerAccountScope, sessionId: string): SessionListRowDraft | null {
    const projection = readListedDraft(scope, sessionId);
    return projection ? { hasPreview: projection.preview.length > 0 } : null;
}

function retainRowDraft(previous: SessionListRowDraft | null, next: SessionListRowDraft | null): SessionListRowDraft | null {
    return previous && next && previous.hasPreview === next.hasPreview ? previous : next;
}

/**
 * The listed draft of one session-list row, observed through that row's own draft address.
 *
 * Typing in a session changes only its row's preview text: the list never rebuilds for draft text,
 * and the row itself re-renders only when the draft appears, disappears, or gains or loses a
 * preview. The preview text is read by `preview`'s own leaf. While the surface is inactive
 * the row keeps its last observed draft; a row whose first render is inactive reads the current
 * draft once without subscribing.
 */
export function useSessionListRowExistingDraft(input: Readonly<{
    activeScope: ServerAccountScope | null;
    serverId: string | null | undefined;
    sessionId: string;
    /** The list surface's data demand; while off the row keeps the draft it last showed. */
    gate: ActiveSignal;
}>): Readonly<{ draft: SessionListRowDraft | null; preview: SessionListRowDraftPreviewSource }> {
    const { activeScope, gate, serverId, sessionId } = input;
    // Drafts are kept for the active Account; rows of another Home have none here.
    const scope = activeScope && (!serverId || serverId === activeScope.serverId) ? activeScope : null;
    const subscribe = React.useMemo(() => {
        if (!scope) return subscribeToNothing;
        const address = { kind: 'session' as const, sessionId };
        return (listener: () => void) => subscribeSessionDraft(scope, address, listener);
    }, [scope, sessionId]);
    const read = React.useMemo(() => {
        if (!scope) return readNoDraft;
        let last: SessionListRowDraft | null = null;
        return () => {
            last = retainRowDraft(last, readListedRowDraft(scope, sessionId));
            return last;
        };
    }, [scope, sessionId]);
    const draft = useActiveGatedExternalStore(gate, subscribe, read);
    const preview = React.useMemo<SessionListRowDraftPreviewSource>(() => ({
        gate,
        subscribe,
        getPreview: () => (scope ? readListedDraft(scope, sessionId)?.preview ?? '' : ''),
    }), [gate, scope, sessionId, subscribe]);
    return { draft, preview };
}

/** The preview text of a row's draft; the only part of the row that renders on a key. */
export function useSessionListRowDraftPreview(source: SessionListRowDraftPreviewSource): string {
    return useActiveGatedExternalStore(source.gate, source.subscribe, source.getPreview);
}
