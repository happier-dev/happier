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
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { pressToolbarMenuItem, toolbarMenuItem } from './toolbarMenus.test-support.js';

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

const SECOND_SOURCE_PLUGIN_ID = 'happier.example-tracker';

function contribution(
    pluginId: string,
    contributionId: string,
    displayName: string,
    settingsPageId: string | undefined,
) {
    return {
        contributor: {
            pluginId,
            contributionId,
            occurrenceId: `${contributionId}-occurrence`,
            sourceCustody: { kind: 'development', registeredRootId: `${contributionId}-root` },
        },
        protocol: {
            id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
            version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
        },
        descriptor: { ...(descriptor(settingsPageId) as Record<string, JsonValue>), displayName },
        operations: [],
        surfaces: [],
    };
}

function targetedContributions(settingsPageId: string | undefined, secondSource = false) {
    return {
        target: {
            pluginId: 'happier.triage',
            occurrenceId: 'target-occurrence-a',
            sourceCustody: { kind: 'development', registeredRootId: 'target-root' },
        },
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
                        occurrenceId: 'contributor-occurrence-a',
                        sourceCustody: { kind: 'development', registeredRootId: 'contributor-root' },
                    },
                    protocol: {
                        id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
                        version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
                    },
                    descriptor: descriptor(settingsPageId),
                    operations: [],
                    surfaces: [],
                }, ...(secondSource
                    ? [contribution(SECOND_SOURCE_PLUGIN_ID, 'example-tracker', 'Example Tracker', 'tracker-settings')]
                    : [])],
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

/**
 * The ordinary state this page spends its life in: a pass answered, and a
 * connection is configured. It is the state in which **Configure sources** is
 * gone and **Manage sources** is the only source-administration entry point
 * left (`core/SURFACE.md` §1.4).
 */
function configuredListResult(): TriageListEntriesResultV1 {
    return TriageListEntriesResultV1Schema.parse({
        v: 1,
        configuredSources: [{
            sourceInstanceId: '00000000-0000-4000-8000-000000000002',
            source: { pluginId: SOURCE_PLUGIN_ID, localId: 'example-forge' },
            displayLabel: 'Example account',
            available: true,
        }],
        configuredSourcesStatus: 'complete',
        window: {
            v: 1,
            rows: [],
            lanes: [{
                sourceInstanceId: '00000000-0000-4000-8000-000000000002',
                source: { pluginId: SOURCE_PLUGIN_ID, localId: 'example-forge' },
                health: { kind: 'walkFinished' },
                exhausted: true,
            }],
            coverage: 'complete',
            assembledAtMs: 1_760_000_100_000,
        },
    });
}

const durableReads = { pins: 0, views: 0 };

