import { arePluginMachineMaterializationRefsEqual } from '@happier-dev/plugin-sdk';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import { readProductionCaptureFindingGroupKeyV1 } from '@happier-dev/database-protocol';
import {
    runCheckpointedPluginEventObserverV1, type BackgroundServiceContext, type PluginCheckpointedEventSourceAdapterV1,
} from '@happier-dev/plugin-sdk/background-services';
import { createCaptureReader } from '../read.js';
import { projectCaptureFindings } from '../analysis/findings.js';
import type { CaptureRuntime } from '../runtime.js';
import { telemetryPartition } from './assignments.js';
import { productionFindingEventParts, productionFindingObservation, productionFindingSourceInstanceId } from './productionFindingEvent.js';

type SourceConfig = ReturnType<typeof productionFindingEventParts.configSchema.parse>;
type ArmedSource = { sourceInstanceId: string; pendingTraces: Set<string> };

export function startProductionFindingObserver(
    input: Readonly<{ context: BackgroundServiceContext; serverId: string; machineId: string; runtime: CaptureRuntime }>,
) {
    const { context, serverId, machineId, runtime } = input;
    const reader = createCaptureReader(runtime.store);
    const armed = new Map<string, ArmedSource>();
    let wake: ((sourceInstanceId?: string) => Promise<void>) | undefined;
    const source: PluginCheckpointedEventSourceAdapterV1<SourceConfig, string> = {
        checkpointOnOccurrenceConflict: true,
        decode(definition) {
            if (definition.eventRef.localId !== productionFindingEventParts.eventRef.localId) return null;
            const parsed = productionFindingEventParts.configSchema.safeParse(definition.sourceConfig);
            return parsed.success && parsed.data.subject.serverId === serverId
                && productionFindingSourceInstanceId(parsed.data.subject) === definition.sourceInstanceId ? parsed.data : null;
        },
        observe: async ({ source: { subject }, definition }) => {
            const partition = telemetryPartition(subject.environmentId);
            const state = armed.get(partition) ?? { sourceInstanceId: definition.sourceInstanceId, pendingTraces: new Set<string>() };
            armed.set(partition, state);
            const current = await runtime.ingest.exclusive(async () => {
                const traces = Array.from(state.pendingTraces);
                for (const traceId of traces) {
                    const pageSize = PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumResultRows;
                    const trace = await reader.trace({ worktree: partition, traceId, pageSize });
                    const findings = projectCaptureFindings({
                        source: subject, sourceScope: { serverId, machineId }, pageSize, coverage: runtime.ingest.coverage(partition),
                    }, trace.summaries, []);
                    const observations = findings.flatMap(finding => {
                        const observation = productionFindingObservation(subject, finding, Date.now());
                        return observation ? [observation] : [];
                    });
                    await runtime.store.retainProductionFindings(partition, observations);
                    state.pendingTraces.delete(traceId);
                }
                // An earlier collector may have queued a database finding before the new owner was installed.
                for (;;) {
                    const pending = await runtime.store.pendingProductionFinding(partition);
                    if (!pending) return undefined;
                    const captured = productionFindingEventParts.payloadSchema.safeParse(pending.payload);
                    if (captured.success && readProductionCaptureFindingGroupKeyV1(captured.data.observation)) return pending;
                    await runtime.store.settleProductionFinding(partition, pending.occurrenceId);
                }
            });
            return current ? {
                observations: [current], checkpoint: current.occurrenceId, complete: true, nextEligibleAt: null,
            } : { observations: [], complete: true, nextEligibleAt: null };
        },
        async save({ source: { subject }, definition, checkpoint }) {
            await runtime.store.settleProductionFinding(telemetryPartition(subject.environmentId), checkpoint);
            // Only a settled checkpoint can advance the queue. An unsettled admission waits for a source wake.
            void wake?.(definition.sourceInstanceId).catch(() => {});
        },
        async retire({ definitions }) {
            const own = context.materialization;
            if (!own) return { complete: true };
            const active = new Set(definitions.filter(definition =>
                definition.eventRef.localId === productionFindingEventParts.eventRef.localId
                && definition.observationTransport.kind === 'checkpointedPull'
                && arePluginMachineMaterializationRefsEqual(own, definition.observationTransport.watcherMaterializationRef)).map(definition => definition.sourceInstanceId));
            for (const [partition, state] of armed) if (!active.has(state.sourceInstanceId)) armed.delete(partition);
            return { complete: true };
        },
        retryAt: () => null,
        subscribeWake(receive) {
            wake = receive;
            return { dispose() { wake = undefined; armed.clear(); } };
        },
    };
    const running = runCheckpointedPluginEventObserverV1({ context, source });
    return {
        running,
        tracesCommitted(partition: string, traceIds: readonly string[]) {
            const state = armed.get(partition);
            if (!state || traceIds.length === 0) return;
            for (const traceId of traceIds) state.pendingTraces.add(traceId);
            void wake?.(state.sourceInstanceId).catch(() => {});
        },
    };
}
