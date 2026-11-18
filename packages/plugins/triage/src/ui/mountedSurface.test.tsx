import { useTriagePinnedEntries } from './marks/useTriagePinnedEntries.js';
import { useTriageConfiguredSources } from './configuration/useTriageConfiguredSources.js';
import { setTriageEntryPinned } from '../actions/userMarks.js';
import { removeConfiguredSourceInstance } from '../corpus/configuration/administerConfiguredSourceInstance.js';
// @vitest-environment jsdom
import { URL as NodeURL } from 'node:url';
import { readPluginTranslationResources } from '../../../../../scripts/testing/readPluginTranslationResources.js';

import * as React from 'react';
import { PluginError } from '@happier-dev/plugin-sdk';
import { act } from 'react';
import { createPluginClientTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit, PluginUiTestkitOpenSurfaceInput } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, type PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiContextEnrichmentV1, PluginUiUpdateEntityDragDropRequestV1, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
    TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
    TriageConfiguredSourceInstanceV1Schema,
    TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1,
    TriageReadFixPullRequestsInputV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageScanInputV1,
    type TriageScanResultV1,
    type TriageSourceScanObservationV1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import {
    TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    TriageListEntriesInputV1Schema,
} from '../actions/listEntriesProtocol.js';
import { TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1 } from '../actions/tasksProtocol.js';
import { TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1 } from '../actions/sessionLinksProtocol.js';
import { createTestkitSourceSessionRelations, readTestkitSourceSessionLinks } from '../sessions/testkit/entrySessionTestkit.test-support.js';
import { linkEntryToSession } from '../sessions/entrySessionLinks.js';
import { readTriageActionsForSurface } from '../actions/actionsCatalog.js';
import {
    TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
    TriageReadActionsInputV1Schema,
} from '../actions/actionsCatalogProtocol.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailInputV1Schema } from '../actions/entryDetailProtocol.js';
import { readTriageEntryDetail } from '../actions/readEntryDetail.js';
import { readTriageFixPullRequests } from '../actions/fixPullRequests.js';
import { createTriageReobserveEntryActionHandler } from '../actions/reobserveEntry.js';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReobserveEntryInputV1Schema } from '../actions/reobserveEntryProtocol.js';
import type { TriageDataActionContext } from '../actions/dataContext.js';
import { TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1 } from '../actions/entrySessionProtocol.js';
import { administerTriageSavedView, readTriageSavedViewsForSurface } from '../actions/savedViews.js';
import {
    TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
    TriageReadSavedViewsInputV1Schema,
    TriageAdministerSavedViewInputV1Schema,
} from '../actions/savedViewsProtocol.js';
import { listTriagePinnedEntries } from '../actions/userMarks.js';
import {
    TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    TriageListPinnedEntriesInputV1Schema,
} from '../actions/userMarksProtocol.js';
import { renderSurface as renderPickerSurface } from '../composer/entryPicker.js';
import { buildTriageEntryDetailLaunchInput, parseTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections, selectTestkitConfiguredSources } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../settings/actions.js';
import { mutateTriageSavedViews, TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1 } from '../settings/savedViews.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { loadMoreTriageListWindow, readTriageListWindowReadOwner, readTriageListWindowSnapshot, refreshTriageListWindow, subscribeToTriageListWindow } from './window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';
import { renderSurface as renderShellSurface } from './surface.js';
import { renderSurface as renderTasksSurface } from './tasksSurface.js';
import { TriageListShell } from './shell/root.js';
import type { PluginUiDataClient, PluginUiCollectionQuerySnapshot } from '@happier-dev/plugin-ui/data';
import { CORPUS_SOURCE_INSTANCES_COLLECTION, CORPUS_SESSION_LINKS_COLLECTION, CORPUS_USER_MARKS_COLLECTION } from '../corpus/collections/definitions.js';
import { closeFilters, filterFacetOption, pressToolbarMenuItem } from './shell/toolbarMenus.test-support.js';
import { TriageMountedUiInputV1Schema, type TriageMountedUiOperationV1 } from '../actions/mountedUiProtocol.js';
import { invokeTriageMountedUiAction } from './mountedActions.js';
import { activate, createTriageMountedUiActionHandler } from '../actions/mountedUi.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { TriageResourceSurface } from './resourceSurface.js';
import { createTriageResolveResourceActionHandler } from '../actions/resolveResource.js';
import { TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, TriageResolveResourceActionInputV1Schema } from '../actions/resolveResourceProtocol.js';
import { internalTaskStateV1 } from '../internalTasks/source.js';
import { readTaskOriginError } from '../corpus/marks/setPinned.js';
import { TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1, TriageReadTaskOriginErrorInputV1Schema } from '../actions/taskOriginProtocol.js';
import {
    buildTriageRouteSubPathV1,
    parseTriageRouteSubPathV1,
    TRIAGE_ROUTE_DEFAULT_LENS_V1,
} from './navigation/location.js';

const PACKAGED_UI_TRANSLATIONS = readPluginTranslationResources(new NodeURL('../../', import.meta.url));

/** The New task draft's first line (lab `tasks-create`). */
const DRAFT_PURPOSE = 'Where does it belong? It\u2019s created there and stays there.';

/**
 * The mounted PRs & Issues vertical, driven end to end through the real host
 * boundary.
 *
 * Nothing here stands in for the aggregate: the surface invokes the published
 * Action through the SDK's own mounted Host API client, which reaches the real
 * `listTriageEntries` handler, which reads the real declared Collection, walks
 * the real published `scan` protocol against fixture sources, folds through the
 * real window owner, and comes back through the one mounted window store into a
 * real React Native Web render. Only three genuine boundaries are replaced: the
 * Account Collection store, the host's admitted-contribution view, and the
 * fixture sources themselves.
 *
 * The second mount is the point of the test. The shell page and the Composer
 * picker are independent surfaces of one plugin with independent host-stamped
 * windows, and the vertical is only correct if opening the picker walks no
 * source at all and says so, rather than silently starting a second walk of
 * every configured source behind a popover.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_A = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const SOURCE_B = Object.freeze({ pluginId: 'happier.other.source', localId: 'other-forge' });
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';

/**
 * The two connections are labelled differently on purpose. A fixture that gives
 * every configured instance one label cannot tell "names the source that
 * failed" apart from "names a source", which is the exact gap this vertical had.
 */
const LABEL_A = 'acme/widgets';
const LABEL_B = 'globex/service';

type ScanFn = (input: TriageScanInputV1) => Promise<TriageScanResultV1>;

function configuredInstance(
    source: Readonly<{ pluginId: string; localId: string }>,
    sourceInstanceId: string,
    displayLabel: string,
): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source, sourceInstanceId },
        binding: {
            purpose: 'triage-source',
            account: { service: { pluginId: source.pluginId, localId: 'accounts' }, accountId: 'account-1' },
        },
        localInstanceKey: displayLabel,
        configuration: { v: 1, token: 'routing-token' },
        locator: { v: 1, displayLabel },
    });
}

