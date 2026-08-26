// @vitest-environment jsdom
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { JsonValue } from '@happier-dev/plugin-sdk';

import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from '../../actions/entryDetailProtocol.js';
import {
    TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    TriageListEntriesResultV1Schema,
    type TriageListEntriesResultV1,
} from '../../actions/listEntriesProtocol.js';
import { TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1 } from '../../actions/savedViewsProtocol.js';
import { TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1 } from '../../actions/userMarksProtocol.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import { renderSurface as renderShellSurface } from '../surface.js';
import { refreshTriageListWindow } from '../window/mountedWindow.js';
import { TRIAGE_SHELL_FILL_TEST_ID_V1, TRIAGE_SHELL_LIST_REGION_TEST_ID_V1 } from './root.js';

/**
 * `core/SURFACE.md` §2.1's split composition, driven by the shell's own
 * measurement of its fill region.
 *
 * The solver (`ui/shell/layout.ts`) has always been tested; what was missing was
 * a producer for `availableWidth`, so production never called it and opening an
 * entry replaced the whole page at every width. These cases mount the real
 * surface and supply the one measurement the platform would.
 *
 * jsdom ships no `ResizeObserver`, so React Native Web's shared observer never
 * fires here. It does install the author's callback on the real host node under
 * `__reactLayoutHandler` (the same fact `plugin-ui`'s own layout mount asserts),
 * so these cases invoke that installed handler with the measurement the observer
 * would have carried. Everything between it and the rendered composition —
 * the text scaling, both pane minima, the ratio clamp and the render — is the
 * production path.
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

/**
 * Widths derived from the fixture theme's own type and spacing, not guessed.
 *
 * At `textScale: 1` the fixture's pane minima sum to ~599; at `textScale: 2`
 * they sum to ~1133. `SPLIT_WIDTH` therefore splits at ordinary text and must
 * stack at the largest, which is the exact §2.1 rule that a device breakpoint
 * cannot express.
 */
const SPLIT_WIDTH = 900;
const STACK_WIDTH = 420;

function listResult(): TriageListEntriesResultV1 {
    const observation = {
        sourceInstanceId: INSTANCE,
        observedAtMs: 1_760_000_100_000,
        outcome: {
            kind: 'present',
            locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: ENTRY_TITLE }),
            viewer: testkitViewer({ involvement: ['reviewRequested'] }),
        },
    };
    return TriageListEntriesResultV1Schema.parse({
        v: 1,
        configuredSources: [{
            sourceInstanceId: INSTANCE,
            source: SOURCE,
            displayLabel: 'Example account',
            available: true,
        }],
        configuredSourcesStatus: 'complete',
        window: {
            v: 1,
            rows: [{
                entryRef: ENTRY_REF,
                lane: '1-open',
                sortAtMs: 1_760_000_100_000,
                presence: { kind: 'present', observedAtMs: 1_760_000_100_000 },
                attention: {
                    level: 'required',
                    fromSourceInstanceId: INSTANCE,
                    reasonId: 'involvement/review-requested',
                    reasonLabel: 'Your review was requested',
                },
                selected: { kind: 'selected', sourceInstanceId: INSTANCE, reason: 'onlyPresent' },
                observation,
                otherObservations: [],
                observedByCount: 1,
            }],
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

async function executeAction(action: string): Promise<JsonValue> {
    if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) {
        return listResult() as unknown as JsonValue;
    }
    if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
        return { v: 1, pins: [] };
    }
    if (action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) {
        return { v: 1, availability: 'absent', views: [], selectedViewId: null, revision: 'revision-1' };
    }
    if (action === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) {
        return { kind: 'unavailable' };
    }
    throw new Error(`unexpected action ${action}`);
}

const mounted: PluginUiTestkit[] = [];

async function mountShell(textScale = 1): Promise<PluginUiTestkit> {
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId: 'triage',
                generation: 'target-generation-a',
            },
            surface: renderShellSurface,
            surfaceContext: createSurfaceContextFixture({
                mount: {
                    kind: 'destination',
                    destination: { pluginId: 'happier.triage', localId: 'triage' },
                    container: 'appPage',
                },
                textScale,
            }),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: {
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action }) => await executeAction(action),
                replacePageLocation: ({ subPath }) => subPath,
            },
        });
    });
    mounted.push(fixture);
    await act(async () => { await refreshTriageListWindow('view', fixture.context.hostApi); });
    return fixture;
}

