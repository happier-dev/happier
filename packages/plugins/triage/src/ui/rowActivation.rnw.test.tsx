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
import { triageListRowTestId } from './list/rows.js';

/**
 * Opening a row, driven through the real mounted vertical.
 *
 * Every row used to render as inert text: the shell never gave the shared
 * `List` a selection owner, so pointer, touch and keyboard activation had
 * nowhere to go, the selection reducer had no production caller, and the route
 * owner never wrote a location. These cases fail if any link in that chain is
 * missing again — including the one that is easiest to lose, the qualified
 * source instance the activated row must carry.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';

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

function createHarness(options: Readonly<{ scanFails?: boolean }> = {}) {
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

    const executeScan: TriageAdmittedOperationExecutorV1 = async () => (options.scanFails === true
        ? ({
            kind: 'failed',
            // A REAL source failure, admitted by the published failure schema.
            // The predecessor fixture carried `{ class, message }`, which the
            // closed schema rejects — so the list result never parsed, the lane
            // never reported `failed`, and this case proved a transport
            // rejection while claiming to prove a failing source.
            failure: {
                class: 'transient',
                code: 'example/unreachable',
                detail: 'Example forge is not answering.',
            },
        } satisfies TriageScanResultV1)
        : ({
            kind: 'complete',
            observations: [{
                kind: 'present',
                localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
                locator: testkitLocator(),
                snapshot: testkitSnapshot({ title: 'Replace the duplicated normalizer' }),
                viewer: testkitViewer(),
                sourceUpdatedAtMs: 3_000,
            }],
            evidence: { kind: 'walkFinished' },
        } satisfies TriageScanResultV1));

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

    return { collections, executeAction };
}

type Harness = ReturnType<typeof createHarness>;

const mounted: PluginUiTestkit[] = [];

async function mountShell(harness: Harness): Promise<Readonly<{
    shell: PluginUiTestkit;
    locations: readonly string[];
}>> {
    const locations: string[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId: 'triage',
                generation: 'triage-list-mount',
            },
            surface: renderShellSurface,
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: {
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action, input }) => await harness.executeAction({ action, input }),
                // The host owns history and settlement; the surface only writes
                // the lens and consumes what settles.
                replacePageLocation: ({ subPath }) => {
                    locations.push(subPath);
                    return subPath;
                },
            },
        });
    });
    mounted.push(fixture);
    await act(async () => { await refreshTriageListWindow('view', fixture.context.hostApi); });
    return { shell: fixture, locations };
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('opening a PRs & Issues row', () => {
    it('makes each row an activatable option rather than inert text', async () => {
        const { shell } = await mountShell(createHarness());

        // `option` is the semantic the shared List gives a row only once the
        // shell supplies a selection owner. Without it the row is unreachable
        // by pointer, touch, keyboard and assistive technology alike.
        expect(await shell.getAllByRole('option', {
            name: 'Replace the duplicated normalizer',
        })).toHaveLength(1);
    });

    it('exposes the canonical collision-safe entry key as a stable native automation id', async () => {
        await mountShell(createHarness());

        const rowKey = JSON.stringify([
            SOURCE.pluginId,
            SOURCE.localId,
            'pull-request',
            'example/repository',
            '17',
        ]);
        expect([...document.querySelectorAll('[data-testid]')].some(
            (element) => element.getAttribute('data-testid') === triageListRowTestId(rowKey),
        )).toBe(true);
    });

    it('writes the activated entry into the shareable location', async () => {
        const { shell, locations } = await mountShell(createHarness());
        const before = locations.length;

        await act(async () => {
            await shell.press(await shell.getByRole('option', {
                name: 'Replace the duplicated normalizer',
            }));
        });

        const written = locations.slice(before);
        expect(written.length).toBeGreaterThan(0);
        // The canonical encoding names every component of the entry reference,
        // percent-encoded, so a copied location selects the same entry rather
        // than a different one whose components happen to join to the same
        // string.
        expect(written[written.length - 1]).toBe(
            'e,happier.example.source,example-forge,pull-request,example%2Frepository,17',
        );
    });

    it('does not claim every source answered when a source failed', async () => {
        const { shell } = await mountShell(createHarness({ scanFails: true }));

        // Named, not "some sources": the reader has to know which connection to
        // go and fix, and the source's own words are quoted rather than the
        // published classification word (`REQ-01`).
        await expect(shell.getByText('example/repository could not be read'))
            .resolves.toEqual({ content: 'example/repository could not be read' });
        await expect(shell.getByText('Example forge is not answering.'))
            .resolves.toEqual({ content: 'Example forge is not answering.' });
        // The old shell said this under a failure banner, which told a reader
        // that nothing needed them while a source was down.
        await expect(shell.queryByText(
            'Every configured source answered, and none of them has an entry for you right now.',
        )).resolves.toBeUndefined();
    });
});
