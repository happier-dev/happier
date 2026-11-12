import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';

import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import { fitActionResultSequenceV1 } from '@happier-dev/triage-sources/projection/actionResultSequence';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { readActiveConfiguredSourceRow } from '../corpus/configuration/readConfiguredSourceRows.js';
import { readResolvedFixPullRequests, selectPrimaryFixPullRequest, type TriageFixPullRequestProjectionV1 } from '../corpus/marks/fixPullRequests.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { setFixPullRequest } from '../corpus/marks/setPinned.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { indexTriageAdmittedSourcesV1, type TriageAdmittedSourceV1 } from './listEntries.js';
import { reobserveTriageEntry } from './reobserveEntry.js';
import { createTriageSourceSessionRelations } from '../sessions/sourceSessionRelations.js';
import type {
    TriageReadFixPullRequestsInputV1,
    TriageReadFixPullRequestsResultV1,
    TriageSetFixPullRequestInputV1,
    TriageSetFixPullRequestResultV1,
} from '@happier-dev/triage-protocol/v1';
import { TriageSourceReadFixPullRequestsResultV1Schema } from '@happier-dev/triage-protocol/v1';

/**
 * The two fix-PR Actions: transport to the one `user-marks` writer and the
 * read over user marks, composed Session links and live native associations. The corpus
 * owners do (`design/FIX-LINK.md`).
 */

export type TriageFixPullRequestsDepsV1 = Readonly<{
    collections: Pick<CorpusCollectionsV1, 'userMarks'>;
    nowMs: () => number;
    signal?: AbortSignal;
    workflowSubjectOf?: TriageFixPullRequestProjectionV1['workflowSubjectOf'];
}>;

