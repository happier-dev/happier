import { buildWorkflowRunSystemRecordLocalId } from '@happier-dev/protocol/sessions/system/records/activity/activitySystemRecordKinds';
import type { SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowRunSnapshotV1';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { openWorkflowRunSystemRecord } from '@/sync/domains/sessionActivity/sessionWorkflowActivityRecords';
import type { OpenSessionSystemRecordResult } from '@/sync/domains/sessionSystemRecords/codec';
import { selectWorkflowSystemRecordQuery } from '@/sync/domains/sessionSystemRecords/compatibility/legacyHostTransport';
import type { SessionSystemRecordFetchResult } from '@/sync/domains/sessionSystemRecords/transport';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';

type FetchFailure = Exclude<SessionSystemRecordFetchResult<never>, { status: 'ok' }>;
export type WorkflowRunSnapshotObservation =
    | Readonly<{ status: 'ready'; value: SessionWorkflowRunSnapshotV1; freshness: 'fresh' | 'stale'; lastError: FetchFailure | null }>
    | Exclude<OpenSessionSystemRecordResult<SessionWorkflowRunSnapshotV1>, { status: 'ready' }>
    | FetchFailure
    | Readonly<{ status: 'loading' }>;

/** One repository observation, including predecessor workflow reads, under exact Home authority. */
export function observeWorkflowRunSnapshot(params: Readonly<{
    session: SessionAddress;
    runId: string;
    onChange: (result: WorkflowRunSnapshotObservation) => void;
}>): () => void {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const emit = (result: WorkflowRunSnapshotObservation) => { if (!cancelled) params.onChange(result); };
    const sync = getSyncSingleton();
    void sync.withSessionSystemRecordRuntime(params.session, async (runtime) => {
        const features = await getServerFeaturesSnapshot({ serverId: params.session.serverId });
        if (cancelled) return;
        if (!runtime.isCurrent()) { emit({ status: 'forbidden' }); return; }
        if (features.status === 'error') {
            emit(features.reason === 'network' || features.reason === 'timeout' ? { status: 'offline' } : { status: 'protocol_unavailable' });
            return;
        }
        if (features.status === 'unsupported' && features.reason !== 'endpoint_missing') {
            emit({ status: 'invalid_response' });
            return;
        }
        const localId = buildWorkflowRunSystemRecordLocalId({ runId: params.runId });
        // This is protocol negotiation, never catch-and-fallback from a failed strict read.
        const selected = selectWorkflowSystemRecordQuery({
            localId,
            protocolVersions: features.status === 'ready'
                ? features.features.capabilities.session.systemRecords?.protocolVersions ?? null
                : null,
        });
        if (selected.status !== 'ready') { emit(selected); return; }
        const query = selected.query;
        const project = async () => {
            if (cancelled) return;
            if (!runtime.isCurrent()) { emit({ status: 'forbidden' }); return; }
            const snapshot = runtime.repository.getSnapshot(params.session, query);
            if (!snapshot.data) {
                emit(snapshot.lastError ?? { status: 'loading' });
                return;
            }
            const opened = await openWorkflowRunSystemRecord({
                runId: params.runId,
                record: snapshot.data,
                context: runtime.readContentContext(),
            });
            if (cancelled || runtime.repository.getSnapshot(params.session, query) !== snapshot) return;
            if (!runtime.isCurrent()) { emit({ status: 'forbidden' }); return; }
            emit(opened.status === 'ready' ? { ...opened, freshness: snapshot.freshness, lastError: snapshot.lastError } : opened);
        };
        const update = () => { void project().catch(() => emit({ status: 'invalid_response' })); };
        unsubscribe = runtime.repository.subscribe(params.session, query, update);
        update();
        // Metadata revision changes remount this observation. Refresh only this
        // workflow query; concurrent observations join its existing request.
        void runtime.repository.refresh(params.session, query);
    }).then((result) => {
        if (result.status !== 'ok') emit(result);
    }).catch(() => emit({ status: 'offline' }));
    return () => { cancelled = true; unsubscribe?.(); };
}
