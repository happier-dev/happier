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
import { TRIAGE_SHELL_FILL_TEST_ID_V1 } from '../shell/root.js';
import { refreshTriageListWindow } from '../window/mountedWindow.js';
import { filterFacetOption, openToolbarMenu, toolbarMenuItem } from '../shell/toolbarMenus.test-support.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { CORPUS_DEFAULT_SMART_POLICY_V1 } from '../../corpus/query/smartPolicy.js';
import { readTriageFilterDoneLabelV1 } from './rail.js';
import type { TriageListShellStateV1 } from '../shell/windowState.js';

/**
 * `core/SURFACE.md` §6's two lens compositions, decided by the SAME measurement
 * §2.1 already publishes.
 *
 * Wide exposes the five facet controls individually. Compact folds exactly
 * those five into one labelled **Filters** trigger presented by the public
 * `Popover` — so focus, dismissal, focus return, Escape and Android Back stay
 * with the host — and keeps every selected constraint visible and removable as
 * a chip outside it. **Views** stays in the toolbar in both; on a phone **Order**
 * joins the facets in that Filters form (the shared Collection toolbar).
 *
 * The measurement is supplied the way `shell/splitComposition.rnw.test.tsx`
 * supplies it: jsdom ships no `ResizeObserver`, so React Native Web's shared
 * observer never fires, but the author's callback is installed on the real host
 * node under `__reactLayoutHandler`. Everything from there to the rendered
 * composition is the production path.
 *
 * Every facet, Views and Order is a shared menu picker in the toolbar. The
 * semantic adapter is mounted with `overlays`, so an open menu's rows are
 * reachable by role the way a reader reaches them: press the trigger, then the
 * row. Positioning, dismissal and focus return stay the host's and are proved
 * in `plugin-ui/src/components/Overlay.rnw.test.tsx` and
 * `apps/ui/.../pluginUiPrivatePresentationHost.*.test.tsx`.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const ENTRY_TITLE = 'Replace the duplicated normalizer';

/**
 * 1200 clears both the fixture's pane minima and the shared Collection toolbar's
 * fold threshold; 420 cannot carry either wide composition. These are measured
 * widths supplied to the real Collection, never a device guess.
 */
const WIDE_WIDTH = 1200;
const COMPACT_WIDTH = 420;

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
                entryRef: {
                    source: SOURCE,
                    kindId: 'pull-request',
                    collisionScope: 'example/repository',
                    entryId: '17',
                },
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

async function executeAction(action: string, result: TriageListEntriesResultV1 = listResult()): Promise<JsonValue> {
    if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) {
        return result as unknown as JsonValue;
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

async function mountShell(result: TriageListEntriesResultV1 = listResult()): Promise<PluginUiTestkit> {
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-174', mountNonce: 'fixture-mount-174' },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: renderShellSurface,
            surfaceContext: createSurfaceContextFixture({
                mount: {
                    kind: 'destination',
                    destination: { pluginId: 'happier.triage', localId: 'triage' },
                    container: 'appPage',
                },
            }),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope, overlays: true }),
            handlers: {
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action }) => await executeAction(action, result),
                replacePageLocation: ({ subPath }) => subPath,
            },
        });
    });
    mounted.push(fixture);
    await act(async () => {
        await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope);
    });
    return fixture;
}

type LayoutHandler = (event: Readonly<{
    nativeEvent: Readonly<{ layout: Readonly<{ x: number; y: number; width: number; height: number }> }>;
}>) => void;

