import type { PluginCancellationOptions, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
    ActionHandler,
    AdmittedTargetedOperationExecutionHandle,
} from '@happier-dev/plugin-sdk/actions';
import {
    admitTriageSourceDescriptorV1,
    type TriageScanContinuationV1,
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
    nowMs: () => number;
    signal?: AbortSignal;
}>;

function lensFrom(
    input: TriageListEntriesInputV1,
    /** The lanes this request will actually walk, and so the frontiers it may return. */
    laneCount: number,
): TriageListLensV1 {
    return {
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
): ReadonlyMap<string, TriageScanContinuationV1> {
    const byInstance = new Map<string, TriageScanContinuationV1>();
    for (const entry of input.resume ?? []) {
        byInstance.set(entry.sourceInstanceId, entry.continuation);
    }
    return byInstance;
}

export async function listTriageEntries(
    input: TriageListEntriesInputV1,
    deps: TriageListEntriesDepsV1,
): Promise<TriageListEntriesResultV1> {
    const options: PluginCancellationOptions | undefined = deps.signal ? { signal: deps.signal } : undefined;
    const resumeByInstance = resumeByInstanceId(input);
    const admittedPromise = deps.readAdmittedSources(options);
    const sources = input.sources;
    let configuredRows: readonly CorpusSourceInstanceRowV1[];
    let configuredSourcesStatus: 'complete' | 'truncated';
    let configuredSourcesNextCursor: string | undefined;
    if (sources.kind === 'allConfigured') {
        const page = await readActiveConfiguredSourceRowPage(deps.sourceInstances, {
            limit: MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
            ...(sources.cursor === undefined ? {} : { cursor: sources.cursor }),
        }, options);
        configuredRows = page.rows;
        configuredSourcesStatus = page.status;
        configuredSourcesNextCursor = page.nextCursor;
    } else {
        const configured = await readActiveConfiguredSourceRows(deps.sourceInstances, options);
        configuredRows = configured.rows.filter((row) => sources.sourceInstanceIds.includes(
            row.configured.instance.sourceInstanceId,
        ));
        configuredSourcesStatus = 'complete';
        configuredSourcesNextCursor = undefined;
    }
    const admitted = await admittedPromise;

    const admittedByQualifiedId = indexTriageAdmittedSourcesV1(admitted);

    const configuredSources: TriageListEntriesResultV1['configuredSources'][number][] = [];
    /** Every instance this request set out to cover, invocable or not. */
    const intended: TriageListIntendedSourceV1[] = [];
    const lanes: TriageScanLaneV1[] = [];
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
        configuredSources.push({
            sourceInstanceId: row.configured.instance.sourceInstanceId,
            source,
            ...(row.configured.locator === undefined
                ? {}
                : { displayLabel: row.configured.locator.displayLabel }),
            available,
        });
        if (input.limit === 0 || !selectionAdmits(input, row.configured.instance.sourceInstanceId)) continue;
        // Selected, so this window is answering for it either way. A source that
        // cannot be invoked becomes an unfinished lane rather than a silent
        // absence, which is what keeps the coverage claim about what was asked.
        intended.push({ sourceInstanceId: row.configured.instance.sourceInstanceId, source });
        if (!available || contribution === undefined) continue;
        const resume = resumeByInstance.get(row.configured.instance.sourceInstanceId);
        lanes.push({
            sourceInstanceId: row.configured.instance.sourceInstanceId,
            source,
            declaredKindIds,
            configured: row.configured,
            ...(resume === undefined ? {} : { resume }),
            scan: (scanInput, scanOptions) => deps.executeScan(
                contribution.operations.scan,
                scanInput,
                scanOptions,
            ),
        });
    }

    const lens = lensFrom(input, lanes.length);
    // One transport page walks every admitted lane fairly without fetching rows
    // the result cannot carry. The shared per-lane geometry is the largest whole
    // share whose first round fits the result row budget; a short lane may yield
    // unused capacity, but no later fold is allowed to advance a provider cursor
    // past rows the wire drops.
    const pageLimit = Math.max(
        1,
        Math.floor(lens.limit / Math.max(lanes.length, 1)),
    );
    const pass = await runTriageScanPass({
        lanes,
        pageLimit,
        observationBudget: lens.limit,
        nowMs: deps.nowMs,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });

    const window: TriageListWindowV1 = foldTriageListWindow({
        observations: pass.observations,
        lanes: triageListCoverageLanes({ intended, walked: pass.lanes }),
        configuredSourcesStatus,
        activeSourceInstanceIds: configuredSources
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
    const continuations = pass.stopped;

    return {
        v: 1,
        configuredSources,
        configuredSourcesStatus,
        ...(configuredSourcesNextCursor === undefined ? {} : { configuredSourcesNextCursor }),
        window: {
            v: 1,
            rows: toTriageListWireRows(window),
            lanes: window.lanes,
            coverage: window.coverage,
            ...(continuations.length === 0 ? {} : { continuations }),
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
