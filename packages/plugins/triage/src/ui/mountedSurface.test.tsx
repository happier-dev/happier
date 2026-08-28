// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, type PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiContextEnrichmentV1, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
    TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageScanInputV1,
    type TriageScanResultV1,
    type TriageSourceScanObservationV1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import {
    TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    TriageListEntriesInputV1Schema,
} from '../actions/listEntriesProtocol.js';
import { readTriageActionsForSurface } from '../actions/actionsCatalog.js';
import {
    TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
    TriageReadActionsInputV1Schema,
} from '../actions/actionsCatalogProtocol.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from '../actions/entryDetailProtocol.js';
import { TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1 } from '../actions/entrySessionProtocol.js';
import { readTriageSavedViewsForSurface } from '../actions/savedViews.js';
import {
    TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
    TriageReadSavedViewsInputV1Schema,
} from '../actions/savedViewsProtocol.js';
import { listTriagePinnedEntries } from '../actions/userMarks.js';
import {
    TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    TriageListPinnedEntriesInputV1Schema,
} from '../actions/userMarksProtocol.js';
import { renderSurface as renderPickerSurface } from '../composer/entryPicker.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTestkitAccountSettings } from '../settings/testkit/accountSettings.test-support.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { refreshTriageListWindow } from './window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';
import { renderSurface as renderShellSurface } from './surface.js';
import { TriageListShell } from './shell/root.js';
import { TRIAGE_UI_TRANSLATIONS } from './translations.js';
import {
    buildTriageRouteSubPathV1,
    TRIAGE_ROUTE_DEFAULT_LENS_V1,
} from './navigation/location.js';

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

function createHarness() {
    const { collections, control } = createTestkitCorpusCollections();
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow('a', SOURCE_A, INSTANCE_A, 1, LABEL_A)));
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow('b', SOURCE_B, INSTANCE_B, 2, LABEL_B)));

    const scans = new Map<object, ScanFn>();
    const scanCalls = { count: 0 };
    const state = { sourceBFails: false };

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
                immutableGenerationId: 'generation-1',
            },
            protocol: {
                id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
                version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
            },
            descriptor: {
                v: 1,
                purpose: 'triage-source',
                displayName: 'Example forge',
                kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
            },
            operations: { listInstances: {}, scan: handle, get: {} },
            surfaces: { detail: {} },
        } as unknown as TriageAdmittedSourceV1;
    }

    const scanA: ScanFn = async (input) => {
        scanCalls.count += 1;
        if (input.page.kind === 'initial') {
            return {
                kind: 'page',
                observations: [presentObservation({
                    entryId: '1',
                    title: 'Replace the duplicated normalizer',
                    sourceUpdatedAtMs: 3_000,
                    involvement: ['reviewRequested'],
                })],
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
        if (state.sourceBFails) {
            return { kind: 'failed', failure: { class: 'transient', code: 'provider-busy' } };
        }
        return {
            kind: 'complete',
            observations: [presentObservation({ entryId: '3', title: 'Middle change', sourceUpdatedAtMs: 2_000 })],
            evidence: { kind: 'walkFinished' },
        };
    };

    const admitted = [admittedSource(SOURCE_A, scanA), admittedSource(SOURCE_B, scanB)];
    const executeScan: TriageAdmittedOperationExecutorV1 = async (operation, input) => {
        const scan = scans.get(operation as unknown as object);
        if (scan === undefined) throw new Error('No admitted scan handle for this operation.');
        return await scan(input);
    };

    const actionCalls: string[] = [];
    const unroutedActions: string[] = [];
    const publishedContexts: (PluginUiContextEnrichmentV1 | null)[] = [];
    const accountSettings = createTestkitAccountSettings();

    /**
     * The host's Action dispatcher. It admits the surface's request through the
     * published input schema before the handler sees it, so a surface that sent
     * something the wire would reject fails here rather than rendering.
     */
    async function executeAction(request: Readonly<{ action: unknown; input: unknown }>) {
        actionCalls.push(String(request.action));
        // The shell also reads the reader's durable pins. It is a different
        // Collection and a different Action, and it reaches no source at all.
        if (String(request.action) === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
            return await listTriagePinnedEntries(
                TriageListPinnedEntriesInputV1Schema.parse(request.input),
                { collections, nowMs: () => Date.now() },
            );
        }
        // The shell also reads the reader's saved views. It is Account
        // Settings rather than a Collection, and it reaches no source either.
        if (String(request.action) === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) {
            return await readTriageSavedViewsForSurface(
                TriageReadSavedViewsInputV1Schema.parse(request.input),
                { settings: accountSettings.settings, mintViewId: () => 'unused' },
            );
        }
        // The shell also reads the reader's configured action catalogue. It is
        // Account Settings, and it reaches no source either.
        if (String(request.action) === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1) {
            return await readTriageActionsForSurface(
                TriageReadActionsInputV1Schema.parse(request.input),
                { settings: accountSettings.settings },
            );
        }
        if (String(request.action) !== TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) {
            // An unrouted Action used to fall through into the list handler and
            // be parsed as a list input, so a surprise read was answered with
            // somebody else's result instead of being seen. It is recorded here
            // and asserted on below.
            unroutedActions.push(String(request.action));
            throw new Error(`unrouted Action: ${String(request.action)}`);
        }
        const parsed = TriageListEntriesInputV1Schema.parse(request.input);
        return await listTriageEntries(parsed, {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => admitted,
            executeScan,
            nowMs: () => Date.now(),
        });
    }

    return {
        actionCalls,
        executeAction,
        ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
        publishedContexts,
        scanCalls,
        state,
        unroutedActions,
    };
}

const mounted: PluginUiTestkit[] = [];
const scopeByHost = new WeakMap<object, PluginUiEphemeralSharedScope>();

async function mountSurface(
    surface: RenderSurface,
    harness: ReturnType<typeof createHarness>,
    viewId: string,
    context: Parameters<typeof createSurfaceContextFixture>[0] = {},
    options: Readonly<{ subPath?: string }> = {},
): Promise<PluginUiTestkit> {
    // Mounting starts the window's first cycle, so the whole mount is driven
    // inside `act` — otherwise the render the cycle causes lands after the
    // helper returns and React reports an unacted update.
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId,
                generation: `${viewId}-mount`,
            },
            ...(options.subPath === undefined ? {} : { subPath: options.subPath }),
            surface,
            surfaceContext: createSurfaceContextFixture(context),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({
                ephemeralSharedScope: harness.ephemeralSharedScope,
            }),
            handlers: {
                publishCurrentUiContext: ({ enrichment }) => {
                    harness.publishedContexts.push(enrichment);
                },
                executeAction: async ({ action, input }) => (
                    await harness.executeAction({ action, input })
                ),
            },
        });
    });
    scopeByHost.set(fixture.context.hostApi, harness.ephemeralSharedScope);
    mounted.push(fixture);
    return fixture;
}

