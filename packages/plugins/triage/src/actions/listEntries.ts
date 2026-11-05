import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';
import type { LoggerService, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { AdmittedTargetedOperationExecutionHandle } from '@happier-dev/plugin-sdk/actions';
import {
    admitTriageSourceDescriptorV1,
    TriageListScopeUnitsResultV1Schema,
    type TriageListScopeUnitsInputV1,
    type TriageListScopeUnitsResultV1,
    type TriageScanInputV1,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import {
    readActiveConfiguredSourceRowPage,
    readActiveConfiguredSourceRows,
} from '../corpus/configuration/readConfiguredSourceRows.js';
import type { CorpusCollectionHandleV1 } from '../corpus/collections/handles.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import {
    CORPUS_DEFAULT_SMART_POLICY_V1,
    parseCorpusSmartPolicy,
} from '../corpus/query/smartPolicy.js';
import {
    TRIAGE_LIST_NO_FILTERS_V1,
    foldTriageListWindow,
    triageListCoverageLanes,
    type TriageListIntendedSourceV1,
    type TriageListLensV1,
    type TriageListWindowV1,
} from '../projection/listWindow.js';
import { toTriageListWireRows } from '../projection/listWindowWire.js';
import {
    runTriageScanPass,
    type TriageScanLaneV1,
} from '../projection/scanPass.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import {
    MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
    triageListRowBudgetV1,
    type TriageListEntriesInputV1,
    type TriageListEntriesResultV1,
} from './listEntriesProtocol.js';

/**
 * The one aggregate PRs & Issues list Action.
 *
 * This is the composed vertical the surface actually opens: it enumerates the
 * configured source instances from their durable Collection, binds each to the
 * admitted V1 source contribution that can be invoked for it, walks every lane's
 * `scan` through the published protocol, and folds the qualified observations
 * into one bounded ordered window through the single projection owner.
 *
 * It persists nothing provider-derived. The only Collection it touches is
 * `source-instances`, and it only reads it.
 */

/** The admitted V1 source contribution shape this target observes at its own point. */
export type TriageAdmittedSourceV1 =
    NonNullable<(typeof TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1)['__targetedContribution']>;

/**
 * The host-owned execution of one admitted operation handle. Only the original
 * host-created handle carries authority, so it is passed through untouched.
 */
/**
 * The admitted view, keyed the one way this plugin addresses a source.
 *
 * Three readers ask the same question — the aggregate list binds each configured
 * connection to its contribution, the Composer resolves an attached entry
 * through its own source's `get`, and the detail read names that source in the
 * source's own words — and each spelled the join itself. One of them indexing
 * on `contributor.pluginId` alone would mount one source's contribution under
 * another's contribution id, so the key is the same qualified id the configured
 * row is stored under and there is one owner of it.
 */
export function indexTriageAdmittedSourcesV1(
    admitted: readonly TriageAdmittedSourceV1[],
): ReadonlyMap<string, TriageAdmittedSourceV1> {
    const byQualifiedId = new Map<string, TriageAdmittedSourceV1>();
    for (const contribution of admitted) {
        if (!admitTriageSourceDescriptorV1(contribution.descriptor).ok) continue;
        byQualifiedId.set(renderSourceQualifiedId({
            pluginId: contribution.contributor.pluginId,
            localId: contribution.contributor.contributionId,
        }), contribution);
    }
    return byQualifiedId;
}

export type TriageAdmittedOperationExecutorV1 = (
    operation: AdmittedTargetedOperationExecutionHandle<TriageScanInputV1, TriageScanResultV1, 'scan'>,
    input: TriageScanInputV1,
    options?: PluginCancellationOptions,
) => Promise<TriageScanResultV1>;

