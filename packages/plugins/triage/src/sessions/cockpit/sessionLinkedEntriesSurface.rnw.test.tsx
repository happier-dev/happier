// @vitest-environment jsdom
import * as React from 'react';
import { act, cloneElement, type ReactElement } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiSemanticSurfaceAdapter } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
    PluginUiCollectionQueryInput,
    PluginUiCollectionQueryPager,
    PluginUiCollectionQuerySnapshot,
    PluginUiDataClient,
} from '@happier-dev/plugin-ui/data';
import { afterEach, describe, expect, it } from 'vitest';

import { createUnavailablePluginUiAccountKv } from '../../../../../plugin-ui/src/data/accountKv.js';
import { CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_SESSION_LINKS_FIELD, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../../corpus/collections/rows.js';
import { sessionLinkTagComponents } from '../../corpus/identity/components.js';
import { TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1 } from './linkedEntriesQuery.js';
import { renderSurface as renderSessionLinkedEntriesSurface } from './sessionLinkedEntriesSurface.js';
import { TRIAGE_ENTRY_DETAIL_DESTINATION_V1 } from '../../composer/openEntryDetails.js';
import type { PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import { Text, defineUiSurface } from '@happier-dev/plugin-ui';
import { useLinkedPullRequestStatus } from './useLinkedPullRequestStatus.js';
import { projectTriageSessionLinkedEntrySummary } from './linkedEntrySummary.js';
import type { TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';
import { testkitObservation, testkitSnapshot } from '../../corpus/testkit/observations.test-support.js';
import { acquireTriageListWindow, refreshTriageListWindow } from '../../ui/window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from '../../ui/window/ephemeralSharedScope.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { toTriageListWireRows } from '../../projection/listWindowWire.js';
import { TriageListEntriesResultV1Schema } from '../../actions/listEntriesProtocol.js';
import { PluginUiHostApiSurfaceContextV1Schema } from '@happier-dev/protocol/plugins/ui/client';
import { createTriageReadSourceSessionLinksActionHandler } from '../../actions/sessionLinks.js';
import { createTestkitCorpusCollections } from '../../corpus/testkit/corpusCollections.test-support.js';
import { testkitConfiguredInstance, testkitReadOnlySourceSnapshot } from '../testkit/entrySessionTestkit.test-support.js';

/**
 * The mounted Session cockpit, driven through the real host boundary.
 *
 * Exactly one thing is replaced: the Account Collection transport, which is a
 * genuine system boundary the host installs privately after `renderSurface`
 * returns. Everything above it — the declared static UI query, the private row
 * hydration, the projection and the rendered rows — is the real path.
 *
 * The failures this file exists to catch are the ones a green surface hides: a
 * second query, a Session id taken from anywhere but the mounted target, a
 * hydration read per render, and a durable link that quietly disappears because
 * the entry it names is not stored anywhere.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLUGIN_ID = 'happier.triage';
const SESSION_ID = 'session-cockpit-1';

function linkRow(overrides: Partial<CorpusSessionLinkRowV1> = {}): CorpusSessionLinkRowV1 {
    return {
        linkTag: 'a'.repeat(43),
        entryTag: 'b'.repeat(43),
        sessionId: SESSION_ID,
        linkedAtMs: 1_000,
        entryRef: {
            source: { pluginId: 'happier.example.source', localId: 'example-forge' },
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '42',
        },
        identityEntryRef: {
            source: { pluginId: 'happier.example.source', localId: 'example-forge' },
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '42',
        },
        displayPathAtLink: 'example/repository#42',
        ...overrides,
    };
}

type PagerControl = Readonly<{
    pager: PluginUiCollectionQueryPager;
    publish(snapshot: PluginUiCollectionQuerySnapshot): void;
    loadMoreCalls(): number;
}>;

function createPagerControl(
    initial: PluginUiCollectionQuerySnapshot,
    onLoadMore: ((publish: (snapshot: PluginUiCollectionQuerySnapshot) => void) => Promise<void>) | undefined,
): PagerControl {
    const listeners = new Set<() => void>();
    let current = initial;
    let loadMoreCallCount = 0;
    const publish = (snapshot: PluginUiCollectionQuerySnapshot): void => {
        current = snapshot;
        for (const listener of listeners) listener();
    };
    return {
        pager: {
            getSnapshot: () => current,
            subscribe(listener) {
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            },
            refresh: async () => {},
            loadMore: async () => {
                loadMoreCallCount += 1;
                await onLoadMore?.(publish);
            },
            dispose: () => { listeners.clear(); },
        },
        publish,
        loadMoreCalls: () => loadMoreCallCount,
    };
}

function queryRow(rowId: string, linkedAtMs: number, revision = 1) {
    return {
        context: {
            collection: { pluginId: PLUGIN_ID, collectionId: CORPUS_SESSION_LINKS_COLLECTION_ID },
            rowId,
            revision,
        },
        fields: {
            [CORPUS_SESSION_LINKS_FIELD.sessionId]: SESSION_ID,
            [CORPUS_SESSION_LINKS_FIELD.entryTag]: `${rowId}-entry`,
            [CORPUS_SESSION_LINKS_FIELD.linkedAtMs]: linkedAtMs,
        },
    } as const;
}

type DataHarness = Readonly<{
    client: PluginUiDataClient;
    opened: PluginUiCollectionQueryInput[];
    gets: string[];
    identityRequests: Array<Readonly<{ field: string; components: readonly string[] }>>;
    deletes: Array<Readonly<{ rowId: string; expectedRevision: number }>>;
    control: PagerControl;
}>;

function createDataHarness(input: Readonly<{
    snapshot: PluginUiCollectionQuerySnapshot;
    rowsById?: ReadonlyMap<string, CorpusSessionLinkRowV1>;
    failingRowIds?: ReadonlySet<string>;
    deleteFails?: boolean;
    onLoadMore?: (publish: (snapshot: PluginUiCollectionQuerySnapshot) => void) => Promise<void>;
}>): DataHarness {
    const opened: PluginUiCollectionQueryInput[] = [];
    const gets: string[] = [];
    const identityRequests: Array<Readonly<{ field: string; components: readonly string[] }>> = [];
    const deletes: Array<Readonly<{ rowId: string; expectedRevision: number }>> = [];
    const control = createPagerControl(input.snapshot, input.onLoadMore);
    const rowsById = input.rowsById ?? new Map<string, CorpusSessionLinkRowV1>();
    const failingRowIds = input.failingRowIds ?? new Set<string>();

    const client: PluginUiDataClient = {
        collection: () => ({
            async identityTag(request: Readonly<{ field: string; components: readonly string[] }>) {
                identityRequests.push(request);
                return `identity:${JSON.stringify([request.field, ...request.components])}`;
            },
            async get(rowId: string) {
                gets.push(rowId);
                if (failingRowIds.has(rowId)) throw new Error('The Account Collection refused this read.');
                const row = rowsById.get(rowId) ?? [...rowsById.values()].find((candidate) => (
                    rowId === `identity:${JSON.stringify([
                        CORPUS_SESSION_LINKS_FIELD.linkTag,
                        ...sessionLinkTagComponents(candidate.identityEntryRef, candidate.sessionId),
                    ])}`
                ));
                return row === undefined
                    ? null
                    : { rowId, revision: 1, value: toCorpusStoredValue(row) };
            },
            put: async () => { throw new Error('The cockpit never writes Account data.'); },
            async delete(rowId: string, options: Readonly<{ expectedRevision: number }>) {
                if (input.deleteFails === true) throw new Error('The Account Collection refused this delete.');
                deletes.push({ rowId, expectedRevision: options.expectedRevision });
                return { rowId, revision: options.expectedRevision + 1 };
            },
            query: async () => { throw new Error('The cockpit never opens a direct index query.'); },
            batch: async () => { throw new Error('The cockpit never batches Account data.'); },
        }) as ReturnType<PluginUiDataClient['collection']>,
        async openCollectionQuery(request) {
            opened.push(request);
            return control.pager;
        },
        accountKv: createUnavailablePluginUiAccountKv(),
    };

    return { client, opened, gets, identityRequests, deletes, control };
}

/** Mirrors the host's post-render private Data binding without widening author context. */
function createCockpitAdapter(
    dataClient: PluginUiDataClient | null,
    sharedScope?: PluginUiEphemeralSharedScope | (() => PluginUiEphemeralSharedScope),
): PluginUiSemanticSurfaceAdapter<typeof renderSessionLinkedEntriesSurface> {
    // Overlays mounted, so the link picker a press opens is observable like the host's.
    const rnwAdapter = createPluginUiRnwSemanticSurfaceAdapter({ overlays: true });
    return {
        async mount(mountInput) {
            return await rnwAdapter.mount({
                ...mountInput,
                surface: (context: RenderContext): ReactElement => dataClient === null
                    ? mountInput.surface(context) as ReactElement
                    : cloneElement(
                        mountInput.surface(context) as ReactElement<{ dataClient?: PluginUiDataClient; ephemeralSharedScope?: PluginUiEphemeralSharedScope }>,
                        { dataClient, ...(sharedScope === undefined ? {} : { ephemeralSharedScope: typeof sharedScope === 'function' ? sharedScope() : sharedScope }) },
                    ),
            });
        },
    };
}

const mounted: PluginUiTestkit[] = [];
type ActionCall = Readonly<{ action: string; input: unknown }>;
const actionCalls: ActionCall[] = [];
type SurfaceOpen = Readonly<{ view: unknown; input?: unknown; subPath?: string }>;
const surfaceOpens: SurfaceOpen[] = [];

/**
 * The one Action the cockpit can invoke, scripted per test.
 *
 * `null` keeps the original behaviour — any dispatch is a failure — which is
 * what the read-only cases still assert. A scripted result stands in for the
 * host Action boundary so a press can be followed all the way through.
 */
async function mountCockpit(
    harness: DataHarness,
    target: ReturnType<typeof createSurfaceContextFixture>['target'],
    unlinkResult: unknown = null,
    accountReachable = true,
    openSurfaceError: unknown = null,
    statusFixture?: Readonly<{ scope: PluginUiEphemeralSharedScope; readStatus: () => Promise<TriagePullRequestStatusV1> }>,
    sourceOccurrencePresent = true,
    listEntries?: () => Promise<unknown>,
    sourceLinks?: () => Promise<unknown>,
    sourceScope?: () => PluginUiEphemeralSharedScope,
    machinePending = false,
): Promise<PluginUiTestkit> {
    let fixture!: PluginUiTestkit;
    const surfaceContext = createSurfaceContextFixture({
        ...(machinePending ? { machineConnectionPending: true, machineExecutionReady: false } : {}),
        mount: {
            kind: 'destination',
            destination: { pluginId: PLUGIN_ID, localId: 'session-linked-entries' },
            container: 'rightSidebarTab',
        },
        target,
        targetedContributions: {
            ...createSurfaceContextFixture().targetedContributions!,
            points: [{ pointId: 'sources', protocols: [{ protocol: { id: 'happier.triage/sources', version: 1 },
                contributions: [{
                    contributor: { pluginId: 'happier.example.source', contributionId: 'example-forge',
                        occurrenceId: 'example-forge-1', sourceCustody: { kind: 'development', registeredRootId: 'example-root' } },
                    protocol: { id: 'happier.triage/sources', version: 1 },
                    descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example forge',
                        kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' },
                            { id: 'merge-request', workflowSubject: 'pullRequest', displayName: 'Merge request' },
                            { id: 'issue', workflowSubject: 'issue', displayName: 'Issue' }] },
                    operations: sourceLinks === undefined ? [] : ['readSessionLinks', 'linkSession'].map((role) => ({
                        point: { pointId: 'sources', protocol: { id: 'happier.triage/sources', version: 1 } },
                        contributor: { pluginId: 'happier.example.source', contributionId: 'example-forge',
                            occurrenceId: 'example-forge-1', sourceCustody: { kind: 'development', registeredRootId: 'example-root' } },
                        role, action: { pluginId: 'happier.example.source', localId: role === 'linkSession' ? 'link-session' : 'read-session-links' },
                    })), surfaces: [],
                }],
            }] }],
        },
    });
    if (!sourceOccurrencePresent) delete surfaceContext.targetedContributions;
    const admittedContext = PluginUiHostApiSurfaceContextV1Schema.safeParse(surfaceContext);
    if (!admittedContext.success) throw new Error(JSON.stringify(admittedContext.error));
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-165', mountNonce: 'fixture-mount-165' },
            authorPlugin: { id: PLUGIN_ID, version: '0.0.0' },
            surface: renderSessionLinkedEntriesSurface,
            surfaceContext,
            adapter: createCockpitAdapter(accountReachable ? harness.client : null, sourceScope ?? statusFixture?.scope),
            handlers: {
                confirm: async () => true,
                // Direct Account writes use the host's Action admission boundary.
                admitAction: async () => true,
                executeAction: async ({ action, input }) => {
                    actionCalls.push({ action: String(action), input });
                    if (sourceLinks !== undefined && String(action) === 'sessions/read-source-links-v1') {
                        return await sourceLinks() as never;
                    }
                    if (listEntries !== undefined && String(action) === 'entries/list-v1') {
                        return await listEntries() as never;
                    }
                    if (statusFixture !== undefined && String(action) === 'entries/read-pull-request-status-v1') {
                        return await statusFixture.readStatus() as never;
                    }
                    if (unlinkResult === null) {
                        throw new Error('This mount scripts no host Action.');
                    }
                    return unlinkResult as never;
                },
                openSurface: async ({ view, input, subPath }) => {
                    surfaceOpens.push({ view, ...(input === undefined ? {} : { input }), ...(subPath === undefined ? {} : { subPath }) });
                    if (openSurfaceError !== null) throw openSurfaceError;
                },
            },
        });
    });
    mounted.push(fixture);
    // Let the query open and the first hydration wave settle.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    return fixture;
}

