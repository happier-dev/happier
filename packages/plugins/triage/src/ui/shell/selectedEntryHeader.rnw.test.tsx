// @vitest-environment jsdom
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { formatTriageTimestampV1, INTERNAL_TASK_SOURCE_V1, TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    type TriageScanInputV1, type TriageScanResultV1 } from '@happier-dev/triage-protocol/v1';

import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from '../../actions/entryDetailProtocol.js';
import {
    TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    TriageListEntriesInputV1Schema,
    TriageListEntriesResultV1Schema,
    type TriageListEntriesResultV1,
} from '../../actions/listEntriesProtocol.js';
import { listTriageEntries, type TriageAdmittedSourceV1 } from '../../actions/listEntries.js';
import { TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1 } from '../../actions/savedViewsProtocol.js';
import { TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1 } from '../../actions/userMarksProtocol.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import { renderSurface as renderShellSurface } from '../surface.js';
import { triageListRowTestId } from '../list/rows.js';
import { acquireTriageListWindow, refreshTriageListWindow, readTriageListWindowReadOwner } from '../window/mountedWindow.js';
import { reobserveTriagePostMutationRow } from '../detail/postMutationReobservation.js';
import { triageEntryRowKey, TRIAGE_LIST_DEFAULT_LENS_V1, MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../../projection/listWindow.js';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1 } from '../../actions/reobserveEntryProtocol.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { renderSurface as renderTasksSurface } from '../tasksSurface.js';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../../internalTasks/contribution.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../../internalTasks/configuration.js';
import { TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1 } from '../../actions/tasksProtocol.js';
import { TRIAGE_SHELL_FILL_TEST_ID_V1 } from './root.js';
import * as listSections from '../list/sections.js';
import * as triageProtocol from '@happier-dev/triage-protocol/v1';
import { reduceTriageSurfaceV1, TRIAGE_SURFACE_INITIAL_STATE_V1 } from '../state/surface.js';
import { readTriageWindowLensV1 } from './lens.js';
import { buildTriageRouteSubPathV1, TRIAGE_ROUTE_DEFAULT_LENS_V1 } from '../navigation/location.js';
import { createTestkitCorpusCollections } from '../../corpus/testkit/corpusCollections.test-support.js';
import { administerConfiguredSourceInstance } from '../../corpus/configuration/administerConfiguredSourceInstance.js';
import { testkitSourceInstanceDraft } from '../../sessions/testkit/entrySessionTestkit.test-support.js';

// Install the real accepted-render probe before ReactDOM registers its renderer.
// The browser and composed regression therefore count the same committed work.
const renderProbe = await vi.hoisted(async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(`${process.cwd()}/../../../apps/stack/scripts/perf/browser-probe.js`, 'utf8');
    Function(source)();
    return (globalThis as typeof globalThis & { __happierPerfProbe: {
        reset(): void;
        collect(): { components: Record<string, { renders: number }> };
        stop(): void;
    } }).__happierPerfProbe;
});

afterAll(() => { renderProbe.stop(); });

/**
 * What the reader keeps looking at when the window stops holding the entry they
 * opened.
 *
 * The selection is deliberately retained when its row leaves the window
 * (`ui/state/surface.ts`, `visibleRowsChanged`), and until now the shell had
 * nothing to render from: the row lookup returned nothing, so the whole
 * aggregate header — the entry's own title, its state, its scope, the connection
 * it was read through and why it was asking for the reader — was replaced by a
 * sentence about the list. A reader mid-read was left holding a cause with no
 * subject, unable to say WHICH entry had gone.
 *
 * The eviction here is the real one: a settled pass that enumerates nothing.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const ENTRY_TITLE = 'Replace the duplicated normalizer';

const ENTRY_REF = Object.freeze({
    source: SOURCE,
    kindId: 'pull-request',
    collisionScope: 'example/repository',
    entryId: '17',
});

function listResult(listsTheEntry: boolean): TriageListEntriesResultV1 {
    const observation = {
        sourceInstanceId: INSTANCE,
        observedAtMs: 1_760_000_100_000,
        outcome: {
            kind: 'present',
            locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: ENTRY_TITLE }),
            // The attention the aggregate derives for itself; the row member
            // below is what the Action emitted from the same fact, and this
            // mount re-folds the observation rather than reading it back.
            viewer: testkitViewer({ involvement: ['reviewRequested'] }),
        },
    };
    return TriageListEntriesResultV1Schema.parse({
        v: 1,
        configuredSources: [{
            sourceInstanceId: INSTANCE, configurationRowId: INSTANCE,
            source: SOURCE,
            displayLabel: 'Example account',
            available: sourceAvailable,
        }],
        configuredSourcesStatus: 'complete',
        window: {
            v: 1,
            rows: listsTheEntry ? [{
                entryRef: ENTRY_REF,
                lane: '1-open',
                sortAtMs: 1_760_000_100_000,
                presence: { kind: 'present', observedAtMs: 1_760_000_100_000 },
                attention: {
                    level: 'required',
                    fromSourceInstanceId: INSTANCE,
                    reasonId: 'involvement/review-requested',
                    reasonLabel: 'Review requested',
                },
                selected: { kind: 'selected', sourceInstanceId: INSTANCE, reason: 'onlyPresent' },
                observation,
                otherObservations: [],
                observedByCount: 1,
            }] : [],
            lanes: [{
                sourceInstanceId: INSTANCE,
                source: SOURCE,
                health: { kind: 'walkFinished' },
                exhausted: true,
            }],
            coverage: 'complete',
            assembledAtMs: 1_760_000_100_000,
        },
    });
}

/**
 * The provider answer this mount's next pass will get.
 *
 * Only the Action transport is replaced — a genuine host boundary — and the
 * value it returns is admitted by the Action's own published result schema, so
 * a payload the wire would reject cannot reach the window store.
 */
