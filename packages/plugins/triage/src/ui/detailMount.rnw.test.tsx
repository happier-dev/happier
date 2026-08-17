// @vitest-environment jsdom
import { act } from 'react';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
    TriageConfiguredSourceInstanceV1Schema,
    TriageDetailSurfaceInputV1JsonSchema,
    type TriageConfiguredSourceInstanceV1,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { TriageReadEntryDetailInputV1Schema } from '../actions/entryDetailProtocol.js';
import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import { TriageListEntriesInputV1Schema } from '../actions/listEntriesProtocol.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from '../actions/entryDetailProtocol.js';
import { readTriageEntryDetail } from '../actions/readEntryDetail.js';
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
 * Opening a row all the way into the source's own detail body.
 *
 * `TargetedSurface` had exactly one appearance in the whole aggregate — a
 * comment saying it was not mounted — so every packaged source detail renderer
 * was unreachable and a reader could see rows and open none of them. This case
 * drives the real vertical: the real shell, the real selection reducer, the real
 * `entries/read-detail-v1` handler over real Collections, the real strict input
 * builder, the real `TargetedSurface`, and the host's own admission projection,
 * which validates the launch input against the PUBLISHED detail role schema
 * before any child is rendered.
 *
 * The contributor is a fixture source rather than a first-party one on purpose:
 * what is being proved is the aggregate's half of the seam, and a fixture keeps
 * the case from passing because one particular forge happens to be packaged.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const CONTRIBUTOR_GENERATION = 'contributor-generation-a';
const TARGET_GENERATION = 'target-generation-a';
const DETAIL_RENDERER_ID = 'example-detail';
const DETAIL_BODY_TEXT = 'The example forge detail body';
const PROTOCOL = Object.freeze({
    id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
});
const DESCRIPTOR = Object.freeze({
    v: 1,
    purpose: 'triage-source',
    displayName: 'Example forge',
    kinds: [{
        id: 'pull-request',
        workflowSubject: 'pullRequest',
        displayName: 'Pull request',
        pluralDisplayName: 'Pull requests',
    }],
});

/** The contributor's real public manifest, as the host reads it at admission. */
const CONTRIBUTOR_MANIFEST = definePlugin({
    id: SOURCE.pluginId,
    version: '1.0.0',
    ui: {
        renderers: [{
            id: DETAIL_RENDERER_ID,
            kind: 'declarative',
            root: { kind: 'text', text: DETAIL_BODY_TEXT },
        }],
    },
}).manifest;

const CONTRIBUTOR = Object.freeze({
    pluginId: SOURCE.pluginId,
    contributionId: SOURCE.localId,
    immutableGenerationId: CONTRIBUTOR_GENERATION,
});

/**
 * A second admitted source at the same point, sorted ahead of the one that owns
 * the entry.
 *
 * It is what makes "the right contributor" a falsifiable claim: with one
 * contribution in the snapshot, mounting the first one and mounting the exact
 * one are the same code. Its own detail body says so, so a lookup that took the
 * first admitted contributor would render a tracker's view of a forge's pull
 * request — the exact wrong-provider mount the aggregate must not make.
 */
const OTHER_SOURCE = Object.freeze({
    pluginId: 'happier.example.another-source',
    localId: 'example-tracker',
});
const OTHER_CONTRIBUTOR = Object.freeze({
    pluginId: OTHER_SOURCE.pluginId,
    contributionId: OTHER_SOURCE.localId,
    immutableGenerationId: 'other-generation-a',
});
const OTHER_DETAIL_BODY_TEXT = 'The other source detail body';
const OTHER_DETAIL_SURFACE = Object.freeze({
    point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol: PROTOCOL },
    contributor: OTHER_CONTRIBUTOR,
    role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
    presentation: 'content' as const,
});
const OTHER_CONTRIBUTOR_MANIFEST = definePlugin({
    id: OTHER_SOURCE.pluginId,
    version: '1.0.0',
    ui: {
        renderers: [{
            id: DETAIL_RENDERER_ID,
            kind: 'declarative',
            root: { kind: 'text', text: OTHER_DETAIL_BODY_TEXT },
        }],
    },
}).manifest;

const DETAIL_SURFACE = Object.freeze({
    point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol: PROTOCOL },
    contributor: CONTRIBUTOR,
    role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
    presentation: 'content' as const,
});

