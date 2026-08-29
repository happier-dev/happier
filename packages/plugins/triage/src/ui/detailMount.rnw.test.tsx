// @vitest-environment jsdom
import { act } from 'react';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1 } from '@happier-dev/plugin-sdk/ui';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TRIAGE_SOURCE_DETAIL_SURFACE_ROLE_V1,
    MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
    TriageConfiguredSourceInstanceV1Schema,
    TriageDetailSurfaceInputV1JsonSchema,
    TriageEntryRefV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import type { JsonValue } from '@happier-dev/plugin-sdk';

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
import { fromCorpusStoredRow, toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1, CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { deriveSessionLinkEntryTag, deriveSessionLinkTag } from '../corpus/identity/tags.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { buildTriageEntryDetailLaunchInput } from '../composer/entryDetailLaunchInput.js';
import {
    TRIAGE_ROUTE_DEFAULT_LENS_V1,
    buildTriageRouteSubPathV1,
} from './navigation/location.js';
import { TRIAGE_SHELL_FILL_TEST_ID_V1 } from './shell/root.js';
import { refreshTriageListWindow } from './window/mountedWindow.js';
import { renderSurface as renderShellSurface } from './surface.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';

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

/**
 * A SECOND configured connection to the same source, sorted after the first.
 *
 * One entry observed by two of the reader's own accounts is ordinary — a public
 * pull request both of them can see — and the corpus's instance selector breaks
 * that tie deterministically by the smaller id. So the window's own answer for
 * this entry is always `INSTANCE`, which is what makes "the launch's connection
 * won" falsifiable: with one configured connection, honouring the launch and
 * ignoring it are the same code.
 */
const SECOND_INSTANCE = '22222222-2222-4222-8222-222222222222';
const CONTRIBUTOR_GENERATION = 'contributor-generation-a';
const TARGET_GENERATION = 'target-generation-a';
const DETAIL_RENDERER_ID = 'example-detail';
const DETAIL_BODY_TEXT = 'The example forge detail body';
/**
 * One entry whose canonical reference is as large as the contract allows.
 *
 * `MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1` is 192 bytes and
 * `MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1` is 128, and percent-encoding triples a
 * non-Latin byte — so a perfectly ordinary entry from a non-Latin repository
 * produces a selection segment of ~750 route bytes on its own. That is what
 * makes §3.2's refusal reachable by a reader rather than only by a hand-edited
 * URL, and it is why the fixture carries a real one instead of padding a short
 * reference out with filler.
 */
const LONG_SCOPE = '設'.repeat(64);
const LONG_ENTRY_ID = '9'.repeat(128);
const LONG_REF_ROW_TITLE = 'An entry with a very long canonical reference';
/** Long enough to pad a location to the bound; bounded by the wire's 512 bytes. */
const SUMMARY_PADDING = 'x'.repeat(512);
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

function configuredInstance(
    sourceInstanceId: string = INSTANCE,
): TriageConfiguredSourceInstanceV1 {
    const second = sourceInstanceId === SECOND_INSTANCE;
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source: SOURCE, sourceInstanceId },
        binding: {
            purpose: 'triage-source',
            account: {
                service: { pluginId: SOURCE.pluginId, localId: 'accounts' },
                accountId: second ? 'account-2' : 'account-1',
            },
        },
        localInstanceKey: 'example/repository',
        configuration: { v: 1, token: 'routing-token' },
        // Deliberately not the entry's scope label: the header renders both,
        // and a fixture where they read the same would let one stand in for the
        // other.
        locator: { v: 1, displayLabel: second ? 'Second account' : 'Example account' },
    });
}

function instanceRow(sourceInstanceId: string = INSTANCE): CorpusSourceInstanceRowV1 {
    return {
        instanceTag: `${sourceInstanceId === SECOND_INSTANCE ? 'b' : 'a'}${'0'.repeat(42)}`,
        sourceQualifiedId: `${SOURCE.pluginId}/${SOURCE.localId}`,
        lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1,
        configured: configuredInstance(sourceInstanceId),
    };
}

