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
            viewer: testkitViewer(),
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
            rows: listsTheEntry ? [{
                entryRef: ENTRY_REF,
                lane: '1-open',
                sortAtMs: 1_760_000_100_000,
                presence: { kind: 'present', observedAtMs: 1_760_000_100_000 },
                attention: {
                    level: 'required',
                    fromSourceInstanceId: INSTANCE,
                    reasonId: 'review-requested',
                    reasonLabel: 'Your review was requested',
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

async function executeAction(action: string): Promise<JsonValue> {
    if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) {
        return listResult(listsTheEntry) as unknown as JsonValue;
    }
    if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
        return { v: 1, pins: [], more: false };
    }
    if (action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) {
        return { v: 1, availability: 'absent', views: [], selectedViewId: null };
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

async function mountShell(): Promise<PluginUiTestkit> {
    listsTheEntry = true;
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

async function openTheRow(shell: PluginUiTestkit): Promise<void> {
    await act(async () => {
        await shell.press(await shell.getByRole('option', { name: ENTRY_TITLE }));
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
}

/** The next settled pass enumerates nothing, so the selected row is evicted. */
async function evictTheRow(shell: PluginUiTestkit): Promise<void> {
    listsTheEntry = false;
    await act(async () => { await refreshTriageListWindow('manual'); });
    await act(async () => { await Promise.resolve(); });
    void shell;
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the selected entry once the window stops holding it', () => {
    it('keeps naming the entry the reader opened', async () => {
        const shell = await mountShell();
        await openTheRow(shell);
        await expect(shell.getByText(ENTRY_TITLE)).resolves.toBeDefined();

        await evictTheRow(shell);

        // The cause is still stated — it always was.
        await expect(shell.getByText('This entry is no longer in the list')).resolves.toBeDefined();
        // And so is the entry it is about. Without this the reader is holding a
        // sentence with no subject.
        await expect(shell.getByText(ENTRY_TITLE)).resolves.toBeDefined();
    });

    it('keeps the facts the aggregate had, and says they are no longer current', async () => {
        const shell = await mountShell();
        await openTheRow(shell);

        await evictTheRow(shell);

        // §2.2's own facts, from the last row the window published for this
        // selection: why it was asking for the reader, its state, its scope and
        // the connection it was read through.
        await expect(shell.getByText('Your review was requested')).resolves.toBeDefined();
        await expect(shell.getByText('Open')).resolves.toBeDefined();
        await expect(shell.getByText('example/repository')).resolves.toBeDefined();
        await expect(shell.getByText('Example account')).resolves.toBeDefined();
        // Marked, never presented as current.
        await expect(shell.getByText(
            'These are the last facts this page held for this entry, and they may be out of date.',
        )).resolves.toBeDefined();
    });

    it('drops the retained facts once the reader leaves the entry', async () => {
        const shell = await mountShell();
        await openTheRow(shell);
        await evictTheRow(shell);

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Close' }));
        });

        // Back on the list, which no longer holds the entry at all. A retained
        // header that outlived its selection would be this surface showing a
        // reader an entry nothing selected.
        await expect(shell.queryByText(ENTRY_TITLE)).resolves.toBeUndefined();
        await expect(shell.queryByText('This entry is no longer in the list'))
            .resolves.toBeUndefined();
    });
});