async function executeAction(
    action: string,
    exposeDurableState: boolean,
    configured: boolean,
    durableUnreachable = false,
): Promise<JsonValue> {
    if (durableUnreachable && action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
        durableReads.pins += 1;
        throw new Error('account unreachable');
    }
    if (durableUnreachable && action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) {
        durableReads.views += 1;
        throw new Error('account unreachable');
    }
    if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) {
        return (configured ? configuredListResult() : emptyListResult()) as unknown as JsonValue;
    }
    if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) return {
        v: 1,
        pins: exposeDurableState ? [{
            entryRef: {
                source: { pluginId: SOURCE_PLUGIN_ID, localId: 'example-forge' },
                kindId: 'pull-request',
                collisionScope: 'example/repository',
                entryId: '17',
            },
            markedAtMs: 2_000,
            displayAtMark: {
                title: 'Pinned after the final source was removed',
                scopeLabel: 'example/repository',
            },
        }] : [],
    };
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
    exposeDurableState?: boolean;
    /** Answer the pass with a configured connection: the ordinary list state. */
    configured?: boolean;
    /** Admit a second source that names its own Settings page. */
    secondSource?: boolean;
    /** The reader's pins and saved views cannot be read: the Account is unreachable. */
    durableUnreachable?: boolean;
}> = {}): Promise<PluginUiTestkit> {
    opened = [];
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-182', mountNonce: 'fixture-mount-182' },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: renderShellSurface,
            surfaceContext: createSurfaceContextFixture({
                mount: {
                    kind: 'destination',
                    destination: { pluginId: 'happier.triage', localId: 'triage' },
                    container: 'appPage',
                },
                targetedContributions: targetedContributions(
                    options.settingsPageId,
                    options.secondSource === true,
                ) as unknown as ReturnType<typeof createSurfaceContextFixture>['targetedContributions'],
            }),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope, overlays: true }),
            handlers: {
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action }) => await executeAction(
                    action,
                    options.exposeDurableState === true,
                    options.configured === true,
                    options.durableUnreachable === true,
                ),
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
    await act(async () => {
        await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope);
    });
    return fixture;
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the unconfigured PRs & Issues screen', () => {
    it('keeps pins, saved views and setup reachable after the final source is removed', async () => {
        const shell = await mountShell({
            settingsPageId: 'triage-sources',
            exposeDurableState: true,
        });

        await expect(shell.getByText('Pinned after the final source was removed'))
            .resolves.toBeDefined();
        await expect(toolbarMenuItem(shell, 'Views', 'menuitem', { name: 'Save as new view' }))
            .resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: 'Connect Example Forge' }))
            .resolves.toBeDefined();
        await expect(toolbarMenuItem(shell, 'More', 'menuitem', { name: 'Manage sources' }))
            .resolves.toBeDefined();
    });

    it('takes the reader to the page the source named', async () => {
        const shell = await mountShell({ settingsPageId: 'triage-sources' });

        await expect(shell.getByText('Connect a source')).resolves.toBeDefined();
        const configure = await shell.getByRole('button', { name: 'Connect Example Forge' });

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

    it('offers every source as its own Connect tile, each opening that source\'s page', async () => {
        // The lab's first run: a reader picks where their work lives from the sources themselves, each a
        // destination one press away, rather than hunting for them behind a menu.
        const shell = await mountShell({ settingsPageId: 'triage-sources', secondSource: true });

        await expect(shell.getByText('Connect a source')).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: 'Connect Example Forge' })).resolves.toBeDefined();
        const tracker = await shell.getByRole('button', { name: 'Connect Example Tracker' });
        await act(async () => { await shell.press(tracker); });
        await act(async () => { await Promise.resolve(); });

        expect(opened).toHaveLength(1);
        expect(opened[0]?.view).toEqual({ pluginId: SECOND_SOURCE_PLUGIN_ID, localId: 'tracker-settings' });
    });

    it('says an unreachable Account once, calmly, with one Retry for everything it blocks', async () => {
        // Pins and saved views are both Account state. Two notices saying the
        // same cause twice — one of them a heavy card — became one sentence.
        durableReads.pins = 0;
        durableReads.views = 0;
        const shell = await mountShell({ settingsPageId: 'triage-sources', durableUnreachable: true });

        await expect(shell.getByText(
            'Happier cannot reach your account right now, so pins and saved views cannot be changed.',
        )).resolves.toBeDefined();
        await expect(shell.queryByText('Pins are unavailable')).resolves.toBeUndefined();
        const retries = (await shell.getAllByRole('button')).filter((button) => button.name === 'Retry');
        expect(retries).toHaveLength(1);

        const pinsBefore = durableReads.pins;
        const viewsBefore = durableReads.views;
        await act(async () => { await shell.press(retries[0]!); });
        await act(async () => { await Promise.resolve(); });
        expect(durableReads.pins).toBeGreaterThan(pinsBefore);
        expect(durableReads.views).toBeGreaterThan(viewsBefore);
    });

    it('shows no search box while there is nothing to search', async () => {
        const shell = await mountShell({ settingsPageId: 'triage-sources' });
        await expect(shell.getByText('Connect a source')).resolves.toBeDefined();
        await expect(shell.queryByRole('textbox', { name: 'Search PRs & Issues' })).resolves.toBeUndefined();

        const configured = await mountShell({ settingsPageId: 'triage-sources', configured: true });
        await expect(configured.getByRole('textbox', { name: 'Search PRs & Issues' })).resolves.toBeDefined();
    });

    it('renders no control for a source that named no page', async () => {
        // Rendering one anyway is the failure this replaced, not a smaller
        // version of it: the press would reach no destination at all.
        const shell = await mountShell({});

        await expect(shell.getByText('No sources are configured')).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Connect Example Forge' }))
            .resolves.toBeUndefined();
    });

    it('renders no control on a mount that cannot navigate', async () => {
        const shell = await mountShell({ settingsPageId: 'triage-sources', canOpenSurface: false });

        await expect(shell.getByText('No sources are configured')).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Connect Example Forge' }))
            .resolves.toBeUndefined();
    });

    it('says so when the host refuses the destination', async () => {
        const shell = await mountShell({ settingsPageId: 'triage-sources', openRefuses: true });

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Connect Example Forge' }));
        });
        await act(async () => { await Promise.resolve(); });

        // A press that silently does nothing is the same failure the Refresh
        // control refuses to be.
        await expect(shell.getByText('Example Forge settings could not be opened'))
            .resolves.toBeDefined();
    });
});