export type TriageListEntriesDepsV1 = Readonly<{
    /** The `source-instances` Collection. This Action never writes it. */
    sourceInstances: Pick<CorpusCollectionHandleV1, 'query'>;
    /** The current admitted view of this target's own sources point. */
    readAdmittedSources: (options?: PluginCancellationOptions) => Promise<readonly TriageAdmittedSourceV1[]>;
    executeScan: TriageAdmittedOperationExecutorV1;
    executeScopeUnits?: (
        operation: AdmittedTargetedOperationExecutionHandle<TriageListScopeUnitsInputV1, TriageListScopeUnitsResultV1, 'listScopeUnits'>,
        input: TriageListScopeUnitsInputV1,
        options?: PluginCancellationOptions,
    ) => Promise<TriageListScopeUnitsResultV1>;
    nowMs: () => number;
    logger?: Pick<LoggerService, 'warn'>;
    signal?: AbortSignal;
    /** Tasks is a lens over this same scan/window owner. */
    taskOnly?: boolean;
}>;

function lensFrom(
    input: TriageListEntriesInputV1,
    /** The lanes this request will actually walk, and so the frontiers it may return. */
    laneCount: number,
    taskOnly = false,
): TriageListLensV1 {
    return {
        ...(!taskOnly || input.tasks === undefined ? {} : { tasks: input.tasks }),
        order: input.order,
        // The one closed policy owner decides. An omitted or unrecognized
        // ladder resolves to the retained default rather than to no order at
        // all, and it is never repaired into a nearby one.
        smartPolicy: parseCorpusSmartPolicy(input.smartPolicy) ?? CORPUS_DEFAULT_SMART_POLICY_V1,
        query: input.query ?? '',
        filters: input.filters ?? TRIAGE_LIST_NO_FILTERS_V1,
        // The explicit row bound of one result, applied by its owner.
        // The projection bounds by the lens it is given — a mounted store folds
        // its whole accumulated page through the same owner and crosses no wire
        // — so the per-invocation contract is enforced here, beside the array
        // whose `maxItems` would otherwise be the only thing that noticed.
        limit: Math.max(0, Math.min(input.limit, triageListRowBudgetV1(laneCount))),
    };
}

function selectionAdmits(input: TriageListEntriesInputV1, sourceInstanceId: string): boolean {
    return input.sources.kind === 'allConfigured'
        || input.sources.sourceInstanceIds.includes(sourceInstanceId);
}

function walkAdmits(input: TriageListEntriesInputV1, sourceInstanceId: string): boolean {
    return selectionAdmits(input, sourceInstanceId)
        && (input.sources.kind !== 'allConfigured' || input.resume === undefined
            || input.resume.some((frontier) => frontier.sourceInstanceId === sourceInstanceId));
}

/**
 * The lane frontiers this request carries in, keyed the one way a lane is
 * addressed.
 *
 * A token naming a connection this request does not walk is simply never looked
 * up. That is deliberate: a stale frontier is not a malformed request, and
 * refusing the invocation over one would cost the caller their whole list —
 * the whole-result rejection `PLAN.md` §0a A9 names as the harm.
 */
function resumeByInstanceId(
    input: TriageListEntriesInputV1,
): ReadonlyMap<string, NonNullable<TriageListEntriesInputV1['resume']>[number]> {
    const byInstance = new Map<
        string,
        NonNullable<TriageListEntriesInputV1['resume']>[number]
    >();
    for (const entry of input.resume ?? []) {
        byInstance.set(entry.sourceInstanceId, entry);
    }
    return byInstance;
}

/**
 * One assembled pass, before any wire projection.
 *
 * The list Action projects it to its own bounded wire rows; the search Action
 * projects the same rows to bounded search items. Both read the SAME assembled
 * window, so a query cannot find in one surface what it cannot find in the
 * other, and neither owns a second scan, fold, order or matcher.
 */
export type TriageAssembledListPassV1 = Readonly<{
    configuredSources: TriageListEntriesResultV1['configuredSources'];
    configuredSourcesStatus: 'complete' | 'truncated';
    configuredSourcesNextCursor?: string;
    window: TriageListWindowV1;
    /** Absent when no walked lane stopped with more to give. */
    continuations?: TriageListEntriesResultV1['window']['continuations'];
}>;