function createHarness(options: Readonly<{
    secondInstance?: boolean;
    secondInstanceObservesEntry?: boolean;
}> = {}) {
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow()));
    if (options.secondInstance === true) {
        control.sourceInstances.seed(toCorpusStoredValue(instanceRow(SECOND_INSTANCE)));
    }
    /** Every connection the mounted detail actually ran a read under. */
    const readDetailInstanceIds: string[] = [];
    /** Flipped to make the next pass observe nothing, so the row leaves. */
    const observes = { current: true };
    /** Makes one same-entry pass publish a genuinely newer observation. */
    const observationRevision = { current: 3_000 };
    let blockedDetailRead: Readonly<{ promise: Promise<void>; release: () => void }> | null = null;
    let failNextLinkedSessionPage = false;
    let repeatNextLinkedSessionCursor = false;
    let finalLinkedSessionId: string | null = null;

    const admitted = [{
        contributor: CONTRIBUTOR,
        protocol: PROTOCOL,
        descriptor: DESCRIPTOR,
        operations: { listInstances: {}, scan: { role: 'scan' }, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1];

    const executeScan: TriageAdmittedOperationExecutorV1 = async (_operation, input) => ({
        kind: 'complete',
        observations: observes.current
            && (options.secondInstanceObservesEntry !== false
                || input.instance.instance.sourceInstanceId !== SECOND_INSTANCE) ? [{
            kind: 'present',
            localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
            locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: 'Replace the duplicated normalizer' }),
            viewer: testkitViewer(),
            sourceUpdatedAtMs: observationRevision.current,
        }, {
            kind: 'present',
            localRef: {
                kindId: 'pull-request',
                collisionScope: LONG_SCOPE,
                entryId: LONG_ENTRY_ID,
            },
            locator: testkitLocator(),
            snapshot: testkitSnapshot({
                title: LONG_REF_ROW_TITLE,
                // The one field long enough to hold the padding a near-full
                // page location needs while still MATCHING this row, now that
                // the query the location carries actually reaches the window.
                summary: SUMMARY_PADDING,
            }),
            viewer: testkitViewer(),
            sourceUpdatedAtMs: 2_000,
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
            const detailInput = TriageReadEntryDetailInputV1Schema.parse(request.input);
            if (detailInput.linkedSessionsCursor !== undefined && failNextLinkedSessionPage) {
                failNextLinkedSessionPage = false;
                throw new Error('linked Session page unavailable');
            }
            readDetailInstanceIds.push(detailInput.sourceInstanceId);
            const blocked = blockedDetailRead;
            blockedDetailRead = null;
            if (blocked !== null) await blocked.promise;
            const result = await readTriageEntryDetail(
                detailInput,
                {
                    sourceInstances: collections.sourceInstances,
                    sessionLinks: collections.sessionLinks,
                    readSessionSummary: async (sessionId) => ({
                        title: sessionId === finalLinkedSessionId
                            ? 'Linked Session 201'
                            : `Linked ${sessionId}`,
                    }),
                },
            );
            if (detailInput.linkedSessionsCursor !== undefined && repeatNextLinkedSessionCursor) {
                repeatNextLinkedSessionCursor = false;
                return result.kind === 'read'
                    ? { ...result, linkedSessionsNextCursor: detailInput.linkedSessionsCursor }
                    : result;
            }
            return result;
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
        executeAction,
        observes,
        readDetailInstanceIds,
        ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
        async seedLinkedSessions(count: number): Promise<void> {
            const entryRef = TriageEntryRefV1Schema.parse({
                source: SOURCE,
                kindId: 'pull-request',
                collisionScope: 'example/repository',
                entryId: '17',
            });
            const entryTag = await deriveSessionLinkEntryTag(collections.sessionLinks, entryRef);
            const links = await Promise.all(Array.from({ length: count }, async (_unused, index) => {
                const sessionId = `session-linked-${String(index + 1).padStart(3, '0')}`;
                const linkTag = await deriveSessionLinkTag(collections.sessionLinks, entryRef, sessionId);
                return {
                    linkTag,
                    entryTag,
                    sessionId,
                    linkedAtMs: 4_000 + index,
                    entryRef,
                    identityEntryRef: entryRef,
                    displayPathAtLink: 'example/repository#17',
                } satisfies CorpusSessionLinkRowV1;
            }));
            for (const link of links) control.sessionLinks.seed(toCorpusStoredValue(link));
            const first = await collections.sessionLinks.query({
                index: 'by-entry',
                prefix: [entryTag],
                order: 'asc',
                limit: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
            });
            if (first.nextCursor === undefined) throw new Error('Expected a second linked Session page.');
            const second = await collections.sessionLinks.query({
                index: 'by-entry',
                prefix: [entryTag],
                order: 'asc',
                cursor: first.nextCursor,
                limit: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
            });
            const finalRow = second.rows[0];
            if (finalRow === undefined) throw new Error('Expected the final linked Session row.');
            finalLinkedSessionId = fromCorpusStoredRow<CorpusSessionLinkRowV1>(finalRow).value.sessionId;
        },
        failNextLinkedSessionPage(): void {
            failNextLinkedSessionPage = true;
        },
        repeatNextLinkedSessionCursor(): void {
            repeatNextLinkedSessionCursor = true;
        },
        publishNewerObservation(): void {
            observationRevision.current += 1;
        },
        blockNextDetailRead(): () => void {
            let release!: () => void;
            const promise = new Promise<void>((resolve) => { release = resolve; });
            blockedDetailRead = { promise, release };
            return release;
        },
    };
}

const mounted: PluginUiTestkit[] = [];
let currentHarness: ReturnType<typeof createHarness> | null = null;
/**
 * The last same-page replacement this mount asked the host for.
 *
 * The Back case below settles the page's OWN declared step rather than a
 * hand-written location, so it cannot pass against a shell that declares no
 * step, declares one that still names the selected entry, or spells the route
 * differently than it parses it.
 */
let lastPageLocation: Readonly<{ subPath: string; backLocation: string | undefined }> | null = null;

async function mountShell(
    options: Readonly<{
        contributesDetail?: boolean;
        subPath?: string;
        launchInput?: JsonValue;
        secondInstance?: boolean;
        secondInstanceObservesEntry?: boolean;
        linkedSessionCount?: number;
    }> = {},
): Promise<PluginUiTestkit> {
    const harness = createHarness({
        ...(options.secondInstance === undefined ? {} : { secondInstance: options.secondInstance }),
        ...(options.secondInstanceObservesEntry === undefined
            ? {}
            : { secondInstanceObservesEntry: options.secondInstanceObservesEntry }),
    });
    currentHarness = harness;
    if (options.linkedSessionCount !== undefined) {
        await harness.seedLinkedSessions(options.linkedSessionCount);
    }
    lastPageLocation = null;
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
                pluginVersion: '0.0.0',
                viewId: 'triage',
                generation: TARGET_GENERATION,
            },
            ...(options.subPath === undefined ? {} : { subPath: options.subPath }),
            ...(options.launchInput === undefined ? {} : { launchInput: options.launchInput }),
            surface: renderShellSurface,
            surfaceContext: surfaceContext(options),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({
                ephemeralSharedScope: harness.ephemeralSharedScope,
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
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action, input }) => await harness.executeAction({ action, input }),
                replacePageLocation: ({ subPath, backLocation }) => {
                    lastPageLocation = { subPath, backLocation };
                    return subPath;
                },
            },
        });
    });
    mounted.push(fixture);
    await act(async () => {
        await refreshTriageListWindow('view', fixture.context.hostApi, harness.ephemeralSharedScope);
    });
    return fixture;
}