let listsTheEntry = true;
let sourceAvailable = true;
let exactTitle = ENTRY_TITLE;
let exactReads = 0;
let lastExactRoutingToken: string | undefined;
let lastExactSourceInstanceId: string | undefined;
let exactNeedsReview = true;
let exactFailure: PluginError | null = null;
let publishedContext: unknown;
let listProducerOverride: ((input: JsonValue | undefined) => Promise<JsonValue>) | null = null;

async function executeAction(action: string, input?: JsonValue): Promise<JsonValue> {
    if (action === TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1) {
        exactReads += 1;
        lastExactSourceInstanceId = (input as { sourceInstanceId?: string } | undefined)?.sourceInstanceId;
        lastExactRoutingToken = (input as { lastKnownLocator?: { routingToken?: string } } | undefined)
            ?.lastKnownLocator?.routingToken;
        if (exactFailure !== null) throw exactFailure;
        // Reject an unexpected recursive transport sequence rather than leaving the test running forever.
        if (exactReads > 6) throw new Error('Unexpected recursive exact reread');
        if (listProducerOverride !== null
            && (input === undefined || (input as { lastKnownLocator?: { routingToken?: string } }).lastKnownLocator?.routingToken !== 'example/repository')) {
            return { kind: 'observed', entryRef: ENTRY_REF, observation: {
                sourceInstanceId: INSTANCE, observedAtMs: 1_760_000_100_020,
                outcome: { kind: 'unresolved', failure: { class: 'unsupportedContract', code: 'locator-routing-token-invalid' } },
            } } as unknown as JsonValue;
        }
        const row = listResult(true).window.rows[0]!;
        return { kind: 'observed', entryRef: ENTRY_REF, observation: {
            ...row.observation, observedAtMs: row.observation.observedAtMs + exactReads,
            outcome: { ...row.observation.outcome, snapshot: testkitSnapshot({ title: exactTitle }),
                viewer: testkitViewer({ involvement: exactNeedsReview ? ['reviewRequested'] : [] }) },
        } } as unknown as JsonValue;
    }
    if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) {
        if (listProducerOverride !== null) return await listProducerOverride(input);
        return listResult(listsTheEntry) as unknown as JsonValue;
    }
    if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
        return { v: 1, pins: [] };
    }
    if (action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) {
        return { v: 1, availability: 'absent', views: [], revision: 'revision-1' };
    }
    if (action === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) {
        // No configured connection answers this read in this fixture. The
        // aggregate header does not come from it, which is exactly the split
        // this case measures.
        return { kind: 'unavailable' };
    }
    throw new Error(`unexpected action ${action}`);
}

const mounted: PluginUiTestkit[] = [];

async function mountShell(hosted = false, options: Readonly<{ pinned?: boolean; listsEntry?: boolean }> = {}) {
    listsTheEntry = options.listsEntry ?? true;
    sourceAvailable = true;
    exactTitle = ENTRY_TITLE;
    exactReads = 0;
    lastExactRoutingToken = undefined;
    lastExactSourceInstanceId = undefined;
    exactNeedsReview = true;
    exactFailure = null;
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
    const surfaceContext = createSurfaceContextFixture({
        mount: {
            kind: 'destination',
            destination: { pluginId: 'happier.triage', localId: 'triage' },
            container: 'appPage',
        },
    });
    let subPath: string | undefined;
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-181', mountNonce: 'fixture-mount-181' },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: context => renderShellSurface({ ...context, ...(subPath === undefined ? {} : { subPath }) }),
            surfaceContext,
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope, ...(hosted ? { detailsPane: { available: true } } : {}) }),
            handlers: {
                publishCurrentUiContext: value => { publishedContext = value; },
                executeAction: async ({ action, input }) => action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1 && options.pinned
                    ? { v: 1, pins: [{ entryRef: ENTRY_REF, markedAtMs: 1_760_000_100_000,
                        displayAtMark: { title: 'Pinned before reading', scopeLabel: ENTRY_REF.collisionScope } }] }
                    : await executeAction(action, input),
                replacePageLocation: ({ subPath }) => subPath,
            },
        });
    });
    mounted.push(fixture);
    await act(async () => {
        await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope);
    });
    return { shell: fixture, ephemeralSharedScope, setSubPath: async (next: string) => {
        subPath = next;
        await act(async () => { await fixture.updateSurface(surfaceContext); });
    } };
}

