import * as React from 'react';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionAddressV1';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import { projectBulkSessionAuthoringFact, type BulkSessionAuthoringHydration } from '@/sync/store/bulkSessionAuthoringFacts';
import { getStorage } from '@/sync/domains/state/storageStore';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { readBulkSessionAuthoringSnapshots } from './bulkSessionAuthoringHydration';

export function useHydratedBulkSessionAuthoringFacts(targets: readonly ActionSessionAddressV1[],
    resumeOptionsByTarget?: ReadonlyMap<string, ResumeCapabilityOptions>) {
    const store = getStorage();
    const loaded = React.useRef<ReadonlyMap<string, BulkSessionAuthoringHydration>>(new Map());
    const project = React.useCallback((snapshots: ReadonlyMap<string, BulkSessionAuthoringHydration>) => targets.map(target => {
        const key = sessionAddressKey(target);
        const snapshot = snapshots.get(key);
        return projectBulkSessionAuthoringFact(target, snapshot?.session ?? null,
            resumeOptionsByTarget?.get(key), snapshot?.errorCode ?? null);
    }), [resumeOptionsByTarget, targets]);
    const [facts, setFacts] = React.useState(() => project(loaded.current));
    const published = React.useRef(facts);
    const [revision, setRevision] = React.useState(0);
    const retry = React.useCallback(() => setRevision(value => value + 1), []);
    // Exact Home list rows publish authoring revisions. Transcript seq/activity clocks
    // do not invalidate these metadata-only reads or render the open composer.
    const readRevision = React.useCallback((state: ReturnType<typeof store.getState>) => JSON.stringify(targets.map(target => {
        const row = readSessionListRowForServerId(state.sessionListRowsByServerId, target.serverId, target.sessionId);
        return row ? [row.metadataVersion, row.metadataLayoutVersion ?? null, row.active, row.access ?? null,
            row.accessLevel ?? null, row.archivedAt ?? null, row.encryptionMode ?? null] : null;
    })), [targets]);
    React.useEffect(() => {
        if (targets.length === 0) return;
        let current = true;
        let controller: AbortController | null = null;
        let basis = readRevision(store.getState());
        const publish = () => {
            const next = retainDeep(published.current, project(loaded.current));
            if (next === published.current) return;
            published.current = next;
            setFacts(next);
        };
        const refresh = () => {
            controller?.abort();
            const request = new AbortController();
            controller = request;
            void readBulkSessionAuthoringSnapshots(targets, request.signal).then(next => {
                if (!current || request.signal.aborted) return;
                loaded.current = next;
                publish();
            });
        };
        // Invalidation is an effect input, not a rendered fact. An unrelated
        // metadata update may require a read, but publishes no React update.
        const stop = store.subscribe(state => {
            const next = readRevision(state);
            if (next === basis) return;
            basis = next;
            refresh();
        }, { sessionListRowsByServerId: targets.map(target => target.serverId) });
        publish();
        refresh();
        return () => { current = false; stop(); controller?.abort(); };
    }, [project, readRevision, revision, store, targets]);
    const currentFacts = React.useMemo(() => retainDeep(facts, project(loaded.current)), [facts, project]);
    published.current = currentFacts;
    return { facts: currentFacts, retry };
}
