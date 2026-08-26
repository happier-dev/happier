// @vitest-environment jsdom
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit, PluginUiTestkitOpenSurfaceInput } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from '@happier-dev/triage-protocol/v1';

import {
    TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    TriageListEntriesResultV1Schema,
    type TriageListEntriesResultV1,
} from '../../actions/listEntriesProtocol.js';
import { TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1 } from '../../actions/savedViewsProtocol.js';
import { TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1 } from '../../actions/userMarksProtocol.js';
import { renderSurface as renderShellSurface } from '../surface.js';
import { refreshTriageListWindow } from '../window/mountedWindow.js';

/**
 * A reader who has nothing configured, and whether this page can do anything
 * about it.
 *
 * The screen always SAID "connect a source in Settings". It could not take
 * anyone there, so a reader who had installed a source was told to go and find
 * its page themselves — while the source was shipping exactly that page all
 * along. What was missing was the descriptor field that names it.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_PLUGIN_ID = 'happier.example-forge';

function descriptor(settingsPageId: string | undefined): JsonValue {
    return {
        v: 1,
        purpose: 'example-forge',
        displayName: 'Example Forge',
        kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
        ...(settingsPageId === undefined ? {} : { settingsPageId }),
    } as unknown as JsonValue;
}

function targetedContributions(settingsPageId: string | undefined) {
    return {
        target: { pluginId: 'happier.triage', immutableGenerationId: 'target-generation-a' },
        points: [{
            pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
            protocols: [{
                protocol: {
                    id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
                    version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
                },
                contributions: [{
                    contributor: {
                        pluginId: SOURCE_PLUGIN_ID,
                        contributionId: 'example-forge',
                        immutableGenerationId: 'contributor-generation-a',
                    },
                    protocol: {
                        id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
                        version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
                    },
                    descriptor: descriptor(settingsPageId),
                    operations: [],
                    surfaces: [],
                }],
            }],
        }],
    };
}

/** A settled pass over an account with no configured connection at all. */
function emptyListResult(): TriageListEntriesResultV1 {
    return TriageListEntriesResultV1Schema.parse({
        v: 1,
        configuredSources: [],
        configuredSourcesStatus: 'complete',
        window: {
            v: 1,
            rows: [],
            lanes: [],
            coverage: 'complete',
            assembledAtMs: 1_760_000_100_000,
        },
    });
}

async function executeAction(action: string): Promise<JsonValue> {
    if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) {
        return emptyListResult() as unknown as JsonValue;
    }
    if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) return { v: 1, pins: [] };
    if (action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) {
        return { v: 1, availability: 'absent', views: [], selectedViewId: null, revision: 'revision-1' };
    }
    throw new Error(`unexpected action ${action}`);
}

const mounted: PluginUiTestkit[] = [];
let opened: PluginUiTestkitOpenSurfaceInput[] = [];

async function mountShell(options: Readonly<{
    settingsPageId?: string;
    /** Omitted entirely to model a mount the host did not negotiate it for. */
    canOpenSurface?: boolean;
    openRefuses?: boolean;
}> = {}): Promise<PluginUiTestkit> {
    opened = [];
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
                targetedContributions: targetedContributions(
                    options.settingsPageId,
                ) as unknown as ReturnType<typeof createSurfaceContextFixture>['targetedContributions'],
            }),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: {
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action }) => await executeAction(action),
                replacePageLocation: ({ subPath }) => subPath,
                ...(options.canOpenSurface === false ? {} : {
                    openSurface: (input: PluginUiTestkitOpenSurfaceInput) => {
                        opened.push(input);
                        if (options.openRefuses === true) throw new Error('destination unavailable');
                    },
                }),
            },
        });
    });
    mounted.push(fixture);
    await act(async () => { await refreshTriageListWindow('view', fixture.context.hostApi); });
    return fixture;
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the unconfigured PRs & Issues screen', () => {
    it('takes the reader to the page the source named', async () => {
        const shell = await mountShell({ settingsPageId: 'triage-sources' });

        await expect(shell.getByText('No sources are configured')).resolves.toBeDefined();
        const configure = await shell.getByRole('button', { name: 'Configure Example Forge' });

        await act(async () => { await shell.press(configure); });
        await act(async () => { await Promise.resolve(); });

        // The source's OWN page, qualified with the contributor the host
        // admitted. A Settings destination carries no launch input and no
        // sub-path, and the host's resolver refuses both.
        expect(opened).toHaveLength(1);
        expect(opened[0]?.view).toEqual({ pluginId: SOURCE_PLUGIN_ID, localId: 'triage-sources' });
        expect(opened[0]?.input).toBeUndefined();
        expect(opened[0]?.subPath).toBeUndefined();
    });

    it('renders no control for a source that named no page', async () => {
        // Rendering one anyway is the failure this replaced, not a smaller
        // version of it: the press would reach no destination at all.
        const shell = await mountShell({});

        await expect(shell.getByText('No sources are configured')).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Configure Example Forge' }))
            .resolves.toBeUndefined();
    });

    it('renders no control on a mount that cannot navigate', async () => {
        const shell = await mountShell({ settingsPageId: 'triage-sources', canOpenSurface: false });

        await expect(shell.getByText('No sources are configured')).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Configure Example Forge' }))
            .resolves.toBeUndefined();
    });

    it('says so when the host refuses the destination', async () => {
        const shell = await mountShell({ settingsPageId: 'triage-sources', openRefuses: true });

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Configure Example Forge' }));
        });
        await act(async () => { await Promise.resolve(); });

        // A press that silently does nothing is the same failure the Refresh
        // control refuses to be.
        await expect(shell.getByText('Example Forge settings could not be opened'))
            .resolves.toBeDefined();
    });
});