function instanceRow(
    tagSeed: string,
    source: Readonly<{ pluginId: string; localId: string }>,
    sourceInstanceId: string,
    configuredAtMs: number,
    displayLabel: string,
): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: `${tagSeed}${'0'.repeat(43 - tagSeed.length)}`,
        sourceQualifiedId: `${source.pluginId}/${source.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs,
        configured: configuredInstance(source, sourceInstanceId, displayLabel),
    };
}

function presentObservation(input: Readonly<{
    entryId: string;
    title: string;
    sourceUpdatedAtMs: number;
    involvement?: readonly 'reviewRequested'[];
}>): TriageSourceScanObservationV1 {
    return {
        kind: 'present',
        localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: input.entryId },
        locator: testkitLocator(),
        snapshot: testkitSnapshot({ title: input.title }),
        viewer: testkitViewer(input.involvement ? { involvement: input.involvement } : {}),
        sourceUpdatedAtMs: input.sourceUpdatedAtMs,
    };
}

function createHarness(options: Readonly<{ tasks?: boolean; details?: boolean; completedTask?: boolean; sourceBUnavailable?: boolean;
    unlinkedTaskOnFirstPage?: boolean;
    sourceSettings?: boolean;
    /** Derived from the existing 1,000-row store fixture, not an observed F cardinality. */
    mixedFailureScale?: boolean;
    /** Source A answers one complete page that asks nothing of the reader. */
    quietFirstPage?: boolean }> = {}) {
    const { collections, control } = createTestkitCorpusCollections();
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow('a', SOURCE_A, INSTANCE_A, 1,
        options.mixedFailureScale ? 'GitHub workspace' : LABEL_A)));
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow('b', SOURCE_B, INSTANCE_B, 2,
        options.mixedFailureScale ? 'Bitbucket workspace' : LABEL_B)));
    const acmeSource = { pluginId: 'happier.third.acme', localId: 'issues' };
    const acmeInstance = '33333333-3333-4333-8333-333333333333';
    if (options.mixedFailureScale) control.sourceInstances.seed(toCorpusStoredValue(
        instanceRow('c', acmeSource, acmeInstance, 3, 'Acme workspace')));

    const scans = new Map<object, ScanFn>();
    const scanCalls = { count: 0 };
    const state = { sourceAFails: false, sourceBFails: false, accountReadsUnavailable: false,
        sessionLinksUnavailable: false, savedViewsUnavailable: false, pinsUnavailable: false,
        fixPullRequestsUnavailable: false, resourceUnavailable: false, entryReadUnavailable: false,
        sessionRead: 'ready' as 'ready' | 'missing' | 'failed' | 'pending', sessionReads: 0,
        sessionReadOverrides: new Map<string, 'ready' | 'missing' | 'failed'>(),
        scanGate: null as Promise<void> | null,
        /** The host refusing one connection's list invocation (an offline Machine, a broken transport). */
        listInvocationFailure: null as ((sourceInstanceId: string) => PluginError | null) | null };

    function admittedSource(
        source: Readonly<{ pluginId: string; localId: string }>,
        scan: ScanFn,
    ): TriageAdmittedSourceV1 {
        const handle = { role: 'scan', of: source.localId };
        scans.set(handle, scan);
        // The admitted entry is a host-created value whose operation handles are
        // deliberately non-constructible; a fixture stands in for the host at
        // that exact boundary and nowhere else.
        return {
            contributor: {
                pluginId: source.pluginId,
                contributionId: source.localId,
                occurrenceId: 'generation-1',
                sourceCustody: { kind: 'development' as const, registeredRootId: 'source-root' },
            },
            protocol: {
                id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
                version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
            },
            descriptor: {
                v: 1,
                purpose: 'triage-source',
                displayName: 'Example forge',
                ...(options.sourceSettings ? { settingsPageId: 'settings' } : {}),
                kinds: (options.tasks ? [{ id: 'issue', workflowSubject: 'issue', displayName: 'Issue', task: true }]
                    : [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }]).map(kind => ({
                        ...kind, ...(options.details ? { detailTabs: [{ kind: 'shared', id: 'overview' }, { kind: 'shared', id: 'activity' }] } : {}),
                    })),
            },
            operations: { listInstances: {}, scan: handle, get: {}, resolveResource: {} },
            surfaces: { detail: {} },
        } as unknown as TriageAdmittedSourceV1;
    }

    const scanA: ScanFn = async (input) => {
        scanCalls.count += 1;
        await state.scanGate;
        if (state.sourceAFails) {
            return { kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } };
        }
        if (input.page.kind === 'initial' && options.quietFirstPage) {
            return {
                kind: 'complete',
                observations: [presentObservation({ entryId: '1', title: 'Replace the duplicated normalizer', sourceUpdatedAtMs: 3_000 })],
                evidence: { kind: 'walkFinished' },
            };
        }
        if (input.page.kind === 'initial') {
            return {
                kind: 'page',
                observations: [presentObservation({
                    entryId: '1',
                    title: 'Replace the duplicated normalizer',
                    sourceUpdatedAtMs: 3_000,
                    involvement: ['reviewRequested'],
                }), ...(options.unlinkedTaskOnFirstPage ? [presentObservation({
                    entryId: 'unlinked', title: 'Unlinked maintenance task', sourceUpdatedAtMs: 2_000,
                })] : [])],
                evidence: { kind: 'partial', reason: 'more-pages' },
                continuation: { v: 1, token: 'page-2' },
            };
        }
        return {
            kind: 'complete',
            observations: [presentObservation({ entryId: '2', title: 'Older change', sourceUpdatedAtMs: 1_000 })],
            evidence: { kind: 'walkFinished' },
        };
    };

    const scanB: ScanFn = async () => {
        scanCalls.count += 1;
        await state.scanGate;
        if (state.sourceBFails) {
            return { kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } };
        }
        return {
            kind: 'complete',
            observations: [presentObservation({ entryId: '3', title: 'Middle change', sourceUpdatedAtMs: 2_000 })],
            evidence: { kind: 'walkFinished' },
        };
    };

    const admitted = [admittedSource(SOURCE_A, scanA), ...(options.sourceBUnavailable ? [] : [admittedSource(SOURCE_B, scanB)]),
        ...(options.mixedFailureScale ? [admittedSource(acmeSource, async input => {
            const { offset, limit } = input.page.kind === 'initial'
                ? { offset: 0, limit: input.page.limit }
                : JSON.parse(input.page.continuation.token) as { offset: number; limit: number };
            const count = Math.min(limit, 1_000 - offset);
            const observations = Array.from({ length: count }, (_, index) => presentObservation({
                entryId: `acme-${offset + index}`, title: `Acme issue ${offset + index}`,
                sourceUpdatedAtMs: 1_900 - offset - index,
            }));
            return offset + count === 1_000
                ? { kind: 'complete', observations, evidence: { kind: 'walkFinished' } }
                : { kind: 'page', observations, evidence: { kind: 'partial', reason: 'more-pages' },
                    continuation: { v: 1, token: JSON.stringify({ offset: offset + count, limit }) } };
        })] : [])];
    const executeScan: TriageAdmittedOperationExecutorV1 = async (operation, input) => {
        const scan = scans.get(operation as unknown as object);
        if (scan === undefined) throw new Error('No admitted scan handle for this operation.');
        const result = await scan(input);
        return !options.tasks || result.kind === 'failed' ? result : { ...result,
            observations: result.observations.map(row => ({ ...row, localRef: { ...row.localRef, kindId: 'issue' },
                ...(options.completedTask && row.kind === 'present' && row.localRef.entryId === '3' ? {
                    snapshot: testkitSnapshot({ title: 'Completed maintenance',
                        state: internalTaskStateV1('completed'), completedAtMs: Date.now() }),
                } : {}),
            })),
        };
    };

    const actionCalls: string[] = [];
    const unroutedActions: string[] = [];
    const publishedContexts: (PluginUiContextEnrichmentV1 | null)[] = [];
    const settledLocations: string[] = [];
    const surfaceOpens: PluginUiTestkitOpenSurfaceInput[] = [];
    const accountKv = createTestkitAccountKv();

    /**
     * The host's Action dispatcher. It admits the surface's request through the
     * published input schema before the handler sees it, so a surface that sent
     * something the wire would reject fails here rather than rendering.
     */
    async function executeAction(request: Readonly<{ action: unknown; input: unknown }>) {
        actionCalls.push(String(request.action));
        // The host's backend/project catalogs are outside this plugin's process.
        // This fixture has no execution backend or project; its detail reads remain real.
        if (request.action === 'agents.backends.list' || request.action === 'projects.list') {
            throw new PluginError({ code: 'unavailable', retryable: false });
        }
        if (request.action === TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1) {
            const input = TriageReadTaskOriginErrorInputV1Schema.parse(request.input);
            return { v: 1, originError: await readTaskOriginError({ entryRef: input.entryRef, collections }) };
        }
        if (String(request.action) === TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1) {
            return await createTriageResolveResourceActionHandler()(TriageResolveResourceActionInputV1Schema.parse(request.input), {
                signal: new AbortController().signal, services: {
                    storage: { account: { collection: () => collections.sourceInstances } },
                    targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: admitted }), dispose() {} }) },
                    actions: { executeAdmittedTargetedOperation: async () => state.resourceUnavailable ? { kind: 'unavailable' } : {
                        kind: 'resolved', localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '1' }, locator: testkitLocator(),
                    } },
                },
            } as unknown as TriageDataActionContext);
        }
        if (options.details && String(request.action) === TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1) {
            if (state.entryReadUnavailable) throw new PluginError({ code: 'server_unavailable', retryable: true });
            const input = TriageReobserveEntryInputV1Schema.parse(request.input);
            // Genuine host transports: Account storage, registry and the fixture source's exact get.
            const context = { surface: 'ui', signal: new AbortController().signal, services: {
                storage: { account: { collection: () => collections.sourceInstances } },
                targetedContributions: { observeForSelf: () => ({
                    readCurrent: async () => ({ contributions: admitted }), dispose() {},
                }) },
                actions: { executeAdmittedTargetedOperation: async () => ({
                    ...presentObservation({ entryId: input.entryRef.entryId, title: 'Replace the duplicated normalizer', sourceUpdatedAtMs: 3_000 }),
                    localRef: { kindId: input.entryRef.kindId, collisionScope: input.entryRef.collisionScope, entryId: input.entryRef.entryId },
                }) },
            } } as unknown as TriageDataActionContext;
            return await createTriageReobserveEntryActionHandler()(input, context);
        }
        if (options.details && String(request.action) === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) {
            return await readTriageEntryDetail(TriageReadEntryDetailInputV1Schema.parse(request.input), {
                sourceRelations: createTestkitSourceSessionRelations({ collections, contributions: admitted }),
                readSessionSummary: async () => null,
            });
        }
        if (options.details && String(request.action) === TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1) {
            if (state.fixPullRequestsUnavailable) throw new PluginError({ code: 'server_unavailable', retryable: true });
            return await readTriageFixPullRequests(TriageReadFixPullRequestsInputV1Schema.parse(request.input), {
                collections, nowMs: () => Date.now(),
                sourceRelations: createTestkitSourceSessionRelations({ collections, contributions: admitted }),
                projection: {
                    workflowSubjectOf: ref => admitted.find(source => source.contributor.pluginId === ref.source.pluginId
                        && source.contributor.contributionId === ref.source.localId)?.descriptor.kinds.find(kind => kind.id === ref.kindId)?.workflowSubject ?? null,
                    presentationOf: async () => null,
                },
            });
        }
        if (String(request.action) === TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1) {
            if (state.sessionLinksUnavailable) throw new Error('Account Session links unavailable');
            return readTestkitSourceSessionLinks(request.input, { collections, contributions: admitted });
        }
        // The shell also reads the reader's durable pins. It is a different
        // Collection and a different Action, and it reaches no source at all.
        if (String(request.action) === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
            if (state.pinsUnavailable) throw new PluginError({ code: 'server_unavailable', retryable: true });
            return await listTriagePinnedEntries(
                TriageListPinnedEntriesInputV1Schema.parse(request.input),
                { collections, nowMs: () => Date.now() },
            );
        }
        // The shell also reads the reader's saved views. It is Account
        // Account KV rather than a Collection, and it reaches no source either.
        if (String(request.action) === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) {
            if (state.savedViewsUnavailable) throw new PluginError({ code: 'server_unavailable', retryable: true });
            return await readTriageSavedViewsForSurface(
                TriageReadSavedViewsInputV1Schema.parse(request.input),
                { catalog: accountKv.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1), mintViewId: () => 'unused' },
            );
        }
        // The shell also reads the reader's configured action catalogue. It is
        // Account KV, and it reaches no source either.
        if (String(request.action) === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1) {
            return await readTriageActionsForSurface(
                TriageReadActionsInputV1Schema.parse(request.input),
                { catalog: accountKv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) },
            );
        }
        const taskOnly = String(request.action) === TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1;
        if (String(request.action) !== TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 && !taskOnly) {
            // An unrouted Action used to fall through into the list handler and
            // be parsed as a list input, so a surprise read was answered with
            // somebody else's result instead of being seen. It is recorded here
            // and asserted on below.
            unroutedActions.push(String(request.action));
            throw new Error(`unrouted Action: ${String(request.action)}`);
        }
        if (state.accountReadsUnavailable) throw new PluginError({ code: 'server_unavailable', retryable: true });
        const parsed = TriageListEntriesInputV1Schema.parse(request.input);
        const refused = parsed.sources.kind === 'selected' && parsed.sources.sourceInstances.length === 1
            ? state.listInvocationFailure?.(parsed.sources.sourceInstances.map(source => source.sourceInstanceId)[0]!) ?? null : null;
        if (refused !== null) throw refused;
        // This harness admits only its fixture external sources. TASK-NOSRC also
        // enumerates the built-in source for allConfigured; selecting the
        // harness inventory avoids inventing an unavailable personal source.
        return await listTriageEntries({ ...parsed, sources: parsed.sources.kind === 'allConfigured'
            ? await selectTestkitConfiguredSources([INSTANCE_A, INSTANCE_B, ...(options.mixedFailureScale ? [acmeInstance] : [])], collections.sourceInstances) : parsed.sources }, {
            sourceInstances: collections.sourceInstances,
            readSourceSnapshot: async () => ({ contributions: admitted }),
            executeScan,
            taskOnly,
            nowMs: () => Date.now(),
        });
    }

    const collectionReadCounts = new Map<string, number>();
    const kvReadCount = { count: 0 };
    const kvObservers = new Map<string, Set<() => void>>();
    return {
        kvReadCount,
        collectionReadCounts,
        kvObservers,
        collections,
        actionCalls,
        executeAction,
        ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
        publishedContexts,
        settledLocations,
        surfaceOpens,
        accountKv,
        admitted,
        scanCalls,
        state,
        unroutedActions,
    };
}

const mounted: PluginUiTestkit[] = [];
const scopeByHost = new WeakMap<object, PluginUiEphemeralSharedScope>();

function sourceContextFixture(harness: ReturnType<typeof createHarness>) {
    return createSurfaceContextFixture({ targetedContributions: {
        target: { pluginId: PLUGIN_MANIFEST.id, occurrenceId: 'triage-generation',
            sourceCustody: { kind: 'development', registeredRootId: 'triage-root' } },
        points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol: {
            id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
        }, contributions: harness.admitted.map(source => ({ contributor: source.contributor,
            protocol: source.protocol, descriptor: source.descriptor, operations: [], surfaces: source.descriptor.kinds.some(kind => kind.detailTabs !== undefined) ? [{
                point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol: source.protocol },
                contributor: source.contributor, role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1, presentation: 'content' as const,
            }] : [] })) }] }],
    } });
}

async function mountSurface(
    surface: RenderSurface,
    harness: ReturnType<typeof createHarness>,
    instanceId: string,
    context: Parameters<typeof createSurfaceContextFixture>[0] = {},
    options: Readonly<{ subPath?: string; launchInput?: Parameters<typeof createPluginUiTestkit>[0]['launchInput']; recordSurfaceOpens?: boolean; directAccountData?: boolean;
        dragDropRequests?: PluginUiUpdateEntityDragDropRequestV1[] }> = {},
): Promise<PluginUiTestkit> {
    // Mounting starts the window's first cycle, so the whole mount is driven
    // inside `act` — otherwise the render the cycle causes lands after the
    // helper returns and React reports an unacted update.
    let fixture!: PluginUiTestkit;
    const emptyQuery: PluginUiCollectionQuerySnapshot = { rows: [], hasMore: false, status: 'ready' };
    // Host Account-data boundary: use the same seeded collection stores as the real Action handlers.
    const dataClient = {
        collection: (definition: Readonly<{ id: string }>) => {
            const collection = definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION.id ? harness.collections.sourceInstances
                : definition.id === CORPUS_SESSION_LINKS_COLLECTION.id ? harness.collections.sessionLinks
                : definition.id === CORPUS_USER_MARKS_COLLECTION.id ? harness.collections.userMarks : null;
            if (collection) return { ...collection, query: (...args: Parameters<typeof collection.query>) => {
                harness.collectionReadCounts.set(definition.id, (harness.collectionReadCounts.get(definition.id) ?? 0) + 1);
                if (harness.state.accountReadsUnavailable) throw new PluginError({ code: 'plugin_account_storage_unavailable' });
                return collection.query(...args);
            } };
            throw new Error(`Unexpected fixture collection ${definition.id}`);
        },
        accountKv: { ...harness.accountKv.kv, get: (...args: Parameters<typeof harness.accountKv.kv.get>) => {
            harness.kvReadCount.count++;
            if (harness.state.accountReadsUnavailable) throw new PluginError({ code: 'plugin_account_storage_unavailable' });
            return harness.accountKv.kv.get(...args);
        } },
        watchAccountData: (selection: Parameters<PluginUiDataClient['watchAccountData']>[0], listener: () => void) => {
            const listeners = harness.kvObservers.get(JSON.stringify(selection)) ?? new Set<() => void>();
            harness.kvObservers.set(JSON.stringify(selection), listeners);
            listeners.add(listener);
            return Promise.resolve({ dispose: () => { listeners.delete(listener); } });
        },
        // These scenarios seed no marks or Session links; their Data query boundary is genuinely empty.
        openCollectionQuery: async () => ({ getSnapshot: () => emptyQuery, subscribe: () => () => {},
            refresh: async () => {}, loadMore: async () => {}, dispose: () => {} }),
    } as unknown as PluginUiDataClient;
    const mountSurface: RenderSurface = options.directAccountData ? context => {
        const entry = surface(context);
        if (!entry || (typeof entry.type !== 'function' && typeof entry.type !== 'object') || entry.type === null) {
            throw new Error('Missing hosted surface entry');
        }
        expect(Reflect.get(entry.type, Symbol.for('happier.pluginUi.privateSurfaceEntryProvider.v1'))).toBe(true);
        // The real host supplies Account data by cloning this marker-checked entry across the SDK React boundary.
        return React.cloneElement(entry as unknown as React.ReactElement<{ dataClient?: PluginUiDataClient }>, { dataClient });
    } : surface;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId, mountNonce: 'fixture-mount-185' },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            ...(options.subPath === undefined ? {} : { subPath: options.subPath }),
            ...(options.launchInput === undefined ? {} : { launchInput: options.launchInput }),
            surface: mountSurface,
            surfaceContext: createSurfaceContextFixture(context),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({
                ephemeralSharedScope: harness.ephemeralSharedScope,
                sessions: true,
                overlays: true,
            }),
            handlers: {
                ...(options.dragDropRequests === undefined ? {} : {
                    updateEntityDragDrop: async ({ request }: Readonly<{ request: PluginUiUpdateEntityDragDropRequestV1 }>) => {
                        options.dragDropRequests?.push(request);
                        return { accepted: true };
                    },
                    watchEntityDragDrop: async () => ({ dispose() {} }),
                }),
                ...(options.recordSurfaceOpens ? { openSurface: (request: PluginUiTestkitOpenSurfaceInput) => {
                    harness.surfaceOpens.push(request);
                } } : {}),
                readSession: ({ sessionId }) => {
                    harness.state.sessionReads += 1;
                    const outcome = harness.state.sessionReadOverrides.get(sessionId) ?? harness.state.sessionRead;
                    if (outcome === 'failed') throw new PluginError({ code: 'server_unavailable', retryable: true });
                    if (outcome === 'pending') return new Promise<never>(() => {});
                    return outcome === 'missing' ? null : {
                        sessionId, lifecycle: 'active', runtime: 'idle', operational: 'ready', pendingPermissions: [],
                        workStatus: { state: 'ready', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Ready' },
                    };
                },
                watchSession: () => {},
                publishCurrentUiContext: ({ enrichment }) => {
                    harness.publishedContexts.push(enrichment);
                },
                executeAction: async ({ action, input }) => {
                    if (action === 'ui/mounted-v1') return await createTriageMountedUiActionHandler()(TriageMountedUiInputV1Schema.parse(input), {
                        plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                        contribution: { id: 'ui/mounted-v1', qualifiedId: `${PLUGIN_MANIFEST.id}/actions/ui/mounted-v1` },
                        invocationSurface: 'ui', signal: new AbortController().signal,
                        ui: fixture.context.hostApi, ephemeralSharedScope: harness.ephemeralSharedScope,
                    });
                    return await harness.executeAction({ action, input });
                },
                // Lens edits are route-owned. These cases exercise list/window
                // projection, so let the host settle their canonical location;
                // rejection/rollback is covered at the mounted route boundary.
                replacePageLocation: ({ subPath }) => {
                    harness.settledLocations.push(subPath);
                    return subPath;
                },
            },
        });
    });
    scopeByHost.set(fixture.context.hostApi, harness.ephemeralSharedScope);
    mounted.push(fixture);
    return fixture;
}

/** Wait for the mount's existing cycle; only an explicit manual demand starts another read. */
async function settleWindow(
    trigger: 'view' | 'manual',
    fixture: PluginUiTestkit,
): Promise<void> {
    const scope = scopeByHost.get(fixture.context.hostApi);
    if (scope === undefined) throw new Error('mounted surface lost its host-owned scope');
    await act(async () => {
        if (trigger === 'manual') {
            await refreshTriageListWindow(trigger, fixture.context.hostApi, scope);
            return;
        }
        const idle = () => readTriageListWindowSnapshot(fixture.context.hostApi, scope).pending === 'idle';
        if (idle()) return;
        await new Promise<void>(resolve => {
            let unsubscribe = () => {};
            const settle = () => {
                if (!idle()) return;
                unsubscribe();
                resolve();
            };
            unsubscribe = subscribeToTriageListWindow(fixture.context.hostApi, settle, scope);
            settle();
        });
    });
}

async function visibleTexts(fixture: PluginUiTestkit, contents: readonly string[]): Promise<void> {
    for (const content of contents) {
        await expect(fixture.getByText(content)).resolves.toEqual({ content });
    }
}

/** A source-local read leaves its next provider page for explicit user demand. */
async function loadRemainingPage(fixture: PluginUiTestkit): Promise<void> {
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Load more' })); });
    await settleWindow('view', fixture);
}

function createRetirableShellSurface(): Readonly<{
    surface: RenderSurface;
    retireShell(): void;
}> {
    let setMounted: React.Dispatch<React.SetStateAction<boolean>> | null = null;
    const surface = defineUiSurface((context) => {
        const [mounted, setCurrentMounted] = React.useState(true);
        setMounted = setCurrentMounted;
        return mounted
            ? <TriageListShell {...(context.subPath === undefined ? {} : { subPath: context.subPath })} />
            : null;
    });
    return {
        surface,
        retireShell() {
            if (setMounted === null) throw new Error('shell has not mounted');
            setMounted(false);
        },
    };
}

afterEach(async () => {
    // Disposal is what releases each surface's acquisition, and the last release
    // retires the shared window — so a leaked mount here would silently hand the
    // next test a store bound to a retired host.
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

/**
 * The Triage Actions that reach a configured source.
 *
 * `entries/list-v1` is the window's own and is filtered out separately; these
 * are the ones a MOUNT must never invoke on its own, because each one spends a
 * provider read the reader did not ask for.
 */
const SOURCE_REACHING_ACTIONS: ReadonlySet<string> = new Set([
    TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
    TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
    TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
]);

async function executePublishedPresentationCommand(
    shell: PluginUiTestkit,
    harness: ReturnType<typeof createHarness>,
    matches: (operation: TriageMountedUiOperationV1, title: string) => boolean,
): Promise<void> {
    const command = harness.publishedContexts.at(-1)?.commands?.find(entry => {
        if (entry.command.kind !== 'executeAction') return false;
        const parsed = TriageMountedUiInputV1Schema.safeParse(entry.command.input);
        return parsed.success && matches(parsed.data.operation, entry.title);
    });
    if (command?.command.kind !== 'executeAction') throw new Error('Missing mounted presentation command');
    const input = command.command.input;
    await act(async () => { expect(await shell.context.hostApi.executeAction('ui/mounted-v1', input)).toEqual({ status: 'applied' }); });
}

describe('the mounted PRs & Issues surface', () => {
    it('selects the same applicable bulk action through the menu and mounted command', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'mounted-bulk-action', sourceContextFixture(harness));
        await settleWindow('view', shell);
        const command = harness.publishedContexts.at(-1)?.commands?.find(entry => entry.command.kind === 'executeAction');
        if (command?.command.kind !== 'executeAction') throw new Error('Missing mounted address');
        const { mountId } = TriageMountedUiInputV1Schema.parse(command.command.input);
        const row = readTriageListWindowSnapshot(shell.context.hostApi, harness.ephemeralSharedScope).window?.rows[0];
        if (row === undefined) throw new Error('Missing selectable entry');
        await act(async () => {
            expect(await shell.context.hostApi.executeAction('ui/mounted-v1', { mountId, operation: {
                kind: 'setSelection', entryRefs: [row.entryRef],
            } })).toEqual({ status: 'applied' });
        });
        await executePublishedPresentationCommand(shell, harness, (operation, title) => operation.kind === 'selectBulkAction' && title === 'Action: Fix');
        await expect(shell.getByRole('button', { name: 'Action: Fix' })).resolves.toBeDefined();
        await pressToolbarMenuItem(shell, 'Action', 'menuitemradio', 'Ask');
        await expect(shell.getByRole('button', { name: 'Action: Ask' })).resolves.toBeDefined();
        const choices = harness.publishedContexts.at(-1)?.commands?.filter(entry => entry.command.kind === 'executeAction'
            && TriageMountedUiInputV1Schema.safeParse(entry.command.input).success
            && TriageMountedUiInputV1Schema.parse(entry.command.input).operation.kind === 'selectBulkAction');
        expect(choices?.some(entry => entry.title === 'Action: Investigate')).toBe(false);
        await executePublishedPresentationCommand(shell, harness, (operation, title) => operation.kind === 'selectBulkAction' && title === 'Action: Fix');
        await expect(shell.getByRole('button', { name: 'Action: Fix' })).resolves.toBeDefined();
    });

    it.each(['ui', 'agent'] as const)('opens outside-source Review through source management (%s)', async route => {
        const harness = createHarness({ sourceBUnavailable: true });
        const shell = await mountSurface(renderShellSurface, harness, `outside-review-${route}`);
        await settleWindow('view', shell);
        const command = harness.publishedContexts.at(-1)?.commands?.find(entry => entry.command.kind === 'executeAction');
        if (command?.command.kind !== 'executeAction') throw new Error('Missing mounted address');
        const { mountId } = TriageMountedUiInputV1Schema.parse(command.command.input);
        await act(async () => {
            expect(await shell.context.hostApi.executeAction('ui/mounted-v1', { mountId, operation: {
                kind: 'setLens', query: '', order: 'smart',
                filters: { ...TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, sources: [{ source: SOURCE_A, sourceInstanceId: INSTANCE_A }] },
            } })).toEqual({ status: 'applied' });
        });
        await settleWindow('view', shell);
        await expect(shell.getByRole('button', { name: 'Review' })).resolves.toBeDefined();
        if (route === 'ui') await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Review' })); });
        else await executePublishedPresentationCommand(shell, harness, (operation, title) => operation.kind === 'setSourceManagementOpen' && title === 'Review');
        await expect(shell.getByText('Configured sources')).resolves.toBeDefined();
    });

    it.each(['ui', 'agent'] as const)('closes the launched configured-action editor (%s)', async route => {
        const harness = createHarness();
        const surface = defineUiSurface(() => <TriageListShell actionEditor={{ v: 1, kind: 'actionEditor' }} />);
        const shell = await mountSurface(surface, harness, `close-editor-${route}`);
        await settleWindow('view', shell);
        await expect(shell.getByRole('button', { name: 'Add an action' })).resolves.toBeDefined();
        if (route === 'ui') await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Done' })); });
        else await executePublishedPresentationCommand(shell, harness, operation => operation.kind === 'closeActionEditor');
        await expect(shell.queryByRole('button', { name: 'Add an action' })).resolves.toBeUndefined();
    });

    it('shares the Add source menu and source-owned settings launch', async () => {
        const harness = createHarness({ sourceSettings: true });
        const shell = await mountSurface(renderShellSurface, harness, 'mounted-add-source', sourceContextFixture(harness), { recordSurfaceOpens: true, directAccountData: true });
        await settleWindow('view', shell);
        await executePublishedPresentationCommand(shell, harness, operation => operation.kind === 'setSourceManagementOpen');
        await executePublishedPresentationCommand(shell, harness, operation => operation.kind === 'setAddSourceOpen');
        const choices = await shell.getAllByRole('menuitem', { name: 'Example forge' });
        expect(choices).toHaveLength(2);
        await executePublishedPresentationCommand(shell, harness, operation => operation.kind === 'setAddSourceOpen');
        await expect(shell.queryByRole('menuitem', { name: 'Example forge' })).resolves.toBeUndefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Add a source' })); });
        await act(async () => { await shell.press((await shell.getAllByRole('menuitem', { name: 'Example forge' }))[0]!); });
        expect(harness.surfaceOpens).toHaveLength(1);
        await executePublishedPresentationCommand(shell, harness, operation => operation.kind === 'configureSource' && operation.sourceId === `${SOURCE_A.pluginId}/settings`);
        expect(harness.surfaceOpens).toHaveLength(2);
        expect(harness.surfaceOpens[1]).toEqual(harness.surfaceOpens[0]);
    });

    it('shares source management and organize state between published commands and controls', async () => {
        const harness = createHarness({ mixedFailureScale: true });
        const shell = await mountSurface(renderShellSurface, harness, 'mounted-presentation');
        await settleWindow('view', shell);
        const snapshot = () => readTriageListWindowSnapshot(shell.context.hostApi, harness.ephemeralSharedScope);
        await act(async () => {
            while ((snapshot().window?.rows.length ?? 0) < 1_000) {
                const before = snapshot().window?.rows.length ?? 0;
                expect(snapshot().loadMore).toEqual({ kind: 'available' });
                await loadMoreTriageListWindow(shell.context.hostApi, harness.ephemeralSharedScope);
                expect(snapshot().window?.rows.length).toBeGreaterThan(before);
            }
        });
        expect(snapshot().window?.rows.length).toBeGreaterThanOrEqual(1_000);
        const invoke = async (kind: string) => {
            const command = harness.publishedContexts.at(-1)?.commands?.find(entry => {
                if (entry.command.kind !== 'executeAction') return false;
                const parsed = TriageMountedUiInputV1Schema.safeParse(entry.command.input);
                return parsed.success && parsed.data.operation.kind === kind;
            });
            expect(command, `Missing mounted ${kind}`).toBeDefined();
            if (command?.command.kind !== 'executeAction') throw new Error(`Missing mounted ${kind}`);
            const input = command.command.input;
            await act(async () => { expect(await shell.context.hostApi.executeAction('ui/mounted-v1', input)).toEqual({ status: 'applied' }); });
        };
        const before = { scans: harness.scanCalls.count, writes: harness.accountKv.setCallCount() };
        await invoke('setSourceManagementOpen');
        await expect(shell.getByText('Configured sources')).resolves.toBeDefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Close' })); });
        await expect(shell.queryByText('Configured sources')).resolves.toBeUndefined();
        await pressToolbarMenuItem(shell, 'More', 'menuitem', 'Manage sources');
        await expect(shell.getByText('Configured sources')).resolves.toBeDefined();
        await invoke('setSourceManagementOpen');
        await expect(shell.queryByText('Configured sources')).resolves.toBeUndefined();
        await invoke('setOrganizing');
        await expect(shell.getByRole('button', { name: 'Done' })).resolves.toBeDefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Done' })); });
        await expect(shell.queryByRole('button', { name: 'Done' })).resolves.toBeUndefined();
        await pressToolbarMenuItem(shell, 'More', 'menuitem', 'Organize list');
        await expect(shell.getByRole('button', { name: 'Done' })).resolves.toBeDefined();
        await invoke('setOrganizing');
        await expect(shell.queryByRole('button', { name: 'Done' })).resolves.toBeUndefined();
        expect(harness.scanCalls.count).toBe(before.scans);
        expect(harness.accountKv.setCallCount()).toBe(before.writes);
    }, 120_000);

    it('opens the configured-action editor through the same launch for control and mounted command', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'mounted-editor', {}, { recordSurfaceOpens: true });
        await settleWindow('view', shell);
        await pressToolbarMenuItem(shell, 'More', 'menuitem', 'Configure actions');
        expect(harness.surfaceOpens).toHaveLength(1);
        const command = harness.publishedContexts.at(-1)?.commands?.find(entry => entry.command.kind === 'executeAction'
            && TriageMountedUiInputV1Schema.parse(entry.command.input).operation.kind === 'openActionEditor');
        expect(command).toBeDefined();
        if (command?.command.kind !== 'executeAction') throw new Error('Missing editor command');
        const input = command.command.input;
        await act(async () => { expect(await shell.context.hostApi.executeAction('ui/mounted-v1', input)).toEqual({ status: 'applied' }); });
        expect(harness.surfaceOpens).toHaveLength(2);
        expect(harness.surfaceOpens[1]).toEqual(harness.surfaceOpens[0]);
    });

    it.each([
        ['resolve', 'ui'], ['read', 'ui'], ['resolve', 'agent'], ['read', 'agent'],
    ] as const)('recovers an unavailable resource through its Retry (%s, %s)', async (failure, surface) => {
        const harness = createHarness({ details: true });
        harness.state.resourceUnavailable = failure === 'resolve';
        harness.state.entryReadUnavailable = failure === 'read';
        const resource = { kind: 'pullRequest' as const, url: 'https://github.com/example/repository/pull/1' };
        const resourceSurface = defineUiSurface(() => <TriageResourceSurface resource={resource} />);
        const page = await mountSurface(resourceSurface, harness, `resource-${failure}`, sourceContextFixture(harness));
        await expect(page.getByText('These details are unavailable')).resolves.toBeDefined();
        await expect(page.getByRole('button', { name: 'Retry' })).resolves.toBeDefined();
        await expect(page.getByRole('button', { name: 'Open on GitHub' })).resolves.toBeDefined();
        harness.state.resourceUnavailable = false;
        harness.state.entryReadUnavailable = false;
        const retry = harness.publishedContexts.at(-1)?.commands?.find(command => command.command.kind === 'executeAction'
            && TriageMountedUiInputV1Schema.parse(command.command.input).operation.kind === 'refresh');
        if (retry?.command.kind !== 'executeAction') throw new Error('Missing resource Retry command');
        await act(async () => {
            if (surface === 'ui') await page.press(await page.getByRole('button', { name: 'Retry' }));
            else expect(await createTriageMountedUiActionHandler()(TriageMountedUiInputV1Schema.parse(retry.command.input), {
                plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                contribution: { id: 'ui/mounted-v1', qualifiedId: `${PLUGIN_MANIFEST.id}/actions/ui/mounted-v1` },
                invocationSurface: surface, signal: new AbortController().signal,
                ui: page.context.hostApi, ephemeralSharedScope: harness.ephemeralSharedScope,
            })).toEqual({ status: 'applied' });
        });
        await expect(page.getByRole('heading', { name: 'Replace the duplicated normalizer' })).resolves.toBeDefined();
        await expect(page.queryByText('These details are unavailable')).resolves.toBeUndefined();
        await expect(page.queryByRole('button', { name: 'Open on GitHub' })).resolves.toBeUndefined();
        expect(harness.actionCalls.filter(action => action === TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1)).toHaveLength(2);
        expect(harness.scanCalls.count).toBe(0);
        expect(harness.unroutedActions).toEqual([]);
    });

    it.each(['ui', 'agent', 'refresh'] as const)('recovers failed fix PR links through the same mounted read (%s)', async surface => {
        const harness = createHarness({ tasks: true, details: true });
        harness.state.fixPullRequestsUnavailable = true;
        const shell = await mountSurface(renderShellSurface, harness, `fix-pr-retry-${surface}`, sourceContextFixture(harness));
        await settleWindow('view', shell);
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Replace the duplicated normalizer' }));
        });
        await expect(shell.getByText('Fix pull request links could not be read.')).resolves.toBeDefined();
        const retryCommand = harness.publishedContexts.at(-1)?.commands?.find(command => {
            if (command.command.kind !== 'executeAction') return false;
            const parsed = TriageMountedUiInputV1Schema.safeParse(command.command.input);
            return parsed.success && parsed.data.operation.kind === 'retryFixPullRequests';
        });
        expect(retryCommand).toBeDefined();
        if (retryCommand?.command.kind !== 'executeAction') throw new Error('Missing fix-PR Retry command');
        const scansBeforeRetry = harness.scanCalls.count;
        const readsBeforeRetry = harness.actionCalls.filter(action => action === TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1).length;
        harness.state.fixPullRequestsUnavailable = false;
        await act(async () => {
            if (surface === 'ui') await shell.press(await shell.getByRole('button', { name: 'Retry: Fix pull request' }));
            else expect(await createTriageMountedUiActionHandler()(surface === 'refresh'
                ? { ...TriageMountedUiInputV1Schema.parse(retryCommand.command.input), operation: { kind: 'refresh' } }
                : TriageMountedUiInputV1Schema.parse(retryCommand.command.input), {
                plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                contribution: { id: 'ui/mounted-v1', qualifiedId: `${PLUGIN_MANIFEST.id}/actions/ui/mounted-v1` },
                invocationSurface: 'agent', signal: new AbortController().signal,
                ui: shell.context.hostApi, ephemeralSharedScope: harness.ephemeralSharedScope,
            })).toEqual({ status: 'applied' });
        });
        await expect(shell.queryByText('Fix pull request links could not be read.')).resolves.toBeUndefined();
        if (surface !== 'refresh') expect(harness.scanCalls.count).toBe(scansBeforeRetry);
        expect(harness.actionCalls.filter(action => action === TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1)).toHaveLength(readsBeforeRetry + 1);
        expect(harness.unroutedActions).toEqual([]);
    });

    it.each(['ui', 'agent'] as const)('recovers failed pins and saved views through the same mounted Retry (%s)', async surface => {
        const harness = createHarness();
        harness.state.savedViewsUnavailable = true;
        harness.state.pinsUnavailable = true;
        const shell = await mountSurface(renderShellSurface, harness, `account-retry-${surface}`, sourceContextFixture(harness));
        await settleWindow('view', shell);
        await expect(shell.getByText('Happier cannot reach your account right now, so pins and saved views cannot be changed.')).resolves.toBeDefined();
        const retryCommand = harness.publishedContexts.at(-1)?.commands?.find(command => {
            if (command.command.kind !== 'executeAction') return false;
            const parsed = TriageMountedUiInputV1Schema.safeParse(command.command.input);
            return parsed.success && parsed.data.operation.kind === 'retryAccountData';
        });
        expect(retryCommand).toBeDefined();
        if (retryCommand?.command.kind !== 'executeAction') throw new Error('Missing Account-data Retry command');
        const scansBeforeRetry = harness.scanCalls.count;
        harness.state.savedViewsUnavailable = false;
        harness.state.pinsUnavailable = false;
        await act(async () => {
            if (surface === 'ui') await shell.press(await shell.getByRole('button', { name: 'Retry' }));
            else expect(await createTriageMountedUiActionHandler()(TriageMountedUiInputV1Schema.parse(retryCommand.command.input), {
                plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                contribution: { id: 'ui/mounted-v1', qualifiedId: `${PLUGIN_MANIFEST.id}/actions/ui/mounted-v1` },
                invocationSurface: surface, signal: new AbortController().signal,
                ui: shell.context.hostApi, ephemeralSharedScope: harness.ephemeralSharedScope,
            })).toEqual({ status: 'applied' });
        });
        await expect(shell.queryByText('Happier cannot reach your account right now, so pins and saved views cannot be changed.')).resolves.toBeUndefined();
        expect(harness.scanCalls.count).toBe(scansBeforeRetry);
        expect(harness.unroutedActions).toEqual([]);
    });

    it('projects pins and sources deleted elsewhere on their existing collection changes without extra reads', async () => {
        const harness = createHarness();
        const ref = { source: SOURCE_A, kindId: 'pull-request', collisionScope: 'example/repository', entryId: 'external-pin' };
        await setTriageEntryPinned({ v: 1, pinned: true, entryRef: ref, displayAtMark: { title: 'External pin', scopeLabel: 'Example' } },
            { collections: harness.collections, nowMs: () => 1 });
        let pins: ReturnType<typeof useTriagePinnedEntries> | undefined;
        let sources: ReturnType<typeof useTriageConfiguredSources> | undefined;
        const surface = defineUiSurface(() => { pins = useTriagePinnedEntries(); sources = useTriageConfiguredSources(); return <></>; });
        await mountSurface(surface, harness, 'external-deletions', {}, { directAccountData: true });
        expect(pins?.pins).toHaveLength(1);
        expect(sources?.sources.some(source => source.sourceInstanceId === INSTANCE_A)).toBe(true);
        await setTriageEntryPinned({ v: 1, pinned: false, entryRef: ref }, { collections: harness.collections, nowMs: () => 2 });
        expect(await removeConfiguredSourceInstance({ collections: harness.collections, sourceInstanceId: INSTANCE_A,
            signal: new AbortController().signal })).toMatchObject({ kind: 'removed' });
        const before = new Map(harness.collectionReadCounts);
        await act(async () => {
            for (const collectionId of [CORPUS_USER_MARKS_COLLECTION.id, CORPUS_SOURCE_INSTANCES_COLLECTION.id]) {
                for (const listener of harness.kvObservers.get(JSON.stringify({ kind: 'collection', collectionId })) ?? []) listener();
            }
        });
        expect.soft(pins?.pins).toHaveLength(0);
        expect.soft(sources?.sources.some(source => source.sourceInstanceId === INSTANCE_A)).toBe(false);
        expect(sources?.sources.some(source => source.sourceInstanceId === INSTANCE_B)).toBe(true);
        for (const id of [CORPUS_USER_MARKS_COLLECTION.id, CORPUS_SOURCE_INSTANCES_COLLECTION.id]) {
            expect((harness.collectionReadCounts.get(id) ?? 0) - (before.get(id) ?? 0)).toBe(1);
        }
    });

    it('clears a selected view on one external KV change with one catalog read and no writes', async () => {
        const harness = createHarness();
        const viewId = '00000001-0000-4000-8000-000000000000';
        const catalog = harness.accountKv.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1);
        const created = await administerTriageSavedView(TriageAdministerSavedViewInputV1Schema.parse({
            v: 1, kind: 'create', expectedRevision: 'absent', label: 'External deletion', query: 'normalizer',
            filters: TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, order: 'newest',
            smartPolicy: TRIAGE_ROUTE_DEFAULT_LENS_V1.smartPolicy,
        }), { catalog, mintViewId: () => viewId });
        expect(created.status).toBe('applied');
        const shell = await mountSurface(renderShellSurface, harness, 'pushed-view-delete', sourceContextFixture(harness), {
            directAccountData: true, subPath: `?sv=${viewId}`,
        });
        await settleWindow('view', shell);
        // Select through the mounted public Action, as an actual reader would.
        const detail = harness.publishedContexts.at(-1)?.detail;
        if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new Error('Missing context');
        const address = detail.mountedAction;
        if (!address || typeof address !== 'object' || Array.isArray(address)) throw new Error('Missing mount');
        await act(async () => {
            expect(await shell.context.hostApi.executeAction('ui/mounted-v1', {
                mountId: address.mountId, operation: { kind: 'selectSavedView', viewId },
            })).toEqual({ status: 'applied' });
        });
        expect(parseTriageRouteSubPathV1(harness.settledLocations.at(-1))?.selectedViewId).toBe(viewId);
        // Spy at the persistent KV boundary; the projection must need only one read.
        const readsBefore = harness.kvReadCount.count;
        await act(async () => {
            expect((await administerTriageSavedView(TriageAdministerSavedViewInputV1Schema.parse({
                v: 1, kind: 'delete', viewId, expectedRevision: harness.accountKv.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
            }), { catalog, mintViewId: () => viewId })).status).toBe('applied');
        });
        const before = { reads: harness.kvReadCount.count, writes: harness.accountKv.setCallCount() };
        await act(async () => {
            for (const listener of harness.kvObservers.get(JSON.stringify({ kind: 'kv', key: TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1 })) ?? []) listener();
        });
        expect(parseTriageRouteSubPathV1(harness.settledLocations.at(-1))?.selectedViewId).toBeNull();
        expect(harness.kvReadCount.count - before.reads).toBe(1);
        expect(harness.accountKv.setCallCount()).toBe(before.writes);
        expect(readsBefore).toBeGreaterThan(0);
    });

    it('selects an externally created saved view through the mounted Action using the current Account catalog', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'external-saved-view', sourceContextFixture(harness));
        await settleWindow('view', shell);
        const catalogReads = () => harness.actionCalls.filter(action => action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1).length;
        const initialReads = catalogReads();
        expect(initialReads).toBeGreaterThan(0);
        const detail = harness.publishedContexts.at(-1)?.detail;
        if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new Error('Expected current list context');
        const address = detail.mountedAction;
        if (!address || typeof address !== 'object' || Array.isArray(address) || typeof address.mountId !== 'string') {
            throw new Error('Expected mounted list Action address');
        }
        const mountId = address.mountId;
        const select = async (viewId: string | null) => await shell.context.hostApi.executeAction('ui/mounted-v1', {
            mountId, operation: { kind: 'selectSavedView', viewId },
        });
        const viewId = '00000001-0000-4000-8000-000000000000';
        const externalWrite = async (kind: 'create' | 'update' | 'delete', query = 'normalizer') => {
            const input = { v: 1, kind, expectedRevision: harness.accountKv.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
                ...(kind === 'create' ? {} : { viewId }),
                ...(kind === 'delete' ? {} : { label: 'External view', query,
                    filters: TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, order: 'newest',
                    smartPolicy: TRIAGE_ROUTE_DEFAULT_LENS_V1.smartPolicy }) };
            return await administerTriageSavedView(TriageAdministerSavedViewInputV1Schema.parse(input), {
                catalog: harness.accountKv.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1), mintViewId: () => viewId,
            });
        };
        expect((await externalWrite('create')).status).toBe('applied');
        const writesAfterCreate = harness.accountKv.setCallCount();
        // An external write is not a local subscription event. Selection is
        // the explicit demand; merely retaining the mount starts no new read.
        expect(catalogReads()).toBe(initialReads);
        await act(async () => { expect(await select(viewId)).toEqual({ status: 'applied' }); });
        await settleWindow('view', shell);
        expect(parseTriageRouteSubPathV1(harness.settledLocations.at(-1))).toMatchObject({ selectedViewId: viewId, query: 'normalizer' });
        expect(catalogReads() - initialReads).toBe(1);
        expect(harness.accountKv.setCallCount()).toBe(writesAfterCreate);

        expect((await externalWrite('update', 'Older')).status).toBe('applied');
        const readsBeforeUpdate = catalogReads();
        const writesAfterUpdate = harness.accountKv.setCallCount();
        await act(async () => { expect(await select(viewId)).toEqual({ status: 'applied' }); });
        await settleWindow('view', shell);
        expect(parseTriageRouteSubPathV1(harness.settledLocations.at(-1))).toMatchObject({ selectedViewId: viewId, query: 'Older' });
        expect(catalogReads() - readsBeforeUpdate).toBe(1);
        expect(harness.accountKv.setCallCount()).toBe(writesAfterUpdate);

        harness.state.savedViewsUnavailable = true;
        const beforeFailedRead = { reads: catalogReads(), locations: harness.settledLocations.length };
        await act(async () => { expect(await select(viewId)).toEqual({ status: 'unavailable' }); });
        expect(catalogReads() - beforeFailedRead.reads).toBe(1);
        expect(harness.settledLocations).toHaveLength(beforeFailedRead.locations);
        expect(harness.accountKv.setCallCount()).toBe(writesAfterUpdate);
        harness.state.savedViewsUnavailable = false;

        expect((await externalWrite('delete')).status).toBe('applied');
        const readsBeforeDelete = catalogReads();
        await act(async () => { expect(await select(viewId)).toEqual({ status: 'unavailable' }); });
        expect(catalogReads() - readsBeforeDelete).toBe(1);
        // The one authoritative projection update retires its missing selection;
        // no second explicit clear from the surface or agent is needed.
        expect(parseTriageRouteSubPathV1(harness.settledLocations.at(-1))?.selectedViewId).toBeNull();
        const readsBeforeClear = catalogReads();
        await act(async () => { expect(await select(null)).toEqual({ status: 'applied' }); });
        expect(catalogReads()).toBe(readsBeforeClear);
        expect(parseTriageRouteSubPathV1(harness.settledLocations.at(-1))?.selectedViewId).toBeNull();
    });

    it('reaches assignable status columns through the Tasks page View chooser and returns to its list', async () => {
        const harness = createHarness({ tasks: true });
        const dragDropRequests: PluginUiUpdateEntityDragDropRequestV1[] = [];
        const shell = await mountSurface(renderShellSurface, harness, 'tasks-status-board', sourceContextFixture(harness), {
            subPath: 'tasks,everyone', dragDropRequests,
        });
        await settleWindow('view', shell);
        const stage = document.querySelector('[data-testid="triage-shell-fill:stage"]');
        expect(stage).not.toBeNull();
        // RNW's native layout event is the existing Collection harness's platform boundary.
        const onLayout: unknown = Reflect.get(stage!, '__reactLayoutHandler');
        if (typeof onLayout !== 'function') throw new Error('Missing RNW Collection layout boundary');
        await act(async () => { onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 1000 } } }); });
        expect(document.querySelector('[data-testid="triage-shell-fill:column:started"]')).toBeNull();
        await act(async () => { await shell.press(await shell.getByRole('radio', { name: 'Board' })); });
        await vi.waitFor(() => {
            expect(document.querySelector('[data-testid="triage-shell-fill:column:started"]')).not.toBeNull();
            expect(document.querySelector('[data-testid="triage-shell-fill:column:completed"]')).not.toBeNull();
        });
        const targets = dragDropRequests.filter(request => request.kind === 'mountTarget').filter(request => request.targetId === 'task-status');
        expect(targets).toHaveLength(5);
        await act(async () => { await shell.press(await shell.getByRole('radio', { name: 'List' })); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="triage-shell-fill:column:started"]')).toBeNull());
        for (const target of targets) expect(dragDropRequests).toContainEqual({ kind: 'unmount', mountId: target.mountId });
        await executePublishedPresentationCommand(shell, harness, operation => operation.kind === 'switchView' && operation.view === 'board');
        await vi.waitFor(() => expect(document.querySelector('[data-testid="triage-shell-fill:column:started"]')).not.toBeNull());
        await executePublishedPresentationCommand(shell, harness, operation => operation.kind === 'switchView' && operation.view === 'list');
        await vi.waitFor(() => expect(document.querySelector('[data-testid="triage-shell-fill:column:started"]')).toBeNull());
    });

    it.each([false, true])('offers both Q1 views on the same lens and keeps the legacy Tasks entrance navigable (legacy=%s)', async legacy => {
        const harness = createHarness({ tasks: true });
        const entryRef = { source: SOURCE_A, kindId: 'issue', collisionScope: 'example/repository', entryId: '1' };
        const savedViewId = '00000001-0000-4000-8000-000000000000';
        const lens = { ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query: 'normalizer', selectedViewId: savedViewId,
            selection: entryRef, filters: { ...TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, tasks: 'everyone' as const } };
        const created = await mutateTriageSavedViews({
            catalog: harness.accountKv.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1), mintViewId: () => savedViewId,
        }, { kind: 'create', expectedRevision: harness.accountKv.revision(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
            label: 'Maintenance', query: lens.query, filters: lens.filters, order: lens.order, smartPolicy: lens.smartPolicy });
        expect(created.status).toBe('applied');
        const launch = buildTriageEntryDetailLaunchInput({ entryRef,
            sourceInstance: { source: SOURCE_A, sourceInstanceId: INSTANCE_A },
            originComposer: { kind: 'pendingMessage', sessionId: 'session-1', localId: 'pending-1' } });
        const writesBeforeSwitch = harness.accountKv.setCallCount();
        const shell = await mountSurface(legacy ? renderTasksSurface : renderShellSurface, harness, `q1-${legacy}`,
            sourceContextFixture(harness), { subPath: buildTriageRouteSubPathV1(lens), launchInput: launch, recordSurfaceOpens: true });
        await settleWindow('view', shell);
        const commands = harness.publishedContexts.at(-1)?.commands ?? [];
        const prs = commands.find(command => command.title === 'PRs & Issues');
        expect(commands.some(command => command.title === 'Tasks')).toBe(true);
        expect(prs?.command.kind).toBe('executeAction');
        if (prs?.command.kind !== 'executeAction') throw new Error('Missing PRs & Issues view command');
        const input = TriageMountedUiInputV1Schema.parse(prs.command.input);
        await act(async () => {
            expect(await invokeTriageMountedUiAction(harness.ephemeralSharedScope, input.mountId, input.operation,
                new AbortController().signal)).toEqual({ status: 'applied' });
        });
        const expected = { ...lens, filters: TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, selectionSourceInstanceId: INSTANCE_A };
        if (legacy) {
            expect(harness.surfaceOpens).toEqual([expect.objectContaining({
                view: { pluginId: 'happier.triage', localId: 'triage' }, subPath: buildTriageRouteSubPathV1(expected),
                input: launch,
            })]);
            expect(parseTriageEntryDetailLaunchInput(harness.surfaceOpens[0]?.input)).toEqual({ status: 'valid', input: launch });
        }
        else expect(parseTriageRouteSubPathV1(harness.settledLocations.at(-1))).toEqual(expected);
        expect(harness.accountKv.setCallCount()).toBe(writesBeforeSwitch);
    });

    it('switches between Tasks and PRs & Issues from the page’s own view switch, without saved-view writes', async () => {
        const harness = createHarness({ tasks: true });
        const writesBefore = harness.accountKv.setCallCount();
        const shell = await mountSurface(renderShellSurface, harness, 'q1-switch', sourceContextFixture(harness));
        await settleWindow('view', shell);
        await act(async () => { await shell.press(await shell.getByRole('radio', { name: 'Tasks' })); });
        await vi.waitFor(() => expect(parseTriageRouteSubPathV1(harness.settledLocations.at(-1))?.filters.tasks).toBe('mine'));
        await vi.waitFor(async () => expect(await shell.getByRole('radio', { name: 'Tasks', state: { checked: true } })).toBeDefined());
        await act(async () => { await shell.press(await shell.getByRole('radio', { name: 'PRs & Issues' })); });
        await vi.waitFor(() => expect(parseTriageRouteSubPathV1(harness.settledLocations.at(-1))?.filters.tasks).toBeUndefined());
        expect(harness.accountKv.setCallCount()).toBe(writesBefore);
    });

    it.each([false, true])('settles unavailable admission without a loading or confirmed-empty claim (Tasks=%s)', async tasks => {
        const harness = createHarness({ tasks });
        const context = { ...sourceContextFixture(harness), requesterExecutionReady: false,
            machineConnectionPending: false, machineExecutionReady: false };
        const shell = await mountSurface(renderShellSurface, harness, `unavailable-list-${tasks}`, context,
            tasks ? { subPath: 'tasks,everyone' } : {});
        await expect(shell.queryByText('Reading your sources…')).resolves.toBeUndefined();
        await expect(shell.queryByText('Nothing needs you')).resolves.toBeUndefined();
        await expect(shell.queryByText('No tasks here')).resolves.toBeUndefined();
        await expect(shell.getByText('The list could not be read')).resolves.toBeDefined();
        expect(harness.scanCalls.count).toBe(0);
        await act(async () => { await shell.updateSurface({ ...context, requesterExecutionReady: true }); });
        await settleWindow('view', shell);
        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
    });

    it('reads linked Session activity without a note pushing the list down', async () => {
        const harness = createHarness();
        await linkEntryToSession({ collections: harness.collections,
            entryRef: { source: SOURCE_A, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '1' },
            sessionId: 'pending-linked-session', display: { locator: testkitLocator(), scopeLabel: LABEL_A }, nowMs: 1 });
        harness.state.sessionRead = 'pending';
        const shell = await mountSurface(renderShellSurface, harness, 'linked-session-pending', sourceContextFixture(harness));
        await settleWindow('view', shell);
        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        expect(harness.state.sessionReads).toBeGreaterThan(0);
        await expect(shell.queryByText('Reading linked Session activity…')).resolves.toBeUndefined();
    });

    it.each([
        { initialRead: 'missing', tasks: false, surface: 'ui' },
        { initialRead: 'failed', tasks: false, surface: 'ui' },
        { initialRead: 'failed', tasks: false, surface: 'agent' },
        { initialRead: 'missing', tasks: true, surface: 'ui' },
    ] as const)('keeps terminal linked Sessions visible without Retry ($initialRead, Tasks=$tasks, $surface)', async ({ initialRead, tasks, surface }) => {
        const harness = createHarness({ tasks });
        const entryRef = { source: SOURCE_A, kindId: tasks ? 'issue' : 'pull-request', collisionScope: 'example/repository', entryId: '1' };
        await linkEntryToSession({ collections: harness.collections,
            entryRef,
            sessionId: 'retained-linked-session', display: { locator: testkitLocator(), scopeLabel: LABEL_A }, nowMs: 1 });
        if (initialRead === 'failed') {
            await linkEntryToSession({ collections: harness.collections,
                entryRef,
                sessionId: 'known-missing-session', display: { locator: testkitLocator(), scopeLabel: LABEL_A }, nowMs: 2 });
            harness.state.sessionReadOverrides.set('known-missing-session', 'missing');
        }
        harness.state.sessionRead = initialRead;
        const shell = await mountSurface(renderShellSurface, harness, `linked-session-${initialRead}-${tasks}`, sourceContextFixture(harness),
            tasks ? { subPath: 'tasks,agents' } : {});
        await settleWindow('view', shell);
        if (initialRead === 'failed') {
            await expect(shell.getByText('Some linked Session activity could not be read.')).resolves.toBeDefined();
            harness.state.sessionRead = 'ready';
            await act(async () => {
                if (surface === 'ui') await shell.press(await shell.getByRole('button', { name: 'Retry' }));
                else {
                    const command = harness.publishedContexts.at(-1)?.commands?.find(command => {
                        if (command.command.kind !== 'executeAction') return false;
                        const parsed = TriageMountedUiInputV1Schema.safeParse(command.command.input);
                        return parsed.success && parsed.data.operation.kind === 'retrySessionActivity';
                    });
                    expect(command).toBeDefined();
                    if (command?.command.kind !== 'executeAction') throw new Error('Missing linked-Session Retry command');
                    expect(await createTriageMountedUiActionHandler()(TriageMountedUiInputV1Schema.parse(command.command.input), {
                        plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                        contribution: { id: 'ui/mounted-v1', qualifiedId: `${PLUGIN_MANIFEST.id}/actions/ui/mounted-v1` },
                        invocationSurface: surface, signal: new AbortController().signal,
                        ui: shell.context.hostApi, ephemeralSharedScope: harness.ephemeralSharedScope,
                    })).toEqual({ status: 'applied' });
                }
            });
        }
        await expect(shell.getByText('Some linked Sessions are unavailable.')).resolves.toBeDefined();
        await expect(shell.queryByText('Some linked Session activity could not be read.')).resolves.toBeUndefined();
        await expect(shell.queryByText('Reading linked Session activity…')).resolves.toBeUndefined();
        await expect(shell.queryByRole('button', { name: 'Retry' })).resolves.toBeUndefined();
        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        expect(harness.state.sessionReads).toBe(initialRead === 'failed' ? 4 : 1);
    });

    it('does not reread relations for reordered rows with unchanged membership and selected sources', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'relation-demand-producer');
        await settleWindow('view', shell);
        await loadRemainingPage(shell);
        const relationReads = () => harness.actionCalls.filter(action => action === TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1).length;
        const initialReads = relationReads();
        expect(initialReads).toBeGreaterThan(0);
        const detail = harness.publishedContexts.at(-1)?.detail;
        if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new Error('Expected current list context');
        const address = detail.mountedAction;
        if (!address || typeof address !== 'object' || Array.isArray(address) || typeof address.mountId !== 'string') {
            throw new Error('Expected mounted list Action address');
        }
        const mountId = address.mountId;
        const scansBefore = harness.scanCalls.count;
        await act(async () => {
            expect(await invokeTriageMountedUiAction(harness.ephemeralSharedScope, mountId, {
                kind: 'setLens', query: '', filters: TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, order: 'oldest',
            }, new AbortController().signal)).toEqual({ status: 'applied' });
        });
        await settleWindow('view', shell);
        await visibleTexts(shell, ['Replace the duplicated normalizer', 'Older change', 'Middle change']);
        expect(parseTriageRouteSubPathV1(harness.settledLocations.at(-1))).toMatchObject({ order: 'oldest' });
        // A named-order edit projects the retained rows, without a provider
        // acquisition or another relationship demand (263c6dea36b).
        expect(harness.scanCalls.count).toBe(scansBefore);
        expect(relationReads()).toBe(initialReads);
        // Explicit Refresh still acquires fresh relationships once.
        await settleWindow('manual', shell);
        expect(relationReads() - initialReads).toBe(1);
    });

    it('shares Tasks Done disclosure between the published mounted Action and human Show/Hide without reads or writes', async () => {
        const harness = createHarness({ tasks: true, completedTask: true });
        const tasksContext = sourceContextFixture(harness);
        const shell = await mountSurface(renderShellSurface, harness, 'tasks-disclosure', tasksContext, { subPath: 'tasks,everyone' });
        await settleWindow('view', shell);
        const declaration = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === 'ui/mounted-v1');
        if (declaration?.execution.target !== 'client') throw new Error('Missing mounted client Action');
        const client = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST,
            target: { ...declaration.execution.client, platform: 'web' }, activate });
        try {
            const handler = client.registration('actions', declaration.id);
            if (!handler) throw new Error('Missing mounted registration');
            const disclosureCommand = () => harness.publishedContexts.at(-1)?.commands?.find(entry => {
                if (entry.command.kind !== 'executeAction') return false;
                const parsed = TriageMountedUiInputV1Schema.safeParse(entry.command.input);
                return parsed.success && parsed.data.operation.kind === 'setGroupExpanded';
            });
            const invoke = async (input?: unknown) => {
                const command = disclosureCommand();
                expect(command).toBeDefined();
                if (command?.command.kind !== 'executeAction') throw new Error('Missing group disclosure command');
                return await handler(input ?? command.command.input, {
                    plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                    contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
                    invocationSurface: 'agent', signal: new AbortController().signal,
                    ui: shell.context.hostApi, ephemeralSharedScope: harness.ephemeralSharedScope,
                });
            };
            const before = { scans: harness.scanCalls.count, reads: harness.actionCalls.length };
            const initial = disclosureCommand();
            expect(initial?.command.kind).toBe('executeAction');
            if (initial?.command.kind !== 'executeAction') throw new Error('Missing initial disclosure');
            const show = TriageMountedUiInputV1Schema.parse(initial.command.input);
            await expect(shell.queryByText('Completed maintenance')).resolves.toBeUndefined();
            await act(async () => { expect(await invoke()).toEqual({ status: 'applied' }); });
            await expect(shell.getByText('Completed maintenance')).resolves.toBeDefined();
            // Replaying an explicit set does not toggle the group back shut.
            await act(async () => { expect(await invoke(show)).toEqual({ status: 'applied' }); });
            await expect(shell.getByText('Completed maintenance')).resolves.toBeDefined();
            await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Hide, Done' })); });
            await expect(shell.queryByText('Completed maintenance')).resolves.toBeUndefined();
            await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Show, Done' })); });
            await expect(shell.getByText('Completed maintenance')).resolves.toBeDefined();
            await act(async () => { expect(await invoke()).toEqual({ status: 'applied' }); });
            await expect(shell.queryByText('Completed maintenance')).resolves.toBeUndefined();
            expect(harness.scanCalls.count).toBe(before.scans);
            expect(harness.actionCalls).toHaveLength(before.reads);
            expect(harness.accountKv.setCallCount()).toBe(0);
            // LIST-R2 publishes the opening view for the host's page title.
            expect(harness.settledLocations).toEqual(['tasks,everyone']);
            // A current mount without the Tasks lens has no such control or authority.
            await act(async () => { expect(await invoke({ mountId: show.mountId, operation: {
                kind: 'setLens', query: '', filters: TRIAGE_ROUTE_DEFAULT_LENS_V1.filters,
                order: 'smart', smartPolicy: TRIAGE_ROUTE_DEFAULT_LENS_V1.smartPolicy,
            } })).toEqual({ status: 'applied' }); });
            expect(disclosureCommand()).toBeUndefined();
            expect(await handler(show, {
                plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
                invocationSurface: 'agent', signal: new AbortController().signal,
                ui: shell.context.hostApi, ephemeralSharedScope: harness.ephemeralSharedScope,
            })).toEqual({ status: 'unavailable' });
        } finally { await client.dispose(); }
    });
    it('opens New task as a draft in the detail\'s place without a second list mount or a provider write', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'tasks-create-entry', {}, { subPath: 'tasks,everyone' });
        await settleWindow('view', shell);
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'New task' })); });
        // The detail frame names the draft; where it goes comes first.
        await expect(shell.getByRole('heading', { name: 'New task' })).resolves.toBeDefined();
        await expect(shell.getByText(DRAFT_PURPOSE)).resolves.toEqual({ content: DRAFT_PURPOSE });
        expect(harness.actionCalls.filter((id) => id === 'tasks/create-v1')).toEqual([]);
    });
    it.each(['everyone', 'agents'] as const)('keeps linked tasks in Agents beside an unadmitted source from %s', async audience => {
        const harness = createHarness({ tasks: true, sourceBUnavailable: true, unlinkedTaskOnFirstPage: true });
        const entryRef = { source: SOURCE_A, kindId: 'issue', collisionScope: 'example/repository', entryId: '1' };
        await linkEntryToSession({ collections: harness.collections, entryRef,
            sessionId: 'agents-linked-session', display: { locator: testkitLocator(), scopeLabel: LABEL_A }, nowMs: 1 });
        const shell = await mountSurface(renderShellSurface, harness, `agents-with-degraded-source-${audience}`, sourceContextFixture(harness),
            { subPath: `tasks,${audience}` });
        await settleWindow('view', shell);
        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        // Inline Status is exposed through the row's accessible label, so the
        // semantic text query intentionally omits its duplicate child text.
        expect(document.body.textContent).toContain('Ready');
        const relationReads = harness.actionCalls.filter(action => action === TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1).length;
        if (audience === 'everyone') {
            await expect(shell.getByText('Unlinked maintenance task')).resolves.toBeDefined();
            await act(async () => { await shell.press(await shell.getByRole('radio', { name: 'Agents' })); });
            await settleWindow('view', shell);
        }
        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        expect(document.body.textContent).toContain('Ready');
        await expect(shell.queryByText('Unlinked maintenance task')).resolves.toBeUndefined();
        await expect(shell.getByText('1 other source needs attention')).resolves.toBeDefined();
        expect([...document.querySelectorAll('[role="status"]')]
            .some(node => node.textContent?.includes(`${LABEL_B} could not be read`))).toBe(false);
        expect(harness.actionCalls.filter(action => action === TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1))
            .toHaveLength(relationReads);
    });
    it('does not mistake an unreadable Session-link index for an empty Agents lens', async () => {
        const harness = createHarness({ tasks: true });
        harness.state.sessionLinksUnavailable = true;
        const shell = await mountSurface(renderShellSurface, harness, 'tasks-agents-unavailable', {}, { subPath: 'tasks,agents' });
        await settleWindow('view', shell);
        // An Account transport refusal cannot establish that the Agents lens is empty.
        await expect(shell.getByText('Some linked Session activity could not be read.'))
            .resolves.toEqual({ content: 'Some linked Session activity could not be read.' });
        await expect(shell.getByText('Nothing needs you')).rejects.toBeDefined();
    });
    it('applies instance/unit filters and Smart precedence through the addressed mounted Action', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-smart-parity');
        await settleWindow('view', shell);
        await loadRemainingPage(shell);
        const detail = harness.publishedContexts.at(-1)?.detail;
        if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new Error('Missing current UI context');
        const address = detail.mountedAction;
        if (!address || typeof address !== 'object' || Array.isArray(address)) throw new Error('Missing mounted address');
        const smartPolicy = { v: 1, precedence: ['activity', 'attention'] } as const;
        const filters = { ...TRIAGE_ROUTE_DEFAULT_LENS_V1.filters,
            sources: [{ source: SOURCE_A, sourceInstanceId: INSTANCE_A }],
            scopes: [{ source: SOURCE_A, sourceInstanceId: INSTANCE_A, unitId: 'unit-a', collisionScope: 'example/repository' }],
        };
        for (const policy of [smartPolicy, undefined]) {
            const input = TriageMountedUiInputV1Schema.parse({ mountId: address.mountId, operation: {
                kind: 'setLens', query: '', filters, order: 'smart',
                ...(policy === undefined ? {} : { smartPolicy: policy }),
            } });
            await act(async () => {
                expect(await invokeTriageMountedUiAction(harness.ephemeralSharedScope, input.mountId, input.operation,
                    new AbortController().signal)).toEqual({ status: 'applied' });
            });
            await settleWindow('view', shell);
            if (readTriageListWindowSnapshot(shell.context.hostApi, harness.ephemeralSharedScope).loadMore?.kind === 'available') {
                await loadRemainingPage(shell);
            }
            // Shared routes carry source identity; configured-instance
            // narrowing remains local (999bafadf14e).
            expect(parseTriageRouteSubPathV1(harness.settledLocations.at(-1))).toMatchObject({ order: 'smart', smartPolicy,
                filters: { ...filters, sources: [{ source: SOURCE_A }],
                    scopes: [{ source: SOURCE_A, unitId: 'unit-a', collisionScope: 'example/repository' }] } });
            await visibleTexts(shell, ['Replace the duplicated normalizer', 'Older change']);
            await expect(shell.queryByText('Middle change')).resolves.toBeUndefined();
        }
        const invalid = TriageMountedUiInputV1Schema.parse({ mountId: address.mountId, operation: {
            kind: 'setLens', query: '', filters: TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, order: 'smart',
            smartPolicy: { v: 1, precedence: ['activity', 'activity'] },
        } });
        await act(async () => {
            expect(await invokeTriageMountedUiAction(harness.ephemeralSharedScope, invalid.mountId, invalid.operation,
                new AbortController().signal)).toEqual({ status: 'rejected' });
        });
        expect(parseTriageRouteSubPathV1(harness.settledLocations.at(-1))).toMatchObject({ smartPolicy });
        await shell.dispose();
        expect(await invokeTriageMountedUiAction(harness.ephemeralSharedScope, String(address.mountId),
            { kind: 'closeDetail' }, new AbortController().signal)).toEqual({ status: 'unavailable' });
    });

    it('resolves its executable chrome from the plugin translation bundle', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list', {
            locale: 'fr',
            translations: PACKAGED_UI_TRANSLATIONS.fr,
        });
        await settleWindow('view', shell);

        // Refresh is the toolbar's icon control: its translated words are its name.
        await expect(shell.getByRole('button', {
            name: PACKAGED_UI_TRANSLATIONS.fr['plugins.triage.surface.refresh'],
        })).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Refresh' })).resolves.toBeUndefined();
    });

    it('opens Tasks with one row-producing list pass, without an initial default-lens pass', async () => {
        const harness = createHarness({ tasks: true });
        const tasksSurface = defineUiSurface(() => <TriageListShell tasksPage />);
        const shell = await mountSurface(tasksSurface, harness, 'triage-tasks');
        await settleWindow('view', shell);
        // Each source settles its own first page; continuation needs Load more.
        // Binding the initial lens is not another page-view producer.
        expect(harness.scanCalls.count).toBe(2);
        expect(harness.actionCalls.filter(action => action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1)).toHaveLength(0);
        // One inventory read, then one independently settling Action per source.
        expect(harness.actionCalls.filter(action => action === TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1)).toHaveLength(3);
        expect(readTriageListWindowSnapshot(shell.context.hostApi, harness.ephemeralSharedScope).passes).toBe(1);
    });

    it('renders one window assembled from every configured source', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list');
        await settleWindow('view', shell);

        await visibleTexts(shell, ['Replace the duplicated normalizer', 'Middle change']);
        await expect(shell.queryByText('Older change')).resolves.toBeUndefined();
        expect(harness.scanCalls.count).toBe(2);
        await loadRemainingPage(shell);

        await visibleTexts(shell, [
            'Replace the duplicated normalizer',
            'Middle change',
            'Older change',
        ]);
        // Healthy is quiet. A settled window stops being current after the refresh interval with nothing on
        // screen changing, so a resting "Up to date" would soon be untrue. The toolbar states the read's age
        // instead (lab "Updated just now"), from the time every configured source last completed a read.
        await expect(shell.queryByText('Up to date')).resolves.toBeUndefined();
        await expect(shell.getByText('Updated just now')).resolves.toBeDefined();
        // The window is the aggregate's, not one source's: source A walked two
        // pages and source B one, all through a single Action invocation family.
        expect(harness.scanCalls.count).toBe(3);
        expect(harness.actionCalls).toContain(TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1);
        // The relation join reads the demanded entries through their canonical
        // owner. These fixture sources declare corpus-owned relations, so this
        // and the pins, saved views and configured actions reach no provider.
        //
        // The property is asserted rather than a fixed set: enumerating the
        // exact ids made this fail every time the product legitimately gained a
        // reader-state read, which trains a lane to bump the list instead of
        // reading it. A surprise Action is still caught, and now by name — the
        // harness routes every Action it knows and records anything else — while
        // a SOURCE-reaching Action on mount fails on the contract that actually
        // matters here.
        expect(harness.unroutedActions).toEqual([]);
        const beyondTheWindow = harness.actionCalls
            .filter((action) => action !== TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1);
        expect(beyondTheWindow.filter((action) => SOURCE_REACHING_ACTIONS.has(action)))
            .toEqual([]);
        expect(beyondTheWindow).toContain(TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1);
        expect(beyondTheWindow).toContain(TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1);
    });

    it('opens the Composer picker without walking a single source', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list');
        await settleWindow('view', shell);
        await loadRemainingPage(shell);
        const scansAfterList = harness.scanCalls.count;

        const picker = await mountSurface(renderPickerSurface, harness, 'triage-entry-picker');

        // `REQ-14`. Mounting the PRs & Issues page is a named materialization
        // producer; opening a Composer control is not. The separate picker
        // artifact joins the exact host-owned window the page already warmed,
        // without starting another provider walk.
        expect(harness.scanCalls.count).toBe(scansAfterList);
        await visibleTexts(picker, ['Replace the duplicated normalizer', 'Middle change', 'Older change']);
        await visibleTexts(shell, ['Replace the duplicated normalizer']);

        // The reader asks, and only then does the picker read.
        await settleWindow('manual', picker);
        expect(harness.scanCalls.count).toBeGreaterThan(scansAfterList);
        await visibleTexts(picker, ['Replace the duplicated normalizer', 'Middle change', 'Older change']);
        expect(await picker.getAllByRole('button', { name: 'Attach Middle change' })).toHaveLength(1);
    });

    it('keeps the last known list on screen when a source fails to refresh', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list');
        await settleWindow('view', shell);
        await loadRemainingPage(shell);

        harness.state.sourceBFails = true;
        await settleWindow('manual', shell);

        // The failing connection's entry is still listed: a transient provider
        // error must never be shown as "nothing needs you". The reason is
        // retained beside the rows, and the list stops claiming to be current.
        await visibleTexts(shell, [
            'Replace the duplicated normalizer',
            'Middle change',
            'Older change',
        ]);
        // The source owner qualifies the connection name with its source;
        // the shared Status announces that failure as one live region.
        const statusLines = [...document.querySelectorAll('[role="status"]')].map(node => node.textContent);
        expect(statusLines, JSON.stringify(statusLines))
            .toContain(`Example forge · ${LABEL_B} could not be reached. Their entries may be missing or out of date.`);
        await expect(shell.queryByText('Up to date')).resolves.toBeUndefined();
        // One cause, one voice: the notice names the connection and why, so the toolbar does not repeat it as
        // "Showing the last known list".
        await expect(shell.queryByText('Showing the last known list')).resolves.toBeUndefined();
        // The healthy connection is never named as a failure, and the published
        // closed classification stays a machine word.
        await expect(shell.queryByText(`${LABEL_A} could not be read`)).resolves.toBeUndefined();
        await expect(shell.queryByText('transient')).resolves.toBeUndefined();
    });

    it('shows the derived 1,000-row mixed-source list when GitHub rejects and Bitbucket recovers', async () => {
        const harness = createHarness({ mixedFailureScale: true });
        harness.state.listInvocationFailure = sourceInstanceId => sourceInstanceId === INSTANCE_A
            ? new PluginError({ code: 'connected_service_credential_reconnect_required', retryable: false }) : null;
        harness.state.sourceBFails = true;
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list-mixed-failure-scale', sourceContextFixture(harness));
        await settleWindow('view', shell);
        const snapshot = () => readTriageListWindowSnapshot(shell.context.hostApi, harness.ephemeralSharedScope);

        // D20's observed cardinality is unknown. This extends the existing
        // 1,000-row owner fixture through the actual mounted list, not a claim
        // that the live Account had this many entries.
        await visibleTexts(shell, ['Acme issue 0']);
        expect(snapshot().pending).toBe('idle');
        expect(document.body.textContent).toContain('GitHub workspace');
        expect(document.body.textContent).toContain('Bitbucket workspace');
        await expect(shell.queryByText('Refreshing')).resolves.toBeUndefined();

        harness.state.sourceBFails = false;
        await settleWindow('manual', shell);
        await visibleTexts(shell, ['Acme issue 0', 'Middle change']);
        // Exercise the visible continuation affordance, then fill the scale
        // fixture through that same window owner in one React update batch.
        // Rendering every intermediate continuation depth is not the scale contract.
        await loadRemainingPage(shell);
        await act(async () => {
            while ((snapshot().window?.rows.length ?? 0) < 1_001) {
                const before = snapshot().window?.rows.length ?? 0;
                expect(snapshot().loadMore).toEqual({ kind: 'available' });
                await loadMoreTriageListWindow(shell.context.hostApi, harness.ephemeralSharedScope);
                expect(snapshot().window?.rows.length).toBeGreaterThan(before);
            }
        });

        expect(snapshot().pending).toBe('idle');
        expect(snapshot().window?.rows).toHaveLength(1_001);
        await visibleTexts(shell, ['Acme issue 0', 'Middle change']);
        const warning = [...document.querySelectorAll<HTMLElement>('[role="status"]')]
            .find(element => element.textContent?.includes('GitHub workspace could not be read'));
        expect(warning).toBeDefined();
        expect(warning?.textContent).not.toContain('Bitbucket workspace');
        await expect(shell.queryByText('Refreshing')).resolves.toBeUndefined();
    }, 120_000);

    it('lets the host band speak alone while the Run on Machine cannot answer, and retries in the shared word', async () => {
        // UI4 D1/D2: one outage, one voice. While the host says its Machine cannot answer, the list's own failure
        // line and Refreshing step aside; when the list does speak, its retry is the same word as the host's.
        const harness = createHarness();
        const context = sourceContextFixture(harness);
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list-host-outage', context);
        await settleWindow('view', shell);
        harness.state.sourceBFails = true;
        await settleWindow('manual', shell);
        const failureLine = () => [...document.querySelectorAll<HTMLElement>('[role="status"]')]
            .find(element => element.textContent?.includes(LABEL_B) === true);
        await vi.waitFor(() => expect(failureLine()).toBeDefined());
        await expect(shell.getByRole('button', { name: 'Retry' })).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Try again' })).resolves.toBeUndefined();
        await act(async () => { await shell.updateSurface({ ...context, machineConnectionPending: false, machineExecutionReady: false }); });
        expect(failureLine()).toBeUndefined();
        await expect(shell.queryByText('Refreshing')).resolves.toBeUndefined();
        expect(document.body.textContent).toContain('Replace the duplicated normalizer');
    });

    it('names one shared cause once when every connection fails for it, still naming each connection', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list', sourceContextFixture(harness), { directAccountData: true });
        const connectionA = `Example forge · ${LABEL_A}`;
        const connectionB = `Example forge · ${LABEL_B}`;
        await settleWindow('view', shell);
        await loadRemainingPage(shell);

        // The owner ruling (2026-11-02): one offline Machine is one cause, so it is said once, naming the Machine
        // in the host's own words, instead of one "could not be reached" line per connection.
        const offline = 'This operation is unavailable on MacBook Pro. Reconnect it or choose another machine with Run on.';
        harness.state.listInvocationFailure = () => new PluginError({ code: 'unavailable', message: offline,
            retryable: true, diagnostics: [{ code: 'plugin_action_machine_required', severity: 'error' }] });
        await settleWindow('manual', shell);

        await visibleTexts(shell, ['Replace the duplicated normalizer', 'Middle change']);
        const statusLines = [...document.querySelectorAll<HTMLElement>('[role="status"]')].map(element => element.textContent);
        expect(statusLines, JSON.stringify(statusLines))
            .toContain(`${connectionA} and ${connectionB} could not be read. Their entries may be missing or out of date. ${offline}`);
        // REQ-01 holds: both connections are still named, in the one heading.
        const warning = [...document.querySelectorAll<HTMLElement>('[role="status"]')]
            .find(element => element.textContent?.includes(offline));
        expect(warning?.textContent).toContain(LABEL_A);
        expect(warning?.textContent).toContain(LABEL_B);
        expect(document.body.textContent?.split(offline)).toHaveLength(2);
        await expect(shell.queryByText('Some sources could not be read')).resolves.toBeUndefined();
        await expect(shell.queryByText('Could not be reached just now.')).resolves.toBeUndefined();
        // Diagnostics live where the reader manages the failed sources, leaving one compact line on the list.
        await expect(shell.queryByRole('button', { name: 'Details' })).resolves.toBeUndefined();
        await pressToolbarMenuItem(shell, 'More', 'menuitem', 'Manage sources');
        for (const label of [LABEL_A, LABEL_B]) {
            await pressToolbarMenuItem(shell, `More actions for ${label}`, 'menuitem', 'Details');
            expect(document.body.textContent).toContain('For support: unavailable');
            await pressToolbarMenuItem(shell, `More actions for ${label}`, 'menuitem', 'Hide details');
        }
    });

    it('keeps different connection causes in Manage sources behind the compact failure line', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list', sourceContextFixture(harness), { directAccountData: true });
        const connectionA = `Example forge · ${LABEL_A}`;
        const connectionB = `Example forge · ${LABEL_B}`;
        await settleWindow('view', shell);
        await loadRemainingPage(shell);

        const offlineA = 'This operation is unavailable on MacBook Pro. Reconnect it or choose another machine with Run on.';
        const offlineB = 'This operation is unavailable on Studio Mac. Reconnect it or choose another machine with Run on.';
        harness.state.listInvocationFailure = (sourceInstanceId) => new PluginError({ code: 'unavailable',
            message: sourceInstanceId === INSTANCE_A ? offlineA : offlineB, retryable: true,
            diagnostics: [{ code: 'plugin_action_machine_required', severity: 'error' }] });
        await settleWindow('manual', shell);

        const statusLines = [...document.querySelectorAll<HTMLElement>('[role="status"]')].map(element => element.textContent);
        expect(statusLines, JSON.stringify(statusLines))
            .toContain(`${connectionA} and ${connectionB} could not be read. Their entries may be missing or out of date.`);
        const warning = [...document.querySelectorAll<HTMLElement>('[role="status"]')]
            .find(element => element.textContent?.includes(`${connectionA} and ${connectionB} could not be read.`));
        expect(warning).toBeDefined();
        expect(warning?.textContent).not.toContain(offlineA);
        expect(warning?.textContent).not.toContain(offlineB);
        await expect(shell.queryByRole('button', { name: 'Details' })).resolves.toBeUndefined();
        await pressToolbarMenuItem(shell, 'More', 'menuitem', 'Manage sources');
        // Each connection owns its cause in its health row; technical codes
        // remain behind that row's own Details menu.
        for (const [label, reason, otherReason] of [[LABEL_A, offlineA, offlineB], [LABEL_B, offlineB, offlineA]]) {
            // Find the row from its own accessible menu and title, preserving
            // attribution without depending on a fixed DOM nesting depth.
            let row = document.querySelector<HTMLElement>(`[aria-label="More actions for ${label}"]`);
            while (row !== null && !row.textContent?.includes(label)) row = row.parentElement;
            expect(row?.textContent).toContain(reason);
            expect(row?.textContent).not.toContain(otherReason);
            await pressToolbarMenuItem(shell, `More actions for ${label}`, 'menuitem', 'Details');
            expect(document.body.textContent).toContain('For support: unavailable');
            await pressToolbarMenuItem(shell, `More actions for ${label}`, 'menuitem', 'Hide details');
        }
    });

    it.each(['ui', 'agent'] as const)('discloses and hides the same source diagnostic (%s)', async route => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, `mounted-diagnostic-${route}`, {}, { directAccountData: true });
        await settleWindow('view', shell);
        harness.state.listInvocationFailure = sourceInstanceId => new PluginError({
            code: sourceInstanceId === INSTANCE_A ? 'unavailable' : 'server_unavailable', retryable: true,
        });
        await settleWindow('manual', shell);
        await pressToolbarMenuItem(shell, 'More', 'menuitem', 'Manage sources');
        const diagnostic = 'For support: unavailable';
        expect(document.body.textContent).not.toContain(diagnostic);
        for (const expanded of [true, false]) {
            if (route === 'ui') {
                await pressToolbarMenuItem(shell, `More actions for ${LABEL_A}`, 'menuitem', expanded ? 'Details' : 'Hide details');
            } else {
                const command = harness.publishedContexts.at(-1)?.commands?.find(entry => {
                    if (entry.command.kind !== 'executeAction') return false;
                    const parsed = TriageMountedUiInputV1Schema.safeParse(entry.command.input);
                    return parsed.success && parsed.data.operation.kind === 'setSourceDiagnosticExpanded'
                        && parsed.data.operation.sourceInstanceId === INSTANCE_A && parsed.data.operation.expanded === expanded;
                });
                if (command?.command.kind !== 'executeAction') throw new Error('Missing source diagnostic command');
                const input = command.command.input;
                await act(async () => { expect(await shell.context.hostApi.executeAction('ui/mounted-v1', input)).toEqual({ status: 'applied' }); });
            }
            expect(document.body.textContent?.includes(diagnostic)).toBe(expanded);
            expect(document.body.textContent).not.toContain('For support: server_unavailable');
        }
    });

    it.each([false, true])('offers source management on the source recovery status (Tasks=%s)', async (tasks) => {
        const harness = createHarness({ tasks, sourceBUnavailable: true });
        const surface = tasks ? renderTasksSurface : renderShellSurface;
        const shell = await mountSurface(surface, harness, `source-warning-${tasks}`, sourceContextFixture(harness),
            { directAccountData: true, ...(tasks ? { subPath: 'tasks,everyone' } : {}) });
        await settleWindow('view', shell);
        // View health partitions failures once (6861b0f0d1fd). An unadmitted
        // source has no declared task kinds, so Tasks sends its recovery to the
        // outside-source status while PRs & Issues names it in the list status.
        const warningText = tasks ? '1 other source needs attention' : `${LABEL_B} could not be read`;
        const warning = [...document.querySelectorAll<HTMLElement>('[role="status"]')]
            .find(element => element.textContent?.includes(warningText));
        expect(document.querySelector('[role="alert"]')?.textContent ?? '').not.toContain(`${LABEL_B} could not be read`);
        expect(warning).toBeDefined();
        if (!tasks) expect(warning?.textContent).toContain('Not installed or enabled on this machine.');
        // The fix sits beside the announced sentence, outside its live region (the shared Status owns that split).
        const manage = warning?.parentElement?.querySelector<HTMLElement>('[role="button"]');
        expect(manage?.textContent).toContain(tasks ? 'Review' : 'Manage sources');
        await act(async () => { manage!.click(); });
        await expect(shell.getByText('Configured sources')).resolves.toBeDefined();
        expect(document.body.textContent).toContain(LABEL_B);
        expect(document.body.textContent).toContain('Not installed or enabled on this machine.');
        if (tasks) await expect(shell.queryByText('1 other source needs attention')).resolves.toBeUndefined();
        else expect(document.body.textContent?.split(`${LABEL_B} could not be read`)).toHaveLength(2);
    });

    it('never claims a last known list when no source has listed anything', async () => {
        const harness = createHarness();
        harness.state.sourceAFails = true;
        harness.state.sourceBFails = true;
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list');
        await settleWindow('view', shell);

        // Nothing was ever listed, so the body's own failure state is the whole answer. A toolbar line saying
        // the reader is looking at "the last known list" over zero rows would be false, and a second voice for
        // one cause.
        const statusLines = [...document.querySelectorAll('[role="status"]')].map(node => node.textContent);
        expect(statusLines, JSON.stringify(statusLines))
            .toContain(`Example forge · ${LABEL_A} and Example forge · ${LABEL_B} could not be reached. Their entries may be missing or out of date.`);
        await expect(shell.queryByText('Showing the last known list')).resolves.toBeUndefined();
    });

    it('shows one cold outage when both authorities are unavailable and folds sources on readmission', async () => {
        const harness = createHarness({ quietFirstPage: true });
        harness.state.accountReadsUnavailable = true;
        const offline = { ...sourceContextFixture(harness), requesterExecutionReady: true,
            machineConnectionPending: false, machineExecutionReady: false };
        const shell = await mountSurface(renderShellSurface, harness, 'triage-all-authorities-offline', offline,
            { directAccountData: true });
        await settleWindow('view', shell);
        const snapshot = () => readTriageListWindowSnapshot(shell.context.hostApi, harness.ephemeralSharedScope);
        const readOwner = () => readTriageListWindowReadOwner(shell.context.hostApi, harness.ephemeralSharedScope);
        const listReads = () => harness.actionCalls.filter(action => action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1).length;
        const owner = readOwner();
        expect(owner).not.toBeNull();
        expect(snapshot()).toMatchObject({ pending: 'idle', error: { code: 'server_unavailable' } });
        expect(snapshot().window).toBeUndefined();
        expect(harness.scanCalls.count).toBe(0);
        expect(harness.collectionReadCounts.get(CORPUS_USER_MARKS_COLLECTION.id)).toBeGreaterThan(0);
        expect(harness.kvReadCount.count).toBeGreaterThan(0);
        await expect(shell.getByText('The list could not be read')).resolves.toBeDefined();
        await expect(shell.getByText('Happier could not reach your sources or your saved views just now. Try again in a moment.'))
            .resolves.toBeDefined();
        await expect(shell.queryByText('Reading your sources…')).resolves.toBeUndefined();
        await expect(shell.queryByText('Nothing needs you')).resolves.toBeUndefined();
        const retries = (await shell.getAllByRole('button')).filter(button => button.name === 'Retry');
        expect.soft(retries).toHaveLength(1);
        await expect.soft(shell.queryByText('Happier cannot reach your account right now, so pins and saved views cannot be changed.'))
            .resolves.toBeUndefined();
        // The outage's one Retry re-reads the Account as well as the list.
        const accountReadsBeforeRetry = harness.kvReadCount.count;
        await act(async () => { await shell.press(retries[0]!); });
        await settleWindow('view', shell);
        expect(harness.kvReadCount.count).toBeGreaterThan(accountReadsBeforeRetry);

        const attemptsWhileOffline = listReads();
        const disconnected = { ...offline, requesterExecutionReady: false };
        await act(async () => { await shell.updateSurface(disconnected); });
        harness.state.accountReadsUnavailable = false;
        // Connectivity alone supplies no materialization demand. The same host
        // admission fact may republish before it actually changes.
        await act(async () => { await shell.updateSurface({ ...disconnected }); });
        expect(listReads()).toBe(attemptsWhileOffline);
        expect(snapshot().window).toBeUndefined();

        const reconnected = { ...offline, machineExecutionReady: true };
        await act(async () => { await shell.updateSurface(reconnected); });
        await settleWindow('view', shell);
        expect(readOwner()).toBe(owner);
        expect(snapshot().window).toMatchObject({ coverage: 'complete', rows: [expect.anything(), expect.anything()] });
        expect(harness.scanCalls.count).toBe(2);
        await visibleTexts(shell, ['Replace the duplicated normalizer', 'Middle change']);
        await expect(shell.queryByText('The list could not be read')).resolves.toBeUndefined();
        expect(document.body.textContent).not.toContain('Happier cannot reach your account');
        const attemptsAfterReconnect = listReads();
        await act(async () => { await shell.updateSurface({ ...reconnected }); });
        expect(listReads()).toBe(attemptsAfterReconnect);
        expect(harness.accountKv.setCallCount()).toBe(0);
    });

    it.each([false, true])('keeps named cold source failure and Retry visible (initially unavailable=%s)', async initiallyUnavailable => {
        const harness = createHarness();
        harness.state.listInvocationFailure = () => new PluginError({
            code: 'unavailable', retryable: true,
        });
        const context = { ...sourceContextFixture(harness), requesterExecutionReady: true,
            machineConnectionPending: false, machineExecutionReady: !initiallyUnavailable };
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list-cold-readiness', context);
        await settleWindow('view', shell);
        const snapshot = () => readTriageListWindowSnapshot(shell.context.hostApi, harness.ephemeralSharedScope);
        expect(snapshot().pending).toBe('idle');
        expect(snapshot().window?.rows).toHaveLength(0);
        const failureLines = () => [...document.querySelectorAll<HTMLElement>('[role="status"]')]
            .map(element => element.textContent ?? '');
        if (!initiallyUnavailable) {
            expect(failureLines()).toEqual(expect.arrayContaining([expect.stringContaining(LABEL_A), expect.stringContaining(LABEL_B)]));
            await expect(shell.getByRole('button', { name: 'Retry' })).resolves.toBeDefined();
        }

        // Readiness is a host execution fact. This context carries no fact that
        // a host band is being presented; dropping the only body leaves D20's
        // toolbar and column headers with no answer about the settled failure.
        await act(async () => { await shell.updateSurface({ ...context, machineConnectionPending: false, machineExecutionReady: false }); });
        expect(snapshot().pending).toBe('idle');
        expect(snapshot().window?.rows).toHaveLength(0);
        expect(failureLines()).toEqual(expect.arrayContaining([expect.stringContaining(LABEL_A), expect.stringContaining(LABEL_B)]));
        await expect(shell.getByRole('button', { name: 'Retry' })).resolves.toBeDefined();
    });

    it('keeps serving the picker after the page that opened the window unmounts', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list');
        await settleWindow('view', shell);
        const picker = await mountSurface(renderPickerSurface, harness, 'triage-entry-picker');
        await settleWindow('view', picker);

        // The page that happened to create the window goes away while the
        // picker is still open. A window that had captured that mount's Host API
        // would now fail every pass it runs for the surface still on screen.
        await mounted.splice(mounted.indexOf(shell), 1)[0]?.dispose();
        const before = harness.scanCalls.count;
        await settleWindow('manual', picker);

        expect(harness.scanCalls.count).toBeGreaterThan(before);
        await visibleTexts(picker, ['Replace the duplicated normalizer', 'Middle change']);
    });

    it('applies the lens its location carries to the rows on screen', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list', {}, {
            subPath: 'q,Middle',
        });
        await settleWindow('view', shell);

        // Without the window binding this is the whole defect: the location
        // parses, the reducer holds the query, and the list shows every row
        // anyway — so a copied link renders a page its URL does not describe.
        await visibleTexts(shell, ['Middle change']);
        await expect(shell.queryByText('Replace the duplicated normalizer')).resolves.toBeUndefined();
        await expect(shell.queryByText('Older change')).resolves.toBeUndefined();
    });

    it('narrows the list from the rail and says so instead of claiming nothing needs you', async () => {
        const harness = createHarness({ quietFirstPage: true });
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list');
        await settleWindow('view', shell);
        await visibleTexts(shell, ['Replace the duplicated normalizer', 'Middle change']);

        // One press of one facet, through the shared public option control:
        // rail -> reducer -> window lens -> rows. Every hop is real here.
        const sourceOption = await filterFacetOption(shell, 'Source', { name: `Example forge · ${LABEL_B}` });
        await act(async () => { await shell.press(sourceOption); });
        await act(async () => { await Promise.resolve(); });
        await closeFilters(shell);

        await visibleTexts(shell, ['Middle change']);
        await expect(shell.queryByText('Replace the duplicated normalizer')).resolves.toBeUndefined();

        // And the honest empty state when a facet matches nothing: the sources
        // all answered, so the healthy claim is available and false.
        const doneOption = await filterFacetOption(shell, 'State', { name: 'Done' });
        await act(async () => { await shell.press(doneOption); });
        await act(async () => { await Promise.resolve(); });
        await closeFilters(shell);

        await expect(shell.getByText('Nothing matches these filters')).resolves.toBeDefined();
        await expect(shell.queryByText('Nothing needs you')).resolves.toBeUndefined();
    });

    it('keeps an empty Needs you in a complete list with one quiet line, and drops the claim once a facet narrows it', async () => {
        const harness = createHarness({ quietFirstPage: true });
        const shell = await mountSurface(renderShellSurface, harness, 'quiet-needs-you');
        await settleWindow('view', shell);
        await visibleTexts(shell, ['Replace the duplicated normalizer', 'Middle change']);
        expect(document.body.textContent).toContain('Needs you');
        await expect(shell.getByText('Nothing needs you right now.')).resolves.toBeDefined();

        const sourceOption = await filterFacetOption(shell, 'Source', { name: `Example forge · ${LABEL_B}` });
        await act(async () => { await shell.press(sourceOption); });
        await act(async () => { await Promise.resolve(); });
        await closeFilters(shell);
        await visibleTexts(shell, ['Middle change']);
        await expect(shell.queryByText('Nothing needs you right now.')).resolves.toBeUndefined();
    });

    it('names the search rather than a filter when a query is what emptied the list', async () => {
        const harness = createHarness({ quietFirstPage: true });
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list', {}, {
            subPath: 'q,unmatchable-token',
        });
        await settleWindow('view', shell);

        // Four causes, four sentences (`core/SURFACE.md` §6.2). Nothing is
        // selected in the rail here, so "adjust or clear a filter to widen it"
        // sends the reader to controls with nothing on them while the query
        // that actually emptied the list sits in the search box above.
        await expect(shell.getByText('Nothing matches your search')).resolves.toBeDefined();
        await expect(shell.queryByText('Nothing matches these filters')).resolves.toBeUndefined();
        await expect(shell.queryByText('Nothing needs you')).resolves.toBeUndefined();
    });

    it('reads the provider again only when the reader asks', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list');
        await settleWindow('view', shell);
        const afterMount = harness.scanCalls.count;

        // Settling the mounted view is not another named read demand. The wait
        // observes its push state; it cannot manufacture a second provider pass.
        await settleWindow('view', shell);
        expect(harness.scanCalls.count).toBe(afterMount);

        await shell.press(await shell.getByRole('button', { name: 'Refresh' }));
        await settleWindow('view', shell);

        // Explicit Refresh is the user asking, and the user is never paced.
        expect(harness.scanCalls.count).toBe(afterMount + 2);
    });

    it('publishes A, replaces it with B, and clears the mount on disposal', async () => {
        const harness = createHarness();
        const lifecycle = createRetirableShellSurface();
        const shell = await mountSurface(lifecycle.surface, harness, 'triage-list');
        await settleWindow('view', shell);

        const entryA = {
            source: SOURCE_A,
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '1',
        } as const;
        const entryB = {
            source: SOURCE_B,
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '3',
        } as const;
        const locationFor = (selection: typeof entryA | typeof entryB) => buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
            selection,
        });

        await act(async () => {
            await shell.updatePageLocation(locationFor(entryA));
            await Promise.resolve();
        });
        expect(harness.publishedContexts.at(-1)).toMatchObject({
            entity: { label: 'Replace the duplicated normalizer', reference: entryA },
            detail: { view: 'selected-detail' },
        });

        await act(async () => {
            await shell.updatePageLocation(locationFor(entryB));
            await Promise.resolve();
        });
        expect(harness.publishedContexts.at(-1)).toMatchObject({
            entity: { label: 'Middle change', reference: entryB },
            detail: { view: 'selected-detail' },
        });

        await act(async () => {
            lifecycle.retireShell();
            await Promise.resolve();
        });
        expect(harness.publishedContexts.at(-1)).toBeNull();
    });

});