async function measureFillRegion(width: number): Promise<void> {
    const node = document.querySelector(`[data-testid="${TRIAGE_SHELL_FILL_TEST_ID_V1}:stage"]`);
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

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the PRs & Issues lens under the shell’s own measurement', () => {
    it('offers configured source and unit choices before any entries arrive on wide and phone layouts', async () => {
        const original = listResult();
        const result = TriageListEntriesResultV1Schema.parse({ ...original, configuredSources: [
            { ...original.configuredSources[0], displayLabel: 'Work account', scope: {
                unit: { singularLabel: 'Project', pluralLabel: 'projects' },
                projection: { kind: 'page', status: 'complete', selection: { kind: 'selected', unitIds: ['11'] },
                    units: [{ id: '11', label: 'Platform' }] },
            } },
            { ...original.configuredSources[0], sourceInstanceId: '22222222-2222-4222-8222-222222222222',
                displayLabel: 'Personal account', scope: {
                    unit: { singularLabel: 'Project', pluralLabel: 'projects' },
                    projection: { kind: 'page', status: 'complete', selection: { kind: 'all' }, units: [] },
                } },
        ], window: { ...original.window, rows: [], coverage: 'partial' } });
        const shell = await mountShell(result);
        await measureFillRegion(WIDE_WIDTH);
        const work = await filterFacetOption(shell, 'Source', { name: 'Work account' });
        await act(async () => { await shell.press(work); });
        await expect(shell.getByRole('button', { name: 'Remove Source Work account' })).resolves.toBeDefined();
        await measureFillRegion(COMPACT_WIDTH);
        await expect(filterFacetOption(shell, 'Scope', { name: 'Platform — Work account' })).resolves.toBeDefined();
        await expect(filterFacetOption(shell, 'Scope', { name: 'All projects — Personal account' })).resolves.toBeDefined();
        const personal = await filterFacetOption(shell, 'Source', { name: 'Personal account' });
        await act(async () => { await shell.press(personal); });
        await expect(shell.getByRole('button', { name: 'Remove Source Work account' })).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: 'Remove Source Personal account' })).resolves.toBeDefined();
    });

    it.each([
        [{ kind: 'initial' }, 'Show results · Not yet synchronized'],
        [{ kind: 'sourcesUnreachable', message: 'Offline', retryable: true }, 'Show results · Unavailable'],
        [{ kind: 'unavailable', message: 'Offline', retryable: true }, 'Show results · Unavailable'],
    ] satisfies readonly (readonly [TriageListShellStateV1, string])[])('carries %j into the completion label without a zero-result claim', (windowState, expected) => {
        expect(readTriageFilterDoneLabelV1({ text: (_key: string, fallback = '') => fallback, resultCount: 0, windowState }))
            .toBe(expected);
    });

    it.each([0, 1])('keeps partial coverage in the phone completion control with %s matches', async (count) => {
        const result = listResult();
        const shell = await mountShell(TriageListEntriesResultV1Schema.parse({
            ...result,
            window: {
                ...result.window,
                rows: result.window.rows.slice(0, count),
                coverage: 'partial',
                lanes: result.window.lanes.map((lane) => ({ ...lane, exhausted: false })),
            },
        }));
        await measureFillRegion(COMPACT_WIDTH);
        await openToolbarMenu(shell, 'Filters');
        await expect(shell.getByRole('button', { name: count === 0 ? 'Show 0 results so far' : 'Show 1 result so far' })).resolves.toBeDefined();
    });

    it('orders through the table title header and retains the toolbar order for list and board', async () => {
        const shell = await mountShell();
        await measureFillRegion(WIDE_WIDTH);
        await expect(shell.queryByRole('button', { name: 'Order: Newest' })).resolves.toBeUndefined();
        const oldest = await toolbarMenuItem(shell, 'Entry', 'menuitemradio', { name: 'Oldest' });
        await act(async () => { await shell.press(oldest); });
        await expect(toolbarMenuItem(shell, 'Entry', 'menuitemradio', { name: 'Oldest', state: { checked: true } })).resolves.toBeDefined();
        await measureFillRegion(COMPACT_WIDTH);
        // Folded, the order joins ⋯ (the shared Collection toolbar), carrying the current choice.
        const oldestFolded = await toolbarMenuItem(shell, 'More', 'menuitemradio', { name: 'Oldest', state: { checked: true } });
        await act(async () => { await shell.press(oldestFolded); });
        await act(async () => { await shell.press(await shell.getByRole('radio', { name: 'Board' })); });
        await expect(shell.getByRole('radio', { name: 'Board', state: { checked: true } })).resolves.toBeDefined();
        await measureFillRegion(WIDE_WIDTH);
        await expect(toolbarMenuItem(shell, 'Order', 'menuitemradio', { name: 'Oldest', state: { checked: true } })).resolves.toBeDefined();
    });

    it('keeps the facets behind one Filters trigger at every width, beside one search', async () => {
        const shell = await mountShell();
        await measureFillRegion(WIDE_WIDTH);

        // The lab's toolbar is one search with its tokens, not a row of facet pills: the narrowings in force are
        // already said as tokens in the search field, so a pill per facet beside them says each one twice.
        await expect(shell.getByRole('button', { name: 'Filters' })).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'State' })).resolves.toBeUndefined();
        await expect(shell.queryByRole('button', { name: 'Source' })).resolves.toBeUndefined();
        // Every facet value stays one trigger away, inside the one grouped form.
        await expect(filterFacetOption(shell, 'State', { name: 'Open' })).resolves.toBeDefined();
        await expect(filterFacetOption(shell, 'Source', { name: 'Example account' })).resolves.toBeDefined();
    });

    it('folds the facets into one Filters trigger when the measured region cannot carry them', async () => {
        const shell = await mountShell();
        await measureFillRegion(COMPACT_WIDTH);

        await expect(shell.getByRole('button', { name: 'Filters' })).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'State' })).resolves.toBeUndefined();
        await expect(shell.queryByRole('checkbox', { name: 'Open' })).resolves.toBeUndefined();
        await expect(shell.queryByRole('checkbox', { name: 'Example account' })).resolves.toBeUndefined();
    });

    it('on a phone opens the same condition editor from Filters and folds Order into ⋯', async () => {
        const shell = await mountShell();
        await measureFillRegion(COMPACT_WIDTH);

        // Views names which saved lens this is and stays a toolbar control at every width; no separate Order
        // picker is left in the row (lab `merged-list-phone`: one search row, one lens row).
        await expect(toolbarMenuItem(shell, 'Views', 'menuitemradio', { name: 'No saved view' })).resolves.toBeDefined();
        const triggers = await shell.getAllByRole('button');
        expect(triggers.some((trigger) => trigger.name?.startsWith('Order') === true)).toBe(false);
        await expect(toolbarMenuItem(shell, 'More', 'menuitemradio', { name: 'Newest', state: { checked: true } }))
            .resolves.toBeDefined();
        await openToolbarMenu(shell, 'Filters');
        // One filter UI at every width: the sheet holds the condition editor the wide row opens (Add filter, then a
        // facet's values as checkboxes), never a second set of checkbox menu groups, and one way back to the list
        // that says what it shows.
        await expect(shell.queryByRole('menuitemcheckbox', { name: 'Open' })).resolves.toBeUndefined();
        await expect(shell.getByRole('button', { name: 'Add filter' })).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: 'Show 1 result' })).resolves.toBeDefined();
        await expect(filterFacetOption(shell, 'State', { name: 'Open' })).resolves.toBeDefined();
    });

    it('keeps every selected constraint visible and removable as a token in the search field, in both arms', async () => {
        const shell = await mountShell();
        await measureFillRegion(WIDE_WIDTH);
        const openFacet = await filterFacetOption(shell, 'State', { name: 'Open' });
        await act(async () => { await shell.press(openFacet); });

        // The narrowing in force is said in the one place a reader looks for what they are looking at: the
        // search field, as a token. The Filters form stays the way to add one.
        await expect(shell.getByRole('button', { name: 'Remove State Open' })).resolves.toBeDefined();

        await measureFillRegion(COMPACT_WIDTH);

        // The facet controls are now behind a trigger, so the token is the only thing naming the constraint.
        // There is one such place, never a token and a chip saying it twice.
        const token = await shell.getByRole('button', { name: 'Remove State Open' });
        const buttons = await shell.queryAllByRole('button');
        expect(buttons.filter((button) => (button.name ?? '').startsWith('Remove filter'))).toEqual([]);
        await act(async () => { await shell.press(token); });

        await expect(shell.queryByRole('button', { name: 'Remove State Open' }))
            .resolves.toBeUndefined();
        // The token removed the constraint itself rather than only its own label.
        await measureFillRegion(WIDE_WIDTH);
        await expect(filterFacetOption(shell, 'State', {
            name: 'Open',
            state: { checked: false },
        })).resolves.toBeDefined();
    });

    it('offers no chips and no Clear filters while nothing is selected', async () => {
        const shell = await mountShell();
        await measureFillRegion(COMPACT_WIDTH);

        // The compact arm must not manufacture a chip row for an unfiltered
        // lens: a chip that removes nothing is a control that lies, and
        // **Clear filters** clears facets, so it is offered only when there are
        // facets to clear.
        await expect(shell.queryByRole('button', { name: 'Clear filters' })).resolves.toBeUndefined();
        const buttons = await shell.queryAllByRole('button');
        expect(buttons.filter((button) => /^Remove (filter|State|Attention)/u.test(button.name ?? ''))).toEqual([]);
    });
});