/**
 * The other half of `core/SURFACE.md` §1.4.
 *
 * **Configure sources** is the compact action of the screen with nothing usable
 * configured; it disappears the moment a connection exists. From then on
 * **Manage sources** is the ONLY source-administration entry point this page
 * has, and §1.4 routes it through the same generic Plugin Settings destination —
 * so a reader who has configured one connection must be able to add a second,
 * or repair the first, without removing what they already have and returning to
 * the unconfigured screen to get the offer back.
 */
describe('Manage sources on the ordinary list screen', () => {
    it('reaches the source-owned settings page beside the sources it lists', async () => {
        const shell = await mountShell({ settingsPageId: 'triage-sources', configured: true });

        // The unconfigured screen — and its own Configure offer — is gone.
        await expect(shell.queryByText('No sources are configured')).resolves.toBeUndefined();
        await expect(shell.queryByRole('button', { name: 'Configure Example Forge' }))
            .resolves.toBeUndefined();

        await act(async () => {
            await pressToolbarMenuItem(shell, 'More', 'menuitem', 'Manage sources');
        });

        const configure = await shell.getByRole('button', { name: 'Configure Example Forge' });
        await act(async () => { await shell.press(configure); });
        await act(async () => { await Promise.resolve(); });

        // The same admitted destination the unconfigured screen opens, from the
        // one offer owner: no second navigation path and no Triage-owned form.
        expect(opened).toHaveLength(1);
        expect(opened[0]?.view).toEqual({ pluginId: SOURCE_PLUGIN_ID, localId: 'triage-sources' });
        expect(opened[0]?.input).toBeUndefined();
        expect(opened[0]?.subPath).toBeUndefined();
    });

    it('says so when the host refuses the destination it offered', async () => {
        const shell = await mountShell({
            settingsPageId: 'triage-sources',
            configured: true,
            openRefuses: true,
        });

        await act(async () => {
            await pressToolbarMenuItem(shell, 'More', 'menuitem', 'Manage sources');
        });
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Configure Example Forge' }));
        });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.getByText('Example Forge settings could not be opened'))
            .resolves.toBeDefined();
    });

    it('offers no destination for a source that named no page', async () => {
        const shell = await mountShell({ configured: true });

        await act(async () => {
            await pressToolbarMenuItem(shell, 'More', 'menuitem', 'Manage sources');
        });

        await expect(shell.queryByRole('button', { name: 'Configure Example Forge' }))
            .resolves.toBeUndefined();
    });
});
