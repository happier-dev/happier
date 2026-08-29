// @vitest-environment jsdom
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageEntryRefV1,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import { TriageListEntriesInputV1Schema } from '../actions/listEntriesProtocol.js';
import { listTriagePinnedEntries, setTriageEntryPinned } from '../actions/userMarks.js';
import {
    TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
    TriageListPinnedEntriesInputV1Schema,
    TriageSetEntryPinnedInputV1Schema,
} from '../actions/userMarksProtocol.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE, CORPUS_USER_MARKS_INDEX_ID } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { refreshTriageListWindow } from './window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';
import { renderSurface as renderShellSurface } from './surface.js';

/**
 * Pin and Unpin, driven through the real mounted vertical.
 *
 * Nothing between the reader and the Collection is stood in for: the surface
 * invokes the published Actions through the SDK's own mounted Host API client,
 * which reach the real Action owners, which delegate to the real `setPinned`
 * writer and the real marks query over a real Account Collection with real
 * identity derivation. Only the Collection store, the host's admitted-source
 * view and the fixture source itself are replaced.
 *
 * The point of these cases is that a pin outlives the thing that rendered it. A
 * projection is mount-scoped and disposable; a pin is Account state a user
 * placed deliberately and cannot recover from any provider if we drop it.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';

function entryRef(entryId: string): TriageEntryRefV1 {
    return { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId };
}

function configuredInstance(): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source: SOURCE, sourceInstanceId: INSTANCE },
        binding: {
            purpose: 'triage-source',
            account: { service: { pluginId: SOURCE.pluginId, localId: 'accounts' }, accountId: 'account-1' },
        },
        localInstanceKey: 'example/repository',
        configuration: { v: 1, token: 'routing-token' },
        locator: { v: 1, displayLabel: 'example/repository' },
    });
}

function instanceRow(): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: `a${'0'.repeat(42)}`,
        sourceQualifiedId: `${SOURCE.pluginId}/${SOURCE.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1,
        configured: configuredInstance(),
    };
}

function createHarness() {
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow()));

    const scanHandle = { role: 'scan' };
    const admitted = [{
        contributor: {
            pluginId: SOURCE.pluginId,
            contributionId: SOURCE.localId,
            immutableGenerationId: 'generation-1',
        },
        protocol: {
            id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
            version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
        },
        descriptor: {
            v: 1,
            purpose: 'triage-source',
            displayName: 'Example forge',
            kinds: [{ id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' }],
        },
        operations: { listInstances: {}, scan: scanHandle, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1];

    const state = { marksUnreachable: false, includeEntry: true };

    const executeScan: TriageAdmittedOperationExecutorV1 = async () => ({
        kind: 'complete',
        observations: state.includeEntry ? [{
            kind: 'present',
            localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
            locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: 'Replace the duplicated normalizer' }),
            viewer: testkitViewer(),
            sourceUpdatedAtMs: 3_000,
        }] : [],
        evidence: { kind: 'walkFinished' },
    } satisfies TriageScanResultV1);

    async function executeAction(request: Readonly<{ action: unknown; input: unknown }>) {
        const action = String(request.action);
        const marksAction = action === TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1
            || action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1;
        if (marksAction && state.marksUnreachable) {
            throw new Error('The account store is unreachable.');
        }
        if (action === TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1) {
            return await setTriageEntryPinned(
                TriageSetEntryPinnedInputV1Schema.parse(request.input),
                { collections, nowMs: () => 2_000 },
            );
        }
        if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
            return await listTriagePinnedEntries(
                TriageListPinnedEntriesInputV1Schema.parse(request.input),
                { collections, nowMs: () => 2_000 },
            );
        }
        return await listTriageEntries(TriageListEntriesInputV1Schema.parse(request.input), {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => admitted,
            executeScan,
            nowMs: () => Date.now(),
        });
    }

    return {
        collections,
        control,
        executeAction,
        state,
        ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
    };
}

type Harness = ReturnType<typeof createHarness>;

async function seedPin(harness: Harness, ref: TriageEntryRefV1, display: Readonly<{
    title: string;
    scopeLabel: string;
}>): Promise<void> {
    // Seeded through the real Action, so the pin under test is addressed by the
    // same derivation a press would use rather than by a hand-written row id.
    await harness.executeAction({
        action: TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
        input: { v: 1, pinned: true, entryRef: ref, displayAtMark: display },
    });
}

const mounted: PluginUiTestkit[] = [];

async function mountShell(harness: Harness): Promise<PluginUiTestkit> {
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId: 'triage-list',
                generation: 'triage-list-mount',
            },
            surface: renderShellSurface,
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({
                ephemeralSharedScope: harness.ephemeralSharedScope,
            }),
            handlers: {
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action, input }) => await harness.executeAction({ action, input }),
            },
        });
    });
    mounted.push(fixture);
    await act(async () => {
        await refreshTriageListWindow('view', fixture.context.hostApi, harness.ephemeralSharedScope);
    });
    return fixture;
}

async function liveMarkCount(harness: Harness): Promise<number> {
    const page = await harness.collections.userMarks.query({
        index: CORPUS_USER_MARKS_INDEX_ID.byPinned,
        prefix: [true],
        order: 'asc',
    });
    return page.rows.length;
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted Pin/Unpin affordance', () => {
    it('lists a pinned entry once, under Pinned rather than its lane', async () => {
        const harness = createHarness();
        await seedPin(harness, entryRef('17'), {
            title: 'Replace the duplicated normalizer',
            scopeLabel: 'example/repository',
        });
        const shell = await mountShell(harness);

        await expect(shell.getByText('Pinned')).resolves.toEqual({ content: 'Pinned' });
        // One entry is one row. The only walked entry was lifted into Pinned, so
        // the Open lane has nothing left and its header is gone with it — a
        // pinned entry that also appeared under Open would read as two pins for
        // one thing, and would collide on the List's own row key.
        //
        // The query is the grid section header's own row role rather than a sweep for
        // the word: the filter rail's State facet offers an **Open** option
        // (`core/SURFACE.md` §6), so a text sweep now proves nothing about
        // sections at all.
        await expect(shell.queryByRole('row', { name: 'Open' })).resolves.toBeUndefined();
        await expect(shell.getByRole('row', { name: 'Pinned' })).resolves.toBeDefined();
        // A materialized pinned row offers its one Pin/Unpin operation through
        // the shared secondary-action owner, not a nested per-row control.
        expect(await shell.getAllByRole('button', {
            name: 'More actions for Replace the duplicated normalizer',
        })).toHaveLength(1);
    });

    it('keeps a pinned entry this mount never materialized, and unpins it from its own bytes', async () => {
        const harness = createHarness();
        await seedPin(harness, entryRef('404'), {
            title: 'A change this device has not read',
            scopeLabel: 'example/other',
        });
        const shell = await mountShell(harness);

        // The pass returned only entry 17, so this pin has no projection at all.
        // Dropping it would strand durable intent the reader could not remove.
        await expect(shell.getByText('A change this device has not read'))
            .resolves.toEqual({ content: 'A change this device has not read' });
        await expect(shell.getByText('Not yet synchronized'))
            .resolves.toEqual({ content: 'Not yet synchronized' });

        await act(async () => {
            await shell.press(await shell.getByRole('button', {
                name: 'Unpin A change this device has not read',
            }));
        });

        // Settled at the writer, not optimistically in this mount.
        expect(await liveMarkCount(harness)).toBe(0);
        await expect(shell.queryByText('A change this device has not read')).resolves.toBeUndefined();
        await expect(shell.getByText('Unpinned')).resolves.toEqual({ content: 'Unpinned' });
    });

    it('renders one pin for an entry the reader pinned from another device', async () => {
        const harness = createHarness();
        // Two devices pinned the same entry with different renderings. If the
        // reference were not the mark's whole address, this would be two rows.
        await seedPin(harness, entryRef('17'), {
            title: 'Replace the duplicated normalizer',
            scopeLabel: 'example/repository',
        });
        await seedPin(harness, { ...entryRef('17') }, {
            title: 'Replace the duplicated normalizer (updated)',
            scopeLabel: 'example/repository',
        });

        const shell = await mountShell(harness);

        expect(await liveMarkCount(harness)).toBe(1);
        expect(await shell.getAllByRole('button', {
            name: 'More actions for Replace the duplicated normalizer',
        })).toHaveLength(1);
        // The first device's rendering is the one the mark kept, and the pinned
        // section shows exactly one row for it.
        await expect(shell.queryByText('Replace the duplicated normalizer (updated)'))
            .resolves.toBeUndefined();
    });

    it('pins and unpins the selected materialized entry from its visible detail header', async () => {
        const harness = createHarness();
        const shell = await mountShell(harness);

        await act(async () => {
            await shell.press(await shell.getByRole('button', {
                name: 'Replace the duplicated normalizer',
            }));
        });

        await act(async () => {
            await shell.press(await shell.getByRole('button', {
                name: 'Pin Replace the duplicated normalizer',
            }));
        });
        expect(await liveMarkCount(harness)).toBe(1);

        await act(async () => {
            await shell.press(await shell.getByRole('button', {
                name: 'Unpin Replace the duplicated normalizer',
            }));
        });
        expect(await liveMarkCount(harness)).toBe(0);
    });

    it('keeps direct Pin available when the selected entry leaves the current window', async () => {
        const harness = createHarness();
        const shell = await mountShell(harness);
        await act(async () => {
            await shell.press(await shell.getByRole('button', {
                name: 'Replace the duplicated normalizer',
            }));
        });

        harness.state.includeEntry = false;
        await act(async () => {
            await refreshTriageListWindow('manual', shell.context.hostApi, harness.ephemeralSharedScope);
        });
        await expect(shell.getByText('This entry is no longer in the list')).resolves.toBeDefined();

        await act(async () => {
            await shell.press(await shell.getByRole('button', {
                name: 'Pin Replace the duplicated normalizer',
            }));
        });
        expect(await liveMarkCount(harness)).toBe(1);
    });

    it('says pins are unavailable rather than showing a control that does nothing', async () => {
        const harness = createHarness();
        harness.state.marksUnreachable = true;
        const shell = await mountShell(harness);

        // A Pin the surface accepted but never wrote would be intent the reader
        // believes is safe and that no provider can hand back, so the honest
        // answer is that it cannot be changed right now. The source rows are
        // untouched: an unreachable account store is not a failed scan.
        await expect(shell.getByText('Pins are unavailable'))
            .resolves.toEqual({ content: 'Pins are unavailable' });
        await expect(shell.getByText('Replace the duplicated normalizer'))
            .resolves.toEqual({ content: 'Replace the duplicated normalizer' });
        await expect(shell.getByText('Up to date')).resolves.toEqual({ content: 'Up to date' });
    });

    it('says pins are unavailable when the WRITE is refused, not just the read', async () => {
        // The read path was already covered; the write path was not, and it is the
        // branch that now carries traffic: `setPinned` stopped reporting every
        // Collections failure as `conflict`, so a store that is unreachable at
        // press time reaches the unavailable branch instead of telling the reader
        // to retry a write retrying cannot fix.
        const harness = createHarness();
        // An UNWALKED pin, because that is the row that carries the inline Unpin
        // (a walked row hosts its control in the detail panel instead).
        await seedPin(harness, entryRef('404'), {
            title: 'A change this device has not read',
            scopeLabel: 'example/other',
        });
        const shell = await mountShell(harness);

        // The initial read SUCCEEDED — that is what makes this the write path.
        await expect(shell.queryByText('Pins are unavailable')).resolves.toBeUndefined();

        harness.state.marksUnreachable = true;
        await act(async () => {
            await shell.press(await shell.getByRole('button', {
                name: 'Unpin A change this device has not read',
            }));
        });

        await expect(shell.getByText('Pins are unavailable'))
            .resolves.toEqual({ content: 'Pins are unavailable' });
        // HONEST LIMIT OF THIS ASSERTION: it proves the write rejection REACHES the
        // unavailable branch, which was previously untested. It does NOT prove the
        // reason is translated — this branch used to render a raw English constant
        // whose text is identical to the English catalogue entry, so the assertion
        // passes either way. This harness exposes no locale knob; proving the
        // catalogue lookup would need one. Do not read this test as i18n coverage.
    });

});
