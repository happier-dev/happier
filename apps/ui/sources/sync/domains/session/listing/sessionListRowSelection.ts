import { shallow } from 'zustand/shallow';
import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListRowStateByServerId } from './sessionListRowStateLookup';

export type SessionListRowPredicate = (row: SessionListRenderableSession, serverId: string) => boolean;

/** Select a surface's consumed rows while retaining unchanged Home bucket identities. */
export function createSessionListRowSelection(predicate: SessionListRowPredicate | undefined):
    (rows: SessionListRowStateByServerId) => SessionListRowStateByServerId {
    let previous: SessionListRowStateByServerId = {};
    return (rows: SessionListRowStateByServerId): SessionListRowStateByServerId => {
        if (!predicate) return rows;
        const selected: Record<string, Readonly<Record<string, SessionListRenderableSession>>> = {};
        for (const [serverId, bucket] of Object.entries(rows)) {
            const next = Object.fromEntries(Object.entries(bucket).filter(([, row]) => predicate(row, serverId)));
            selected[serverId] = previous[serverId] && shallow(previous[serverId], next) ? previous[serverId] : next;
        }
        previous = selected;
        return selected;
    };
}