afterEach(async () => {
    actionCalls.splice(0);
    surfaceOpens.splice(0);
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

/** Round 2 (lab `plugin-tabs` P1/PP): a linked row opens in place; its actions sit at the bottom of the open row. */
async function openRow(fixture: PluginUiTestkit, name: string): Promise<void> {
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name })); });
    await act(async () => { await Promise.resolve(); });
}

describe('expanded PR status from the exact linked source observation', () => {
    it('uses shared host pending and re-admission for an expanded source read', async () => {
        const observation = testkitObservation({ entryRef: linkRow().entryRef, outcome: {
            kind: 'present', locator: { v: 1, displayPath: 'example/repository#42' },
            snapshot: testkitSnapshot(), viewer: { involvement: [] },
        } });
        const row = foldTriageListWindow({ observations: [observation], lanes: [],
            activeSourceInstanceIds: [observation.sourceInstanceId], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: observation.observedAtMs }).rows[0]!;
        const entry = projectTriageSessionLinkedEntrySummary(row, 'pullRequest');
        expect(entry?.detailSource).toBeTruthy();
        let withdrawn = true;
        const initial = { ...createSurfaceContextFixture(), machineConnectionPending: true, machineExecutionReady: false };
        const surface = defineUiSurface(() => <Text value={useLinkedPullRequestStatus(entry, true, 0).phase} />);
        const fixture = await createPluginUiTestkit({ identity: { instanceId: 'status-read', mountNonce: 'status-read-nonce' },
            authorPlugin: { id: PLUGIN_ID, version: '0.0.0' }, surface, surfaceContext: initial,
            adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { executeAction: async () => {
                if (withdrawn) throw new Error('The mounted host has withdrawn Machine reads.');
                return { kind: 'status', observedAtMs: observation.observedAtMs,
                    checks: null, review: null, merge: null, branch: null, facts: [] };
            } },
        });
        mounted.push(fixture);
        await expect(fixture.getByText('reading')).resolves.toBeDefined();
        withdrawn = false;
        await act(async () => { await fixture.updateSurface({ ...initial, machineConnectionPending: false, machineExecutionReady: true }); });
        await expect(fixture.getByText('ready')).resolves.toBeDefined();
    });

    it('loads only on expansion and retains source facts across collapse and failed refresh, then recovers', async () => {
        const scope = createTriageEphemeralSharedScopeFixture();
        const link = linkRow();
        const observation = testkitObservation({ entryRef: link.entryRef, outcome: {
            kind: 'present',
            locator: { v: 1, displayPath: link.displayPathAtLink, routingToken: 'exact-route' },
            snapshot: testkitSnapshot({ title: 'Key settings modals by route' }),
            viewer: { involvement: [] },
        } });
        const seedHost = { executeAction: async () => ({
            v: 1, configuredSourcesStatus: 'complete',
            configuredSources: [{ sourceInstanceId: observation.sourceInstanceId, source: link.entryRef.source, available: true }],
            window: { v: 1, assembledAtMs: observation.observedAtMs, coverage: 'complete',
                lanes: [{ sourceInstanceId: observation.sourceInstanceId, source: link.entryRef.source, health: { kind: 'walkFinished' }, exhausted: true }],
                rows: toTriageListWireRows(foldTriageListWindow({
                    observations: [observation], lanes: [], activeSourceInstanceIds: [observation.sourceInstanceId],
                    configuredSourcesStatus: 'complete', lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: observation.observedAtMs,
                })),
            },
        }) };
        TriageListEntriesResultV1Schema.parse(await seedHost.executeAction());
        const lease = acquireTriageListWindow(seedHost, scope);
        await refreshTriageListWindow('manual', seedHost, scope);
        lease.release();
        const status: TriagePullRequestStatusV1 = {
            kind: 'status', observedAtMs: observation.observedAtMs,
            checks: { state: 'complete', passed: 9, failed: 1, pending: 0, total: 10, incomplete: false,
                rows: [{ id: 'web', name: 'ui-tests (web)', state: 'failed' },
                    ...Array.from({ length: 9 }, (_, index) => ({ id: `unit-${index}`, name: `unit-tests ${index}`, state: 'passed' as const }))] },
            review: { decision: 'changesRequested', incomplete: false,
                reviewers: [{ id: 'user:ana', name: 'Ana', verb: 'changesRequested' }, { id: 'user:jonas', name: 'Jonas', verb: 'pending' }] },
            merge: { state: 'blocked', blocker: 'Blocked by the failing check and required review' },
            branch: { head: 'fix/settings-remount', base: 'main', additions: 48, deletions: 12 }, facts: [],
        };
        const harness = createDataHarness({
            snapshot: { status: 'ready', rows: [queryRow('link-pr', link.linkedAtMs)] },
            rowsById: new Map([['link-pr', link]]),
        });
        let currentStatus = status;
        let readFails = false;
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, null, true, null, { scope, readStatus: async () => {
            if (readFails) throw new Error('The source is temporarily unavailable.');
            return currentStatus;
        } });
        expect(actionCalls.filter((call) => call.action === 'entries/read-pull-request-status-v1')).toEqual([]);
        await openRow(fixture, 'Key settings modals by route');
        await expect(fixture.getByText('ui-tests (web)')).resolves.toBeDefined();
        await expect(fixture.getByText('Ana')).resolves.toBeDefined();
        await expect(fixture.getByText('Jonas')).resolves.toBeDefined();
        await expect(fixture.getByText(status.merge!.blocker!)).resolves.toBeDefined();
        await expect(fixture.getByText('fix/settings-remount')).resolves.toBeDefined();
        await expect(fixture.getByText('+48')).resolves.toBeDefined();
        await expect(fixture.getByText('−12')).resolves.toBeDefined();
        await expect(fixture.getByText('9/10')).resolves.toBeDefined();
        const calls = actionCalls.filter((call) => call.action === 'entries/read-pull-request-status-v1');
        expect(calls).toEqual([{ action: 'entries/read-pull-request-status-v1', input: {
            v: 1, entryRef: link.entryRef, sourceInstanceId: observation.sourceInstanceId,
            lastKnownLocator: observation.outcome.kind === 'present' ? observation.outcome.locator : null,
        } }]);
        await openRow(fixture, 'Key settings modals by route');
        await openRow(fixture, 'Key settings modals by route');
        await expect(fixture.getByText('ui-tests (web)')).resolves.toBeDefined();
        expect(actionCalls.filter((call) => call.action === 'entries/read-pull-request-status-v1')).toEqual(calls);
        readFails = true;
        // The tab's existing refresh appears on its retained-query failure line, not as new header chrome.
        await act(async () => { harness.control.publish({ rows: [queryRow('link-pr', link.linkedAtMs)], status: 'error' }); });
        await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Refresh' })); });
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByText('PR status is unavailable.')).resolves.toBeDefined();
        await expect(fixture.getByText('ui-tests (web)')).resolves.toBeDefined();
        await expect(fixture.getByText('9/10')).resolves.toBeDefined();
        readFails = false;
        currentStatus = { ...status, checks: { ...status.checks!, passed: 10, failed: 0,
            rows: status.checks!.rows.map((check) => ({ ...check, state: 'passed' as const })) } };
        // The query failure line and status recovery use the same existing refresh owner.
        const refreshButtons = (await fixture.queryAllByRole('button')).filter((button) => button.name === 'Refresh');
        await act(async () => { await fixture.press(refreshButtons.at(-1)!); });
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByText('10/10')).resolves.toBeDefined();
        await expect(fixture.queryByText('PR status is unavailable.')).resolves.toBeUndefined();
    });
});

