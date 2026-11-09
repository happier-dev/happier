import { MEMORY_SESSION_SYSTEM_RECORD_KINDS, SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE } from '@happier-dev/protocol/sessions/system/records/memory/memorySystemRecordKinds';
import { SessionSynopsisV1Schema, type SessionSynopsisV1 } from '@happier-dev/protocol/messages/structured/sessionSynopsisV1';
import type { SessionSystemRecordStored } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import type { SessionStoredContentContext } from '@happier-dev/sync-client';

import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { openSessionSystemRecord } from '@/sync/domains/sessionSystemRecords/codec';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getAppliedActiveServerId } from '@/sync/runtime/orchestration/connectionManager';

const SYNOPSIS_KIND = MEMORY_SESSION_SYSTEM_RECORD_KINDS[1];

export type SessionSynopsesRead = Readonly<{
    status: 'ready' | 'loading' | 'unavailable'; synopses: readonly SessionSynopsisV1[];
}>;

async function openSynopses(records: readonly SessionSystemRecordStored[], context: SessionStoredContentContext | null): Promise<SessionSynopsesRead> {
    const opened = await Promise.all(records.map(record => openSessionSystemRecord<SessionSynopsisV1>({ record,
        address: { owner: 'host', namespace: SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE, kind: SYNOPSIS_KIND, localId: record.address.localId },
        context, decode: value => {
            const parsed = SessionSynopsisV1Schema.safeParse(value);
            return parsed.success ? { status: 'ready', value: parsed.data } : { status: 'malformed' };
        },
    })));
    return { status: opened.some(result => result.status !== 'ready') ? 'unavailable' : 'ready',
        synopses: opened.flatMap(result => result.status === 'ready' ? [result.value] : []) };
}

/** Finite Action read shares the observed repository, content codec and Account lifetime. */
export async function readSessionSynopses(session: SessionAddress): Promise<SessionSynopsesRead> {
    let result: SessionSynopsesRead = { status: 'unavailable', synopses: [] };
    const lifetime = captureActiveServerAccountScopeLifetime();
    const focused = areServerProfileIdentifiersEquivalent(getAppliedActiveServerId(), session.serverId);
    if (focused && !lifetime) return result;
    await getSyncSingleton().withSessionSystemRecordRuntime(session, async runtime => {
        if (!runtime.isCurrent() || (focused && (!lifetime?.isCurrent() || !areServerAccountScopesEqual(lifetime.scope, runtime.scope)))) return;
        const features = await getServerFeaturesSnapshot({ serverId: session.serverId });
        if (features.status !== 'ready' || !features.features.capabilities.session.systemRecords?.protocolVersions?.includes(1)) return;
        const query = { type: 'list' as const, namespace: SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE, kind: SYNOPSIS_KIND };
        await runtime.repository.refresh(session, query);
        if (!runtime.isCurrent() || (focused && !lifetime?.isCurrent())) return;
        const snapshot = runtime.repository.getSnapshot(session, query);
        if (!snapshot.data || snapshot.lastError) return;
        const opened = await openSynopses(snapshot.data.records, runtime.readContentContext());
        if (runtime.isCurrent() && (!focused || lifetime?.isCurrent())) result = opened;
    }).catch(() => undefined);
    return result;
}

/**
 * The memory worker's `session_synopsis.v1` records for one Session, read through the shared System
 * Record repository (the same owner the workflow snapshot reader uses) under the Session's exact Home.
 *
 * It emits every synopsis this viewer can open; the Recap resolver picks the latest. A Home that does
 * not serve System Records, a Session with memory off, or a read failure all emit nothing — the Recap
 * then falls back to the latest worker update, and nothing is shown as an error.
 */
export function observeSessionSynopses(params: Readonly<{
    session: SessionAddress;
    onChange: (synopses: readonly SessionSynopsisV1[], status: SessionSynopsesRead['status']) => void;
}>): () => void {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const emit = (synopses: readonly SessionSynopsisV1[], status: SessionSynopsesRead['status'] = 'unavailable') => {
        if (!cancelled) params.onChange(synopses, status);
    };
    const lifetime = captureActiveServerAccountScopeLifetime();
    // The focused Home remains applied while its runtime is unavailable; it must
    // not regain access through the retained repository's background-Home path.
    if (!lifetime && areServerProfileIdentifiersEquivalent(getAppliedActiveServerId(), params.session.serverId)) {
        emit([]);
        return () => { cancelled = true; };
    }
    const retirement = lifetime && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, params.session.serverId)
        ? lifetime.onRetire(() => {
            emit([]);
            cancelled = true;
            unsubscribe?.();
        }) : undefined;
    const sync = getSyncSingleton();
    void sync.withSessionSystemRecordRuntime(params.session, async (runtime) => {
        if (cancelled) return;
        if (lifetime && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, params.session.serverId)
            && !areServerAccountScopesEqual(lifetime.scope, runtime.scope)) { emit([]); return; }
        const features = await getServerFeaturesSnapshot({ serverId: params.session.serverId });
        if (cancelled || !runtime.isCurrent() || features.status !== 'ready') { emit([]); return; }
        const versions = features.features.capabilities.session.systemRecords?.protocolVersions ?? null;
        if (!versions || !versions.includes(1)) { emit([]); return; }
        const query = { type: 'list' as const, namespace: SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE, kind: SYNOPSIS_KIND };
        const project = async () => {
            if (cancelled) return;
            if (!runtime.isCurrent()) { emit([]); return; }
            const snapshot = runtime.repository.getSnapshot(params.session, query);
            const opened = snapshot.data ? await openSynopses(snapshot.data.records, runtime.readContentContext())
                : { status: snapshot.lastError ? 'unavailable' as const : 'loading' as const, synopses: [] };
            if (cancelled) return;
            if (!runtime.isCurrent()) { emit([]); return; }
            if (runtime.repository.getSnapshot(params.session, query) !== snapshot) return;
            emit(opened.synopses, snapshot.lastError && !snapshot.data ? 'unavailable' : opened.status);
        };
        const update = () => { void project().catch(() => emit([])); };
        unsubscribe = runtime.repository.subscribe(params.session, query, update);
        update();
        void runtime.repository.refresh(params.session, query);
    }).catch(() => emit([]));
    return () => { cancelled = true; unsubscribe?.(); retirement?.dispose(); };
}