/**
 * The exact cold admission the physical host would hold. Its `inputSchema` is
 * the PUBLISHED detail role schema, so a launch input the contract would reject
 * renders the fallback instead of the child — which is what makes this a proof
 * of the strict boundary rather than of a prop being passed along.
 */
const ADMITTED_MOUNT = Object.freeze({
    kind: 'targetedSurface',
    target: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, immutableGenerationId: TARGET_GENERATION },
    point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol: PROTOCOL },
    contributor: CONTRIBUTOR,
    role: TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
    presentation: 'content',
    inputSchema: TriageDetailSurfaceInputV1JsonSchema,
    rendererChain: [{ pluginId: SOURCE.pluginId, localId: DETAIL_RENDERER_ID }],
    selectedRenderer: {
        identity: { pluginId: SOURCE.pluginId, localId: DETAIL_RENDERER_ID },
        renderer: { kind: 'declarative', contributionId: DETAIL_RENDERER_ID, model: { visible: true } },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
    },
    executionOrigin: {
        serverIdentityId: 'srv_example',
        materializationRef: {
            machineId: 'machine-example',
            materializationId: `materialization-${CONTRIBUTOR_GENERATION}`,
            pluginId: SOURCE.pluginId,
        },
    },
    resourceCapability: { readable: true, dynamic: true },
    contributorTargetedContributions: {
        target: { pluginId: SOURCE.pluginId, immutableGenerationId: CONTRIBUTOR_GENERATION },
        points: [],
    },
});

const OTHER_ADMITTED_MOUNT = Object.freeze({
    ...ADMITTED_MOUNT,
    contributor: OTHER_CONTRIBUTOR,
    rendererChain: [{ pluginId: OTHER_SOURCE.pluginId, localId: DETAIL_RENDERER_ID }],
    selectedRenderer: {
        identity: { pluginId: OTHER_SOURCE.pluginId, localId: DETAIL_RENDERER_ID },
        renderer: { kind: 'declarative', contributionId: DETAIL_RENDERER_ID, model: { visible: true } },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
    },
    executionOrigin: {
        serverIdentityId: 'srv_other',
        materializationRef: {
            machineId: 'machine-other',
            materializationId: 'materialization-other',
            pluginId: OTHER_SOURCE.pluginId,
        },
    },
    contributorTargetedContributions: {
        target: { pluginId: OTHER_SOURCE.pluginId, immutableGenerationId: 'other-generation-a' },
        points: [],
    },
});

