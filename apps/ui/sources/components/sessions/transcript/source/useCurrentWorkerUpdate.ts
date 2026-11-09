import * as React from 'react';
import type { WorkerUpdateV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';

import { getStorage } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import { readStoredSessionTranscriptForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { buildLatestWorkerUpdates } from '@/sync/store/latestWorkerUpdates';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useSessionTranscriptSource } from './SessionTranscriptSourceContext';

/** Historical notices keep their result; only the latest notice in this exact transcript owns live answers. A null message reads nothing. */
export function useCurrentWorkerUpdate(update: WorkerUpdateV1, messageId: string | null, serverId: string | null | undefined): boolean {
    const source = useSessionTranscriptSource();
    const history = source.history.useState();
    const sameHome = areServerProfileIdentifiersEquivalent(source.serverId, serverId);
    if (source.kind !== 'app') {
        const ids = source.useMessageIdsOldestFirst();
        const byId = source.useMessagesById();
        if (messageId === null || !sameHome || history.hasNewer) return false;
        const updates = buildLatestWorkerUpdates(ids.flatMap(id => byId[id] ? [byId[id]] : []));
        return updates[update.workerKind]?.[update.workerId]?.messageId === messageId;
    }
    const activeServerId = useActiveServerSnapshot(Boolean(source.serverId)).serverId;
    const selector = React.useMemo(() => {
        const address = normalizeSessionAddress(source.serverId, source.sessionId);
        return (state: StorageState) => {
            if (messageId === null) return false;
            const transcript = readStoredSessionTranscriptForAddress(state, address, { activeServerId });
            return transcript?.latestWorkerUpdates?.[update.workerKind]?.[update.workerId]?.messageId === messageId;
        };
    }, [source, activeServerId, update.workerId, update.workerKind, messageId]);
    const current = getStorage()(selector);
    return sameHome && !history.hasNewer && current;
}