type LayoutHandler = (event: Readonly<{
    nativeEvent: Readonly<{ layout: Readonly<{ x: number; y: number; width: number; height: number }> }>;
}>) => void;

/**
 * Supply the measurement React Native Web's own observer would have carried.
 *
 * The handler is read off the mounted host node rather than reached through the
 * surface's props, so a shell that never asked to be measured fails here instead
 * of silently receiving a width nothing in production would have produced.
 */
async function measureFillRegion(width: number): Promise<void> {
    const node = document.querySelector(`[data-testid="${TRIAGE_SHELL_FILL_TEST_ID_V1}"]`);
    if (node === null) throw new Error('The Triage shell rendered no measured fill region.');
    const handler = (node as unknown as Record<string, unknown>).__reactLayoutHandler;
    if (typeof handler !== 'function') {
        throw new Error('The Triage shell fill region asked for no layout measurement.');
    }
    await act(async () => {
        (handler as LayoutHandler)({
            nativeEvent: { layout: { x: 0, y: 0, width, height: 800 } },
        });
    });
}

async function openTheRow(shell: PluginUiTestkit): Promise<void> {
    await act(async () => {
        await shell.press(await shell.getByRole('option', { name: ENTRY_TITLE }));
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
}

/**
 * The list region's own box, read from the DOM rather than through a semantic
 * query — because while a stacked entry is open the whole point is that the
 * region is correctly ABSENT from the accessibility tree, and an assertion that
 * could see it there would be asserting the defect.
 */
function listRegionNode(): HTMLElement {
    const node = document.querySelector(`[data-testid="${TRIAGE_SHELL_LIST_REGION_TEST_ID_V1}"]`);
    if (node === null) throw new Error('The Triage shell rendered no list region.');
    return node as HTMLElement;
}

function fillRegionNode(): HTMLElement {
    const node = document.querySelector(`[data-testid="${TRIAGE_SHELL_FILL_TEST_ID_V1}"]`);
    if (node === null) throw new Error('The Triage shell rendered no fill region.');
    return node as HTMLElement;
}

/** The virtualized collection's own host element — the thing a remount replaces. */
function collectionNode(): Element | null {
    return document.querySelector('[role="listbox"]');
}

async function closeTheDetail(shell: PluginUiTestkit): Promise<void> {
    await act(async () => {
        await shell.press(await shell.getByRole('button', { name: 'Close' }));
    });
    await act(async () => { await Promise.resolve(); });
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the Triage shell composition under its own measurement', () => {
    it('gives the native virtualizer a bounded flex viewport through the shell fill chain', async () => {
        await mountShell();

        const fill = fillRegionNode();
        const listRegion = listRegionNode();
        const collectionBox = collectionNode()?.parentElement as HTMLElement | undefined;
        expect(collectionBox, 'the virtualized collection must have its shared List box').toBeDefined();

        // These are the shrink boundaries that make the SectionList own a real
        // viewport instead of growing the page to its content height.
        expect(fill.style.flexGrow).toBe('1');
        expect(fill.style.minHeight).toBe('0px');
        expect(fill.style.overflowX).toBe('hidden');
        expect(fill.style.overflowY).toBe('hidden');
        expect(listRegion.style.flexGrow).toBe('1');
        expect(listRegion.style.minHeight).toBe('0px');
        expect(listRegion.style.overflowX).toBe('hidden');
        expect(listRegion.style.overflowY).toBe('hidden');
        expect(collectionBox?.style.flexGrow).toBe('1');
        expect(collectionBox?.style.minHeight).toBe('0px');
        expect(collectionBox?.style.overflowX).toBe('hidden');
        expect(collectionBox?.style.overflowY).toBe('hidden');
    });

    it('keeps the list beside the detail once the measured region can honour both pane minima', async () => {
        const shell = await mountShell();
        await measureFillRegion(SPLIT_WIDTH);

        await openTheRow(shell);

        // The selected entry is open — Close belongs to the detail header and
        // to nothing else on this page.
        await expect(shell.getByRole('button', { name: 'Close' })).resolves.toBeDefined();
        // ...and the list it was opened FROM is still on screen and still
        // selectable. Replacing the page at this width loses the reader's scroll
        // position and their place in the queue they were working through.
        await expect(shell.getByRole('option', { name: ENTRY_TITLE })).resolves.toBeDefined();
    });

    it('stacks — replacing the list — when the measured region cannot honour both minima', async () => {
        const shell = await mountShell();
        await measureFillRegion(STACK_WIDTH);

        await openTheRow(shell);

        await expect(shell.getByRole('button', { name: 'Close' })).resolves.toBeDefined();
        // §2.1's stacked rule: the selection replaces the list rather than
        // appearing beside it, and the list is not duplicated underneath.
        await expect(shell.queryByRole('option', { name: ENTRY_TITLE })).resolves.toBeUndefined();
    });

    it('stacks until it has actually been measured, rather than guessing a desktop width', async () => {
        // No measurement at all: the platform has not laid the region out yet.
        // Splitting here would be the device guess §2.1 forbids, and on a phone
        // it would clip both panes on the very first frame.
        const shell = await mountShell();

        await openTheRow(shell);

        await expect(shell.getByRole('button', { name: 'Close' })).resolves.toBeDefined();
        await expect(shell.queryByRole('option', { name: ENTRY_TITLE })).resolves.toBeUndefined();
    });

    it('crosses back to stacked on accessibility text alone, at one unchanged measured width', async () => {
        const shell = await mountShell(2);
        // The SAME width that splits at ordinary text. The panes no longer fit
        // the reader's own type size, so the composition — not the type — gives.
        await measureFillRegion(SPLIT_WIDTH);

        await openTheRow(shell);

        await expect(shell.getByRole('button', { name: 'Close' })).resolves.toBeDefined();
        await expect(shell.queryByRole('option', { name: ENTRY_TITLE })).resolves.toBeUndefined();
    });

    it('keeps the stacked list MOUNTED rather than tearing it out of the tree', async () => {
        const shell = await mountShell();
        await measureFillRegion(STACK_WIDTH);
        const collection = collectionNode();
        expect(collection, 'the shell must mount a virtualized collection').not.toBeNull();

        await openTheRow(shell);

        // §2.1's stacked rule is about the SCREEN: the entry owns the region and
        // the list is not duplicated underneath it. It is not a rule about the
        // React tree, and answering it by unmounting throws away the very state
        // the split arm keeps — the collection instance, its virtualizer window,
        // the row the reader's keyboard was on, their place in the queue. On a
        // phone, the only composition that ever stacks, that is every reader.
        expect(listRegionNode().style.display).toBe('none');
        expect(collectionNode()).toBe(collection);
        // Hidden is hidden: no announcement, no tab stop, nothing to press.
        await expect(shell.queryByRole('option', { name: ENTRY_TITLE })).resolves.toBeUndefined();

        await closeTheDetail(shell);

        // The reader comes back to the list they left, not a rebuilt one.
        expect(collectionNode()).toBe(collection);
        expect(listRegionNode().style.display).toBe('');
        await expect(shell.getByRole('option', { name: ENTRY_TITLE })).resolves.toBeDefined();
    });

    it('brings the list back beside an already-open entry when the region grows', async () => {
        const shell = await mountShell();
        await measureFillRegion(STACK_WIDTH);
        await openTheRow(shell);
        // Stacked: the entry has the whole region.
        await expect(shell.queryByRole('option', { name: ENTRY_TITLE })).resolves.toBeUndefined();

        // The window is widened — a resize, a rotation, or the reader closing a
        // sidebar — with the entry still open.
        await measureFillRegion(SPLIT_WIDTH);

        // §2.1: the composition crosses without the reader losing what they had
        // open. Recomputing the composition must not clear the selection, and
        // the list has to come back beside it rather than instead of it.
        await expect(shell.getByRole('button', { name: 'Close' })).resolves.toBeDefined();
        await expect(shell.getByRole('option', { name: ENTRY_TITLE })).resolves.toBeDefined();
    });
});
