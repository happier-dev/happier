import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { throwIfAborted } from '@happier-dev/plugin-sdk/async';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { readResolvedFixPullRequests, type TriageFixPullRequestProjectionV1 } from '../corpus/marks/fixPullRequests.js';
import { readActiveConfiguredSourceRows } from '../corpus/configuration/readConfiguredSourceRows.js';
import { findConfiguredSourceInstanceRow } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { setFixPullRequest } from '../corpus/marks/setPinned.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { indexTriageAdmittedSourcesV1, type TriageAdmittedSourceV1 } from './listEntries.js';
import { reobserveTriageEntry } from './reobserveEntry.js';
import type {
    TriageReadFixPullRequestsInputV1,
    TriageReadFixPullRequestsResultV1,
    TriageSetFixPullRequestInputV1,
    TriageSetFixPullRequestResultV1,
} from './fixPullRequestsProtocol.js';

/**
 * The two fix-PR Actions: transport to the one `user-marks` writer and the
 * read over `user-marks` plus `session-links`. They decide nothing; the corpus
 * owners do (`design/FIX-LINK.md`).
 */

export type TriageFixPullRequestsDepsV1 = Readonly<{
    collections: Pick<CorpusCollectionsV1, 'userMarks' | 'sessionLinks'>;
    nowMs: () => number;
    signal?: AbortSignal;
    workflowSubjectOf?: TriageFixPullRequestProjectionV1['workflowSubjectOf'];
}>;

export async function readTriageFixPullRequests(
    input: TriageReadFixPullRequestsInputV1,
    deps: TriageFixPullRequestsDepsV1 & Readonly<{ projection: TriageFixPullRequestProjectionV1 }>,
): Promise<TriageReadFixPullRequestsResultV1> {
    const resolved = await readResolvedFixPullRequests({
        collections: deps.collections,
        entryRef: input.entryRef,
        projection: deps.projection,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    return {
        v: 1,
        ...resolved,
    };
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

export function createTriageReadFixPullRequestsActionHandler(): ActionHandler<
    TriageReadFixPullRequestsInputV1,
    TriageReadFixPullRequestsResultV1
> {
    return async (input, context: PluginInvocationContext) => {
        throwIfAborted(context.signal);
        const options = context.signal === undefined ? {} : { signal: context.signal };
        const collections = bindCorpusCollections(requireTriageAccountStorage(context));
        const observation = context.services.targetedContributions.observeForSelf(
            TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
        );
        try {
            const [admitted, configured] = await Promise.all([
                readFixLinkSourceFacts(async () => (await observation.readCurrent(options)).contributions, context.signal),
                readActiveConfiguredSourceRows(collections.sourceInstances, options),
            ]);
            throwIfAborted(context.signal);
            const sources = indexTriageAdmittedSourcesV1(admitted);
            return await readTriageFixPullRequests(input, {
                collections,
                nowMs: () => Date.now(),
                ...(context.signal ? { signal: context.signal } : {}),
                projection: {
                    workflowSubjectOf: (entryRef) => workflowSubjectOf(sources, entryRef),
                    presentationOf: async (entryRef) => {
                        for (const row of configured.rows) {
                            if (renderSourceQualifiedId(row.configured.instance.source) !== renderSourceQualifiedId(entryRef.source)) continue;
                            const result = await reobserveTriageEntry({
                                entryRef, sourceInstanceId: row.configured.instance.sourceInstanceId,
                            }, {
                                readConfiguredInstance: async (sourceInstanceId, readOptions) => {
                                    const current = await findConfiguredSourceInstanceRow(collections.sourceInstances, sourceInstanceId, readOptions);
                                    return current?.value.lifecycle === CORPUS_SOURCE_INSTANCE_LIFECYCLE.active
                                        ? current.value.configured : null;
                                },
                                readAdmittedSources: async () => admitted,
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
        } finally {
            observation.dispose();
        }
    };
}

export function createTriageSetFixPullRequestActionHandler(): ActionHandler<
    TriageSetFixPullRequestInputV1,
    TriageSetFixPullRequestResultV1
> {
    return async (input, context: PluginInvocationContext) => {
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