async function openTheRow(shell: PluginUiTestkit): Promise<void> {
    await act(async () => {
        await shell.press(await shell.getByRole('button', {
            name: 'Replace the duplicated normalizer',
        }));
    });
    // Let the detail read settle through the real Action seam.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
}

type LayoutHandler = (event: Readonly<{
    nativeEvent: Readonly<{ layout: Readonly<{ x: number; y: number; width: number; height: number }> }>;
}>) => void;

async function measureFillRegion(width: number): Promise<void> {
    const node = document.querySelector(`[data-testid="${TRIAGE_SHELL_FILL_TEST_ID_V1}"]`);
    if (node === null) throw new Error('The Triage shell rendered no measured fill region.');
    const handler = (node as unknown as Record<string, unknown>).__reactLayoutHandler;
    if (typeof handler !== 'function') throw new Error('The Triage shell installed no layout observer.');
    await act(async () => {
        (handler as LayoutHandler)({
            nativeEvent: { layout: { x: 0, y: 0, width, height: 800 } },
        });
    });
}

function queryDetailBodyNode(): Element | null {
    return Array.from(document.querySelectorAll('*')).find(
        (candidate) => candidate.children.length === 0 && candidate.textContent === DETAIL_BODY_TEXT,
    ) ?? null;
}

