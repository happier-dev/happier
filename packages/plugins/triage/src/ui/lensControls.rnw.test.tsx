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

    async function executeAction(request: Readonly<{ action: unknown; input: unknown }>) {
        if (String(request.action) === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
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

    return { executeAction };
}

const mounted: PluginUiTestkit[] = [];

async function mountShell(subPath?: string): Promise<Readonly<{
    shell: PluginUiTestkit;
    locations: readonly string[];
}>> {
    const harness = createHarness();
    const locations: string[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId: 'triage',
                generation: 'triage-lens-mount',
            },
            surface: renderShellSurface,
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            ...(subPath === undefined ? {} : { subPath }),
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
    await act(async () => { await refreshTriageListWindow('view'); });
    return { shell: fixture, locations };
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the PRs & Issues lens controls', () => {
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

        const active = await shell.getByRole('checkbox', {
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

        await expect(shell.getByRole('checkbox', {
            name: SCOPE,
            state: { checked: true },
        })).resolves.toBeTruthy();
    });
});
