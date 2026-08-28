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
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import { TriageListEntriesInputV1Schema } from '../actions/listEntriesProtocol.js';
import { administerTriageSavedView, readTriageSavedViewsForSurface } from '../actions/savedViews.js';
import {
    TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1,
    TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
    TriageAdministerSavedViewInputV1Schema,
    TriageReadSavedViewsInputV1Schema,
} from '../actions/savedViewsProtocol.js';
import { listTriagePinnedEntries } from '../actions/userMarks.js';
import {
    TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    TriageListPinnedEntriesInputV1Schema,
} from '../actions/userMarksProtocol.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { TRIAGE_SAVED_VIEWS_SETTING_ID_V1 } from '../settings/savedViews.js';
import { createTestkitAccountSettings } from '../settings/testkit/accountSettings.test-support.js';
import { refreshTriageListWindow } from './window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';
import { renderSurface as renderShellSurface } from './surface.js';

/**
 * The saved-view lens a reader can actually reach.
 *
 * `core/CORPUS.md` §6.3 makes `triage.savedViews` durable user policy and
 * `core/SURFACE.md` §6.5 makes selecting one an explicit Settings mutation whose
 * re-read projection becomes the reducer lens. These cases fail whenever the
 * saved set has no consumer, when selecting applies only part of a view, when
 * an ordinary lens edit silently rewrites the saved view, or when a route lens
 * touches Settings at all.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const SCOPE = 'example/repository';
const VIEW_ID = '0000000a-0000-4000-8000-00000000000a';
const VIEW_LABEL = 'Needs my review';

function configuredInstance(): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source: SOURCE, sourceInstanceId: INSTANCE },
        binding: {
            purpose: 'triage-source',
            account: { service: { pluginId: SOURCE.pluginId, localId: 'accounts' }, accountId: 'account-1' },
        },
        localInstanceKey: SCOPE,
        configuration: { v: 1, token: 'routing-token' },
        locator: { v: 1, displayLabel: SCOPE },
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

/** One stored view: Done only, Smart order, and the non-default Smart ladder. */
function storedSetting(selectedViewId: string | null) {
    return {
        v: 1,
        views: [{
            viewId: VIEW_ID,
            label: VIEW_LABEL,
            filters: { sources: [], types: [], scopes: [], states: ['done'], attention: [] },
            order: 'smart',
            smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
        }],
        selectedViewId,
    };
}

function createHarness(selectedViewId: string | null, gateViewsRead?: Promise<void>) {
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow()));
    const settings = createTestkitAccountSettings();
    settings.seed(TRIAGE_SAVED_VIEWS_SETTING_ID_V1, storedSetting(selectedViewId));

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
        operations: { listInstances: {}, scan: { role: 'scan' }, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1];

    const executeScan: TriageAdmittedOperationExecutorV1 = async () => ({
        kind: 'complete',
        observations: [{
            kind: 'present',
            localRef: { kindId: 'pull-request', collisionScope: SCOPE, entryId: '17' },
            locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: 'Replace the duplicated normalizer' }),
            viewer: testkitViewer(),
            sourceUpdatedAtMs: 3_000,
        }],
        evidence: { kind: 'walkFinished' },
    } satisfies TriageScanResultV1);

    let minted = 0;
    const viewDeps = {
        settings: settings.settings,
        mintViewId: () => {
            minted += 1;
            return `0000000b-0000-4000-8000-${String(minted).padStart(12, '0')}`;
        },
    };

    async function executeAction(request: Readonly<{ action: unknown; input: unknown }>) {
        const action = String(request.action);
        if (action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) {
            // An Account read is a round trip; a test that always answers it
            // within the same tick cannot see what the reader did while it was
            // in flight.
            if (gateViewsRead !== undefined) await gateViewsRead;
            return await readTriageSavedViewsForSurface(
                TriageReadSavedViewsInputV1Schema.parse(request.input),
                viewDeps,
            );
        }
        if (action === TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1) {
            return await administerTriageSavedView(
                TriageAdministerSavedViewInputV1Schema.parse(request.input),
                viewDeps,
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

    return { executeAction, settings };
}

const mounted: PluginUiTestkit[] = [];

async function mountShell(options: Readonly<{
    subPath?: string;
    selectedViewId?: string | null;
    gateViewsRead?: Promise<void>;
}> = {}): Promise<Readonly<{
    shell: PluginUiTestkit;
    locations: readonly string[];
    settings: ReturnType<typeof createTestkitAccountSettings>;
}>> {
    const harness = createHarness(options.selectedViewId ?? null, options.gateViewsRead);
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
    const locations: string[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId: 'triage',
                generation: 'triage-saved-views-mount',
            },
            surface: renderShellSurface,
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope }),
            ...(options.subPath === undefined ? {} : { subPath: options.subPath }),
            handlers: {
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action, input }) => await harness.executeAction({ action, input }),
                replacePageLocation: ({ subPath: written }) => {
                    locations.push(written);
                    return written;
                },
            },
        });
    });
    mounted.push(fixture);
    await act(async () => {
        await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope);
    });
    // Let the saved-view read settle before anything is asserted about it.
    await act(async () => { await Promise.resolve(); });
    return { shell: fixture, locations, settings: harness.settings };
}