async function unlinkThroughSharedPolicy(fixture: PluginUiTestkit, name: string): Promise<void> {
    await openRow(fixture, name);
    await act(async () => { await fixture.press(await fixture.findByRole('button', { name: `Unlink ${name}` })); });
    await act(async () => { await Promise.resolve(); });
}

describe('the Session tab, round 2', () => {
    it.each([true, false])('retains linked rows with a source occurrence present: %s', async (sourceOccurrencePresent) => {
        const issueRef = {
            source: { pluginId: 'happier.example.source', localId: 'example-forge' },
            kindId: 'issue',
            collisionScope: 'example/repository',
            entryId: '7',
        } as const;
        const harness = createDataHarness({
            snapshot: { rows: [queryRow('link-a', 2_000), queryRow('link-b', 1_000)], hasMore: false, status: 'ready' },
            rowsById: new Map([
                ['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })],
                ['link-b', linkRow({ displayPathAtLink: 'example/repository#7', entryRef: issueRef, identityEntryRef: issueRef })],
            ]),
        });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, null, true, null, undefined, sourceOccurrencePresent);

        await expect(fixture.findByRole('button', { name: 'example/repository#42' })).resolves.toBeDefined();
        await expect(fixture.findByRole('button', { name: 'example/repository#7' })).resolves.toBeDefined();
        if (sourceOccurrencePresent) {
            await expect(fixture.getByText('Pull requests')).resolves.toBeDefined();
            await expect(fixture.getByText('Issues')).resolves.toBeDefined();
        } else {
            await expect(fixture.getByText('Other links')).resolves.toBeDefined();
            expect(await fixture.queryByText('Pull requests')).toBeUndefined();
            expect(await fixture.queryByText('Issues')).toBeUndefined();
        }
        // Rows are not a list of Unlink buttons any more: removing a link is one step down, in the open row.
        expect((await fixture.queryAllByRole('button')).filter((button) => button.name === 'Unlink')).toHaveLength(0);
    });

    it('opens a linked row in place and submits Unlink through the shared Action policy without a second local step', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [queryRow('link-a', 2_000)], hasMore: false, status: 'ready' },
            rowsById: new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })]]),
        });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, { v: 1, status: 'unlinked' });

        await openRow(fixture, 'example/repository#42');
        // Pressing the row opened it; it did not navigate.
        expect(surfaceOpens).toHaveLength(0);
        await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Open' })); });
        await act(async () => { await Promise.resolve(); });
        expect(surfaceOpens[0]).toMatchObject({ view: TRIAGE_ENTRY_DETAIL_DESTINATION_V1 });

        await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Unlink example/repository#42' })); });
        await act(async () => { await Promise.resolve(); });
        expect(harness.deletes).toHaveLength(1);
    });
});

