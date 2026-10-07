import { MEMORY_SESSION_SYSTEM_RECORD_KINDS, SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE } from '@happier-dev/protocol/sessions/system/records/memory/memorySystemRecordKinds';
import { SessionSynopsisV1Schema, type SessionSynopsisV1 } from '@happier-dev/protocol/messages/structured/sessionSynopsisV1';

import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { openSessionSystemRecord } from '@/sync/domains/sessionSystemRecords/codec';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getAppliedActiveServerId } from '@/sync/runtime/orchestration/connectionManager';

const SYNOPSIS_KIND = MEMORY_SESSION_SYSTEM_RECORD_KINDS[1];

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
    onChange: (synopses: readonly SessionSynopsisV1[]) => void;
}>): () => void {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const emit = (synopses: readonly SessionSynopsisV1[]) => { if (!cancelled) params.onChange(synopses); };
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
        if (cancelled || !runtime.isCurrent() || features.status !== 'ready') return;
        const versions = features.features.capabilities.session.systemRecords?.protocolVersions ?? null;
        if (!versions || !versions.includes(1)) return;
        const query = { type: 'list' as const, namespace: SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE, kind: SYNOPSIS_KIND };
        const project = async () => {
            if (cancelled) return;
            if (!runtime.isCurrent()) { emit([]); return; }
            const snapshot = runtime.repository.getSnapshot(params.session, query);
            const records = snapshot.data?.records ?? [];
            const opened = await Promise.all(records.flatMap((record) => (record.address.owner === 'host' ? [record] : [])).map(
                async (record) => await openSessionSystemRecord<SessionSynopsisV1>({
                    record,
                    address: { owner: 'host', namespace: SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE, kind: SYNOPSIS_KIND, localId: record.address.localId },
                    context: runtime.readContentContext(),
                    decode: (value) => {
                        const parsed = SessionSynopsisV1Schema.safeParse(value);
                        return parsed.success ? { status: 'ready' as const, value: parsed.data } : { status: 'malformed' as const };
                    },
                }),
            ));
            if (cancelled) return;
            if (!runtime.isCurrent()) { emit([]); return; }
            if (runtime.repository.getSnapshot(params.session, query) !== snapshot) return;
            emit(opened.flatMap((result) => (result.status === 'ready' ? [result.value] : [])));
        };
        const update = () => { void project().catch(() => emit([])); };
        unsubscribe = runtime.repository.subscribe(params.session, query, update);
        update();
        void runtime.repository.refresh(params.session, query);
    }).catch(() => emit([]));
    return () => { cancelled = true; unsubscribe?.(); retirement?.dispose(); };
}