export async function readTriageFixPullRequests(
    input: TriageReadFixPullRequestsInputV1,
    deps: TriageFixPullRequestsDepsV1 & Readonly<{
        projection: TriageFixPullRequestProjectionV1;
        sourceRelations: Pick<ReturnType<typeof createTriageSourceSessionRelations>, 'read'>;
    }>,
): Promise<TriageReadFixPullRequestsResultV1> {
    const resolved = await readResolvedFixPullRequests({
        collections: deps.collections,
        sourceRelations: deps.sourceRelations,
        entryRef: input.entryRef,
        projection: deps.projection,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    return {
        v: 1,
        ...resolved,
    };
}

/** Resolve native evidence only through the currently admitted selected source. */
export async function readTriageNativeFixPullRequests(
    input: TriageReadFixPullRequestsInputV1,
    deps: Readonly<{
        sourceRelations: Pick<ReturnType<typeof createTriageSourceSessionRelations>, 'readSources'>;
        execute: TriageDataActionContext['services']['actions']['executeAdmittedTargetedOperation'];
        signal?: AbortSignal;
    }>,
): Promise<Awaited<ReturnType<NonNullable<TriageFixPullRequestProjectionV1['readNativeCandidates']>>>> {
    try {
        const { sources, configured } = await deps.sourceRelations.readSources({ entryRef: input.entryRef });
        const source = sources.get(renderSourceQualifiedId(input.entryRef.source));
        const operation = source?.operations.readFixPullRequests;
        if (operation === undefined) return { candidates: [], incomplete: false };
        const selected = input.sourceContext;
        const record = configured.records.find(({ value: row }) => row.configured.instance.sourceInstanceId === selected?.instance.instance.sourceInstanceId
            && renderSourceQualifiedId(row.configured.instance.source) === renderSourceQualifiedId(input.entryRef.source));
        if (record === undefined || selected === undefined || !source?.descriptor.kinds.some((kind) => kind.id === input.entryRef.kindId)) {
            return { candidates: [], incomplete: true };
        }
        const row = record.value;
        const result = TriageSourceReadFixPullRequestsResultV1Schema.safeParse(await deps.execute(operation, {
            v: 1, instance: row.configured,
            localRef: { kindId: input.entryRef.kindId, collisionScope: input.entryRef.collisionScope, entryId: input.entryRef.entryId },
            lastKnownLocator: selected.lastKnownLocator,
        }, { signal: deps.signal }));
        if (!result.success || result.data.kind !== 'complete') return { candidates: [], incomplete: true };
        if (result.data.candidates.some((candidate) => !source.descriptor.kinds.some((kind) => kind.id === candidate.localRef.kindId
            && kind.workflowSubject === 'pullRequest'))) return { candidates: [], incomplete: true };
        return { candidates: result.data.candidates.map((candidate) => ({
            entryRef: { source: input.entryRef.source, ...candidate.localRef }, status: candidate.status, display: candidate.display,
            sourceContext: { sourceInstanceId: row.configured.instance.sourceInstanceId, sourceInstanceRowId: record.rowId,
                lastKnownLocator: candidate.locator },
        })), incomplete: false };
    } catch {
        throwIfAborted(deps.signal);
        return { candidates: [], incomplete: true };
    }
}

export async function setTriageFixPullRequest(
    input: TriageSetFixPullRequestInputV1,
    deps: TriageFixPullRequestsDepsV1,
): Promise<TriageSetFixPullRequestResultV1> {
    const common = {
        collections: deps.collections,
        entryRef: input.entryRef,
        displayAtMark: input.displayAtMark,
        fixPullRequest: input.fixPullRequest,
        fixPullRequestWorkflowSubject: deps.workflowSubjectOf?.(input.fixPullRequest) ?? null,
        nowMs: deps.nowMs(),
        ...(deps.signal ? { signal: deps.signal } : {}),
    };
    const result = input.linked
        ? await setFixPullRequest({ ...common, linked: true, displayAtLink: input.displayAtLink })
        : await setFixPullRequest({ ...common, linked: false });
    return { v: 1, status: result.status };
}

function workflowSubjectOf(sources: ReturnType<typeof indexTriageAdmittedSourcesV1>, entryRef: TriageReadFixPullRequestsInputV1['entryRef']) {
    return sources.get(renderSourceQualifiedId(entryRef.source))
        ?.descriptor.kinds.find((kind) => kind.id === entryRef.kindId)?.workflowSubject ?? null;
}

async function readFixLinkSourceFacts(
    readCurrent: () => Promise<readonly TriageAdmittedSourceV1[]>,
    signal?: AbortSignal,
): Promise<readonly TriageAdmittedSourceV1[]> {
    try {
        return await readCurrent();
    } catch {
        // These are semantic facts, not authority for the Account write. Missing
        // source facts cannot erase durable intent or turn it into a known non-PR.
        throwIfAborted(signal);
        return [];
    }
}

/** Fit only the outward Action; local Collection reads retain the complete derived set. */
function fitFixPullRequestsActionResult(result: TriageReadFixPullRequestsResultV1): TriageReadFixPullRequestsResultV1 {
    const explicit = new Set(result.candidates.filter((candidate) => candidate.origins.includes('user')));
    const derived = result.candidates.filter((candidate) => !explicit.has(candidate));
    return fitActionResultSequenceV1(derived, (included, omittedCount) => {
        const retained = new Set(included);
        const candidates = Object.freeze(result.candidates.filter((candidate) => explicit.has(candidate) || retained.has(candidate)));
        return Object.freeze({
            ...result,
            candidates,
            primary: selectPrimaryFixPullRequest(candidates),
            incomplete: result.incomplete || omittedCount > 0,
        });
    }).result;
}

export function createTriageReadFixPullRequestsActionHandler(): TriageDataActionHandler<
    TriageReadFixPullRequestsInputV1,
    TriageReadFixPullRequestsResultV1
> {
    return async (input, context: TriageDataActionContext) => {
        throwIfAborted(context.signal);
        const collections = bindCorpusCollections(requireTriageAccountStorage(context));
        const selected = input.sourceContext === undefined ? undefined : {
            entryRef: input.entryRef,
            record: await readActiveConfiguredSourceRow(collections.sourceInstances, input.sourceContext.instance, { signal: context.signal })
                .catch(() => { throwIfAborted(context.signal); return null; }),
        };
        const sourceRelations = createTriageSourceSessionRelations(context, collections, selected);
        const sourceView = await sourceRelations.readSources({ entryRef: input.entryRef }).catch(() => {
            throwIfAborted(context.signal);
            return null;
        });
        const sources = sourceView?.sources ?? new Map<string, TriageAdmittedSourceV1>();
        const configuredRows = sourceView?.configured.rows ?? [];
        const admitted = [...sources.values()];
        throwIfAborted(context.signal);
        const result = await readTriageFixPullRequests(input, {
            collections,
            sourceRelations,
            nowMs: () => Date.now(),
            ...(context.signal ? { signal: context.signal } : {}),
            projection: {
                readNativeCandidates: () => readTriageNativeFixPullRequests(input, {
                    sourceRelations,
                    execute: (operation, input, options) => context.services.actions.executeAdmittedTargetedOperation(operation, input, options),
                    signal: context.signal,
                }),
                workflowSubjectOf: (entryRef) => workflowSubjectOf(sources, entryRef),
                presentationOf: async (entryRef) => {
                    const rows = selected !== undefined && renderSourceQualifiedId(entryRef.source) !== renderSourceQualifiedId(input.entryRef.source)
                        ? (await sourceRelations.readSources({ entryRef })).configured.rows : configuredRows;
                    for (const row of rows) {
                        if (renderSourceQualifiedId(row.configured.instance.source) !== renderSourceQualifiedId(entryRef.source)) continue;
                        const result = await reobserveTriageEntry({
                            entryRef, sourceInstanceId: row.configured.instance.sourceInstanceId,
                        }, {
                            readConfiguredInstance: async (sourceInstanceId) =>
                                (await sourceRelations.findConfiguredInstance(sourceInstanceId, entryRef))?.value.configured ?? null,
                            readSourceSnapshot: async () => ({ contributions: admitted }),
                            executeGet: async (operation, getInput, getOptions) => await context.services.actions
                                .executeAdmittedTargetedOperation(operation, getInput, getOptions ?? {}),
                            nowMs: () => Date.now(),
                            ...(context.signal ? { signal: context.signal } : {}),
                        });
                        if (result.kind === 'observed' && result.observation.outcome.kind === 'present') {
                            return result.observation.outcome.snapshot.state.presentation;
                        }
                    }
                    return null;
                },
            },
        });
        return fitFixPullRequestsActionResult(result);
    };
}

export function createTriageSetFixPullRequestActionHandler(): TriageDataActionHandler<
    TriageSetFixPullRequestInputV1,
    TriageSetFixPullRequestResultV1
> {
    return async (input, context: TriageDataActionContext) => {
        throwIfAborted(context.signal);
        const deps = {
            collections: bindCorpusCollections(requireTriageAccountStorage(context)),
            nowMs: () => Date.now(),
            ...(context.signal ? { signal: context.signal } : {}),
        };
        // Removing a durable choice never needs live source facts.
        if (!input.linked) return await setTriageFixPullRequest(input, deps);
        const observation = context.services.targetedContributions.observeForSelf(
            TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
        );
        try {
            const options = context.signal === undefined ? {} : { signal: context.signal };
            const admitted = await readFixLinkSourceFacts(
                async () => (await observation.readCurrent(options)).contributions, context.signal,
            );
            throwIfAborted(context.signal);
            const sources = indexTriageAdmittedSourcesV1(admitted);
            return await setTriageFixPullRequest(input, {
                ...deps,
                workflowSubjectOf: (entryRef) => workflowSubjectOf(sources, entryRef),
            });
        } finally {
            observation.dispose();
        }
    };
}