describe('the mounted Session cockpit', () => {
    it('reads source relations through the Account aggregate without a Machine', async () => {
        const harness = createDataHarness({ snapshot: { status: 'ready', rows: [], hasMore: false } });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID },
            null, true, null, undefined, true, undefined, async () => ({ kind: 'complete', links: [{
                entryRef: linkRow().entryRef, sessionId: SESSION_ID, linkedAtMs: 10, displayPath: 'My linked Account task',
            }] }), undefined, true);
        await expect(fixture.getByText('My linked Account task')).resolves.toBeDefined();
        expect(actionCalls.filter(call => call.action === 'sessions/read-source-links-v1')).toHaveLength(1);
        expect(harness.gets).toHaveLength(0);
    });

    it('never carries source-only links into another Account scope with the same Session id', async () => {
        const harness = createDataHarness({ snapshot: { status: 'ready', rows: [], hasMore: false } });
        let scope = createTriageEphemeralSharedScopeFixture();
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID },
            null, true, null, undefined, true, undefined, async () => ({ kind: 'complete', links: [{
                entryRef: linkRow().entryRef, sessionId: SESSION_ID, linkedAtMs: 10, displayPath: 'First Account private task',
            }] }), () => scope);
        await expect(fixture.getByText('First Account private task')).resolves.toBeDefined();
        scope = createTriageEphemeralSharedScopeFixture();
        const nextContext = createSurfaceContextFixture({ target: { kind: 'session', sessionId: SESSION_ID } });
        delete nextContext.targetedContributions;
        await act(async () => { await fixture.updateSurface(nextContext); });
        await expect(fixture.queryByText('First Account private task')).resolves.toBeUndefined();
        expect(harness.gets).toHaveLength(0);
    });

    it('shows healthy source links beside named incomplete coverage and never reports a partial empty read as empty', async () => {
        const harness = createDataHarness({ snapshot: { status: 'ready', rows: [], hasMore: false } });
        const { collections, control } = createTestkitCorpusCollections();
        const configured = testkitConfiguredInstance();
        for (const [index, instance] of [configured, { ...configured,
            instance: { source: { pluginId: 'acme.uninstalled', localId: 'items' }, sourceInstanceId: '22222222-2222-4222-8222-222222222222' },
            locator: { v: 1 as const, displayLabel: 'Retained source' },
        }].entries()) control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: `${index}${'a'.repeat(42)}`, lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            sourceQualifiedId: `${instance.instance.source.pluginId}/${instance.instance.source.localId}`, configured: instance,
        }));
        let links = [{ localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '42' }, sessionId: SESSION_ID,
            linkedAtMs: 10, displayPath: 'Healthy linked work' }];
        const snapshot = testkitReadOnlySourceSnapshot();
        const context = { surface: 'ui', caller: { kind: 'plugin', pluginId: PLUGIN_ID }, signal: new AbortController().signal,
            services: {
                storage: { account: { collection: () => collections.sourceInstances } },
                targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [
                    { ...snapshot.contributions[0], operations: { readSessionLinks: { role: 'readSessionLinks' } } },
                ] }), dispose: () => {} }) },
                actions: { executeAdmittedTargetedOperation: async () => ({ kind: 'complete', links }) },
            },
        } as unknown as PluginInvocationContext;
        const read = createTriageReadSourceSessionLinksActionHandler();
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID },
            null, true, null, undefined, true, undefined, async () => await read({ v: 1, sessionId: SESSION_ID }, context));
        await expect(fixture.getByText('Healthy linked work')).resolves.toBeDefined();
        await expect(fixture.getByText('Some linked entries could not be read: Retained source.')).resolves.toBeDefined();
        links = [];
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh' })); });
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.queryByText('Healthy linked work')).resolves.toBeUndefined();
        await expect(fixture.getByText('Some linked entries could not be read: Retained source.')).resolves.toBeDefined();
        await expect(fixture.queryByText('Keep this session’s PRs and issues at hand')).resolves.toBeUndefined();
    });

    it('joins source-owned work without a v2 row and retains it after a failed source refresh', async () => {
        const harness = createDataHarness({ snapshot: { status: 'ready', rows: [], hasMore: false } });
        let failSource = false;
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID },
            { v: 1, status: 'unlinked' }, true, null, undefined, true, undefined, async () => {
                if (failSource) throw new Error('The source is offline');
                return { kind: 'complete', links: [{ entryRef: linkRow().entryRef, sessionId: SESSION_ID,
                    linkedAtMs: 10, displayPath: 'Personal task without external storage' }] };
            });
        await expect(fixture.getByText('Personal task without external storage')).resolves.toBeDefined();
        expect(harness.gets).toHaveLength(0);
        failSource = true;
        await act(async () => { harness.control.publish({ status: 'error', rows: [], hasMore: false }); });
        await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Refresh' })); });
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByText('Personal task without external storage')).resolves.toBeDefined();
        await openRow(fixture, 'Personal task without external storage');
        await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Unlink Personal task without external storage' })); });
        expect(actionCalls.filter((call) => call.action === 'sessions/unlink-entry-v1')).toHaveLength(1);
        expect(harness.deletes).toHaveLength(0);
    });

    it('loads and retains every linked-entry page so link 51 can be inspected and unlinked', async () => {
        const firstPage = Array.from({ length: 50 }, (_, index) => (
            queryRow(`link-${index + 1}`, 100 - index)
        ));
        // The appended row is newest, so the real virtualized List mounts it
        // without the test pretending every retained row is simultaneously in
        // the viewport. Link 1 remaining mounted proves page-one retention.
        const allRows = [...firstPage, queryRow('link-51', 101)];
        const rowsById = new Map(allRows.map((row, index) => [
            row.context.rowId,
            linkRow({
                displayPathAtLink: `example/repository#${index + 1}`,
                entryRef: {
                    source: { pluginId: 'happier.example.source', localId: 'example-forge' },
                    kindId: 'pull-request',
                    collisionScope: 'example/repository',
                    entryId: `${index + 1}`,
                },
                identityEntryRef: {
                    source: { pluginId: 'happier.example.source', localId: 'example-forge' },
                    kindId: 'pull-request',
                    collisionScope: 'example/repository',
                    entryId: `${index + 1}`,
                },
            }),
        ]));
        const harness = createDataHarness({
            snapshot: { rows: firstPage, hasMore: true, status: 'ready' },
            rowsById,
            onLoadMore: async (publish) => {
                publish({ rows: allRows, hasMore: false, status: 'ready' });
            },
        });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        await expect(fixture.getByText('example/repository#1')).resolves
            .toEqual({ content: 'example/repository#1' });
        await expect(fixture.queryByText('example/repository#51')).resolves.toBeUndefined();

        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'Load more' }));
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        expect(harness.control.loadMoreCalls()).toBe(1);
        await expect(fixture.getByText('example/repository#1')).resolves
            .toEqual({ content: 'example/repository#1' });
        await expect(fixture.getByText('example/repository#51')).resolves
            .toEqual({ content: 'example/repository#51' });

        await unlinkThroughSharedPolicy(fixture, 'example/repository#51');

        const link51 = rowsById.get('link-51')!;
        expect(harness.identityRequests).toContainEqual({
            field: CORPUS_SESSION_LINKS_FIELD.linkTag,
            components: sessionLinkTagComponents(link51.identityEntryRef, SESSION_ID),
        });
    }, 15_000);

    it('keeps retained links visible while loading and after an error, then retries the same pager', async () => {
        const firstRows = [queryRow('link-a', 2)];
        const appendedRows = [...firstRows, queryRow('link-b', 1)];
        let attempt = 0;
        const harness = createDataHarness({
            snapshot: { rows: firstRows, hasMore: true, status: 'ready' },
            rowsById: new Map([
                ['link-a', linkRow({ displayPathAtLink: 'example/repository#1' })],
                ['link-b', linkRow({ displayPathAtLink: 'example/repository#2' })],
            ]),
            onLoadMore: async (publish) => {
                attempt += 1;
                publish(attempt === 1
                    ? { rows: firstRows, hasMore: true, status: 'error' }
                    : { rows: appendedRows, hasMore: false, status: 'ready' });
            },
        });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'Load more' }));
        });
        await expect(fixture.getByText('example/repository#1')).resolves
            .toEqual({ content: 'example/repository#1' });
        await expect(fixture.getByText('More entries could not be loaded')).resolves
            .toEqual({ content: 'More entries could not be loaded' });

        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'Try again' }));
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        expect(harness.control.loadMoreCalls()).toBe(2);
        await expect(fixture.getByText('example/repository#1')).resolves
            .toEqual({ content: 'example/repository#1' });
        await expect(fixture.getByText('example/repository#2')).resolves
            .toEqual({ content: 'example/repository#2' });
    });

    it('keeps retained links visible during a pending page and ignores its completion after disposal', async () => {
        const rows = [queryRow('link-a', 1)];
        let settle!: () => void;
        const pending = new Promise<void>((resolve) => { settle = resolve; });
        const harness = createDataHarness({
            snapshot: { rows, hasMore: true, status: 'ready' },
            rowsById: new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#1' })]]),
            onLoadMore: async () => { await pending; },
        });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'Load more' }));
        });
        const loadingButton = await fixture.getByRole('button', { name: 'Load more' });
        expect(loadingButton.state).toMatchObject({ busy: true, disabled: true });
        await expect(fixture.getByText('example/repository#1')).resolves
            .toEqual({ content: 'example/repository#1' });

        await fixture.dispose();
        await act(async () => {
            settle();
            await pending;
        });
        expect(harness.control.loadMoreCalls()).toBe(1);
    });

    it('describes a bounded query page without claiming its client-side sort is globally recent', async () => {
        const harness = createDataHarness({
            snapshot: {
                rows: [queryRow('link-a', 1_000)],
                hasMore: true,
                status: 'ready',
            },
            rowsById: new Map([['link-a', linkRow()]]),
        });

        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        await expect(fixture.getByText('Recent links from this page are shown; the rest are still linked.'))
            .resolves.toEqual({
                content: 'Recent links from this page are shown; the rest are still linked.',
            });
        await expect(fixture.queryByText('This panel shows the most recently linked; the rest are still linked.'))
            .resolves.toBeUndefined();
    });

    it('opens exactly one declared query for the exact mounted Session and hydrates each row once', async () => {
        const rows = [queryRow('link-a', 2_000), queryRow('link-b', 1_000)];
        const harness = createDataHarness({
            snapshot: { rows, hasMore: false, status: 'ready' },
            rowsById: new Map([
                ['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })],
                ['link-b', linkRow({ displayPathAtLink: 'example/other#7' })],
            ]),
        });

        const fixture = await mountCockpit(harness, {
            kind: 'session',
            sessionId: SESSION_ID,
            agentId: 'codex',
        });

        // ONE query, over the one durable collection, parameterized by the exact
        // host-stamped mounted Session — never a launch input or active Session.
        expect(harness.opened).toHaveLength(1);
        expect(harness.opened[0]?.collectionId).toBe(CORPUS_SESSION_LINKS_COLLECTION_ID);
        expect(harness.opened[0]?.uiQueryId).toBe(TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1);
        expect(harness.opened[0]?.parameters).toEqual({ sessionId: SESSION_ID });

        // One private read per rendered row, addressed by the host-stamped rowId.
        expect(harness.gets.slice().sort()).toEqual(['link-a', 'link-b']);

        await expect(fixture.getByText('example/repository#42')).resolves
            .toEqual({ content: 'example/repository#42' });
        await expect(fixture.getByText('example/other#7')).resolves
            .toEqual({ content: 'example/other#7' });

        // The panel reaches no host Action and therefore no provider at all.
        expect(actionCalls).toEqual([]);
    });

    it('opens a linked row through the qualified Triage destination and keeps Unlink beside Open', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [queryRow('link-a', 2_000)], hasMore: false, status: 'ready' },
            rowsById: new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })]]),
        });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        // The row opens in place; Open is its primary and Unlink a separate control beside it.
        await openRow(fixture, 'example/repository#42');
        await fixture.press(await fixture.findByRole('button', { name: 'Open' }));
        await act(async () => { await Promise.resolve(); });

        expect(surfaceOpens).toHaveLength(1);
        expect(surfaceOpens[0]).toMatchObject({
            view: TRIAGE_ENTRY_DETAIL_DESTINATION_V1,
            subPath: 'e,happier.example.source,example-forge,pull-request,example%2Frepository,42',
        });
        expect(surfaceOpens[0]?.input).toBeUndefined();
        expect((await fixture.queryAllByRole('button'))
            .filter((button) => button.name === 'Unlink example/repository#42'))
            .toHaveLength(1);
        expect(actionCalls).toEqual([]);
    });

    it('keeps an open refusal visible and leaves unlink available', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [queryRow('link-a', 2_000)], hasMore: false, status: 'ready' },
            rowsById: new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })]]),
        });
        const fixture = await mountCockpit(
            harness,
            { kind: 'session', sessionId: SESSION_ID },
            null,
            true,
            new Error('The destination is unavailable.'),
        );

        await openRow(fixture, 'example/repository#42');
        await fixture.press(await fixture.findByRole('button', { name: 'Open' }));
        await act(async () => { await Promise.resolve(); });

        await expect(fixture.getByText('This entry could not be opened.')).resolves
            .toEqual({ content: 'This entry could not be opened.' });
        expect((await fixture.queryAllByRole('button'))
            .filter((button) => button.name === 'Unlink example/repository#42'))
            .toHaveLength(1);
        expect(actionCalls).toEqual([]);
    });

    it('does not re-read a hydrated row when the pager republishes the same revisions', async () => {
        const rows = [queryRow('link-a', 2_000)];
        const harness = createDataHarness({
            snapshot: { rows, hasMore: false, status: 'ready' },
            rowsById: new Map([['link-a', linkRow()]]),
        });

        await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });
        expect(harness.gets).toEqual(['link-a']);

        await act(async () => {
            harness.control.publish({ rows, hasMore: false, status: 'ready' });
        });
        await act(async () => { await Promise.resolve(); });

        expect(harness.gets).toEqual(['link-a']);
    });

    it('re-reads a link the pager republishes at a new revision', async () => {
        const stored = new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })]]);
        const harness = createDataHarness({
            snapshot: { rows: [queryRow('link-a', 2_000, 1)], hasMore: false, status: 'ready' },
            rowsById: stored,
        });

        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });
        await expect(fixture.getByText('example/repository#42')).resolves
            .toEqual({ content: 'example/repository#42' });

        stored.set('link-a', linkRow({ displayPathAtLink: 'example/repository#99' }));
        await act(async () => {
            harness.control.publish({
                rows: [queryRow('link-a', 2_000, 2)],
                hasMore: false,
                status: 'ready',
            });
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        // A revision the hydration map does not describe is re-read, not
        // presented from the read taken at the previous revision.
        expect(harness.gets).toEqual(['link-a', 'link-a']);
        await expect(fixture.getByText('example/repository#99')).resolves
            .toEqual({ content: 'example/repository#99' });
    });

    it('recovers an unreadable private link at the same revision without rereading healthy links', async () => {
        const rows = [queryRow('link-a', 2_000), queryRow('link-b', 1_000)];
        const failures = new Set(['link-b']);
        const harness = createDataHarness({
            snapshot: { rows, hasMore: false, status: 'ready' },
            rowsById: new Map([
                ['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })],
                ['link-b', linkRow({ displayPathAtLink: 'example/repository#43' })],
            ]),
            failingRowIds: failures,
        });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });
        await expect(fixture.getByText('This link could not be read.')).resolves.toBeDefined();
        failures.clear();
        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'Refresh' }));
        });
        await act(async () => { await Promise.resolve(); });
        await expect(fixture.getByRole('button', { name: 'example/repository#43' })).resolves.toBeDefined();
        await expect(fixture.findByRole('button', { name: 'example/repository#42' })).resolves.toBeDefined();
        expect(harness.gets).toEqual(['link-a', 'link-b', 'link-b']);
        await act(async () => { harness.control.publish({ rows, hasMore: false, status: 'ready' }); });
        expect(harness.gets).toEqual(['link-a', 'link-b', 'link-b']);
    });

    it('renders a link whose private row could not be read instead of dropping it', async () => {
        const rows = [queryRow('link-a', 2_000), queryRow('link-b', 1_000)];
        const harness = createDataHarness({
            snapshot: { rows, hasMore: false, status: 'ready' },
            rowsById: new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })]]),
            failingRowIds: new Set(['link-b']),
        });

        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        // The readable link still renders, and the unreadable one says so rather
        // than vanishing or taking the panel down with it.
        await expect(fixture.getByText('example/repository#42')).resolves
            .toEqual({ content: 'example/repository#42' });
        await expect(fixture.getByText('This link could not be read.')).resolves
            .toEqual({ content: 'This link could not be read.' });
    });

    it('says a link was removed underneath the page rather than showing an empty panel', async () => {
        const rows = [queryRow('link-a', 2_000)];
        const harness = createDataHarness({
            snapshot: { rows, hasMore: false, status: 'ready' },
            rowsById: new Map(),
        });

        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        await expect(fixture.getByText('This link was removed.')).resolves
            .toEqual({ content: 'This link was removed.' });
    });

    it('never presents an unavailable page as an empty link set', async () => {
        const harness = createDataHarness({
            snapshot: {
                rows: [],
                hasMore: false,
                status: 'unavailable',
                error: { error: 'collection_unavailable' },
            },
        });

        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        await expect(fixture.getByText('Linked entries could not be read')).resolves
            .toEqual({ content: 'Linked entries could not be read' });
        expect(harness.gets).toEqual([]);
    });

    it('reports linked entries unavailable when the Account Data client is absent', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [], hasMore: false, status: 'ready' },
        });

        const fixture = await mountCockpit(
            harness,
            { kind: 'session', sessionId: SESSION_ID },
            null,
            false,
        );

        await expect(fixture.getByText('Linked entries could not be read')).resolves
            .toEqual({ content: 'Linked entries could not be read' });
        expect(harness.opened).toEqual([]);
        expect(harness.gets).toEqual([]);
    });

    it('reports a settled empty page as an empty link set', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [], hasMore: false, status: 'ready' },
        });

        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        await expect(fixture.getByText('Keep this session’s PRs and issues at hand')).resolves
            .toEqual({ content: 'Keep this session’s PRs and issues at hand' });
    });

    it('leads the empty state with its one action, linking a PR or issue, and keeps browsing quiet beside it', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [], hasMore: false, status: 'ready' },
        });

        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        // The state's primary opens the same picker as the pane header's "+" (which the host draws in its band).
        const linkControls = await fixture.getAllByRole('button', { name: 'Link a PR or issue' });
        await expect(fixture.queryByRole('textbox', { name: 'Search PRs & Issues' })).resolves.toBeUndefined();
        await act(async () => { await fixture.press(linkControls[linkControls.length - 1]!); });
        await expect(fixture.findByRole('textbox', { name: 'Search PRs & Issues' })).resolves.toBeDefined();
        // PRs & Issues has read nothing on this mount: the picker says there is nothing to pick yet, never that
        // this Session's links could not be read.
        await expect(fixture.getByText('Nothing matches in PRs & Issues yet')).resolves.toBeDefined();
        await expect(fixture.queryByText('Linked entries could not be read')).resolves.toBeUndefined();
        await expect(fixture.getByRole('button', { name: 'Browse PRs & Issues' })).resolves.toBeDefined();
    });

    it('reads PRs & Issues when the picker opens on a mount that has read nothing, and lists what it finds', async () => {
        // Opening the picker is the reader asking for entries; on a cold app (the Session opened first) an empty
        // picker would leave them nothing to link. The open picker is a view of the one list window, so it sends
        // that window's paced view demand rather than reading on its own.
        const scope = createTriageEphemeralSharedScopeFixture();
        const link = linkRow();
        const observation = testkitObservation({ entryRef: link.entryRef, outcome: {
            kind: 'present',
            locator: { v: 1, displayPath: link.displayPathAtLink, routingToken: 'exact-route' },
            snapshot: testkitSnapshot({ title: 'Key settings modals by route' }),
            viewer: { involvement: [] },
        } });
        const listResult = {
            v: 1, configuredSourcesStatus: 'complete',
            configuredSources: [{ sourceInstanceId: observation.sourceInstanceId, source: link.entryRef.source, available: true }],
            window: { v: 1, assembledAtMs: observation.observedAtMs, coverage: 'complete',
                lanes: [{ sourceInstanceId: observation.sourceInstanceId, source: link.entryRef.source, health: { kind: 'walkFinished' }, exhausted: true }],
                rows: toTriageListWireRows(foldTriageListWindow({
                    observations: [observation], lanes: [], activeSourceInstanceIds: [observation.sourceInstanceId],
                    configuredSourcesStatus: 'complete', lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: observation.observedAtMs,
                })),
            },
        };
        const harness = createDataHarness({ snapshot: { rows: [], hasMore: false, status: 'ready' } });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID }, null, true, null,
            { scope, readStatus: async () => { throw new Error('No status read is expected here.'); } }, true,
            async () => listResult);
        expect(actionCalls.filter((call) => call.action === 'entries/list-v1')).toEqual([]);

        const linkControls = await fixture.getAllByRole('button', { name: 'Link a PR or issue' });
        await act(async () => { await fixture.press(linkControls[linkControls.length - 1]!); });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
        await expect(fixture.getByText('Key settings modals by route')).resolves.toBeDefined();
        expect(actionCalls.some((call) => call.action === 'entries/list-v1')).toBe(true);
    });

    it('opens no query at all when the mounted target is not a Session', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [], hasMore: false, status: 'ready' },
        });

        const fixture = await mountCockpit(harness, { kind: 'app' });

        expect(harness.opened).toEqual([]);
        expect(harness.gets).toEqual([]);
        await expect(fixture.getByText('No session for this panel')).resolves
            .toEqual({ content: 'No session for this panel' });
    });
});

