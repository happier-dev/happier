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

/**
 * `core/SURFACE.md` §6's two lens compositions, decided by the SAME measurement
 * §2.1 already publishes.
 *
 * Wide exposes the five facet controls individually. Compact folds exactly
 * those five into one labelled **Filters** trigger presented by the public
 * `Popover` — so focus, dismissal, focus return, Escape and Android Back stay
 * with the host — and keeps every selected constraint visible and removable as
 * a chip outside it. **Views** and **Order** stay separately labelled in both.
 *
 * The measurement is supplied the way `shell/splitComposition.rnw.test.tsx`
 * supplies it: jsdom ships no `ResizeObserver`, so React Native Web's shared
 * observer never fires, but the author's callback is installed on the real host
 * node under `__reactLayoutHandler`. Everything from there to the rendered
 * composition is the production path.
 *
 * The overlay's CONTENT is deliberately not asserted here. `Popover` renders it
 * only through the private presentation host, which this semantic adapter does
 * not publish; the host owns that behaviour and
 * `plugin-ui/src/components/Overlay.rnw.test.tsx` plus
 * `apps/ui/.../pluginUiPrivatePresentationHost.modal.dom.test.tsx` own its
 * proof. What is asserted here is Triage's whole half: which composition the
 * measurement selects, and that nothing a reader can act on is lost by it.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const ENTRY_TITLE = 'Replace the duplicated normalizer';

/**
 * The fixture theme's own pane minima sum to ~599 at `textScale: 1`, so 900
 * carries the wide composition and 420 cannot. Both are the measured widths
 * `shell/layout.ts` resolves, never a device guess.
 */
const WIDE_WIDTH = 900;
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
        return { v: 1, pins: [], more: false };
    }
    if (action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) {
        return { v: 1, availability: 'absent', views: [], selectedViewId: null };
    }
    if (action === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) {
        return { kind: 'unavailable' };
    }
    throw new Error(`unexpected action ${action}`);
}

const mounted: PluginUiTestkit[] = [];

async function mountShell(): Promise<PluginUiTestkit> {
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
    await act(async () => { await refreshTriageListWindow('view'); });
    return fixture;
}

type LayoutHandler = (event: Readonly<{
    nativeEvent: Readonly<{ layout: Readonly<{ x: number; y: number; width: number; height: number }> }>;
}>) => void;

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

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the PRs & Issues lens under the shell’s own measurement', () => {
    it('exposes the facet controls individually once the measured region can carry them', async () => {
        const shell = await mountShell();
        await measureFillRegion(WIDE_WIDTH);

        // A closed-vocabulary facet option and a discovered Source option: both
        // exist only while their own control is on the page.
        await expect(shell.getByRole('checkbox', { name: 'Open' })).resolves.toBeDefined();
        await expect(shell.getByRole('checkbox', { name: 'Example account' })).resolves.toBeDefined();
        // ...and nothing is folded away behind a trigger at this width.
        await expect(shell.queryByRole('button', { name: 'Filters' })).resolves.toBeUndefined();
    });

    it('folds the facets into one Filters trigger when the measured region cannot carry them', async () => {
        const shell = await mountShell();
        await measureFillRegion(COMPACT_WIDTH);

        await expect(shell.getByRole('button', { name: 'Filters' })).resolves.toBeDefined();
        await expect(shell.queryByRole('checkbox', { name: 'Open' })).resolves.toBeUndefined();
        await expect(shell.queryByRole('checkbox', { name: 'Example account' })).resolves.toBeUndefined();
    });

    it('keeps Views and Order separately labelled rather than folding them into the trigger', async () => {
        const shell = await mountShell();
        await measureFillRegion(COMPACT_WIDTH);

        // §6: exactly the five facets go behind the trigger. Views names which
        // saved lens this is and Order names the ladder; a reader who has to
        // open a Filters overlay to reorder the list has lost both.
        await expect(shell.getByRole('radio', { name: 'Newest' })).resolves.toBeDefined();
        await expect(shell.getByRole('radio', { name: 'No saved view' })).resolves.toBeDefined();
    });

    it('keeps every selected constraint visible and removable outside the overlay', async () => {
        const shell = await mountShell();
        await measureFillRegion(WIDE_WIDTH);
        const openFacet = await shell.getByRole('checkbox', { name: 'Open' });
        await act(async () => { await shell.press(openFacet); });

        await measureFillRegion(COMPACT_WIDTH);

        // The constraint is still applied and the control that showed it is now
        // behind a trigger, so the chip is the only thing naming it. Without it
        // the reader is looking at a narrowed list with no visible cause.
        const chip = await shell.getByRole('button', { name: 'Remove filter State: Open' });
        await act(async () => { await shell.press(chip); });

        await expect(shell.queryByRole('button', { name: 'Remove filter State: Open' }))
            .resolves.toBeUndefined();
        // The chip removed the constraint itself rather than only its own label.
        await measureFillRegion(WIDE_WIDTH);
        await expect(shell.getByRole('checkbox', {
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
        expect(buttons.filter((button) => (button.name ?? '').startsWith('Remove filter'))).toEqual([]);
    });

    it('keeps the facets exposed until a measurement actually says they do not fit', async () => {
        // No measurement at all. Taking away controls the reader can reach is
        // the destructive direction, so it waits for positive evidence: the
        // wide arm wraps in render order and cannot overflow the page, while a
        // trigger folded away on a guess would hide five controls on a width
        // nobody reported.
        const shell = await mountShell();

        await expect(shell.getByRole('checkbox', { name: 'Open' })).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Filters' })).resolves.toBeUndefined();
    });
});