function surfaceContext(options: Readonly<{ contributesDetail?: boolean }> = {}) {
    const contributesDetail = options.contributesDetail !== false;
    return createSurfaceContextFixture({
        mount: {
            kind: 'destination',
            destination: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: 'triage' },
            container: 'appPage',
        },
        targetedContributions: {
            target: {
                pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
                immutableGenerationId: TARGET_GENERATION,
            },
            points: [{
                pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
                protocols: [{
                    protocol: PROTOCOL,
                    contributions: [{
                        // Sorted first, exactly as the admitted snapshot orders
                        // contributors, and deliberately not the entry's source.
                        contributor: OTHER_CONTRIBUTOR,
                        protocol: PROTOCOL,
                        descriptor: {
                            ...DESCRIPTOR,
                            displayName: 'Another source',
                        },
                        operations: [],
                        surfaces: [OTHER_DETAIL_SURFACE],
                    }, {
                        contributor: CONTRIBUTOR,
                        protocol: PROTOCOL,
                        descriptor: DESCRIPTOR,
                        operations: [],
                        surfaces: contributesDetail ? [DETAIL_SURFACE] : [],
                    }],
                }],
            }],
        },
    });
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
        // Deliberately not the entry's scope label: the header renders both,
        // and a fixture where they read the same would let one stand in for the
        // other.
        locator: { v: 1, displayLabel: 'Example account' },
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
    /** Flipped to make the next pass observe nothing, so the row leaves. */
    const observes = { current: true };

    const admitted = [{
        contributor: CONTRIBUTOR,
        protocol: PROTOCOL,
        descriptor: DESCRIPTOR,
        operations: { listInstances: {}, scan: { role: 'scan' }, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1];

    const executeScan: TriageAdmittedOperationExecutorV1 = async () => ({
        kind: 'complete',
        observations: observes.current ? [{
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
        if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
            return await listTriagePinnedEntries(
                TriageListPinnedEntriesInputV1Schema.parse(request.input),
                { collections, nowMs: () => 2_000 },
            );
        }
        if (action === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) {
            // The real handler over the real Collections; only the invocation
            // context's caller stamp is the host's to supply.
            return await readTriageEntryDetail(
                TriageReadEntryDetailInputV1Schema.parse(request.input),
                {
                    sourceInstances: collections.sourceInstances,
                    sessionLinks: collections.sessionLinks,
                    readSessionSummary: async () => null,
                },
            );
        }
        return await listTriageEntries(TriageListEntriesInputV1Schema.parse(request.input), {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => admitted,
            executeScan,
            nowMs: () => Date.now(),
        });
    }

    return { collections, executeAction, observes };
}

const mounted: PluginUiTestkit[] = [];
let currentHarness: ReturnType<typeof createHarness> | null = null;

async function mountShell(options: Readonly<{ contributesDetail?: boolean }> = {}): Promise<PluginUiTestkit> {
    const harness = createHarness();
    currentHarness = harness;
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
                pluginVersion: '0.0.0',
                viewId: 'triage',
                generation: TARGET_GENERATION,
            },
            surface: renderShellSurface,
            surfaceContext: surfaceContext(options),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({
                targetedSurfaces: {
                    readCurrentMounts: () => [ADMITTED_MOUNT, OTHER_ADMITTED_MOUNT],
                    readContributorManifest: (pluginId: string) => (
                        pluginId === OTHER_SOURCE.pluginId
                            ? OTHER_CONTRIBUTOR_MANIFEST
                            : CONTRIBUTOR_MANIFEST
                    ),
                },
            }),
            handlers: {
                executeAction: async ({ action, input }) => await harness.executeAction({ action, input }),
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
        await shell.press(await shell.getByRole('option', {
            name: 'Replace the duplicated normalizer',
        }));
    });
    // Let the detail read settle through the real Action seam.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
}

afterEach(async () => {
    currentHarness = null;
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('opening a row into the source detail', () => {
    it('mounts the admitted source detail contribution', async () => {
        const shell = await mountShell();

        await openTheRow(shell);

        // The child rendered. Reaching it required the admitted handle from the
        // mount's own contribution snapshot AND a launch input the published
        // detail schema accepts; the host's projection refuses either way.
        await expect(shell.getByText(DETAIL_BODY_TEXT))
            .resolves.toEqual({ content: DETAIL_BODY_TEXT });
        // And not the other admitted source's, which is sorted ahead of it.
        await expect(shell.queryByText(OTHER_DETAIL_BODY_TEXT)).resolves.toBeUndefined();
    });

    it('renders the aggregate-owned header beside it', async () => {
        const shell = await mountShell();

        await openTheRow(shell);

        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        // The entry's own scope, and — separately — the configured connection
        // this detail is being read through.
        await expect(shell.getByText('example/repository')).resolves.toBeDefined();
        await expect(shell.getByText('Example account')).resolves.toBeDefined();
        // The source's own name for itself and for this entry kind live only in
        // its declared descriptor, which reaches this mount as raw JSON. They
        // are absent on purpose: decoding them here is the cold UI semantic
        // projection `SDK-EU-26` reserves (`PLAN.md` §5.2).
        await expect(shell.queryByText('Example forge')).resolves.toBeUndefined();
        await expect(shell.queryByText('Pull request')).resolves.toBeUndefined();
    });

    it('returns to the list when the detail is closed', async () => {
        const shell = await mountShell();

        await openTheRow(shell);
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Close' }));
        });

        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
    });

    it('says the selected entry left the list rather than closing the detail by itself', async () => {
        const shell = await mountShell();
        await openTheRow(shell);

        // The next pass observes nothing, so the selected row leaves the window
        // while the selection — which is the reader's, not the window's —
        // stays. `core/SURFACE.md` §3.1 keeps it for exactly this.
        if (currentHarness !== null) currentHarness.observes.current = false;
        await act(async () => { await refreshTriageListWindow('manual'); });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.getByText('This entry is no longer in the list')).resolves.toBeDefined();
        // Silently falling back to the list would read as the surface closing
        // the detail on its own, with no account of where the entry went.
        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
    });

    it('says the source contributes no detail view rather than mounting nothing', async () => {
        const shell = await mountShell({ contributesDetail: false });

        await openTheRow(shell);

        await expect(shell.getByText('This source has no detail view')).resolves.toBeDefined();
        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
    });
});