/** Settle the cycle the mount already started; `flush` joins it rather than adding one. */
async function settleWindow(
    trigger: 'view' | 'manual',
    fixture: PluginUiTestkit,
): Promise<void> {
    const scope = scopeByHost.get(fixture.context.hostApi);
    if (scope === undefined) throw new Error('mounted surface lost its host-owned scope');
    await act(async () => {
        await refreshTriageListWindow(trigger, fixture.context.hostApi, scope);
    });
}

async function visibleTexts(fixture: PluginUiTestkit, contents: readonly string[]): Promise<void> {
    for (const content of contents) {
        await expect(fixture.getByText(content)).resolves.toEqual({ content });
    }
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

describe('the mounted PRs & Issues surface', () => {
    it('resolves its executable chrome from the plugin translation bundle', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list', {
            locale: 'fr',
            translations: TRIAGE_UI_TRANSLATIONS.fr,
        });
        await settleWindow('view', shell);

        await visibleTexts(shell, [
            TRIAGE_UI_TRANSLATIONS.fr['plugins.triage.surface.upToDate'],
            TRIAGE_UI_TRANSLATIONS.fr['plugins.triage.surface.refresh'],
        ]);
        await expect(shell.queryByText('Up to date')).resolves.toBeUndefined();
    });

    it('renders one window assembled from every configured source', async () => {
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list');
        await settleWindow('view', shell);

        await visibleTexts(shell, [
            'Replace the duplicated normalizer',
            'Middle change',
            'Older change',
            'Up to date',
        ]);
        // The window is the aggregate's, not one source's: source A walked two
        // pages and source B one, all through a single Action invocation family.
        expect(harness.scanCalls.count).toBe(3);
        expect(harness.actionCalls).toContain(TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1);
        // Everything else the mount asked for is durable reader state — the
        // pins, the saved views, the configured actions — and none of them
        // touches a source.
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

        harness.state.sourceBFails = true;
        await settleWindow('manual', shell);

        // The failing connection's entry is still listed: a transient provider
        // error must never be shown as "nothing needs you". The reason is
        // retained beside the rows, and the list stops claiming to be current.
        await visibleTexts(shell, [
            'Replace the duplicated normalizer',
            'Middle change',
            'Older change',
            'Showing the last known list',
            // `REQ-01`. Source A answered and source B did not, so the reader is
            // told *which connection* to go and fix. "Some sources could not be
            // read" is health without attribution: with two connections
            // configured it leaves the reader guessing, and with six it is
            // useless.
            `${LABEL_B} could not be read`,
            'Could not be reached just now.',
        ]);
        await expect(shell.queryByText('Up to date')).resolves.toBeUndefined();
        // The healthy connection is never named as a failure, and the published
        // closed classification stays a machine word.
        await expect(shell.queryByText(`${LABEL_A} could not be read`)).resolves.toBeUndefined();
        await expect(shell.queryByText('transient')).resolves.toBeUndefined();
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
        const harness = createHarness();
        const shell = await mountSurface(renderShellSurface, harness, 'triage-list');
        await settleWindow('view', shell);
        await visibleTexts(shell, ['Replace the duplicated normalizer', 'Middle change']);

        // One press of one facet, through the shared public option control:
        // rail -> reducer -> window lens -> rows. Every hop is real here.
        await act(async () => {
            await shell.press(await shell.getByRole('checkbox', { name: LABEL_B }));
        });
        await act(async () => { await Promise.resolve(); });

        await visibleTexts(shell, ['Middle change']);
        await expect(shell.queryByText('Replace the duplicated normalizer')).resolves.toBeUndefined();

        // And the honest empty state when a facet matches nothing: the sources
        // all answered, so the healthy claim is available and false.
        await act(async () => {
            await shell.press(await shell.getByRole('checkbox', { name: 'Done' }));
        });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.getByText('Nothing matches these filters')).resolves.toBeDefined();
        await expect(shell.queryByText('Nothing needs you')).resolves.toBeUndefined();
    });

    it('names the search rather than a filter when a query is what emptied the list', async () => {
        const harness = createHarness();
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

        // View demand inside the one shared minimum interval joins instead of
        // multiplying. Nothing in this surface repeats on its own: there is no
        // timer, interval or poller to wait out.
        await settleWindow('view', shell);
        expect(harness.scanCalls.count).toBe(afterMount);

        await shell.press(await shell.getByRole('button', { name: 'Refresh' }));
        await settleWindow('manual', shell);

        // Explicit Refresh is the user asking, and the user is never paced.
        expect(harness.scanCalls.count).toBeGreaterThan(afterMount);
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
