// @vitest-environment jsdom
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { JsonValue } from '@happier-dev/plugin-sdk';

import {
    TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    TriageListEntriesResultV1Schema,
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
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { parseTriageRouteSubPathV1 } from '../navigation/location.js';

/**
 * An empty list that the reader's own search emptied: the page names the way out beside the sentence
 * (`ui/shell/emptyState.ts` decides which steps), and pressing it changes the page.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const ASSEMBLED_AT_MS = 1_760_000_100_000;
const SEARCH_THAT_MATCHES_NOTHING = 'zzqxnomatch';

type LaneHealth = Readonly<{ kind: 'walkFinished' }> | Readonly<{ kind: 'failed'; failure: Readonly<{ class: 'authentication'; code: string; detail: string }> }>;

function listResult(health: LaneHealth = { kind: 'walkFinished' }): JsonValue {
    return TriageListEntriesResultV1Schema.parse({
        v: 1,
        configuredSources: [{ sourceInstanceId: INSTANCE, configurationRowId: INSTANCE, source: SOURCE, displayLabel: 'Example account', available: true }],
        configuredSourcesStatus: 'complete',
        window: {
            v: 1,
            rows: [{
                entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
                lane: '1-open',
                sortAtMs: ASSEMBLED_AT_MS,
                presence: { kind: 'present', observedAtMs: ASSEMBLED_AT_MS },
                selected: { kind: 'selected', sourceInstanceId: INSTANCE, reason: 'onlyPresent' },
                observation: {
                    sourceInstanceId: INSTANCE,
                    observedAtMs: ASSEMBLED_AT_MS,
                    outcome: {
                        kind: 'present',
                        locator: testkitLocator(),
                        snapshot: testkitSnapshot({ title: 'Replace the duplicated normalizer' }),
                        viewer: testkitViewer(),
                    },
                },
                otherObservations: [],
                observedByCount: 1,
            }],
            lanes: [{ sourceInstanceId: INSTANCE, source: SOURCE, health, exhausted: health.kind === 'walkFinished' }],
            coverage: 'complete',
            assembledAtMs: ASSEMBLED_AT_MS,
        },
    }) as unknown as JsonValue;
}

const mounted: PluginUiTestkit[] = [];

async function mountSearched(health?: LaneHealth): Promise<Readonly<{ shell: PluginUiTestkit; locations: string[] }>> {
    const locations: string[] = [];
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
    let shell!: PluginUiTestkit;
    await act(async () => {
        shell = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-empty', mountNonce: 'fixture-mount-empty' },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: renderShellSurface,
            surfaceContext: createSurfaceContextFixture({
                mount: {
                    kind: 'destination',
                    destination: { pluginId: 'happier.triage', localId: 'triage' },
                    container: 'appPage',
                },
            }),
            subPath: `q,${SEARCH_THAT_MATCHES_NOTHING}`,
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope }),
            handlers: {
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action }) => {
                    if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) return listResult(health);
                    if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) return { v: 1, pins: [] };
                    if (action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) {
                        return { v: 1, availability: 'absent', views: [], revision: 'revision-1' };
                    }
                    throw new Error(`unexpected action ${action}`);
                },
                replacePageLocation: ({ subPath }) => {
                    locations.push(subPath);
                    return subPath;
                },
            },
        });
    });
    mounted.push(shell);
    await act(async () => { await refreshTriageListWindow('view', shell.context.hostApi, ephemeralSharedScope); });
    return { shell, locations };
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('a list the reader’s own search emptied', () => {
    it('offers Clear search beside the sentence, and pressing it brings the entries back', async () => {
        const { shell, locations } = await mountSearched();

        await expect(shell.getByText('Nothing matches your search')).resolves.toBeDefined();
        await expect(shell.queryByText('Replace the duplicated normalizer')).resolves.toBeUndefined();

        const clear = await shell.getByRole('button', { name: 'Clear search' });
        await act(async () => { await shell.press(clear); });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        await expect(shell.queryByText('Nothing matches your search')).resolves.toBeUndefined();
        // LIST-R2 publishes the opening view; Clear search must settle a new route.
        expect(locations.length).toBeGreaterThan(0);
        expect(parseTriageRouteSubPathV1(locations.at(-1)).query).toBe('');
    });

    it('keeps Clear search and names the failing connection when a source could not be read', async () => {
        const { shell } = await mountSearched({ kind: 'failed',
            failure: { class: 'authentication', code: 'credential_reconnect_required', detail: 'Reconnect the account.' } });

        await expect(shell.getByRole('button', { name: 'Clear search' })).resolves.toBeDefined();
        const statusLines = [...document.querySelectorAll('[role="status"]')].map(node => node.textContent ?? '');
        expect(statusLines.some(line => line.includes('could not be read')), JSON.stringify(statusLines)).toBe(true);
    });
});
