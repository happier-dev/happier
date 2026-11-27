import type { DeploymentTelemetryServiceV1 } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { AutomationDatabaseSubjectV1 } from '@happier-dev/plugin-sdk/events';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import { CAPTURED_DATABASE_FINDING_EVENT_REF_V1, type CapturedDatabaseFindingV1,
    type DatabaseCaptureSourceV1 } from '@happier-dev/database-protocol';
import { projectCaptureFindings } from '../analysis/findings.js';
import { createCaptureReader } from '../read.js';
import type { CaptureRuntime } from '../runtime.js';
import { telemetryPartition, TELEMETRY_PARTITION_PREFIX } from './assignments.js';
import { databaseEndpointKey } from './databaseEndpoint.js';

type BindingSource = NonNullable<DeploymentTelemetryServiceV1['databaseBindings']>;
type BindingSnapshot = {
    matches?: ReadonlyMap<string, AutomationDatabaseSubjectV1 | null>;
};

export function startDatabaseFindingProjection(input: Readonly<{
    context: BackgroundServiceContext;
    runtime: CaptureRuntime;
    source: BindingSource;
    serverId: string;
    machineId: string;
}>) {
    const { context, runtime, source, serverId, machineId } = input;
    const reader = createCaptureReader(runtime.store);
    const bindings = new Map<string, BindingSnapshot>();
    const pending = new Set<Promise<void>>();
    const report = () => {
        if (!context.signal.aborted) context.services.logger.warn('Database Capture finding delivery is unavailable');
    };
    function retain(operation: Promise<void>) {
        const tracked = operation.catch(report).finally(() => pending.delete(tracked));
        pending.add(tracked);
    }
    function refresh(environmentId: string) {
        const snapshot: BindingSnapshot = {};
        bindings.set(environmentId, snapshot);
        retain(source.read(environmentId, context.signal).then(rows => {
            const matches = new Map<string, AutomationDatabaseSubjectV1 | null>();
            for (const row of rows) {
                const key = databaseEndpointKey(row);
                matches.set(key, matches.has(key) ? null : row.subject);
            }
            snapshot.matches = matches;
        }));
    }
    const unsubscribe = source.subscribeChanged(change => {
        for (const id of change.kind === 'changes' ? change.environmentIds : bindings.keys()) {
            if (!bindings.has(id)) continue;
            if (change.kind === 'retired') bindings.set(id, {});
            else refresh(id);
        }
    });
    return {
        assignmentsChanged(environmentIds: readonly string[]) {
            const assigned = new Set(environmentIds);
            for (const id of bindings.keys()) if (!assigned.has(id)) bindings.delete(id);
            for (const id of assigned) if (!bindings.has(id)) refresh(id);
        },
        tracesCommitted(partition: string, traceIds: readonly string[]) {
            const environmentId = partition.slice(TELEMETRY_PARTITION_PREFIX.length);
            const snapshot = bindings.get(environmentId);
            if (!snapshot?.matches?.size || partition !== telemetryPartition(environmentId)) return;
            const matches = snapshot.matches;
            const captureSource: DatabaseCaptureSourceV1 = { kind: 'environment', environmentId, serverId };
            const sourceScope = { serverId, machineId };
            const receivedAt = Date.now();
            retain((async () => {
                for (const traceId of traceIds) {
                    if (context.signal.aborted || bindings.get(environmentId) !== snapshot) return;
                    const observations = await runtime.ingest.exclusive(async () => {
                        const pageSize = PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumResultRows;
                        const trace = await reader.trace({ worktree: partition, traceId, pageSize });
                        if (!trace.repeatedQueries.length) return [];
                        const endpointKeys = await runtime.store.traceDatabaseEndpointKeys(partition, traceId);
                        const exactRepetitions = trace.repeatedQueries.filter(repetition => {
                            const key = endpointKeys.get(repetition.observationIds[0]);
                            return key !== undefined && matches.get(key)
                                && repetition.observationIds.every(id => endpointKeys.get(id) === key);
                        });
                        const result: CapturedDatabaseFindingV1[] = [];
                        projectCaptureFindings({
                            source: captureSource, sourceScope, pageSize, coverage: runtime.ingest.coverage(partition),
                        }, trace.summaries, exactRepetitions, (finding, repetition) => {
                            const key = endpointKeys.get(repetition.observationIds[0]);
                            const subject = key === undefined ? undefined : matches.get(key);
                            if (!subject) return;
                            const { v, sourceRef, evidenceIdentity, observedWindow, coverage, summary } = finding;
                            result.push({ subject, observationReceivedAt: receivedAt, observedDelta: 1,
                                observation: { v, sourceRef, sourceScope, evidenceIdentity, kind: repetition.kind, observedWindow, coverage, summary } });
                        });
                        return result;
                    });
                    if (context.signal.aborted || bindings.get(environmentId) !== snapshot) return;
                    for (const observation of observations) {
                        await context.services.events.plugin.emit(CAPTURED_DATABASE_FINDING_EVENT_REF_V1.localId, observation);
                    }
                }
            })());
        },
        async stop() {
            unsubscribe();
            bindings.clear();
            await Promise.all(pending);
        },
    };
}
