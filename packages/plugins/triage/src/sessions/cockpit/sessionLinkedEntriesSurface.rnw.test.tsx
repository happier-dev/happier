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
import { createUnavailablePluginUiAccountSettings } from '../../../../../plugin-ui/src/data/accountSettings.js';
import { CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_SESSION_LINKS_FIELD } from '../../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../../corpus/collections/rows.js';
import { TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1 } from '../../actions/entrySessionProtocol.js';
import { TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1 } from './linkedEntriesQuery.js';
import { renderSurface as renderSessionLinkedEntriesSurface } from './sessionLinkedEntriesSurface.js';

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
        cardPublicationId: 'publication-1',
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
}>;

function createPagerControl(initial: PluginUiCollectionQuerySnapshot): PagerControl {
    const listeners = new Set<() => void>();
    let current = initial;
    return {
        pager: {
            getSnapshot: () => current,
            subscribe(listener) {
                listeners.add(listener);
                return () => { listeners.delete(listener); };
            },
            refresh: async () => {},
            loadMore: async () => {},
            dispose: () => { listeners.clear(); },
        },
        publish(snapshot) {
            current = snapshot;
            for (const listener of listeners) listener();
        },
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
    control: PagerControl;
}>;

function createDataHarness(input: Readonly<{
    snapshot: PluginUiCollectionQuerySnapshot;
    rowsById?: ReadonlyMap<string, CorpusSessionLinkRowV1>;
    failingRowIds?: ReadonlySet<string>;
}>): DataHarness {
    const opened: PluginUiCollectionQueryInput[] = [];
    const gets: string[] = [];
    const control = createPagerControl(input.snapshot);
    const rowsById = input.rowsById ?? new Map<string, CorpusSessionLinkRowV1>();
    const failingRowIds = input.failingRowIds ?? new Set<string>();

    const client: PluginUiDataClient = {
        collection: () => ({
            async get(rowId: string) {
                gets.push(rowId);
                if (failingRowIds.has(rowId)) throw new Error('The Account Collection refused this read.');
                const row = rowsById.get(rowId);
                return row === undefined
                    ? null
                    : { rowId, revision: 1, value: toCorpusStoredValue(row) };
            },
            put: async () => { throw new Error('The cockpit never writes Account data.'); },
            delete: async () => { throw new Error('The cockpit never deletes Account data.'); },
            query: async () => { throw new Error('The cockpit never opens a direct index query.'); },
            batch: async () => { throw new Error('The cockpit never batches Account data.'); },
        }) as ReturnType<PluginUiDataClient['collection']>,
        async openCollectionQuery(request) {
            opened.push(request);
            return control.pager;
        },
        accountKv: createUnavailablePluginUiAccountKv(),
        accountSettings: createUnavailablePluginUiAccountSettings(),
    };

    return { client, opened, gets, control };
}

/** Mirrors the host's post-render private Data binding without widening author context. */
function createCockpitAdapter(
    dataClient: PluginUiDataClient,
): PluginUiSemanticSurfaceAdapter<typeof renderSessionLinkedEntriesSurface> {
    const rnwAdapter = createPluginUiRnwSemanticSurfaceAdapter();
    return {
        async mount(mountInput) {
            return await rnwAdapter.mount({
                ...mountInput,
                surface: (context: RenderContext): ReactElement => cloneElement(
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
            adapter: createCockpitAdapter(harness.client),
            handlers: {
                executeAction: async ({ action, input }) => {
                    actionCalls.push({ action: String(action), input });
                    if (unlinkResult === null) {
                        throw new Error('This mount scripts no host Action.');
                    }
                    return unlinkResult as never;
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
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted Session cockpit', () => {
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

        const buttons = await fixture.queryAllByRole('button');
        // One per resolved link and no more: a row that is still being read,
        // already removed, or unreadable carries no reference to remove.
        expect(buttons.map((button) => button.name ?? '')).toEqual(['Unlink', 'Unlink']);

        await act(async () => {
            await fixture.press(buttons[0]!);
        });
        await act(async () => { await Promise.resolve(); });

        // The exact mounted Session and the exact reference the private row
        // held. A rebuilt reference would address a row the reader never
        // linked, which for a removal means deleting nothing and saying it
        // worked.
        expect(actionCalls).toEqual([{
            action: TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
            input: { v: 1, sessionId: SESSION_ID, entryRef: wrongEntry.entryRef },
        }]);
    });

    it('says a refused removal failed instead of showing the link as gone', async () => {
        const rows = [queryRow('link-a', 2_000)];
        const harness = createDataHarness({
            snapshot: { rows, hasMore: false, status: 'ready' },
            rowsById: new Map([['link-a', linkRow({ displayPathAtLink: 'example/repository#42' })]]),
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