function detailBodyNode(): Element {
    const node = queryDetailBodyNode();
    if (node === null) throw new Error('The admitted source detail body is not mounted.');
    return node;
}

afterEach(async () => {
    currentHarness = null;
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('opening a row into the source detail', () => {
    it('loads another linked-Session page without dropping or duplicating earlier rows, and retries a failed page', async () => {
        const shell = await mountShell({ linkedSessionCount: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1 });
        await openTheRow(shell);

        const initialLinkedSessionNames = (await shell.getAllByRole('button'))
            .map((button) => button.name)
            .filter((name) => name.startsWith('Linked session-linked-'));
        expect(initialLinkedSessionNames).toHaveLength(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1);
        const firstLinkedSessionName = initialLinkedSessionNames[0];
        if (firstLinkedSessionName === undefined) throw new Error('The first linked Session page was empty.');
        const firstLinkedSessionNode = Array.from(document.querySelectorAll('*')).find(
            (candidate) => candidate.textContent === firstLinkedSessionName
                && !Array.from(candidate.children).some((child) => child.textContent === firstLinkedSessionName),
        );
        if (firstLinkedSessionNode === undefined) throw new Error('The first linked Session row was not mounted.');
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        harness.failNextLinkedSessionPage();

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Load more' }));
        });
        await expect(shell.getByText('More linked Sessions could not be loaded.')).resolves.toBeDefined();
        await expect(shell.queryByText('Linked Session 201')).resolves.toBeUndefined();

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Retry' }));
        });

        await expect(shell.getByRole('button', { name: 'Linked Session 201' })).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: firstLinkedSessionName })).resolves.toBeDefined();
        const retainedFirstLinkedSessionNode = Array.from(document.querySelectorAll('*')).find(
            (candidate) => candidate.textContent === firstLinkedSessionName
                && !Array.from(candidate.children).some((child) => child.textContent === firstLinkedSessionName),
        );
        expect(retainedFirstLinkedSessionNode).toBe(firstLinkedSessionNode);
        const loadedLinkedSessionNames = (await shell.getAllByRole('button'))
            .map((button) => button.name)
            .filter((name) => name === 'Linked Session 201' || name.startsWith('Linked session-linked-'));
        expect(loadedLinkedSessionNames).toHaveLength(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1);
        expect(new Set(loadedLinkedSessionNames).size)
            .toBe(MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1);
        await expect(shell.queryByRole('button', { name: 'Load more' })).resolves.toBeUndefined();
        await expect(shell.queryByRole('button', { name: 'Retry' })).resolves.toBeUndefined();
    });

    it('settles a non-advancing linked-Session cursor while retaining the admitted page', async () => {
        const shell = await mountShell({ linkedSessionCount: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 + 1 });
        await openTheRow(shell);
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        harness.repeatNextLinkedSessionCursor();

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Load more' }));
        });

        // The page itself was admitted; only its non-advancing continuation is
        // refused. Rows from both pages remain while Retry can ask the same
        // Account boundary again after it recovers.
        await expect(shell.getByRole('button', { name: 'Linked Session 201' })).resolves.toBeDefined();
        await expect(shell.getByText('More linked Sessions could not be loaded.')).resolves.toBeDefined();

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Retry' }));
        });
        await expect(shell.queryByText('More linked Sessions could not be loaded.')).resolves.toBeUndefined();
        await expect(shell.queryByRole('button', { name: 'Load more' })).resolves.toBeUndefined();
    });

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

    it('keeps the ready source detail mounted while the same entry rereads', async () => {
        const shell = await mountShell();
        await openTheRow(shell);
        const mountedBody = detailBodyNode();
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        const releaseDetailRead = harness.blockNextDetailRead();
        harness.publishNewerObservation();

        await act(async () => {
            await refreshTriageListWindow('manual', shell.context.hostApi, harness.ephemeralSharedScope);
        });
        await act(async () => { await Promise.resolve(); });

        // A background reread may update the mounted input when it settles, but
        // it must not replace useful detail with a loading screen in between.
        const bodyWhilePending = queryDetailBodyNode();
        const loadingWhilePending = document.body.textContent?.includes('Reading this entry') === true;

        releaseDetailRead();
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });
        expect(bodyWhilePending).toBe(mountedBody);
        expect(loadingWhilePending).toBe(false);
        expect(detailBodyNode()).toBe(mountedBody);
    });

    it('replaces the ready source detail while a different entry is being read', async () => {
        const shell = await mountShell();
        await measureFillRegion(900);
        await openTheRow(shell);
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        const releaseDetailRead = harness.blockNextDetailRead();

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: LONG_REF_ROW_TITLE }));
        });
        await act(async () => { await Promise.resolve(); });

        // Ready detail is useful only for the exact entry and source instance
        // that produced it. Retaining it here would show the old provider body
        // beneath the newly selected entry's aggregate header.
        expect(queryDetailBodyNode()).toBeNull();
        await expect(shell.getByText('Reading this entry')).resolves.toBeDefined();

        releaseDetailRead();
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });
    });

    it('keeps one source detail mount while the open shell crosses split and stacked layouts', async () => {
        const shell = await mountShell();
        await measureFillRegion(900);
        await openTheRow(shell);
        const mountedBody = detailBodyNode();

        await measureFillRegion(420);

        // Responsive composition changes the detail container's layout, not
        // the detail's parent identity. Tabs, scroll and parser state therefore
        // remain owned by the same mounted source subtree.
        expect(detailBodyNode()).toBe(mountedBody);
    });

    it('renders the aggregate-owned header beside it', async () => {
        const shell = await mountShell();

        await openTheRow(shell);

        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        // The entry's own scope, and — separately — the configured connection
        // this detail is being read through.
        await expect(shell.getByText('example/repository')).resolves.toBeDefined();
        await expect(shell.getByText('Example account')).resolves.toBeDefined();
        // §2.2's Source and Type: the source's own name for itself and for this
        // entry kind, decoded by nothing in this shell — the host parsed the
        // descriptor at admission and `entries/read-detail-v1` carries the typed
        // value here out of the admitted snapshot.
        await expect(shell.getByText('Example forge')).resolves.toBeDefined();
        await expect(shell.getByText('Pull request')).resolves.toBeDefined();
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

    it('clears the stacked selection once when the host settles the declared Back step', async () => {
        // `core/SURFACE.md` §3.3 precedence 3. The host consumes ONE system
        // Back with the step this page declared, and the only thing that
        // reaches a mounted surface is a new location — so a shell that read
        // its location once, at construction, left the reader on a detail
        // screen the system Back button appeared to do nothing to.
        const shell = await mountShell();
        await openTheRow(shell);
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();

        const declared = lastPageLocation;
        if (declared === null) throw new Error('the shell declared no page location for its selection');
        const backLocation = declared.backLocation;
        // A selection-free step, declared with the selection and not before it.
        expect(backLocation).toBeDefined();
        expect(backLocation).not.toBe(declared.subPath);

        // The location the shell itself asked for, settled and delivered back.
        // It must NOT close anything: the reader is looking at the entry it
        // names, and a rule that fired here would slam the detail shut on the
        // render after every press.
        await act(async () => { await shell.updatePageLocation(declared.subPath); });
        await expect(shell.getByText(DETAIL_BODY_TEXT)).resolves.toBeDefined();

        // Now the host walks the declared step. The location names no entry.
        await act(async () => { await shell.updatePageLocation(backLocation as string); });

        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
        await expect(shell.getByRole('button', {
            name: 'Replace the duplicated normalizer',
        })).resolves.toBeDefined();
    });

    it('says the selected entry left the list rather than closing the detail by itself', async () => {
        const shell = await mountShell();
        await openTheRow(shell);

        // The next pass observes nothing, so the selected row leaves the window
        // while the selection — which is the reader's, not the window's —
        // stays. `core/SURFACE.md` §3.1 keeps it for exactly this.
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        harness.observes.current = false;
        await act(async () => {
            await refreshTriageListWindow('manual', shell.context.hostApi, harness.ephemeralSharedScope);
        });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.getByText('This entry is no longer in the list')).resolves.toBeDefined();
        // Silently falling back to the list would read as the surface closing
        // the detail on its own, with no account of where the entry went.
        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
    });

    it('refuses a selection whose route would not fit instead of dropping it silently', async () => {
        // `core/SURFACE.md` §3.2. The 1,024-byte bound is real and fails closed
        // in transport, but the page used to discard that refusal: the reducer
        // had already opened the entry, so the reader ended up on a detail
        // screen their URL did not name — unshareable, unreloadable, and
        // silent about it. The preflight moves the refusal in front of the
        // reducer, where it can still be shown and still preserves the lens.
        const selection = TriageEntryRefV1Schema.parse({
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: LONG_SCOPE,
            entryId: LONG_ENTRY_ID,
        });
        const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
        const selectionSegmentBytes = bytes(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query: 'x', selection,
        })) - bytes(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query: 'x', selection: null,
        }));
        // The padding is the settled query, and the query now REACHES the
        // window (`core/SURFACE.md` §6) — so it is a run the target row's own
        // summary contains. A run nothing matched would empty the list, and the
        // press this case is about would have nothing to press.
        const query = SUMMARY_PADDING.slice(
            0,
            PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1 - selectionSegmentBytes - 1,
        );
        const openedAt = buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query, selection: null,
        });
        // The page's own location is legal; only ADDING the selection is not.
        expect(bytes(openedAt)).toBeLessThanOrEqual(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1);
        expect(bytes(openedAt) + selectionSegmentBytes)
            .toBeGreaterThan(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1);

        const shell = await mountShell({ subPath: openedAt });
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: LONG_REF_ROW_TITLE }));
        });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
        await expect(shell.getByText('That entry could not be opened')).resolves.toBeDefined();
        // The prior effective lens survives: the row is still listed under the
        // same query the page was opened at.
        await expect(shell.getByRole('button', { name: LONG_REF_ROW_TITLE }))
            .resolves.toBeDefined();
        // And the host was never asked, so no location moved either.
        expect(lastPageLocation).toBeNull();
    });

    it('opens the entry a Composer launch named, over the route the page was mounted at', async () => {
        // `core/SURFACE.md` §3.2's deciding direct-launch case, and `core/COMPOSER.md`
        // §7's assignment of it to `ui/surface.tsx`. **View details** produces a
        // complete strict launch input and the host carries it unchanged, so a
        // surface that forwards only `subPath` reports `{ kind: 'opened' }` and
        // silently drops the reader on the page's own prior location.
        //
        // The mounted route names A and the launch names B, so an entry read
        // from the route cannot pass for one read from the launch.
        const entryA = {
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: LONG_SCOPE,
            entryId: LONG_ENTRY_ID,
        } as const;
        const entryB = {
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '17',
        } as const;
        const shell = await mountShell({
            subPath: buildTriageRouteSubPathV1({
                ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
                selection: entryA,
            }),
            launchInput: buildTriageEntryDetailLaunchInput({
                entryRef: entryB,
                sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE },
            }) as unknown as JsonValue,
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        // B is what the reader is looking at, not the route's A.
        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        await expect(shell.queryByText(LONG_REF_ROW_TITLE)).resolves.toBeUndefined();

        // And acceptance is not complete at the reducer: the same location
        // writer every other selection uses was asked to replace the page
        // location, so the URL names B rather than the A it was opened at.
        const settled = lastPageLocation;
        if (settled === null) throw new Error('the launch selection wrote no page location');
        expect(settled.subPath).toBe(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
            selection: entryB,
        }));

        // The launch is consumed once. A mount that re-read it on every render
        // would reopen the detail the host's own Back step just closed.
        const backLocation = settled.backLocation;
        expect(backLocation).toBeDefined();
        await act(async () => { await shell.updatePageLocation(backLocation as string); });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
        await expect(shell.getByRole('button', {
            name: 'Replace the duplicated normalizer',
        })).resolves.toBeDefined();
    });

    it('never substitutes the window connection for a launched connection whose full observation is absent', async () => {
        // The authority half of the same rule `openEntryDetails` enforces on the
        // way out: a launch names ONE exact connection, and the page that
        // receives it must act under that one. The window makes its own
        // qualification for every row it lists, and for an entry two of the
        // reader's accounts both observe, that answer is the deterministic tie
        // break — never the account the reader actually pressed **View details**
        // on. Adopting a launch by entry identity alone therefore opens somebody
        // else's connection while the page looks exactly right.
        const entry = {
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '17',
        } as const;
        const shell = await mountShell({
            secondInstance: true,
            // The second connection is configured and therefore nameable, but
            // this pass did not observe the entry through it. Only the first
            // connection has a full observation the detail contract may admit.
            secondInstanceObservesEntry: false,
            launchInput: buildTriageEntryDetailLaunchInput({
                entryRef: entry,
                sourceInstance: { source: SOURCE, sourceInstanceId: SECOND_INSTANCE },
            }) as unknown as JsonValue,
        });
        const harness = currentHarness;
        if (harness === null) throw new Error('the shell was not mounted');
        await act(async () => {
            await refreshTriageListWindow('manual', shell.context.hostApi, harness.ephemeralSharedScope);
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        // This page can name the launched connection from configured-source
        // facts, but it must not hand the first connection's observation to
        // the second connection's detail renderer.
        await expect(shell.getByText('Second account')).resolves.toBeDefined();
        await expect(shell.getByText('No connection to open this through')).resolves.toBeDefined();
        expect(harness.readDetailInstanceIds).toEqual([]);
        // The header and refusal both stay on the launched connection; neither
        // silently falls through to the window's qualified account.
        await expect(shell.queryByText('Example account')).resolves.toBeUndefined();
    });

    it('falls through to the page location when the launch input is not admitted', async () => {
        // `openEntryDetails` admits the input through the SAME parser before it
        // navigates, so an inadmissible one only reaches here from something
        // else entirely. It is not a different page: the reader lands on the
        // location the host routed them to, which is what an ordinary open is.
        // The refused input names an entry that exists, under a connection to
        // ANOTHER source — the parser's `sourceMismatch` — so a surface that
        // forwarded it unvalidated would open the wrong entry rather than
        // crash, and would still pass a shallower assertion.
        const entryB = {
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '17',
        } as const;
        const shell = await mountShell({
            subPath: buildTriageRouteSubPathV1({
                ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
                selection: entryB,
            }),
            launchInput: {
                v: 1,
                kind: 'entryDetail',
                entryRef: {
                    source: SOURCE,
                    kindId: 'pull-request',
                    collisionScope: LONG_SCOPE,
                    entryId: LONG_ENTRY_ID,
                },
                sourceInstance: { source: OTHER_SOURCE, sourceInstanceId: INSTANCE },
            },
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.getByText('Replace the duplicated normalizer')).resolves.toBeDefined();
        await expect(shell.queryByText(LONG_REF_ROW_TITLE)).resolves.toBeUndefined();
    });

    it('refuses a Composer launch whose route would not fit, exactly as pressing that row is refused', async () => {
        // `core/SURFACE.md` §3.2 has ONE preflight site for row activation, and
        // `applyLensEdit` is it. The adoption used to dispatch `rowActivated`
        // raw, so a launch onto a page whose lens is already near the subpath
        // byte cap opened the detail with no location write and no refusal —
        // while pressing that same row on that same page WAS refused. Two
        // producers of one selection cannot disagree about whether it is legal.
        const entry = TriageEntryRefV1Schema.parse({
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: LONG_SCOPE,
            entryId: LONG_ENTRY_ID,
        });
        const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
        const selectionSegmentBytes = bytes(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query: 'x', selection: entry,
        })) - bytes(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query: 'x', selection: null,
        }));
        const query = SUMMARY_PADDING.slice(
            0,
            PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1 - selectionSegmentBytes - 1,
        );
        const openedAt = buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query, selection: null,
        });
        // The page's own location is legal; only ADDING the launched selection
        // to it is not.
        expect(bytes(openedAt)).toBeLessThanOrEqual(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1);
        expect(bytes(openedAt) + selectionSegmentBytes)
            .toBeGreaterThan(PLUGIN_UI_SUB_PATH_MAX_UTF8_BYTES_V1);

        const shell = await mountShell({
            subPath: openedAt,
            launchInput: buildTriageEntryDetailLaunchInput({
                entryRef: entry,
                sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE },
            }) as unknown as JsonValue,
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        await expect(shell.getByText('That entry could not be opened')).resolves.toBeDefined();
        // Nothing opened, so there is no detail region and no Close beside it.
        await expect(shell.queryByText('Close')).resolves.toBeUndefined();
        // The prior effective lens survives: the row is still listed under the
        // query the page was opened at.
        await expect(shell.getByRole('button', { name: LONG_REF_ROW_TITLE })).resolves.toBeDefined();
        // And the host was never asked, so no location moved either.
        expect(lastPageLocation).toBeNull();
    });

    it('selects an entry the page lens excludes and says so rather than doing nothing', async () => {
        // `core/SURFACE.md` §3.2 and `core/COMPOSER.md` §7: a ref the current
        // projection has not materialized STILL selects, and the header says so
        // rather than refusing. The adoption used to scan only the mounted
        // window — already filtered by the page's own lens — and fall off the
        // end with no else branch, so a launch onto a page carrying an ordinary
        // query produced no detail, no header, no location write and no message
        // at all, while the opener still reported `{ kind: 'opened' }`.
        const entryB = {
            source: SOURCE,
            kindId: 'pull-request',
            collisionScope: 'example/repository',
            entryId: '17',
        } as const;
        // An ordinary reader state, not a bounded window: a settled query the
        // OTHER row matches and the launched entry does not.
        const query = 'canonical';
        const openedAt = buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query });
        const shell = await mountShell({
            subPath: openedAt,
            launchInput: buildTriageEntryDetailLaunchInput({
                entryRef: entryB,
                sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE },
            }) as unknown as JsonValue,
        });
        await act(async () => { await Promise.resolve(); });
        await act(async () => { await Promise.resolve(); });

        // The selection is real, and the header names THIS cause. The entry did
        // not leave a window — this page's own query never listed it — so the
        // "no longer in the list / may return on the next refresh" sentence
        // would be false twice over: refreshing forever would not bring it back,
        // clearing the query would.
        await expect(shell.getByText('This entry is outside the current filter')).resolves.toBeDefined();
        await expect(shell.queryByText('This entry is no longer in the list')).resolves.toBeUndefined();

        // Acceptance is not complete at the reducer: the one route owner wrote
        // the result, so a copied link, reload and Back name the launched entry.
        const settled = lastPageLocation;
        if (settled === null) throw new Error('the launch selection wrote no page location');
        expect(settled.subPath).toBe(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, query, selection: entryB,
        }));

        // Closing returns to the list the page's lens really does produce: the
        // other row is listed and the launched entry is not. That exclusion is
        // what made the old fall-through silent.
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Close' }));
        });
        await expect(shell.getByRole('button', { name: LONG_REF_ROW_TITLE })).resolves.toBeDefined();
        await expect(shell.queryByRole('button', {
            name: 'Replace the duplicated normalizer',
        })).resolves.toBeUndefined();
    });

    it('says the source contributes no detail view rather than mounting nothing', async () => {
        const shell = await mountShell({ contributesDetail: false });

        await openTheRow(shell);

        await expect(shell.getByText('This source has no detail view')).resolves.toBeDefined();
        await expect(shell.queryByText(DETAIL_BODY_TEXT)).resolves.toBeUndefined();
    });
});
