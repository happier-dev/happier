// @vitest-environment jsdom
import { act, cloneElement, type ReactElement } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiSemanticSurfaceAdapter } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import type {
    PluginUiCollectionQueryInput,
    PluginUiCollectionQueryPager,
    PluginUiCollectionQuerySnapshot,
    PluginUiDataClient,
} from '@happier-dev/plugin-ui/data';
import { afterEach, describe, expect, it } from 'vitest';

import { createUnavailablePluginUiAccountKv } from '../../../../../plugin-ui/src/data/accountKv.js';
import { CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_SESSION_LINKS_FIELD } from '../../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../../corpus/collections/rows.js';
import { sessionLinkTagComponents } from '../../corpus/identity/components.js';
import { TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1 } from './linkedEntriesQuery.js';
import { renderSurface as renderSessionLinkedEntriesSurface } from './sessionLinkedEntriesSurface.js';
import { TRIAGE_ENTRY_DETAIL_DESTINATION_V1 } from '../../composer/openEntryDetails.js';

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
): PluginUiSemanticSurfaceAdapter<typeof renderSessionLinkedEntriesSurface> {
    const rnwAdapter = createPluginUiRnwSemanticSurfaceAdapter();
    return {
        async mount(mountInput) {
            return await rnwAdapter.mount({
                ...mountInput,
                surface: (context: RenderContext): ReactElement => dataClient === null
                    ? mountInput.surface(context) as ReactElement
                    : cloneElement(
                        mountInput.surface(context) as ReactElement<{ dataClient?: PluginUiDataClient }>,
                        { dataClient },
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
): Promise<PluginUiTestkit> {
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: PLUGIN_ID,
                pluginVersion: '0.0.0',
                viewId: 'session-linked-entries',
                generation: 'session-linked-entries-mount',
            },
            surface: renderSessionLinkedEntriesSurface,
            surfaceContext: createSurfaceContextFixture({
                mount: {
                    kind: 'destination',
                    destination: { pluginId: PLUGIN_ID, localId: 'session-linked-entries' },
                    container: 'rightSidebarTab',
                },
                target,
            }),
            adapter: createCockpitAdapter(accountReachable ? harness.client : null),
            handlers: {
                executeAction: async ({ action, input }) => {
                    actionCalls.push({ action: String(action), input });
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

describe('the mounted Session cockpit', () => {
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

        const unlinkButtons = (await fixture.queryAllByRole('button'))
            .filter((button) => button.name === 'Unlink');
        await act(async () => { await fixture.press(unlinkButtons[0]!); });
        await act(async () => { await Promise.resolve(); });

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

    it('opens a linked row through the qualified Triage destination and preserves a separate Unlink action', async () => {
        const harness = createDataHarness({
            snapshot: { rows: [queryRow('link-a', 2_000)], hasMore: false, status: 'ready' },
            rowsById: new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })]]),
        });
        const fixture = await mountCockpit(harness, { kind: 'session', sessionId: SESSION_ID });

        // The row itself is the primary, accessible action. Its accessory is
        // outside that press target and remains a separate Unlink button.
        await fixture.press(await fixture.findByRole('button', { name: 'example/repository#42' }));
        await act(async () => { await Promise.resolve(); });

        expect(surfaceOpens).toHaveLength(1);
        expect(surfaceOpens[0]).toMatchObject({
            view: TRIAGE_ENTRY_DETAIL_DESTINATION_V1,
            subPath: 'e,happier.example.source,example-forge,pull-request,example%2Frepository,42',
        });
        expect(surfaceOpens[0]?.input).toBeUndefined();
        expect((await fixture.queryAllByRole('button'))
            .filter((button) => button.name === 'Unlink'))
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

        await fixture.press(await fixture.findByRole('button', { name: 'example/repository#42' }));
        await act(async () => { await Promise.resolve(); });

        await expect(fixture.getByText('This entry could not be opened.')).resolves
            .toEqual({ content: 'This entry could not be opened.' });
        expect((await fixture.queryAllByRole('button'))
            .filter((button) => button.name === 'Unlink'))
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

        await expect(fixture.getByText('Nothing is linked yet')).resolves
            .toEqual({ content: 'Nothing is linked yet' });
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

        const buttons = (await fixture.queryAllByRole('button'))
            .filter((button) => button.name === 'Unlink');
        // One per resolved link and no more: a row that is still being read,
        // already removed, or unreadable carries no reference to remove.
        expect(buttons.map((button) => button.name ?? '')).toEqual(['Unlink', 'Unlink']);

        await act(async () => {
            await fixture.press(buttons[0]!);
        });
        await act(async () => { await Promise.resolve(); });

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

        await act(async () => {
            await fixture.press(await fixture.getByRole('button', { name: 'Unlink' }));
        });
        await act(async () => { await Promise.resolve(); });

        // The row is still the link it was. Presenting a refused delete as a
        // removal would tell the reader their mistake is undone while the
        // Session still claims the entry.
        await expect(fixture.getByText('example/repository#42')).resolves
            .toEqual({ content: 'example/repository#42' });
        await expect(fixture.getByText('This link could not be removed.')).resolves
            .toEqual({ content: 'This link could not be removed.' });
    });
});