async function openTheRow(shell: PluginUiTestkit): Promise<void> {
    await act(async () => {
        await shell.press(await shell.getByRole('button', { name: ENTRY_TITLE }));
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
}

async function activateProducedRow(): Promise<void> {
    const row = document.querySelector<HTMLElement>(
        `[data-testid="${triageListRowTestId(triageEntryRowKey(ENTRY_REF))}"]`,
    );
    if (row === null) throw new Error('The produced entry row is not mounted');
    await act(async () => { row.click(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
}

/** The next settled pass enumerates nothing, so the selected row is evicted. */
async function evictTheRow(
    shell: PluginUiTestkit,
    ephemeralSharedScope: ReturnType<typeof createTriageEphemeralSharedScopeFixture>,
): Promise<void> {
    listsTheEntry = false;
    await act(async () => {
        await refreshTriageListWindow('manual', shell.context.hostApi, ephemeralSharedScope);
    });
    await act(async () => { await Promise.resolve(); });
    void shell;
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
    listProducerOverride = null;
});

describe('the selected entry once the window stops holding it', () => {
    it('opens an off-window entry through its retained connection and source route', async () => {
        const { shell, ephemeralSharedScope, setSubPath } = await mountShell(true, { pinned: true });
        const otherInstance = '00000000-0000-4000-8000-000000000000';
        listProducerOverride = async () => {
            const result = listResult(true);
            const row = result.window.rows[0]!;
            return { ...result, window: { ...result.window, rows: [{ ...row, observation: {
                ...row.observation, outcome: { ...row.observation.outcome,
                    locator: testkitLocator({ routingToken: 'example/repository' }) },
            } }] }, configuredSources: [...result.configuredSources, {
                ...result.configuredSources[0]!, sourceInstanceId: otherInstance, configurationRowId: otherInstance,
            }] } as unknown as JsonValue;
        };
        await act(async () => { await refreshTriageListWindow('manual', shell.context.hostApi, ephemeralSharedScope); });
        await setSubPath(buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query: 'outside this lens' }));
        const store = readTriageListWindowReadOwner(shell.context.hostApi, ephemeralSharedScope)!;
        expect(store.getSnapshot().window?.rows).toHaveLength(0);
        expect(store.getRow(triageEntryRowKey(ENTRY_REF))?.selected).toMatchObject({ sourceInstanceId: INSTANCE });

        await setSubPath(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query: 'outside this lens', selection: ENTRY_REF,
        }));

        expect(lastExactSourceInstanceId).toBe(INSTANCE);
        expect(lastExactRoutingToken).toBe('example/repository');
    });
    it('filters a formerly exact-only pin using its later retained facts', async () => {
        const { shell, ephemeralSharedScope, setSubPath } = await mountShell(true, { pinned: true, listsEntry: false });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Pinned before reading' })); });
        await expect(shell.getByRole('button', { name: ENTRY_TITLE })).resolves.toBeDefined();
        expect(exactReads).toBe(1);

        // The same mounted pin becomes acquired. Its old exact-only answer remains in the shell cache.
        listsTheEntry = true;
        await act(async () => { await refreshTriageListWindow('manual', shell.context.hostApi, ephemeralSharedScope); });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Close details' })); });
        const store = readTriageListWindowReadOwner(shell.context.hostApi, ephemeralSharedScope)!;
        const retained = store.getRow(triageEntryRowKey(ENTRY_REF))!;
        const observation = retained.observations[0]!;
        if (observation.outcome.kind !== 'present') throw new Error('Fixture pin must be present');
        const title = 'Retained source title changed';
        await act(async () => { store.publishObservation({ ...observation, entryRef: ENTRY_REF,
            observedAtMs: observation.observedAtMs + 1,
            outcome: { ...observation.outcome, snapshot: { ...observation.outcome.snapshot, title } } }); });
        await expect(shell.getByRole('button', { name: title })).resolves.toBeDefined();

        await setSubPath(buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query: ENTRY_TITLE }));
        expect(store.getRow(triageEntryRowKey(ENTRY_REF))?.content?.outcome.snapshot.title).toBe(title);
        expect(store.getSnapshot().window?.rows).toHaveLength(0);
        await expect(shell.queryByRole('button', { name: ENTRY_TITLE })).resolves.toBeUndefined();
    });
    it('settles a listed entry opening failure and retries without losing its identity', async () => {
        const { shell } = await mountShell(true);
        exactFailure = new PluginError({ code: 'source_unreachable', retryable: true });
        await openTheRow(shell);

        await expect(shell.getByRole('heading', { name: ENTRY_TITLE })).resolves.toBeDefined();
        await expect(shell.getByText('These details could not be read')).resolves.toBeDefined();

        exactFailure = null;
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Retry' })); });
        await expect(shell.getByText('This connection is no longer configured')).resolves.toBeDefined();
        await expect(shell.getByRole('heading', { name: ENTRY_TITLE })).resolves.toBeDefined();
        expect(exactReads).toBe(2);
    });
    it('reopens an exact-read failure after list refresh and recovers its observation', async () => {
        const { collections } = createTestkitCorpusCollections();
        expect(await administerConfiguredSourceInstance({
            collections,
            source: SOURCE,
            declaredPurpose: 'triage-source',
            request: { kind: 'create', draft: testkitSourceInstanceDraft() },
            nowMs: 1,
            mintSourceInstanceId: () => INSTANCE,
        })).toEqual({ kind: 'active', sourceInstanceId: INSTANCE });
        const scanHandle = {};
        const admitted = [{
            contributor: { pluginId: SOURCE.pluginId, contributionId: SOURCE.localId,
                immutableGenerationId: 'generation-1' },
            protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
                version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 },
            descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example forge',
                kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }] },
            operations: { listInstances: {}, scan: scanHandle, get: {} }, surfaces: { detail: {} },
        } as unknown as TriageAdmittedSourceV1];
        let assembledAtMs = 1_760_000_100_000;
        listProducerOverride = async input => await listTriageEntries(
            TriageListEntriesInputV1Schema.parse(input), {
                sourceInstances: collections.sourceInstances,
                readSourceSnapshot: async () => ({ contributions: admitted }),
                executeScan: async (_operation, _scanInput: TriageScanInputV1): Promise<TriageScanResultV1> => ({
                    kind: 'complete',
                    observations: [{ kind: 'present', localRef: { kindId: 'pull-request', collisionScope: ENTRY_REF.collisionScope,
                        entryId: ENTRY_REF.entryId }, locator: testkitLocator({ routingToken: 'example/repository' }),
                        snapshot: testkitSnapshot({ title: ENTRY_TITLE }), viewer: testkitViewer({ involvement: ['reviewRequested'] }) }],
                    evidence: { kind: 'walkFinished' },
                }),
                nowMs: () => ++assembledAtMs,
            }) as unknown as JsonValue;
        const { shell, ephemeralSharedScope } = await mountShell(true);
        expect(readTriageListWindowReadOwner(shell.context.hostApi, ephemeralSharedScope)
            ?.getRow(triageEntryRowKey(ENTRY_REF))?.content?.outcome).toMatchObject({
                kind: 'present', snapshot: { title: ENTRY_TITLE },
            });
        exactFailure = new PluginError({ code: 'forbidden', retryable: false });
        await activateProducedRow();
        await expect(shell.getByText('These details could not be read')).resolves.toBeDefined();

        const store = readTriageListWindowReadOwner(shell.context.hostApi, ephemeralSharedScope)!;
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Close details' })); });
        await act(async () => { await refreshTriageListWindow('manual', shell.context.hostApi, ephemeralSharedScope); });
        await act(async () => { await Promise.resolve(); });
        const refreshed = store.getRow(triageEntryRowKey(ENTRY_REF));
        expect(refreshed?.content).toMatchObject({ sourceInstanceId: INSTANCE,
            outcome: { kind: 'present', locator: { routingToken: 'example/repository' } } });
        exactFailure = null;
        await activateProducedRow();

        expect(exactReads).toBe(2);
        expect(lastExactRoutingToken).toBe('example/repository');
        const recovered = readTriageListWindowReadOwner(shell.context.hostApi, ephemeralSharedScope)!
            .getRow(triageEntryRowKey(ENTRY_REF))!;
        expect(recovered.selected).toMatchObject({ kind: 'selected', sourceInstanceId: INSTANCE });
    });
    it('refuses reopening a failed row when its source is unavailable', async () => {
        const { shell, ephemeralSharedScope } = await mountShell(true);
        await openTheRow(shell);
        const store = readTriageListWindowReadOwner(shell.context.hostApi, ephemeralSharedScope)!;
        const retained = store.getRow(triageEntryRowKey(ENTRY_REF))!;
        await act(async () => {
            store.publishObservation({
                entryRef: retained.entryRef,
                sourceInstanceId: INSTANCE,
                observedAtMs: 1_760_000_100_010,
                outcome: { kind: 'unresolved', failure: { class: 'permission', code: 'forbidden' } },
            });
        });
        sourceAvailable = false;
        await act(async () => { await refreshTriageListWindow('manual', shell.context.hostApi, ephemeralSharedScope); });
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Close details' })); });

        await openTheRow(shell);

        await expect(shell.getByText('No active connection is available for this entry’s source. Configure or reconnect a source, then open the entry again.')).resolves.toBeDefined();
        expect(exactReads).toBe(1);
    });
    it('says in words that an open entry could no longer be read, above its technical details', async () => {
        const { shell, ephemeralSharedScope } = await mountShell(true);
        await openTheRow(shell);
        const store = readTriageListWindowReadOwner(shell.context.hostApi, ephemeralSharedScope)!;
        const retained = store.getRow(triageEntryRowKey(ENTRY_REF))!;
        await act(async () => {
            store.publishObservation({
                entryRef: retained.entryRef,
                sourceInstanceId: INSTANCE,
                observedAtMs: 1_760_000_100_010,
                outcome: { kind: 'unresolved', failure: { class: 'transient', code: 'github_secondary_rate_limited', retryable: true } },
            });
        });

        // Not a lone "Details" fold: the reader is told what happened before the code that says why.
        await expect(shell.getByText('These details could not be read')).resolves.toBeDefined();
        await expect(shell.getByText('Details')).resolves.toBeDefined();
    });
    it('settles a retired opening generation as an unavailable detail', async () => {
        const { shell } = await mountShell(true);
        exactFailure = new PluginError({ code: 'plugin_action_generation_retired', retryable: false });
        await openTheRow(shell);

        await expect(shell.getByRole('heading', { name: ENTRY_TITLE })).resolves.toBeDefined();
        await expect(shell.getByText('These details could not be read')).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Retry' })).resolves.toBeUndefined();
    });
    it.each([3, 200, 1_000])('keeps %i retained Tasks through exact publications and local title edits', async (count) => {
        const sourceInstanceId = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId;
        const refs = ['edited', 'dependent', 'blocker', ...Array.from({ length: count - 3 }, (_, index) => `task-${index}`)].map(entryId => ({ source: INTERNAL_TASK_SOURCE_V1,
            kindId: 'task', collisionScope: 'personal', entryId }));
        const titles = refs.map((_, index) => [count === 200 ? 'Task 001' : 'Independent task', 'Waiting task', 'Required task'][index] ?? `Other task ${index}`);
        const { attention: _attention, ...taskRow } = listResult(true).window.rows[0]!;
        const resultPage = (offset: number) => TriageListEntriesResultV1Schema.parse({ ...listResult(true),
            configuredSources: [{ sourceInstanceId, configurationRowId: INTERNAL_TASK_SOURCE_RECORD_V1.rowId, source: INTERNAL_TASK_SOURCE_V1, displayLabel: 'Happier tasks', available: true }],
            window: { ...listResult(true).window,
                rows: refs.slice(offset, offset + MAX_TRIAGE_LIST_WINDOW_ROWS_V1).map((entryRef, pageIndex) => {
                    const index = offset + pageIndex;
                    return { ...taskRow, entryRef,
                    selected: { kind: 'selected', sourceInstanceId, reason: 'onlyPresent' },
                    observation: { sourceInstanceId, observedAtMs: 1_760_000_100_000,
                        outcome: { kind: 'present', locator: testkitLocator({ displayPath: titles[index] }),
                            snapshot: testkitSnapshot({ title: titles[index],
                                state: { presentation: 'active', stage: 'unstarted', nativeLabel: 'To do' },
                                relations: { blockedBy: index === 1 ? [refs[2]!] : [] } }),
                            viewer: testkitViewer({ involvement: ['assignee'] }) } },
                }; }),
                lanes: [{ sourceInstanceId, source: INTERNAL_TASK_SOURCE_V1,
                    health: offset + MAX_TRIAGE_LIST_WINDOW_ROWS_V1 >= refs.length ? { kind: 'walkFinished' } : { kind: 'partial', reason: 'more-pages' },
                    exhausted: offset + MAX_TRIAGE_LIST_WINDOW_ROWS_V1 >= refs.length }],
                continuations: offset + MAX_TRIAGE_LIST_WINDOW_ROWS_V1 >= refs.length ? [] : [{ sourceInstanceId,
                    pageLimit: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
                    continuation: { v: 1, token: `${offset + MAX_TRIAGE_LIST_WINDOW_ROWS_V1}` } }],
                taskProjection: { sourceInstanceId, order: { scope: { serverId: 'home', accountId: 'account' },
                    undoneOrder: refs.map(ref => ref.entryId) },
                    entries: refs.map(entryRef => ({ entryRef, result: { kind: 'complete', links: [] } })) },
            },
        });
        const result = resultPage(0);
        let listReads = 0;
        let contextPublications = 0;
        const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
        const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
        const admittedSurface = createSurfaceContextFixture({
            reducedMotion: true,
            mount: { kind: 'destination', destination: { pluginId: 'happier.triage', localId: 'tasks' }, container: 'appPage' },
            targetedContributions: { target: { pluginId: 'happier.triage', occurrenceId: 'task-target',
                sourceCustody: { kind: 'development', registeredRootId: 'triage-root' } },
                points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol,
                    contributions: [{ contributor: { pluginId: INTERNAL_TASK_SOURCE_V1.pluginId,
                        contributionId: INTERNAL_TASK_SOURCE_V1.localId, occurrenceId: 'task-source',
                        sourceCustody: { kind: 'development', registeredRootId: 'triage-root' } },
                        protocol, descriptor: INTERNAL_TASK_DESCRIPTOR_V1, operations: [], surfaces: [] }] }] }] },
        });
        let showTasks = false;
        let shell!: PluginUiTestkit;
        await act(async () => {
            shell = await createPluginUiTestkit({
                identity: { instanceId: 'task-title-locality', mountNonce: 'task-title-locality' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' },
                // The query-clear replay exercises an active page; locality-only cases observe a retained inactive surface.
                surface: context => showTasks ? renderTasksSurface({ ...context, activity: { active: count === 200 } }) : null,
                surfaceContext: admittedSurface,
                adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope, detailsPane: { available: true } }),
                handlers: { executeAction: async ({ action, input }) => {
                    if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 || action === TRIAGE_TASKS_LIST_ACTION_LOCAL_ID_V1) {
                        listReads++;
                        const requested = TriageListEntriesInputV1Schema.parse(input);
                        return resultPage(Number(requested.resume?.[0]?.continuation?.token ?? 0)) as unknown as JsonValue;
                    }
                    if (action === TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1) {
                        const requested = input as { entryRef: { entryId: string } };
                        const row = result.window.rows.find(row => row.entryRef.entryId === requested.entryRef.entryId)!;
                        return { kind: 'observed', entryRef: row.entryRef, observation: row.observation } as unknown as JsonValue;
                    }
                    return executeAction(action);
                }, replacePageLocation: ({ subPath }) => subPath,
                publishCurrentUiContext: () => { contextPublications++; } },
            });
        });
        mounted.push(shell);
        // Populate the real retained owner before mounting the list whose publication cost is measured.
        const preload = acquireTriageListWindow(shell.context.hostApi, ephemeralSharedScope);
        const store = readTriageListWindowReadOwner(shell.context.hostApi, ephemeralSharedScope)!;
        try {
            const initial = TRIAGE_SURFACE_INITIAL_STATE_V1;
            store.setLens(readTriageWindowLensV1(reduceTriageSurfaceV1(initial,
                { kind: 'settledRouteApplied', state: initial }, 'mine')));
            await refreshTriageListWindow('view', shell.context.hostApi, ephemeralSharedScope);
            while ((store.getSnapshot().window?.rows.length ?? 0) < count) {
                expect(store.getSnapshot().loadMore).toEqual({ kind: 'available' });
                await store.loadMore();
            }
            showTasks = true;
            await act(async () => { await shell.updateSurface(admittedSurface); });
        } finally { preload.release(); }
        const measureTable = async () => {
            const stage = document.querySelector(`[data-testid="${TRIAGE_SHELL_FILL_TEST_ID_V1}:stage"]`);
            const onLayout = (stage as unknown as { __reactLayoutHandler: (event: unknown) => void }).__reactLayoutHandler;
            await act(async () => { onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 800 } } }); });
        };
        await measureTable();
        if (count === 200) await act(async () => {
            await refreshTriageListWindow('view', shell.context.hostApi, ephemeralSharedScope);
            while ((store.getSnapshot().window?.rows.length ?? 0) < count) await store.loadMore();
        });
        expect(document.body.textContent).toContain('Blocked by Required task');
        if (count === 200) {
            let input = document.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]');
            if (!input) throw new Error('Expected mounted Tasks search');
            const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            const editQuery = async (query: string) => { await act(async () => {
                input = document.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;
                setInput.call(input, query);
                input.dispatchEvent(new InputEvent('input', { bubbles: true }));
            }); };
            const readsBeforeQuery = listReads;
            contextPublications = 0;
            renderProbe.reset();
            const descriptorAdmissions = vi.spyOn(triageProtocol, 'admitTriageSourceDescriptorV1');
            try {
                await editQuery('Task');
                expect(contextPublications).toBe(1);
                // Query-dependent row destinations change, but the virtualizer renders only mounted rows.
                const visibleRows = document.querySelectorAll('[data-testid^="triage-entry-row:"]').length;
                expect(visibleRows).toBeGreaterThan(0);
                expect(visibleRows).toBeLessThan(count);
                expect(renderProbe.collect().components.CollectionRow?.renders ?? 0).toBeLessThanOrEqual(visibleRows);
                expect(descriptorAdmissions).not.toHaveBeenCalled();
            } finally { descriptorAdmissions.mockRestore(); }
            contextPublications = 0;
            renderProbe.reset();
            await editQuery('001');
            expect(store.getSnapshot().window?.rows).toHaveLength(1);
            expect(contextPublications).toBe(1);
            expect(renderProbe.collect().components.CollectionRow?.renders ?? 0).toBeLessThanOrEqual(1);
            const row = store.getRow(triageEntryRowKey(refs[0]!))!;
            const observation = row.observations[0]!;
            if (observation.outcome.kind !== 'present') throw new Error('Expected Task');
            for (const state of [{ presentation: 'resolved', completionReason: 'completed', nativeLabel: 'Done' },
                { presentation: 'active', stage: 'unstarted', nativeLabel: 'To do' }] as const) {
                await act(async () => { store.publishObservation({ ...observation, entryRef: row.entryRef,
                    outcome: { ...observation.outcome, snapshot: { ...observation.outcome.snapshot, state } } }, false, { reconcileMembership: true }); });
            }
            const clearAdmissions = vi.spyOn(triageProtocol, 'admitTriageSourceDescriptorV1');
            try {
                renderProbe.reset();
                contextPublications = 0;
                await editQuery('');
                expect(contextPublications).toBe(1);
                const visibleRows = document.querySelectorAll('[data-testid^="triage-entry-row:"]').length;
                expect(renderProbe.collect().components.CollectionRow?.renders ?? 0).toBeLessThanOrEqual(visibleRows);
                expect(clearAdmissions).not.toHaveBeenCalled();
            } finally { clearAdmissions.mockRestore(); }
            expect(store.getSnapshot().window?.rows).toHaveLength(200);
            expect(document.querySelector('[role="grid"][aria-label="Tasks"]')?.getAttribute('aria-rowcount')).toBe('201');
            expect(listReads).toBe(readsBeforeQuery);
        }
        await act(async () => { await shell.press(await shell.getByRole('button', { name: titles[0]! })); });
        expect(store.getSnapshot().window?.rows).toHaveLength(count);
        const publishTitle = async (index: number, title: string) => {
            const row = store.getRow(triageEntryRowKey(refs[index]!))!;
            const observation = row.observations[0]!;
            if (observation.outcome.kind !== 'present') throw new Error('Fixture task must be present');
            await act(async () => { store.publishObservation({ ...observation, entryRef: row.entryRef,
                observedAtMs: observation.observedAtMs + 1,
                outcome: { ...observation.outcome, snapshot: { ...observation.outcome.snapshot, title } } }); });
        };
        renderProbe.reset();
        // Observe the real planner without replacing internal behavior: every input row builds an item.
        const planning = vi.spyOn(listSections, 'planTriageListItemsV1');
        try {
            await publishTitle(0, 'Independent task edited');
            expect(planning.mock.calls.reduce((count, [input]) => count + input.rows.length, 0)).toBe(1);
        } finally { planning.mockRestore(); }
        await expect(shell.getByRole('heading', { name: 'Independent task edited' })).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: 'Independent task edited' })).resolves.toBeDefined();
        const counts = renderProbe.collect().components;
        expect(counts.CollectionRow?.renders).toBe(1);
        expect(counts.Collection?.renders ?? 0).toBe(0);
        expect(counts.ListRoot?.renders ?? 0).toBe(0);
        expect(counts.NativeCollectionVirtualizer?.renders ?? 0).toBe(0);
        expect(counts.CollectionOwnedDetailHeader?.renders).toBe(1);
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Close details' })); });
        await measureTable();
        renderProbe.reset();
        await publishTitle(2, 'Required task renamed');
        await expect(shell.getByText('Blocked by Required task renamed')).resolves.toBeDefined();
        const blockerCounts = renderProbe.collect().components;
        expect(blockerCounts.CollectionRow?.renders).toBe(2);
        expect(blockerCounts.Collection?.renders ?? 0).toBe(0);
        expect(blockerCounts.ListRoot?.renders ?? 0).toBe(0);
        expect(blockerCounts.NativeCollectionVirtualizer?.renders ?? 0).toBe(0);
    }, 60_000);
    it('publishes a native exact reread to the retained row, selected header and current context', async () => {
        const { shell, ephemeralSharedScope } = await mountShell(true);
        await openTheRow(shell);
        expect(exactReads).toBe(1);
        const store = readTriageListWindowReadOwner(shell.context.hostApi, ephemeralSharedScope)!;
        const row = store.getRow(triageEntryRowKey(ENTRY_REF))!;
        exactTitle = 'Native write settled';
        await act(async () => {
            const observed = await reobserveTriagePostMutationRow(shell.context.hostApi, row, store.getSnapshot().window!.lanes, INSTANCE, {
                publishObservation: (observation, keepViewerFacts) => store.publishObservation(observation, keepViewerFacts),
            });
            expect(observed).not.toBeNull();
        });
        expect(exactReads).toBe(2);
        expect(store.getRow(triageEntryRowKey(ENTRY_REF))?.content?.outcome.snapshot.title).toBe(exactTitle);
        await expect(shell.getByRole('heading', { name: exactTitle })).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: exactTitle })).resolves.toBeDefined();
        expect(store.project({ ...TRIAGE_LIST_DEFAULT_LENS_V1, query: exactTitle })?.rows).toHaveLength(1);
        expect(JSON.stringify(publishedContext)).toContain(exactTitle);
    });
    it('settles a native exact reread that changes the selected row group without rereading its publication', async () => {
        const { shell, ephemeralSharedScope } = await mountShell(true);
        await openTheRow(shell);
        expect(exactReads).toBe(1);
        const store = readTriageListWindowReadOwner(shell.context.hostApi, ephemeralSharedScope)!;
        const row = store.getRow(triageEntryRowKey(ENTRY_REF))!;
        exactNeedsReview = false;
        await act(async () => {
            const observed = await reobserveTriagePostMutationRow(shell.context.hostApi, row, store.getSnapshot().window!.lanes, INSTANCE, {
                publishObservation: (observation, keepViewerFacts) => store.publishObservation(observation, keepViewerFacts),
            });
            expect(observed).not.toBeNull();
        });
        expect(store.getRow(triageEntryRowKey(ENTRY_REF))?.attention).toBeNull();
        expect(exactReads).toBe(2);
    });
    it('names the host pane and keeps one close control when the entry leaves the window', async () => {
        const { shell, ephemeralSharedScope } = await mountShell(true);
        await openTheRow(shell);
        await expect(shell.getByRole('group', { name: 'Details pane' })).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Close' })).resolves.toBeUndefined();
        await evictTheRow(shell, ephemeralSharedScope);
        await expect(shell.getByText(ENTRY_TITLE)).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Close' })).resolves.toBeUndefined();
        await shell.press(await shell.getByRole('button', { name: 'Close details' }));
        await expect(shell.queryByRole('group', { name: 'Details pane' })).resolves.toBeUndefined();
    });

    it('keeps naming the entry the reader opened', async () => {
        const { shell, ephemeralSharedScope } = await mountShell();
        await openTheRow(shell);
        await expect(shell.getByText(ENTRY_TITLE)).resolves.toBeDefined();

        await evictTheRow(shell, ephemeralSharedScope);

        // The cause is still stated — it always was.
        await expect(shell.getByText('These details are not loaded')).resolves.toBeDefined();
        // And so is the entry it is about. Without this the reader is holding a
        // sentence with no subject.
        await expect(shell.getByText(ENTRY_TITLE)).resolves.toBeDefined();
    });

    it('keeps the facts the aggregate had, and says they are no longer current', async () => {
        const { shell, ephemeralSharedScope } = await mountShell();
        await openTheRow(shell);

        await evictTheRow(shell, ephemeralSharedScope);

        // §2.2's own facts, from the last row the window published for this
        // selection: why it was asking for the reader, its state, its scope and
        // the connection it was read through.
        await expect(shell.getByText('Review requested')).resolves.toBeDefined();
        // The context keeps both facts when the host wraps them onto separate lines.
        await expect(shell.getByText('example/repository #17')).resolves.toBeDefined();
        await expect(shell.getByText(
            `Opened ${formatTriageTimestampV1('en', testkitSnapshot().createdAtMs ?? 0, 'relative', Date.now())}`,
        )).resolves.toBeDefined();
        // Marked, never presented as current.
        await expect(shell.getByText(
            'These are the last facts this page held for this entry, and they may be out of date.',
        )).resolves.toBeDefined();
    });

    it('drops the retained facts once the reader leaves the entry', async () => {
        const { shell, ephemeralSharedScope } = await mountShell();
        await openTheRow(shell);
        await evictTheRow(shell, ephemeralSharedScope);

        await act(async () => {
            // Pushed: the return control names the page it returns to.
            await shell.press(await shell.getByRole('button', { name: 'PRs & Issues' }));
        });

        // Back on the list, which no longer holds the entry at all. A retained
        // header that outlived its selection would be this surface showing a
        // reader an entry nothing selected.
        await expect(shell.queryByText(ENTRY_TITLE)).resolves.toBeUndefined();
        await expect(shell.queryByText('This entry is no longer in the list'))
            .resolves.toBeUndefined();
    });
});
