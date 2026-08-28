import type { PluginActionInputById, PluginActionResultById } from './actions/index.js';
import type { JsonValue, PluginContributionRef } from './identity.js';
import type { PluginInvocationContext } from './invocation.js';

type SourcesListResult = PluginActionResultById['automation.event.sources.list'];
type SourceDefinition = Extract<SourcesListResult, Readonly<{ kind: 'page' }>>['definitions'][number];
type AdmitItemResult = PluginActionResultById['automation.event.admit']['results'][number];
type SourceStatusInput = Extract<
    PluginActionInputById['automation.event.source.status.report'],
    Readonly<{ kind: 'source' }>
>;

export type CheckpointedPluginEventObservationV1 = Readonly<{
    eventRef: PluginContributionRef;
    sourceInstanceId: string;
    sourceContractVersion: number;
    occurrenceId: string;
    occurredAt: number;
    observationReceivedAt: number;
    /** One only for the first durable observation attempt; retries report zero. */
    observedDelta: 0 | 1;
    payload: JsonValue;
}>;

export type CheckpointedPluginEventDispositionV1 = Readonly<{
    kind: 'checkpointSafe' | 'unsettled';
}>;

type CurrentSourceCatalog = Readonly<{
    revision: string;
    definitions: readonly SourceDefinition[];
}>;

async function readCurrentSourceDefinitions(
    context: PluginInvocationContext,
): Promise<CurrentSourceCatalog | null> {
    const definitions: SourceDefinition[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let revision: string | null = null;
    for (;;) {
        context.signal.throwIfAborted();
        const request: PluginActionInputById['automation.event.sources.list'] = {
            transport: { kind: 'checkpointedPull' },
            ...(cursor === undefined ? {} : { cursor }),
        };
        let result: SourcesListResult;
        try {
            result = await context.services.actions.execute(
                'automation.event.sources.list',
                request,
                { signal: context.signal },
            );
        } catch (error) {
            if (context.signal.aborted) throw error;
            return null;
        }
        context.signal.throwIfAborted();
        if (result.kind !== 'page' || (revision !== null && result.revision !== revision)) {
            return null;
        }
        revision ??= result.revision;
        definitions.push(...result.definitions);
        if (result.nextCursor === null) return { revision: result.revision, definitions };
        if (seenCursors.has(result.nextCursor)) return null;
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
    }
}

async function reportCurrentSourceCatalog(
    context: PluginInvocationContext,
    revision: string,
): Promise<void> {
    try {
        await context.services.actions.execute('automation.event.source.status.report', {
            kind: 'catalogReconciliation',
            scope: { kind: 'checkpointedPull' },
            observedRevision: revision,
            adoptedRevision: revision,
            state: 'current',
            scanStartedAt: null,
            nextRetryAt: null,
        }, { signal: context.signal });
        context.signal.throwIfAborted();
    } catch (error) {
        if (context.signal.aborted) throw error;
    }
}

function sourceStatusForAdmission(input: Readonly<{
    definition: SourceDefinition;
    result: AdmitItemResult | undefined;
    observationReceivedAt: number;
    observedDelta: 0 | 1;
}>): SourceStatusInput {
    const checkpointSafe = input.result?.checkpointSafe === true;
    const status = checkpointSafe
        ? { state: 'observing' as const, code: 'none' as const }
        : input.result?.kind === 'refreshDefinition'
            ? { state: 'attention' as const, code: 'definitionStale' as const }
            : input.result?.kind === 'blocked' && input.result.reason === 'capacity'
                ? { state: 'backingOff' as const, code: 'capacityBlocked' as const }
                : { state: 'backingOff' as const, code: 'admissionUnavailable' as const };
    return {
        kind: 'source',
        automationId: input.definition.automationId,
        triggerId: input.definition.triggerId,
        triggerRevision: input.definition.triggerRevision,
        eventRef: input.definition.eventRef,
        sourceSelectorId: input.definition.sourceSelectorId,
        state: status.state,
        code: status.code,
        lastObservedAt: input.observationReceivedAt,
        lastDispositionAt: checkpointSafe ? input.observationReceivedAt : null,
        nextRetryAt: null,
        observedDelta: input.observedDelta,
        admittedDelta: input.result?.kind === 'admitted' ? 1 : 0,
        skippedDelta: input.result?.kind === 'skipped' ? 1 : 0,
    };
}

async function reportAdmissionStatuses(input: Readonly<{
    context: PluginInvocationContext;
    definitions: readonly SourceDefinition[];
    results: readonly AdmitItemResult[];
    observationReceivedAt: number;
    observedDelta: 0 | 1;
}>): Promise<void> {
    for (let index = 0; index < input.definitions.length; index += 1) {
        try {
            await input.context.services.actions.execute(
                'automation.event.source.status.report',
                sourceStatusForAdmission({
                    definition: input.definitions[index]!,
                    result: input.results[index],
                    observationReceivedAt: input.observationReceivedAt,
                    observedDelta: input.observedDelta,
                }),
                { signal: input.context.signal },
            );
            input.context.signal.throwIfAborted();
        } catch (error) {
            if (input.context.signal.aborted) throw error;
        }
    }
}

/**
 * Resolves one checkpointed-pull observation against a complete, revision-stable
 * source scan and invokes canonical host admission. Status reporting is
 * observational: failures never change the checkpoint disposition, while
 * cancellation always propagates.
 */
export async function admitCheckpointedPluginEventObservationV1(
    observation: CheckpointedPluginEventObservationV1,
    context: PluginInvocationContext,
): Promise<CheckpointedPluginEventDispositionV1> {
    const catalog = await readCurrentSourceDefinitions(context);
    if (catalog === null) return { kind: 'unsettled' };
    await reportCurrentSourceCatalog(context, catalog.revision);
    const matchingDefinitions = catalog.definitions.filter((definition) => (
        definition.eventRef.pluginId === observation.eventRef.pluginId
        && definition.eventRef.localId === observation.eventRef.localId
        && definition.sourceInstanceId === observation.sourceInstanceId
        && definition.sourceContractVersion === observation.sourceContractVersion
    ));
    if (matchingDefinitions.length === 0) return { kind: 'checkpointSafe' };

    const admission: PluginActionInputById['automation.event.admit'] = {
        eventRef: observation.eventRef,
        occurrenceId: observation.occurrenceId,
        occurredAt: observation.occurredAt,
        observationReceivedAt: observation.observationReceivedAt,
        payload: observation.payload,
        definitions: matchingDefinitions.map((definition) => ({
            automationId: definition.automationId,
            triggerId: definition.triggerId,
            triggerRevision: definition.triggerRevision,
            sourceSelectorId: definition.sourceSelectorId,
        })),
    };
    let admitted: PluginActionResultById['automation.event.admit'];
    try {
        admitted = await context.services.actions.execute(
            'automation.event.admit',
            admission,
            { signal: context.signal },
        );
        context.signal.throwIfAborted();
    } catch (error) {
        if (context.signal.aborted) throw error;
        await reportAdmissionStatuses({
            context,
            definitions: matchingDefinitions,
            results: [],
            observationReceivedAt: observation.observationReceivedAt,
            observedDelta: observation.observedDelta,
        });
        return { kind: 'unsettled' };
    }
    await reportAdmissionStatuses({
        context,
        definitions: matchingDefinitions,
        results: admitted.results,
        observationReceivedAt: observation.observationReceivedAt,
        observedDelta: observation.observedDelta,
    });
    return admitted.results.length === matchingDefinitions.length
        && admitted.results.every((result) => result.checkpointSafe)
        ? { kind: 'checkpointSafe' }
        : { kind: 'unsettled' };
}
