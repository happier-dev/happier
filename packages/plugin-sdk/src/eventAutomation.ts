import {
    AutomationEventSourcesListResultV1Schema,
    isAutomationEventSourcesListPageProgressingV1,
} from '@happier-dev/protocol/automations/event';

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

/**
 * The one observation-transport scope a provider-side admission bridge runs
 * under. It selects the source-catalog listing transport and the durable
 * catalog-status scope; occurrence admission itself is transport-independent.
 */
export type PluginEventObservationScopeV1 = Readonly<{
    kind: 'checkpointedPull';
} | {
    kind: 'socket';
}>;

export type PluginEventObservationV1 = Readonly<{
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

export type PluginEventDispositionV1 = Readonly<{
    kind: 'checkpointSafe' | 'unsettled';
}>;

/**
 * The connection-owned transport truth a provider may project onto its
 * current Automation sources. Channels and other transport owners decide
 * this fact; Automations remains the sole status-row persistence owner.
 */
export type PluginEventSourceConnectionStatusV1 = 'ready' | 'reconnecting' | 'historyGap';

export type PluginEventSourceConnectionStatusProjectionV1 = Readonly<{
    eventRef: PluginContributionRef;
    sourceContractVersion: number;
    /**
     * One provider-connection source-identity root, including its terminal
     * delimiter. The provider owns this opaque identity grammar; the shared
     * helper only scans current definitions and exact-prefix selects it.
     */
    sourceInstanceIdPrefix: string;
    scope: PluginEventObservationScopeV1;
    status: PluginEventSourceConnectionStatusV1;
}>;

type CurrentSourceCatalog = Readonly<{
    revision: string;
    definitions: readonly SourceDefinition[];
}>;

async function readCurrentSourceDefinitions(
    context: PluginInvocationContext,
    scope: PluginEventObservationScopeV1,
): Promise<CurrentSourceCatalog | null> {
    const definitions: SourceDefinition[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let revision: string | null = null;
    for (;;) {
        context.signal.throwIfAborted();
        const request: PluginActionInputById['automation.event.sources.list'] = {
            transport: scope,
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
        const canonicalResult = AutomationEventSourcesListResultV1Schema.safeParse(result);
        if (
            !canonicalResult.success
            || canonicalResult.data.kind !== 'page'
            || (revision !== null && canonicalResult.data.revision !== revision)
            || !isAutomationEventSourcesListPageProgressingV1(canonicalResult.data)
        ) {
            return null;
        }
        revision ??= canonicalResult.data.revision;
        definitions.push(...canonicalResult.data.definitions);
        if (canonicalResult.data.nextCursor === null) {
            return { revision: canonicalResult.data.revision, definitions };
        }
        if (seenCursors.has(canonicalResult.data.nextCursor)) return null;
        seenCursors.add(canonicalResult.data.nextCursor);
        cursor = canonicalResult.data.nextCursor;
    }
}

async function reportCurrentSourceCatalog(
    context: PluginInvocationContext,
    revision: string,
    scope: PluginEventObservationScopeV1,
): Promise<void> {
    try {
        await context.services.actions.execute('automation.event.source.status.report', {
            kind: 'catalogReconciliation',
            scope,
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

function sourceStatusForConnection(input: Readonly<{
    definition: SourceDefinition;
    status: PluginEventSourceConnectionStatusV1;
}>): SourceStatusInput {
    const state = input.status === 'ready'
        ? { state: 'observing' as const, code: 'none' as const }
        : input.status === 'historyGap'
            ? { state: 'attention' as const, code: 'historyGap' as const }
            : { state: 'backingOff' as const, code: 'admissionUnavailable' as const };
    return {
        kind: 'source',
        automationId: input.definition.automationId,
        triggerId: input.definition.triggerId,
        triggerRevision: input.definition.triggerRevision,
        eventRef: input.definition.eventRef,
        sourceSelectorId: input.definition.sourceSelectorId,
        state: state.state,
        code: state.code,
        nextRetryAt: null,
        observedDelta: 0,
        admittedDelta: 0,
        skippedDelta: 0,
    };
}

async function reportConnectionStatuses(input: Readonly<{
    context: PluginInvocationContext;
    definitions: readonly SourceDefinition[];
    status: PluginEventSourceConnectionStatusV1;
}>): Promise<void> {
    for (const definition of input.definitions) {
        try {
            await input.context.services.actions.execute(
                'automation.event.source.status.report',
                sourceStatusForConnection({ definition, status: input.status }),
                { signal: input.context.signal },
            );
            input.context.signal.throwIfAborted();
        } catch (error) {
            if (input.context.signal.aborted) throw error;
        }
    }
}

/**
 * Reuses the admission bridge's complete revision-stable source scan for an
 * idle connection. It reports catalog currentness and only the current
 * trigger definitions belonging to the provider-owned connection source root;
 * it neither observes occurrences nor owns connection health or status rows.
 */
export async function projectPluginEventSourceConnectionStatusV1(
    input: PluginEventSourceConnectionStatusProjectionV1,
    context: PluginInvocationContext,
): Promise<void> {
    if (input.sourceInstanceIdPrefix.length === 0) {
        throw new Error('A connection source-status projection requires a non-empty source identity prefix.');
    }
    const catalog = await readCurrentSourceDefinitions(context, input.scope);
    if (catalog === null) return;
    await reportCurrentSourceCatalog(context, catalog.revision, input.scope);
    await reportConnectionStatuses({
        context,
        definitions: catalog.definitions.filter((definition) => (
            definition.eventRef.pluginId === input.eventRef.pluginId
            && definition.eventRef.localId === input.eventRef.localId
            && definition.sourceContractVersion === input.sourceContractVersion
            && definition.sourceInstanceId.startsWith(input.sourceInstanceIdPrefix)
        )),
        status: input.status,
    });
}

/**
 * Shared admission core: resolves one observation against a complete,
 * revision-stable source scan under one observation-transport scope and
 * invokes canonical host admission. Status reporting is observational:
 * failures never change the disposition, while cancellation always propagates.
 * The caller owns the transport truthfulness of its declared source.
 */
async function admitPluginEventObservationUnderScopeV1(
    observation: PluginEventObservationV1,
    context: PluginInvocationContext,
    scope: PluginEventObservationScopeV1,
): Promise<PluginEventDispositionV1> {
    const catalog = await readCurrentSourceDefinitions(context, scope);
    if (catalog === null) return { kind: 'unsettled' };
    await reportCurrentSourceCatalog(context, catalog.revision, scope);
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

/**
 * Admits one observation of a `checkpointedPull` Event source: the provider
 * owns an ordered provider cursor and advances its durable provider checkpoint
 * only after every admission here returns checkpoint-safe.
 */
export async function admitCheckpointedPluginEventObservationV1(
    observation: PluginEventObservationV1,
    context: PluginInvocationContext,
): Promise<PluginEventDispositionV1> {
    return admitPluginEventObservationUnderScopeV1(observation, context, { kind: 'checkpointedPull' });
}

/**
 * Admits one observation of a session-`socket` Event source: the provider
 * observes through its own long-lived session-bound connection and owns no
 * ordered provider pull checkpoint. Admission still dedupes by occurrence
 * identity; an unsettled result leaves retry/custody with the caller's
 * existing observation owner. The socket itself promises no replay, and
 * history gaps are reported through that transport-fact owner rather than
 * through a checkpoint.
 */
export async function admitSessionSocketPluginEventObservationV1(
    observation: PluginEventObservationV1,
    context: PluginInvocationContext,
): Promise<PluginEventDispositionV1> {
    return admitPluginEventObservationUnderScopeV1(observation, context, { kind: 'socket' });
}
