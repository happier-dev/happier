import { computeCanonicalDomainSeparatedDigest, createCanonicalJsonSigningInput, type DeploymentTelemetryServiceV1 } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { RepeatedQueryEvidence } from '../analysis/requests.js';
import { automationSubjectKeyV1, type AutomationDatabaseFindingSubjectV1 } from '@happier-dev/plugin-sdk/events';
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
    matches?: ReadonlyMap<string, AutomationDatabaseFindingSubjectV1 | null>;
};

type FindingTrace = Awaited<ReturnType<ReturnType<typeof createCaptureReader>['trace']>>;
export type WorktreeFindingSubjects = ReadonlyMap<string, AutomationDatabaseFindingSubjectV1>;

export function createDatabaseFindingPublisher(runtime: CaptureRuntime, context: Pick<BackgroundServiceContext, 'signal'> & {
    services: { events: Pick<BackgroundServiceContext['services']['events'], 'plugin'> };
}) {
    const reader = createCaptureReader(runtime.store);
    return async (input: Readonly<{
        source: DatabaseCaptureSourceV1;
        sourceScope: CapturedDatabaseFindingV1['observation']['sourceScope'];
        partition: string;
        traceIds: readonly string[];
        isCurrent?: () => boolean;
        selectSubjects(trace: FindingTrace): ReadonlyMap<RepeatedQueryEvidence, AutomationDatabaseFindingSubjectV1>
            | Promise<ReadonlyMap<RepeatedQueryEvidence, AutomationDatabaseFindingSubjectV1>>;
    }>): Promise<void> => {
        const { source, sourceScope, partition, isCurrent } = input;
        const observationReceivedAt = Date.now();
        const stillActive = () => !context.signal.aborted && isCurrent?.() !== false;
        async function project(traceId: string) {
            const result: { finding: CapturedDatabaseFindingV1; evidenceIds: readonly string[] }[] = [];
            if (!stillActive()) return result;
            const pageSize = PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumResultRows;
            const trace = await reader.trace({ worktree: partition, traceId, pageSize,
                includeWorktreeRepetitions: source.kind === 'worktree' });
            const selected = await input.selectSubjects(trace);
            if (!selected.size) return result;
            projectCaptureFindings({ source, sourceScope, pageSize, coverage: runtime.ingest.coverage(partition) },
                trace.summaries, [...selected.keys()], (finding, repetition) => {
                    const subject = selected.get(repetition);
                    if (!subject) return;
                    const { v, sourceRef, observedWindow, coverage, summary } = finding;
                    const evidenceIdentity = computeCanonicalDomainSeparatedDigest('happier.database.capture-binding-shape.v1', [
                        automationSubjectKeyV1(subject), repetition.shape,
                    ]);
                    result.push({ evidenceIds: repetition.observationIds,
                        finding: { subject, observationReceivedAt, observedDelta: 1,
                            observation: { v, sourceRef, sourceScope, evidenceIdentity, kind: repetition.kind, observedWindow, coverage, summary } } });
                });
            return result;
        }
        for (const traceId of input.traceIds) {
            // Wire capture drops observations while the writer is busy. Worktree analysis
            // only needs that writer to order genuine findings with Capture Clear.
            const worktreeFindings = source.kind === 'worktree' ? await project(traceId) : undefined;
            if (worktreeFindings?.length === 0) continue;
            await runtime.ingest.exclusive(async () => {
                const projected = worktreeFindings ?? await project(traceId);
                if (!projected.length || !stillActive()) return;
                // Clear may have run during the Worktree scan. Only the exact wire evidence can admit the Event.
                const retained = worktreeFindings && await runtime.store.traceWorktreeMemberKeys(partition, traceId);
                if (!stillActive()) return;
                for (const { finding, evidenceIds } of projected) {
                    if (retained && !evidenceIds.every(id => retained.has(id))) continue;
                    const { evidenceIdentity, observedWindow } = finding.observation;
                    // The ingest writer serializes first observation with both replay and Clear.
                    // Workbench forwards the stable identity to Home for Event and Run dedupe.
                    if (!await runtime.store.hasDatabaseFinding(partition, evidenceIdentity)) {
                        await context.services.events.plugin.emit(CAPTURED_DATABASE_FINDING_EVENT_REF_V1.localId, finding);
                    }
                    await runtime.store.retainDatabaseFindingOccurrence(partition, evidenceIdentity, traceId, observedWindow.toMs);
                }
            });
        }
    };
}

export function selectWorktreeFindingSubjects(trace: FindingTrace, members: WorktreeFindingSubjects) {
    const selected = new Map<RepeatedQueryEvidence, AutomationDatabaseFindingSubjectV1>();
    for (const repetition of trace.worktreeRepetitions ?? []) {
        const subject = members.get(createCanonicalJsonSigningInput(repetition.databaseTarget));
        if (subject) selected.set(repetition, subject);
    }
    return selected;
}

export function startDatabaseFindingProjection(input: Readonly<{
    context: BackgroundServiceContext;
    runtime: CaptureRuntime;
    source: BindingSource;
    serverId: string;
    machineId: string;
}>) {
    const { context, runtime, source, serverId, machineId } = input;
    const publish = createDatabaseFindingPublisher(runtime, context);
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
            const matches = new Map<string, AutomationDatabaseFindingSubjectV1 | null>();
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
            retain(publish({ source: { kind: 'environment', environmentId, serverId }, sourceScope: { serverId, machineId },
                partition, traceIds, isCurrent: () => bindings.get(environmentId) === snapshot,
                async selectSubjects(trace) {
                    const selected = new Map<RepeatedQueryEvidence, AutomationDatabaseFindingSubjectV1>();
                    if (!trace.repeatedQueries.length) return selected;
                    const endpointKeys = await runtime.store.traceDatabaseEndpointKeys(partition, trace.traceId);
                    for (const repetition of trace.repeatedQueries) {
                        const key = endpointKeys.get(repetition.observationIds[0]);
                        const subject = key === undefined ? undefined : matches.get(key);
                        if (subject && repetition.observationIds.every(id => endpointKeys.get(id) === key)) {
                            selected.set(repetition, subject);
                        }
                    }
                    return selected;
                },
            }));
        },
        async stop() {
            unsubscribe();
            bindings.clear();
            await Promise.all(pending);
        },
    };
}