describe('undoing a link from the mounted cockpit', () => {
    /**
     * The reader who started a Session from the wrong entry had no way back: a
     * link is durable Account state, the cockpit was read-only, and nothing
     * else removes one. This is that path, end to end through the real mount.
     */
    it('removes exactly the link the pressed row was rendered from', async () => {
        const rows = [queryRow('link-a', 2_000), queryRow('link-b', 1_000)];
        const wrongEntry = linkRow({
            displayPathAtLink: 'example/repository#42',
            entryRef: {
                source: { pluginId: 'happier.example.source', localId: 'example-forge' },
                kindId: 'pull-request',
                collisionScope: 'example/repository',
                entryId: '42',
            },
        });
        const harness = createDataHarness({
            snapshot: { rows, hasMore: false, status: 'ready' },
            rowsById: new Map([
                ['link-a', wrongEntry],
                ['link-b', linkRow({ displayPathAtLink: 'example/other#7' })],
            ]),
        });

        const fixture = await mountCockpit(
            harness,
            { kind: 'session', sessionId: SESSION_ID },
            { v: 1, status: 'unlinked' },
        );

        // Unlink is addressed by the open row and admitted by the shared Action policy.
        await unlinkThroughSharedPolicy(fixture, 'example/repository#42');

        // The mounted surface can reach Account Collections directly, so it
        // removes through that canonical transport rather than needlessly
        // routing the user's own durable state through a daemon Action. The
        // identity derivation still receives the exact mounted Session and the
        // exact immutable reference the private row held.
        expect(harness.identityRequests).toContainEqual({
            field: CORPUS_SESSION_LINKS_FIELD.linkTag,
            components: sessionLinkTagComponents(wrongEntry.identityEntryRef, SESSION_ID),
        });
        expect(harness.deletes).toHaveLength(1);
        expect(harness.deletes[0]?.expectedRevision).toBe(1);
        expect(actionCalls).toEqual([]);
    });

    it('says a refused removal failed instead of showing the link as gone', async () => {
        const rows = [queryRow('link-a', 2_000)];
        const harness = createDataHarness({
            snapshot: { rows, hasMore: false, status: 'ready' },
            rowsById: new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })]]),
            deleteFails: true,
        });

        const fixture = await mountCockpit(
            harness,
            { kind: 'session', sessionId: SESSION_ID },
            { v: 1, status: 'failed' },
        );

        await unlinkThroughSharedPolicy(fixture, 'example/repository#42');

        // The row is still the link it was. Presenting a refused delete as a
        // removal would tell the reader their mistake is undone while the
        // Session still claims the entry.
        await expect(fixture.findByRole('button', { name: 'example/repository#42' })).resolves.toBeDefined();
        await expect(fixture.getByText('This link could not be removed.')).resolves
            .toEqual({ content: 'This link could not be removed.' });
    });
});
