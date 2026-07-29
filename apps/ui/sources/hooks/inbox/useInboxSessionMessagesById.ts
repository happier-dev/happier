import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { getStorage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';

type InboxMessageSession = Readonly<{ id: string }>;

function collectInboxSessionMessageIds(params: Readonly<{
    sessions: readonly InboxMessageSession[];
    sessionRows: readonly Readonly<{ session: InboxMessageSession }>[];
}>): string[] {
    const ids = new Set<string>();
    for (const session of params.sessions) {
        const sessionId = session.id.trim();
        if (sessionId) ids.add(sessionId);
    }
    for (const row of params.sessionRows) {
        const sessionId = row.session.id.trim();
        if (sessionId) ids.add(sessionId);
    }
    return Array.from(ids).sort();
}

export function useInboxSessionMessagesById(params: Readonly<{
    sessions: readonly InboxMessageSession[];
    sessionRows: readonly Readonly<{ session: InboxMessageSession }>[];
}>): StorageState['sessionMessages'] {
    const sessionIds = React.useMemo(
        () => collectInboxSessionMessageIds(params),
        [params.sessions, params.sessionRows],
    );

    return getStorage()(useShallow((state) => {
        const out: StorageState['sessionMessages'] = {};
        for (const sessionId of sessionIds) {
            const sessionMessages = state.sessionMessages[sessionId];
            if (sessionMessages) {
                out[sessionId] = sessionMessages;
            }
        }
        return out;
    }));
}