export async function assembleTriageListPass(
    input: TriageListEntriesInputV1,
    deps: TriageListEntriesDepsV1,
): Promise<TriageAssembledListPassV1> {
    const options: PluginCancellationOptions | undefined = deps.signal ? { signal: deps.signal } : undefined;
    const resumeByInstance = resumeByInstanceId(input);
    const sources = input.sources;
    // Own both rejections before yielding: admission can fail during plugin
    // retirement while Account storage is pending, and either read can fail first.
    const [configured, admitted] = await Promise.all([
        sources.kind === 'allConfigured'
            ? readActiveConfiguredSourceRowPage(deps.sourceInstances, {
                limit: MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
                ...(sources.cursor === undefined ? {} : { cursor: sources.cursor }),
            }, options)
            : readActiveConfiguredSourceRows(deps.sourceInstances, options),
        deps.readAdmittedSources(options),
    ]);
    const configuredRows = sources.kind === 'allConfigured'
        ? configured.rows
        : configured.rows.filter((row) => sources.sourceInstanceIds.includes(
            row.configured.instance.sourceInstanceId,
        ));
    const configuredRecords = sources.kind === 'allConfigured'
        ? configured.records
        : configured.records.filter((record) => sources.sourceInstanceIds.includes(
            record.value.configured.instance.sourceInstanceId,
        ));
    const configuredSourcesStatus = configured.status;
    const configuredSourcesNextCursor = 'nextCursor' in configured ? configured.nextCursor : undefined;

    const admittedByQualifiedId = indexTriageAdmittedSourcesV1(admitted);

    const configuredSources: TriageListEntriesResultV1['configuredSources'][number][] = [];
    /** Every instance this request set out to cover, invocable or not. */
    const intended: TriageListIntendedSourceV1[] = [];
    const lanes: TriageScanLaneV1[] = [];
    const unknownCompletedCoverage = new Set<string>();
    const configurationRevisionBySourceInstanceId = new Map(configuredRecords.map((record) => [
        record.value.configured.instance.sourceInstanceId,
        record.revision,
    ]));
    const contributionGenerationBySourceInstanceId = new Map<string, string>();
    const configuredScopes = new Map<string, NonNullable<TriageListEntriesResultV1['configuredSources'][number]['scope']>>();
    await Promise.all(configuredRows.map(async (row) => {
        const contribution = admittedByQualifiedId.get(row.sourceQualifiedId);
        if (contribution === undefined) return;
        const sourceInstanceId = row.configured.instance.sourceInstanceId;
        contributionGenerationBySourceInstanceId.set(sourceInstanceId, contribution.contributor.occurrenceId);
        const unit = contribution.descriptor.scopeUnit;
        const operation = contribution.operations.listScopeUnits;
        if (unit === undefined || operation === undefined || deps.executeScopeUnits === undefined) return;
        const configured = row.configured;
        let projection: TriageListScopeUnitsResultV1;
        try {
            // Decode only retained source-owned bytes. No fabricated discovery
            // locator/stability, provider directory read or aggregate token parser.
            const result = await deps.executeScopeUnits(operation, { v: 1, mode: 'configured', draft: {
                v: 1, binding: configured.binding, localInstanceKey: configured.localInstanceKey,
                configuration: configured.configuration,
                ...(configured.locator === undefined ? {} : { locator: configured.locator }),
            } }, options);
            const parsed = TriageListScopeUnitsResultV1Schema.safeParse(result);
            projection = parsed.success ? parsed.data : { kind: 'failed',
                failure: { class: 'unsupportedContract', code: 'scope_projection_invalid' } };
        } catch (error) {
            if (deps.signal?.aborted) throw error;
            projection = { kind: 'failed', failure: { class: 'unknown', code: 'scope_projection_unavailable' } };
        }
        configuredScopes.set(sourceInstanceId, { unit, projection });
    }));
    for (const row of configuredRows) {
        const contribution = admittedByQualifiedId.get(row.sourceQualifiedId);
        const source = {
            pluginId: row.configured.instance.source.pluginId,
            localId: row.configured.instance.source.localId,
        };
        const declaredKindIds = contribution?.descriptor?.kinds.map((kind) => kind.id) ?? [];
        // A source with no admitted contribution, or one whose descriptor
        // declares no kind, cannot be invoked at all — and its configured row
        // stays exactly as it is, because absence from the admitted view is
        // never retirement evidence.
        const available = contribution !== undefined && declaredKindIds.length > 0;
        const configurationRevision = configurationRevisionBySourceInstanceId.get(
            row.configured.instance.sourceInstanceId,
        );
        configuredSources.push({
            sourceInstanceId: row.configured.instance.sourceInstanceId,
            source,
            ...(configurationRevision === undefined ? {} : { configurationRevision }),
            ...(row.configured.locator === undefined
                ? {}
                : { displayLabel: row.configured.locator.displayLabel }),
            available,
            ...(configuredScopes.has(row.configured.instance.sourceInstanceId)
                ? { scope: configuredScopes.get(row.configured.instance.sourceInstanceId) } : {}),
        });
        if (input.limit === 0 || !walkAdmits(input, row.configured.instance.sourceInstanceId)) continue;
        const selectedKindIds = deps.taskOnly
            ? contribution?.descriptor.kinds.filter((kind) => kind.task === true).map((kind) => kind.id)
            : undefined;
        if (selectedKindIds?.length === 0) continue;
        // Selected, so this window is answering for it either way. A source that
        // cannot be invoked becomes an unfinished lane rather than a silent
        // absence, which is what keeps the coverage claim about what was asked.
        intended.push({ sourceInstanceId: row.configured.instance.sourceInstanceId, source });
        if (!available || contribution === undefined) continue;
        const completedKindIds = selectedKindIds === undefined || input.tasks === undefined ? []
            : contribution.descriptor.kinds.filter(kind => kind.task === true && kind.taskCapabilities?.completedScan === true)
                .map(kind => kind.id);
        if (selectedKindIds !== undefined && input.tasks !== undefined && completedKindIds.length < selectedKindIds.length) {
            unknownCompletedCoverage.add(row.configured.instance.sourceInstanceId);
        }
        const resume = resumeByInstance.get(row.configured.instance.sourceInstanceId);
        lanes.push({
            sourceInstanceId: row.configured.instance.sourceInstanceId,
            source,
            declaredKindIds,
            ...(selectedKindIds === undefined ? {} : { selectedKindIds }),
            ...(completedKindIds.length === 0 || input.tasks === undefined ? {} : {
                completed: { kindIds: completedKindIds, sinceMs: input.tasks.completedSinceMs },
            }),
            configured: row.configured,
            ...(resume === undefined
                ? {}
                : { resume: resume.continuation, pageLimit: resume.pageLimit }),
            scan: (scanInput, scanOptions) => deps.executeScan(
                contribution.operations.scan,
                scanInput,
                scanOptions,
            ),
        });
    }

    const lens = lensFrom(input, lanes.length, deps.taskOnly);
    // One transport page walks every admitted lane fairly without fetching rows
    // the result cannot carry. The shared per-lane geometry is the largest whole
    // share whose first round fits the result row budget; a short lane may yield
    // unused capacity, but no later fold is allowed to advance a provider cursor
    // past rows the wire drops.
    const pageLimit = Math.max(
        1,
        Math.floor(lens.limit / Math.max(lanes.length, 1)),
    );
    // An explicitly selected new lane starts before existing walks deepen.
    // Other unfinished lanes keep the rotation order returned by scanPass;
    // configured-row ordering must not restart the rotation on every window.
    const orderedLanes = input.resume === undefined ? lanes : [
        ...lanes.filter((lane) => !resumeByInstance.has(lane.sourceInstanceId)),
        ...[...resumeByInstance.keys()].flatMap((sourceInstanceId) => {
            const lane = lanes.find((candidate) => candidate.sourceInstanceId === sourceInstanceId);
            return lane === undefined ? [] : [lane];
        }),
    ];
    const pass = await runTriageScanPass({
        lanes: orderedLanes,
        pageLimit,
        observationBudget: lens.limit,
        nowMs: deps.nowMs,
        logger: deps.logger,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });

    /**
     * Re-read both currentness owners after provider work settles.
     *
     * A configured row can be removed or rewritten under the same stable
     * `sourceInstanceId` while an admitted source is answering. The initial row
     * granted authority to start that call; it does not grant authority to
     * publish after its Collection revision or admitted immutable generation
     * changed. No durable scan generation is needed: compare the two canonical
     * identities at this one result boundary and discard only stale lanes.
     */
    // Both independent authorities fence the settled provider work. Start
    // them together, as at initial admission, rather than serializing I/O.
    const [currentConfigured, currentAdmittedByQualifiedId] = input.limit === 0 && configuredScopes.size === 0
        ? [null, admittedByQualifiedId] as const
        : await Promise.all([
            readActiveConfiguredSourceRows(deps.sourceInstances, options),
            deps.readAdmittedSources(options).then(indexTriageAdmittedSourcesV1),
        ]);
    const initialSourceInstanceIds = new Set(
        configuredRows.map((row) => row.configured.instance.sourceInstanceId),
    );
    const currentRecords = currentConfigured === null
        ? configuredRecords
        : currentConfigured.records.filter((record) => (
            initialSourceInstanceIds.has(record.value.configured.instance.sourceInstanceId)
            && selectionAdmits(input, record.value.configured.instance.sourceInstanceId)
        ));
    const currentRecordBySourceInstanceId = new Map(currentRecords.map((record) => [
        record.value.configured.instance.sourceInstanceId,
        record,
    ]));
    const currentGenerationMatches = (sourceInstanceId: string): boolean => {
        const record = currentRecordBySourceInstanceId.get(sourceInstanceId);
        const initialRevision = configurationRevisionBySourceInstanceId.get(sourceInstanceId);
        if (record === undefined || initialRevision === undefined || record.revision !== initialRevision) return false;
        const currentContribution = currentAdmittedByQualifiedId.get(record.value.sourceQualifiedId);
        return currentContribution !== undefined
            && currentContribution.contributor.occurrenceId
                === contributionGenerationBySourceInstanceId.get(sourceInstanceId);
    };

    const settledConfiguredSources: TriageListEntriesResultV1['configuredSources'][number][] = [];
    const settledIntended: TriageListIntendedSourceV1[] = [];
    for (const record of currentRecords) {
        const row = record.value;
        const contribution = currentAdmittedByQualifiedId.get(row.sourceQualifiedId);
        const declaredKindIds = contribution?.descriptor?.kinds.map((kind) => kind.id) ?? [];
        const available = contribution !== undefined && declaredKindIds.length > 0;
        const source = {
            pluginId: row.configured.instance.source.pluginId,
            localId: row.configured.instance.source.localId,
        };
        settledConfiguredSources.push({
            sourceInstanceId: row.configured.instance.sourceInstanceId,
            source,
            configurationRevision: record.revision,
            ...(row.configured.locator === undefined
                ? {}
                : { displayLabel: row.configured.locator.displayLabel }),
            available,
            ...(currentGenerationMatches(row.configured.instance.sourceInstanceId)
                && configuredScopes.has(row.configured.instance.sourceInstanceId)
                ? { scope: configuredScopes.get(row.configured.instance.sourceInstanceId) } : {}),
        });
        const hasSelectedKinds = !deps.taskOnly || contribution === undefined
            || contribution.descriptor.kinds.some((kind) => kind.task === true);
        if (hasSelectedKinds && input.limit > 0 && walkAdmits(input, row.configured.instance.sourceInstanceId)) {
            settledIntended.push({ sourceInstanceId: row.configured.instance.sourceInstanceId, source });
        }
    }
    const settledLanes = pass.lanes.filter((lane) => currentGenerationMatches(lane.sourceInstanceId)).map(lane => (
        unknownCompletedCoverage.has(lane.sourceInstanceId) ? { ...lane, exhausted: false,
            health: lane.health.kind === 'walkFinished'
                ? { kind: 'partial' as const, reason: 'completedScanUnavailable' } : lane.health,
        } : lane
    ));
    const settledObservations = pass.observations.filter(
        (observation) => currentGenerationMatches(observation.sourceInstanceId),
    );

    const window: TriageListWindowV1 = foldTriageListWindow({
        observations: settledObservations,
        lanes: triageListCoverageLanes({
            intended: currentConfigured === null ? intended : settledIntended,
            walked: settledLanes,
        }),
        configuredSourcesStatus,
        activeSourceInstanceIds: settledConfiguredSources
            .filter((summary) => summary.available)
            .map((summary) => summary.sourceInstanceId),
        lens,
        assembledAtMs: deps.nowMs(),
    });

    // Every lane that stopped with more to give, in the rotation's own order.
    // All of them: the row budget above already reserved the bytes for one
    // frontier per walked lane, so there is nothing here to cut — and cutting
    // is what starved the tail of the rotation on every page (`PLAN.md` §0a
    // A9a).
    const continuations = pass.stopped.filter((stop) => currentGenerationMatches(stop.sourceInstanceId));

    return {
        configuredSources: currentConfigured === null ? configuredSources : settledConfiguredSources,
        configuredSourcesStatus,
        ...(configuredSourcesNextCursor === undefined ? {} : { configuredSourcesNextCursor }),
        window,
        ...(continuations.length === 0 ? {} : { continuations }),
    };
}