function storedValue(settings: ReturnType<typeof createTestkitAccountSettings>) {
    return settings.read(TRIAGE_SAVED_VIEWS_SETTING_ID_V1) as {
        views: readonly {
            viewId: string;
            label: string;
            filters: { states: readonly string[] };
        }[];
        selectedViewId: string | null;
    };
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the PRs & Issues saved-view lens', () => {
    it('applies a selected view’s facets, order and Smart policy together', async () => {
        const { shell, locations } = await mountShell();

        const option = await shell.getByRole('radio', { name: VIEW_LABEL });
        await act(async () => { await shell.press(option); });

        // All four halves of the stored lens reach the one reducer, so the
        // shareable location names exactly the view the reader chose. A
        // selection that carried only the facets would look right on screen and
        // rank the rows by the wrong ladder.
        const written = locations[locations.length - 1] ?? '';
        expect(written).toContain(`sv,${VIEW_ID}`);
        expect(written).toContain('o,smart');
        expect(written).toContain('sp,activity');
        expect(written).toContain('fst,done');
        await expect(shell.getByRole('checkbox', {
            name: 'Done',
            state: { checked: true },
        })).resolves.toBeTruthy();
    });

    it('marks the lens modified after an edit without writing the saved view', async () => {
        const { shell, settings } = await mountShell();

        const option = await shell.getByRole('radio', { name: VIEW_LABEL });
        await act(async () => { await shell.press(option); });
        const writesAfterSelect = settings.setCallCount();

        const openFacet = await shell.getByRole('checkbox', { name: 'Open' });
        await act(async () => { await shell.press(openFacet); });

        // The reader is looking at something the saved view does not describe,
        // and they are told so — but nothing durable moved. An implementation
        // that saved on every edit would silently overwrite the lens they
        // started from.
        await expect(shell.queryByText('Modified')).resolves.toBeTruthy();
        expect(settings.setCallCount()).toBe(writesAfterSelect);
        expect(storedValue(settings).views[0]?.filters.states).toEqual(['done']);
    });

    it('writes the edited lens into the saved view only on an explicit Update', async () => {
        const { shell, settings } = await mountShell();

        const option = await shell.getByRole('radio', { name: VIEW_LABEL });
        await act(async () => { await shell.press(option); });
        const openFacet = await shell.getByRole('checkbox', { name: 'Open' });
        await act(async () => { await shell.press(openFacet); });

        const update = await shell.getByRole('button', { name: 'Update this view' });
        await act(async () => { await shell.press(update); });
        await act(async () => { await Promise.resolve(); });

        expect([...(storedValue(settings).views[0]?.filters.states ?? [])].sort())
            .toEqual(['done', 'open']);
        // The label is the reader's, not the lens's: Update saves what they are
        // looking at under the name they already gave it.
        expect(storedValue(settings).views[0]?.label).toBe(VIEW_LABEL);
    });

    it('refuses a stale full-view update, re-reads, and shows the conflict', async () => {
        const { shell, settings } = await mountShell({ selectedViewId: VIEW_ID });
        const openFacet = await shell.getByRole('checkbox', { name: 'Open' });
        await act(async () => { await shell.press(openFacet); });

        // Another device renames the view after this mount read it. The local
        // Update still carries the old full draft, including the old label.
        settings.seed(TRIAGE_SAVED_VIEWS_SETTING_ID_V1, {
            ...storedSetting(VIEW_ID),
            views: [{ ...storedSetting(VIEW_ID).views[0], label: 'Renamed elsewhere' }],
        });

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Update this view' }));
        });
        for (let settle = 0; settle < 3; settle += 1) {
            await act(async () => { await Promise.resolve(); });
        }

        await expect(shell.getByText(
            'Your saved views changed somewhere else, so nothing was changed here. Try again.',
        )).resolves.toBeTruthy();
        expect(storedValue(settings).views[0]).toMatchObject({
            label: 'Renamed elsewhere',
            filters: { states: ['done'] },
        });
        await expect(shell.getByRole('radio', { name: 'Renamed elsewhere' })).resolves.toBeTruthy();
    });

    it('clears the selected view id when the view is deleted', async () => {
        const { shell, settings, locations } = await mountShell({ selectedViewId: VIEW_ID });

        const remove = await shell.getByRole('button', { name: 'Delete' });
        await act(async () => { await shell.press(remove); });
        await act(async () => { await Promise.resolve(); });

        expect(storedValue(settings).views).toEqual([]);
        expect(storedValue(settings).selectedViewId).toBeNull();
        expect(locations[locations.length - 1] ?? '').not.toContain('sv,');
    });

    it('restores the selected view exactly when the location carries no lens', async () => {
        const { shell, settings } = await mountShell({ selectedViewId: VIEW_ID });

        // Durable account preference, applied on restart without a write.
        await expect(shell.getByRole('checkbox', {
            name: 'Done',
            state: { checked: true },
        })).resolves.toBeTruthy();
        await expect(shell.getByRole('radio', {
            name: VIEW_LABEL,
            state: { checked: true },
        })).resolves.toBeTruthy();
        expect(settings.setCallCount()).toBe(0);
    });

    it('clears a view id the stored set does not answer to while its route lens survives', async () => {
        const { shell, settings, locations } = await mountShell({
            selectedViewId: VIEW_ID,
            // Deleted on another device, or minted under another Account: the
            // id names nothing here, but the lens beside it is still what the
            // reader followed.
            subPath: 'sv,0000000c-0000-4000-8000-00000000000c/fst,open',
        });

        await expect(shell.getByRole('checkbox', {
            name: 'Open',
            state: { checked: true },
        })).resolves.toBeTruthy();
        const written = locations[locations.length - 1] ?? '';
        expect(written).toContain('fst,open');
        expect(written).not.toContain('sv,');
        // Clearing a dangling id is a statement about this page, never a write.
        expect(settings.setCallCount()).toBe(0);
    });

    it('does not restore a view over an edit the reader made while the read was in flight', async () => {
        let release!: () => void;
        const gateViewsRead = new Promise<void>((resolve) => { release = resolve; });
        const { shell, settings } = await mountShell({
            selectedViewId: VIEW_ID,
            gateViewsRead,
        });

        const openFacet = await shell.getByRole('checkbox', { name: 'Open' });
        await act(async () => { await shell.press(openFacet); });

        await act(async () => {
            release();
            await gateViewsRead;
            await Promise.resolve();
        });

        // The reader said something more current than the durable preference
        // behind it. Restoring over it would take their narrowing away seconds
        // after they made it, with nothing on screen saying why.
        await expect(shell.getByRole('checkbox', {
            name: 'Open',
            state: { checked: true },
        })).resolves.toBeTruthy();
        await expect(shell.getByRole('checkbox', {
            name: 'Done',
            state: { checked: false },
        })).resolves.toBeTruthy();
        expect(settings.setCallCount()).toBe(0);
    });

    it('lets an explicit route lens win without mutating Settings', async () => {
        const { shell, settings } = await mountShell({
            selectedViewId: VIEW_ID,
            subPath: 'fst,open',
        });

        // The location the reader arrived at is the lens they see; the durable
        // selection is not applied over it and, above all, is not rewritten to
        // match it.
        await expect(shell.getByRole('checkbox', {
            name: 'Open',
            state: { checked: true },
        })).resolves.toBeTruthy();
        await expect(shell.getByRole('checkbox', {
            name: 'Done',
            state: { checked: false },
        })).resolves.toBeTruthy();
        expect(settings.setCallCount()).toBe(0);
    });
});
