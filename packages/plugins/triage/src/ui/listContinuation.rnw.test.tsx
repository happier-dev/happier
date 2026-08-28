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
    type TriageSourceScanObservationV1,
} from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import { TriageListEntriesInputV1Schema } from '../actions/listEntriesProtocol.js';
import {
    TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
    TriageListPinnedEntriesInputV1Schema,
    TriageSetEntryPinnedInputV1Schema,
    type TriageListPinnedEntriesResultV1,
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
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../projection/listWindow.js';
import { refreshTriageListWindow } from './window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';
import { renderSurface as renderShellSurface } from './surface.js';

/**
 * The continuation row, pressed through the real mounted vertical.
 *
 * The 56-row Action response bound is a transport limit and it stays one. It
 * was also, until now, a PRODUCT limit: the row that closes an unfinished
 * section was written as a statement with no control, so entry 57 could not be
 * reached at all — and the same defect at smaller scale left a reader's own
 * older pins both invisible and, because Unpin is only ever offered on a row,
 * unremovable.
 *
 * These cases press the row a reader would press, which is the wiring no owner
 * test can reach: that the shell hands each section its own copy and its own
 * demand, and that the press arrives at the owner which pages that section.
 *
 * **Why the source puts two entries in Open and the rest in Done.** The mounted
 * virtualizer renders its initial batch and never receives the layout or scroll
 * events that would extend it, so a section whose continuation row sits at
 * position 57 has no mounted row to press. Splitting the walk across the two
 * lanes puts one section's continuation row inside that batch while the walk
 * itself stays exactly what it must be — a full observation budget plus a
 * continuation, which is the only shape that makes the Action return one.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';

/** How many of each page's entries land in the Open lane; the rest are Done. */
const OPEN_PER_PAGE = 2;

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

function observation(input: Readonly<{
    entryId: string;
    title: string;
    sourceUpdatedAtMs: number;
    open: boolean;
}>): TriageSourceScanObservationV1 {
    return {
        kind: 'present',
        localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: input.entryId },
        locator: testkitLocator(),
        snapshot: testkitSnapshot({
            title: input.title,
            state: input.open
                ? { presentation: 'active', nativeLabel: 'Open' }
                : { presentation: 'closed', nativeLabel: 'Closed' },
        }),
        viewer: testkitViewer(),
        sourceUpdatedAtMs: input.sourceUpdatedAtMs,
    };
}

const admittedSources = [{
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

type Harness = Readonly<{
    executeAction: (request: Readonly<{ action: unknown; input: unknown }>) => Promise<unknown>;
    state: {
        sourceUnreachable: boolean;
        repeatMarksCursor: boolean;
        cycleMarksCursor: boolean;
    };
    ephemeralSharedScope: ReturnType<typeof createTriageEphemeralSharedScopeFixture>;
}>;

/**
 * A source that fills the Action's whole observation budget on every page and
 * always offers another, over a real Account Collection and the real scan
 * projection. Nothing between the press and either of those is stood in for.
 */
function createEntriesHarness(): Harness {
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow()));
    const state = {
        sourceUnreachable: false,
        repeatMarksCursor: false,
        cycleMarksCursor: false,
    };

    const executeScan: TriageAdmittedOperationExecutorV1 = async (unusedOperation, input) => {
        const scanInput = input as Readonly<{ page: { kind: string; continuation?: { token: string } } }>;
        const page = scanInput.page.kind === 'initial'
            ? 1
            : Number(scanInput.page.continuation?.token ?? '1');
        return {
            kind: 'page',
            observations: Array.from(
                { length: MAX_TRIAGE_LIST_WINDOW_ROWS_V1 },
                (unused, index) => observation({
                    entryId: `p${page}-${index}`,
                    title: `Change ${page}.${index}`,
                    // Descending across pages, so the newest-first order puts
                    // each appended window after the rows already on screen.
                    sourceUpdatedAtMs: 1_000_000 - (page * MAX_TRIAGE_LIST_WINDOW_ROWS_V1 + index),
                    open: index < OPEN_PER_PAGE,
                }),
            ),
            evidence: { kind: 'partial', reason: 'more-pages' },
            continuation: { v: 1, token: `${page + 1}` },
        } satisfies TriageScanResultV1;
    };

    return {
        state,
        ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
        async executeAction(request) {
            const action = String(request.action);
            if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
                TriageListPinnedEntriesInputV1Schema.parse(request.input);
                return { v: 1, pins: [] } satisfies TriageListPinnedEntriesResultV1;
            }
            if (state.sourceUnreachable) throw new Error('No machine is reachable for these sources.');
            return await listTriageEntries(TriageListEntriesInputV1Schema.parse(request.input), {
                sourceInstances: collections.sourceInstances,
                readAdmittedSources: async () => admittedSources,
                executeScan,
                nowMs: () => Date.now(),
            });
        },
    };
}