/** The bounded wire projection of one assembled pass. */
export async function listTriageEntries(
    input: TriageListEntriesInputV1,
    deps: TriageListEntriesDepsV1,
): Promise<TriageListEntriesResultV1> {
    const pass = await assembleTriageListPass(input, deps);
    return {
        v: 1,
        configuredSources: pass.configuredSources,
        configuredSourcesStatus: pass.configuredSourcesStatus,
        ...(pass.configuredSourcesNextCursor === undefined
            ? {}
            : { configuredSourcesNextCursor: pass.configuredSourcesNextCursor }),
        window: {
            v: 1,
            rows: toTriageListWireRows(pass.window),
            lanes: pass.window.lanes,
            coverage: pass.window.coverage,
            ...(pass.continuations === undefined || pass.continuations.length === 0
                ? {}
                : { continuations: pass.continuations }),
            assembledAtMs: pass.window.assembledAtMs,
        },
    };
}

/**
 * The registered Action handler. It binds the narrow owner above to the exact
 * invocation context the host supplies and adds no dispatch, cache or registry
 * of its own.
 */
export function createTriageListEntriesActionHandler(lens?: Readonly<{ taskOnly?: boolean }>): TriageDataActionHandler<
    TriageListEntriesInputV1,
    TriageListEntriesResultV1
> {
    return async (input, context: TriageDataActionContext) => await listTriageEntries(input, {
        sourceInstances: bindCorpusCollections(requireTriageAccountStorage(context)).sourceInstances,
        readAdmittedSources: async (options) => {
            const observation = context.services.targetedContributions.observeForSelf(
                TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
                { onInvalidated: () => {} },
            );
            try {
                const snapshot = await observation.readCurrent(options);
                return snapshot.contributions;
            } finally {
                observation.dispose();
            }
        },
        executeScan: async (operation, scanInput, options) => await context.services.actions
            .executeAdmittedTargetedOperation(operation, scanInput, { ...options, machineAvailability: 'current' }),
        executeScopeUnits: async (operation, scopeInput, options) => await context.services.actions
            .executeAdmittedTargetedOperation(operation, scopeInput, { ...options, machineAvailability: 'current' }),
        nowMs: () => Date.now(),
        taskOnly: lens?.taskOnly,
        signal: context.signal,
    });
}
