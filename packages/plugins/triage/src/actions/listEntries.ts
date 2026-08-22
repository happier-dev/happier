import type { PluginCancellationOptions, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
    ActionHandler,
    AdmittedTargetedOperationExecutionHandle,
} from '@happier-dev/plugin-sdk/actions';
import {
    MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1,
    type TriageScanInputV1,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1 } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import type { CorpusCollectionHandleV1 } from '../corpus/collections/handles.js';
import {
    CORPUS_SOURCE_INSTANCES_INDEX_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../corpus/collections/ids.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
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
import { runTriageScanPass, type TriageScanLaneV1 } from '../projection/scanPass.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import type {
    TriageListEntriesInputV1,
    TriageListEntriesResultV1,
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
    nowMs: () => number;
    signal?: AbortSignal;
}>;

function lensFrom(input: TriageListEntriesInputV1): TriageListLensV1 {
    return {
        order: input.order,
        // The one closed policy owner decides. An omitted or unrecognized
        // ladder resolves to the retained default rather than to no order at
        // all, and it is never repaired into a nearby one.
        smartPolicy: parseCorpusSmartPolicy(input.smartPolicy) ?? CORPUS_DEFAULT_SMART_POLICY_V1,
        query: input.query ?? '',
        filters: input.filters ?? TRIAGE_LIST_NO_FILTERS_V1,
        limit: input.limit,
    };
}

function selectionAdmits(input: TriageListEntriesInputV1, sourceInstanceId: string): boolean {
    return input.sources.kind === 'allConfigured'
        || input.sources.sourceInstanceIds.includes(sourceInstanceId);
}

/**
 * The active configured set, and whether it could be carried whole.
 *
 * The lifecycle writer refuses to create or reactivate past the same maximum,
 * but that check is a read-then-write admission bound rather than a set-level
 * guard: two creates racing at the boundary can each observe room and each
 * commit their own tuple-addressed row. This read therefore does not assume the
 * writer's bound holds. It asks for one row past the maximum, carries exactly
 * the maximum — which is also what this Action's own result array can name —
 * and reports the surplus as `truncated` so the window says it is incomplete
 * instead of silently dropping a configured source no reader could ever ask
 * about.
 */
async function readActiveConfiguredRows(
    deps: TriageListEntriesDepsV1,
): Promise<Readonly<{
    rows: readonly CorpusSourceInstanceRowV1[];
    status: 'complete' | 'truncated';
}>> {
    const options: PluginCancellationOptions | undefined = deps.signal ? { signal: deps.signal } : undefined;
    const page = await deps.sourceInstances.query({
        index: CORPUS_SOURCE_INSTANCES_INDEX_ID.byLifecycle,
        prefix: [CORPUS_SOURCE_INSTANCE_LIFECYCLE.active],
        order: 'asc',
        limit: MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1 + 1,
    }, options);
    const rows = page.rows.map((row) => fromCorpusStoredRow<CorpusSourceInstanceRowV1>(row).value);
    return {
        rows: rows.slice(0, MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1),
        status: rows.length > MAX_TRIAGE_CONFIGURED_SOURCE_INSTANCES_V1 ? 'truncated' : 'complete',
    };
}

export async function listTriageEntries(
    input: TriageListEntriesInputV1,
    deps: TriageListEntriesDepsV1,
): Promise<TriageListEntriesResultV1> {
    const options: PluginCancellationOptions | undefined = deps.signal ? { signal: deps.signal } : undefined;
    const [configured, admitted] = await Promise.all([
        readActiveConfiguredRows(deps),
        deps.readAdmittedSources(options),
    ]);

    const admittedByQualifiedId = indexTriageAdmittedSourcesV1(admitted);

    const configuredSources: TriageListEntriesResultV1['configuredSources'][number][] = [];
    /** Every instance this request set out to cover, invocable or not. */
    const intended: TriageListIntendedSourceV1[] = [];
    const lanes: TriageScanLaneV1[] = [];
    for (const row of configured.rows) {
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
        configuredSources.push({
            sourceInstanceId: row.configured.instance.sourceInstanceId,
            source,
            ...(row.configured.locator === undefined
                ? {}
                : { displayLabel: row.configured.locator.displayLabel }),
            available,
        });
        if (!selectionAdmits(input, row.configured.instance.sourceInstanceId)) continue;
        // Selected, so this window is answering for it either way. A source that
        // cannot be invoked becomes an unfinished lane rather than a silent
        // absence, which is what keeps the coverage claim about what was asked.
        intended.push({ sourceInstanceId: row.configured.instance.sourceInstanceId, source });
        if (!available || contribution === undefined) continue;
        lanes.push({
            sourceInstanceId: row.configured.instance.sourceInstanceId,
            source,
            declaredKindIds,
            configured: row.configured,
            scan: (scanInput, scanOptions) => deps.executeScan(
                contribution.operations.scan,
                scanInput,
                scanOptions,
            ),
        });
    }

    const lens = lensFrom(input);
    const pass = await runTriageScanPass({
        lanes,
        pageLimit: Math.min(Math.max(lens.limit, 1), MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1),
        // Each lane may legitimately supply a whole window's worth of rows, and
        // two instances observing one entry produce two observations of it.
        observationBudget: Math.max(lens.limit, 1) * Math.max(lanes.length, 1),
        nowMs: deps.nowMs,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });

    const window: TriageListWindowV1 = foldTriageListWindow({
        observations: pass.observations,
        lanes: triageListCoverageLanes({ intended, walked: pass.lanes }),
        configuredSourcesStatus: configured.status,
        activeSourceInstanceIds: configuredSources
            .filter((summary) => summary.available)
            .map((summary) => summary.sourceInstanceId),
        lens,
        assembledAtMs: deps.nowMs(),
    });

    return {
        v: 1,
        configuredSources,
        configuredSourcesStatus: configured.status,
        window: {
            v: 1,
            rows: toTriageListWireRows(window),
            lanes: window.lanes,
            coverage: window.coverage,
            assembledAtMs: window.assembledAtMs,
        },
    };
}

/**
 * The registered Action handler. It binds the narrow owner above to the exact
 * invocation context the host supplies and adds no dispatch, cache or registry
 * of its own.
 */
export function createTriageListEntriesActionHandler(): ActionHandler<
    TriageListEntriesInputV1,
    TriageListEntriesResultV1
> {
    return async (input, context: PluginInvocationContext) => await listTriageEntries(input, {
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
            .executeAdmittedTargetedOperation(operation, scanInput, options ?? {}),
        nowMs: () => Date.now(),
        signal: context.signal,
    });
}