/**
 * The pinned section's own paging, at a page size the mounted virtualizer can
 * actually show a continuation row for.
 *
 * The two mark Actions answer from an in-memory set here, and that is the one
 * stand-in in this file. It is deliberate and bounded: the real Action's cursor
 * paging over the real marks query — a pin past the real page bound, reached and
 * then unpinned — is proved end to end in `ui/marks/pinCommand.test.ts`. What
 * cannot be proved there is the mounted press, and proving it against the real
 * 56-pin page bound would put the row to press outside the batch the
 * virtualizer mounts.
 */
function createPinsHarness(pinCount: number): Harness {
    const PAGE = 2;
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow()));
    const state = {
        sourceUnreachable: false,
        repeatMarksCursor: false,
        cycleMarksCursor: false,
    };
    /** Newest pin first, which is the order the marks index already returns. */
    const pins = Array.from({ length: pinCount }, (unused, index) => ({
        entryRef: entryRef(`${pinCount - 1 - index}`),
        markedAtMs: 1_000 + (pinCount - 1 - index),
        displayAtMark: {
            title: `Pinned change ${pinCount - 1 - index}`,
            scopeLabel: 'example/repository',
        },
    }));

    return {
        state,
        ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
        async executeAction(request) {
            const action = String(request.action);
            if (action === TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1) {
                const input = TriageSetEntryPinnedInputV1Schema.parse(request.input);
                const at = pins.findIndex((pin) => pin.entryRef.entryId === input.entryRef.entryId);
                if (!input.pinned && at >= 0) pins.splice(at, 1);
                return { v: 1, status: input.pinned ? 'pinned' : 'unpinned' };
            }
            if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
                const input = TriageListPinnedEntriesInputV1Schema.parse(request.input);
                const from = input.cursor === undefined ? 0 : Number(input.cursor);
                const to = Math.min(from + PAGE, pins.length);
                const nextCursor = to >= pins.length ? undefined : `${to}`;
                return {
                    v: 1,
                    pins: pins.slice(from, to),
                    ...(nextCursor === undefined
                        ? {}
                        : { nextCursor: input.cursor !== undefined && state.repeatMarksCursor
                            ? input.cursor
                            : state.cycleMarksCursor && input.cursor === '4'
                                ? '2'
                                : nextCursor }),
                } satisfies TriageListPinnedEntriesResultV1;
            }
            // A real configured source with nothing to walk, so the pinned
            // section's continuation row is the only one on screen.
            return await listTriageEntries(TriageListEntriesInputV1Schema.parse(request.input), {
                sourceInstances: collections.sourceInstances,
                readAdmittedSources: async () => admittedSources,
                executeScan: async () => ({
                    kind: 'complete',
                    observations: [],
                    evidence: { kind: 'walkFinished' },
                } satisfies TriageScanResultV1),
                nowMs: () => Date.now(),
            });
        },
    };
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

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted continuation row', () => {
    it('reaches the entries after the transport bound, and keeps the ones already listed', async () => {
        const harness = createEntriesHarness();
        const shell = await mountShell(harness);

        // The section is unfinished, so it closes with the stated row — and that
        // row now carries a control. It was inert from the day it was written,
        // which is what made entry 57 unreachable.
        await expect(shell.getByText('More entries may exist'))
            .resolves.toEqual({ content: 'More entries may exist' });
        await expect(shell.getByText('Change 1.0')).resolves.toEqual({ content: 'Change 1.0' });
        await expect(shell.queryByText('Change 2.0')).resolves.toBeUndefined();

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Load more' }));
        });

        // The next bounded window is on screen, and the first one is still there.
        await expect(shell.getByText('Change 2.0')).resolves.toEqual({ content: 'Change 2.0' });
        await expect(shell.getByText('Change 1.0')).resolves.toEqual({ content: 'Change 1.0' });
    });

    it('leaves every listed entry on screen when the append fails, and offers a retry', async () => {
        const harness = createEntriesHarness();
        const shell = await mountShell(harness);

        harness.state.sourceUnreachable = true;
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Load more' }));
        });

        // Not an error over an empty surface: the rows the reader already had
        // are untouched by a page that never arrived, so the honest presentation
        // is the same list plus an offer to try again.
        await expect(shell.getByText('More entries could not be loaded'))
            .resolves.toEqual({ content: 'More entries could not be loaded' });
        await expect(shell.getByText('Change 1.0')).resolves.toEqual({ content: 'Change 1.0' });

        harness.state.sourceUnreachable = false;
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Try again' }));
        });

        await expect(shell.getByText('Change 2.0')).resolves.toEqual({ content: 'Change 2.0' });
    });

    it('reaches a pin past the bounded page, and lets the reader remove it', async () => {
        const harness = createPinsHarness(4);
        const shell = await mountShell(harness);

        // The oldest pin is the one the page bound leaves out, and it is durable
        // intent with no upstream owner to recover it from.
        await expect(shell.queryByText('Pinned change 0')).resolves.toBeUndefined();
        await expect(shell.getByText('More pinned entries exist'))
            .resolves.toEqual({ content: 'More pinned entries exist' });

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Load more' }));
        });

        await expect(shell.getByText('Pinned change 0'))
            .resolves.toEqual({ content: 'Pinned change 0' });

        // Reachable is only half of it. Unpin is only ever offered on a row, so
        // a pin that could not be listed could not be removed either.
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Unpin Pinned change 0' }));
        });

        await expect(shell.queryByText('Pinned change 0')).resolves.toBeUndefined();
        // The write did not fold the section back to its first page: the rest of
        // the pins the reader had loaded are still on screen.
        await expect(shell.getByText('Pinned change 1'))
            .resolves.toEqual({ content: 'Pinned change 1' });
    });

    it('settles a non-advancing pins cursor without dropping the page it answered', async () => {
        const harness = createPinsHarness(6);
        const shell = await mountShell(harness);
        harness.state.repeatMarksCursor = true;

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Load more' }));
        });

        await expect(shell.getByText('Pinned change 3')).resolves.toBeDefined();
        await expect(shell.getByText('More pins could not be loaded')).resolves.toBeDefined();

        harness.state.repeatMarksCursor = false;
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Try again' }));
        });
        await expect(shell.queryByText('More pins could not be loaded')).resolves.toBeUndefined();
    });

    it('settles a cyclic pins cursor instead of replaying it forever', async () => {
        const harness = createPinsHarness(8);
        const shell = await mountShell(harness);
        harness.state.cycleMarksCursor = true;

        // The first append reaches cursor 4. The second walk is 2 -> 4 -> 2:
        // each individual cursor advances, but the walk has returned to a
        // position it already consumed and can never reach the two older pins.
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Load more' }));
        });
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Load more' }));
        });

        await expect(shell.getByText('Pinned change 2')).resolves.toBeDefined();
        await expect(shell.queryByText('Pinned change 0')).resolves.toBeUndefined();
        await expect(shell.getByText('More pins could not be loaded')).resolves.toBeDefined();
    });
});
