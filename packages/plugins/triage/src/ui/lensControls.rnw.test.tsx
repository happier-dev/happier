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
import { refreshTriageListWindow } from './window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';
import { filterFacetOption } from './shell/toolbarMenus.test-support.js';
import { renderSurface as renderShellSurface } from './surface.js';

/**
 * The lens controls a reader can actually reach.
 *
 * A shareable location carries a query and all five facets, and the window
 * applies every one of them. So a reader can arrive — from a copied link, from
 * their own earlier session, or from system Back — at a list narrowed by a
 * constraint the surface never names. These cases fail if the query or an
 * active Type/Scope facet is applied with no control on screen to see it or
 * take it off again.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const SCOPE = 'example/repository';

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

function createHarness() {
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow()));

    const admitted = [{
        contributor: {
            pluginId: SOURCE.pluginId,
            contributionId: SOURCE.localId,
            occurrenceId: 'generation-1',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'source-root' },
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

    async function executeAction(request: Readonly<{ action: unknown; input: unknown }>) {
        if (String(request.action) === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
            return await listTriagePinnedEntries(
                TriageListPinnedEntriesInputV1Schema.parse(request.input),
                { collections, nowMs: () => 2_000 },
            );
        }
        return await listTriageEntries(TriageListEntriesInputV1Schema.parse(request.input), {
            sourceInstances: collections.sourceInstances,
            readSourceSnapshot: async () => ({ contributions: admitted }),
            executeScan,
            nowMs: () => Date.now(),
        });
    }

    return { executeAction };
}

const mounted: PluginUiTestkit[] = [];

async function mountShell(subPath?: string): Promise<Readonly<{
    shell: PluginUiTestkit;
    locations: readonly string[];
    views: readonly (string | undefined)[];
}>> {
    const harness = createHarness();
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
    const locations: string[] = [];
    const views: (string | undefined)[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-177', mountNonce: 'fixture-mount-177' },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: renderShellSurface,
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope, overlays: true }),
            ...(subPath === undefined ? {} : { subPath }),
            handlers: {
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action, input }) => await harness.executeAction({ action, input }),
                replacePageLocation: ({ subPath: written, view }) => {
                    locations.push(written);
                    views.push(view);
                    return written;
                },
            },
        });
    });
    mounted.push(fixture);
    await act(async () => {
        await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope);
    });
    return { shell: fixture, locations, views };
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the page view under a slow host location write', () => {
    // Live READY240: the host answers each replacement, then publishes the location later; presses land between
    // those two events in any order. Each schedule is [press, ...events] steps; the page must settle on the last press.
    it.each([
        ['ack, echo between every press', 'T a e P a e T a e P a e'],
        ['echo before ack', 'T e a P e a T e a P e a'],
        ['next press before the echo', 'T a P e a T e a P e a e'],
        ['older echo after the newer ack', 'T a P a T e a e P a e e'],
        ['echoes all late', 'T a P a T a P a e e e e'],
        ['acks and echoes all late', 'T P T P a e a e a e a e'],
        ['older echo arrives after a newer press is acked', 'T a e P a T a e P e a e'],
    ])('settles the last view chosen when the host answers %s (QB-82)', async (_name, schedule) => {
        const harness = createHarness();
        const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
        const acks: Array<Readonly<{ subPath: string; settle: () => void }>> = [];
        const echoes: string[] = [];
        let hostAt = '';
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({
                identity: { instanceId: 'fixture-instance-182b', mountNonce: 'fixture-mount-182b' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' },
                surface: renderShellSurface,
                surfaceContext: createSurfaceContextFixture(),
                adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope, overlays: true }),
                handlers: {
                    publishCurrentUiContext: () => undefined,
                    executeAction: async ({ action, input }) => await harness.executeAction({ action, input }),
                    replacePageLocation: ({ subPath }) => new Promise<string>((resolve) => {
                        echoes.push(subPath);
                        acks.push({ subPath, settle: () => resolve(subPath) });
                    }),
                },
            });
        });
        mounted.push(fixture);
        await act(async () => {
            await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope);
        });
        // The opening publication settles before the reader acts.
        for (let step = 0; step < 4 && (acks.length > 0 || echoes.length > 0); step += 1) {
            await act(async () => { acks.shift()?.settle(); for (let turn = 0; turn < 4; turn += 1) await Promise.resolve(); });
            const echo = echoes.shift();
            if (echo !== undefined) { hostAt = echo; await act(async () => { await fixture.updatePageLocation(echo); }); }
        }
        let last = '';
        for (const token of schedule.split(' ')) {
            if (token === 'T' || token === 'P') {
                last = token === 'T' ? 'Tasks' : 'PRs & Issues';
                await act(async () => { await fixture.press(await fixture.getByRole('radio', { name: last })); });
            } else if (token === 'a') {
                await act(async () => { acks.shift()?.settle(); for (let turn = 0; turn < 4; turn += 1) await Promise.resolve(); });
            } else {
                const echo = echoes.shift();
                if (echo !== undefined) { hostAt = echo; await act(async () => { await fixture.updatePageLocation(echo); }); }
            }
        }
        // Drain whatever the page still writes, answering each write then publishing it.
        for (let step = 0; step < 12 && (acks.length > 0 || echoes.length > 0); step += 1) {
            await act(async () => { acks.shift()?.settle(); for (let turn = 0; turn < 4; turn += 1) await Promise.resolve(); });
            const echo = echoes.shift();
            if (echo !== undefined) { hostAt = echo; await act(async () => { await fixture.updatePageLocation(echo); }); }
        }
        await expect(fixture.getByRole('radio', { name: last, state: { checked: true } })).resolves.toBeTruthy();
        expect(hostAt.startsWith('tasks,')).toBe(last === 'Tasks');
    });

    it('settles the last view chosen while an earlier view write is still in flight (QB-82)', async () => {
        // Live c3e5a241bcda: Tasks, PRs & Issues, Tasks, PRs & Issues 60 ms apart left the page on Tasks in 2 of 5
        // runs. A choice equal to the last settled location wrote nothing while the opposite write was still queued,
        // so the queued older choice landed after it.
        const harness = createHarness();
        const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
        const writes: Array<Readonly<{ subPath: string; settle: () => void }>> = [];
        const landed: string[] = [];
        let fixture!: PluginUiTestkit;
        await act(async () => {
            fixture = await createPluginUiTestkit({
                identity: { instanceId: 'fixture-instance-182', mountNonce: 'fixture-mount-182' },
                authorPlugin: { id: 'happier.triage', version: '0.0.0' },
                surface: renderShellSurface,
                surfaceContext: createSurfaceContextFixture(),
                adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope, overlays: true }),
                handlers: {
                    publishCurrentUiContext: () => undefined,
                    executeAction: async ({ action, input }) => await harness.executeAction({ action, input }),
                    replacePageLocation: ({ subPath }) => new Promise<string>((resolve) => {
                        writes.push({ subPath, settle: () => { landed.push(subPath); resolve(subPath); } });
                    }),
                },
            });
        });
        mounted.push(fixture);
        await act(async () => {
            await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope);
        });
        const choose = async (name: string) => {
            await act(async () => { await fixture.press(await fixture.getByRole('radio', { name })); });
        };
        for (const name of ['Tasks', 'PRs & Issues', 'Tasks', 'PRs & Issues']) await choose(name);
        for (let step = 0; step < 8 && writes.length > 0; step += 1) {
            await act(async () => { writes.shift()!.settle(); await Promise.resolve(); });
        }
        expect(landed.at(-1)).not.toMatch(/^tasks,/);
        await expect(fixture.getByRole('radio', { name: 'PRs & Issues', state: { checked: true } })).resolves.toBeTruthy();
    });
});

describe('the PRs & Issues lens controls', () => {
    it('publishes the cold Tasks route and view once without rewriting on re-render', async () => {
        const subPath = 'tasks,mine/q,normalizer';
        const { shell, locations, views } = await mountShell(subPath);

        expect(locations).toEqual([subPath]);
        expect(views).toEqual(['tasks']);
        await act(async () => {
            await shell.updateSurface(createSurfaceContextFixture({ textScale: 1.25 }));
        });
        await act(async () => {
            await shell.updateSurface(createSurfaceContextFixture({ textScale: 1 }));
        });
        expect(locations).toEqual([subPath]);
        expect(views).toEqual(['tasks']);
    });

    it('shows the route-carried query in a search control the reader can see', async () => {
        const { shell } = await mountShell('q,normalizer');

        // The window applies this query, so without the control a reader lands
        // on a narrowed list whose only cause is invisible.
        const search = await shell.getByRole('textbox');
        expect(search.value).toBe('normalizer');
        // The control names itself; the exact sentence is the catalog's.
        expect(search.label).toBeTruthy();
    });

    it('offers the search control on an unnarrowed page too', async () => {
        const { shell } = await mountShell();

        const search = await shell.getByRole('textbox');
        expect(search.value).toBe('');
    });

    it('shows an active Type facet and lets one press take it off', async () => {
        const { shell, locations } = await mountShell(
            `ft,${SOURCE.pluginId},${SOURCE.localId},pull-request`,
        );

        const active = await filterFacetOption(shell, 'Type', {
            name: 'pull-request',
            state: { checked: true },
        });
        const before = locations.length;

        await act(async () => { await shell.press(active); });

        // Deselecting writes the location the reader is now looking at, and it
        // no longer carries the Type constraint.
        const written = locations.slice(before);
        expect(written.length).toBeGreaterThan(0);
        expect(written[written.length - 1]).not.toContain('ft,');
    });

    it('shows an active Scope facet the route carried', async () => {
        const { shell } = await mountShell(
            `fp,${SOURCE.pluginId},${SOURCE.localId},${encodeURIComponent(SCOPE)}`,
        );

        await expect(filterFacetOption(shell, 'Scope', {
            name: SCOPE,
            state: { checked: true },
        })).resolves.toBeTruthy();
    });
});
