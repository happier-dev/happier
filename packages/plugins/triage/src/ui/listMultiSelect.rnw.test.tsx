// @vitest-environment jsdom
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import { TriageListEntriesInputV1Schema } from '../actions/listEntriesProtocol.js';
import { readTriageActionsForSurface } from '../actions/actionsCatalog.js';
import {
    TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
    TriageReadActionsInputV1Schema,
} from '../actions/actionsCatalogProtocol.js';
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
import { TRIAGE_ACTIONS_SETTING_ID_V1 } from '../settings/actions.js';
import { createTestkitAccountSettings } from '../settings/testkit/accountSettings.test-support.js';
import { refreshTriageListWindow } from './window/mountedWindow.js';
import { renderSurface as renderShellSurface } from './surface.js';

/**
 * Keyed MULTI-selection on the PRs & Issues list, driven through the real
 * mounted vertical.
 *
 * The surface reducer's `focus` and `selection` are two independent SINGLE
 * cursors and stay that way: a bulk set is a THIRD fact, owned by the shared
 * `List`'s selection store, and building one must never open a detail or write
 * a location. These cases fail if the capability is not mounted, if it is
 * mounted over a Triage-local copy of the reducer, or if a modified press
 * collapses the set back into the detail cursor.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const SOURCE_PROTOCOL = Object.freeze({
    id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
});

/**
 * The host-projected source snapshot for this list mount. Bulk planning only
 * admits entries whose source currently declares the matching workflow
 * subject; the generic testkit snapshot intentionally contains no sources.
 */
const SOURCE_TARGETED_CONTRIBUTIONS = {
    target: {
        pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
        immutableGenerationId: 'triage-list-target-generation',
    },
    points: [{
        pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
        protocols: [{
            protocol: SOURCE_PROTOCOL,
            contributions: [{
                contributor: {
                    pluginId: SOURCE.pluginId,
                    contributionId: SOURCE.localId,
                    immutableGenerationId: 'example-forge-generation',
                },
                protocol: SOURCE_PROTOCOL,
                descriptor: {
                    v: 1,
                    purpose: 'triage-source',
                    displayName: 'Example forge',
                    kinds: [{
                        id: 'pull-request',
                        workflowSubject: 'pullRequest',
                        displayName: 'Pull request',
                    }, {
                        id: 'issue',
                        workflowSubject: 'issue',
                        displayName: 'Issue',
                    }],
                },
                operations: [],
                surfaces: [],
            }],
        }],
    }],
} satisfies NonNullable<ReturnType<typeof createSurfaceContextFixture>['targetedContributions']>;

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

function createHarness(options: Readonly<{
    scanFails?: boolean;
    kindId?: string;
    /** A stored `triage.actions` catalog replacing the shipped seed. */
    actions?: JsonValue;
}> = {}) {
    const kindId = options.kindId ?? 'pull-request';
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    const accountSettings = createTestkitAccountSettings(
        options.actions === undefined ? {} : { [TRIAGE_ACTIONS_SETTING_ID_V1]: options.actions },
    );
    const referenceReads: string[] = [];
    const newSessionSeeds: unknown[] = [];
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
            kinds: [
                { id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' },
                { id: 'issue', workflowSubject: 'issue', displayName: 'Issue' },
            ],
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
                localRef: { kindId, collisionScope: 'example/repository', entryId: '17' },
                locator: testkitLocator(),
                snapshot: testkitSnapshot({ title: 'Replace the duplicated normalizer' }),
                viewer: testkitViewer(),
                sourceUpdatedAtMs: 3_000,
            }, {
                kind: 'present',
                localRef: { kindId, collisionScope: 'example/repository', entryId: '18' },
                locator: testkitLocator(),
                snapshot: testkitSnapshot({ title: 'Extract the selection reducer' }),
                viewer: testkitViewer(),
                sourceUpdatedAtMs: 2_000,
            }, {
                kind: 'present',
                localRef: { kindId, collisionScope: 'example/repository', entryId: '19' },
                locator: testkitLocator(),
                snapshot: testkitSnapshot({ title: 'Migrate the sessions list' }),
                viewer: testkitViewer(),
                sourceUpdatedAtMs: 1_000,
            }],
            evidence: { kind: 'walkFinished' },
        } satisfies TriageScanResultV1));

    async function executeAction(request: Readonly<{ action: unknown; input: unknown }>) {
        if (String(request.action) === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1) {
            return await readTriageActionsForSurface(
                TriageReadActionsInputV1Schema.parse(request.input),
                { settings: accountSettings.settings },
            );
        }
        if (String(request.action) === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
            return await listTriagePinnedEntries(
                TriageListPinnedEntriesInputV1Schema.parse(request.input),
                { collections, nowMs: () => 2_000 },
            );
        }
        if (String(request.action) === 'projects.list') return { items: [], truncated: false };
        if (String(request.action) === 'sessions.spawn.profiles.list') {
            referenceReads.push('sessions.spawn.profiles.list');
            return { items: [], truncated: false };
        }
        if (String(request.action) === 'prompts.invocations.list'
            || String(request.action) === 'prompts.invocation.resolve') {
            referenceReads.push(String(request.action));
            return { items: [], truncated: false };
        }
        return await listTriageEntries(TriageListEntriesInputV1Schema.parse(request.input), {
            sourceInstances: collections.sourceInstances,
            readAdmittedSources: async () => admitted,
            executeScan,
            nowMs: () => Date.now(),
        });
    }

    return { collections, executeAction, newSessionSeeds, referenceReads };
}

type Harness = ReturnType<typeof createHarness>;

const mounted: PluginUiTestkit[] = [];

async function mountShell(
    harness: Harness,
    options: Readonly<{ sourceContributions?: 'admitted' | 'absent' }> = {},
): Promise<Readonly<{
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
            surfaceContext: createSurfaceContextFixture(
                options.sourceContributions === 'absent'
                    ? {}
                    : { targetedContributions: SOURCE_TARGETED_CONTRIBUTIONS },
            ),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: {
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action, input }) => await harness.executeAction({ action, input }),
                selectActionInput: async ({ request }) => {
                    if (!('seed' in request)) return { kind: 'cancelled' } as never;
                    harness.newSessionSeeds.push(request.seed);
                    return { kind: 'newSessionSeeded' } as never;
                },
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
    await act(async () => { await refreshTriageListWindow('view'); });
    return { shell: fixture, locations };
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});


const rowOptions = () => Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
);
const optionNamed = (label: string) => rowOptions().find(
    (option) => option.textContent?.includes(label),
);
const selectedLabels = () => rowOptions()
    .filter((option) => option.getAttribute('aria-selected') === 'true')
    .map((option) => option.textContent ?? '');

async function pressRow(
    label: string,
    modifiers: Readonly<{ shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }> = {},
): Promise<void> {
    const option = optionNamed(label);
    expect(option).toBeDefined();
    await act(async () => {
        option?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }));
    });
}

/**
 * The bulk bar's own action picker, read from the shared `Form.Select`'s
 * radiogroup rather than from every radio on the page: the saved-view and sort
 * controls are radios too, and a page-wide query would report their options as
 * bulk actions.
 */
function offeredBulkActionLabels(): readonly string[] {
    const group = document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Action"]');
    if (group === null) return [];
    return Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'))
        .map((option) => option.getAttribute('aria-label') ?? '');
}

async function settle(): Promise<void> {
    for (let turn = 0; turn < 6; turn += 1) {
        await act(async () => { await Promise.resolve(); });
    }
}

describe('selecting several PRs & Issues rows', () => {
    it('enters the same selection mode from touch without opening a detail', async () => {
        const { locations } = await mountShell(createHarness());
        const before = locations.length;
        const enter = document.querySelector<HTMLElement>(
            '[data-testid="happier-list-selection-mode"]',
        );
        expect(enter).not.toBeNull();

        await act(async () => { enter?.click(); });
        await pressRow('Replace the duplicated normalizer');
        await pressRow('Migrate the sessions list');

        expect(selectedLabels()).toEqual([
            expect.stringContaining('Replace the duplicated normalizer'),
            expect.stringContaining('Migrate the sessions list'),
        ]);
        expect(document.querySelector('[data-testid="triage-bulk-action-bar"]')).not.toBeNull();
        expect(locations.slice(before)).toEqual([]);
    });

    it('builds a keyed set with the command modifier without opening a detail', async () => {
        const { locations } = await mountShell(createHarness());
        const before = locations.length;

        await pressRow('Replace the duplicated normalizer', { ctrlKey: true });
        // Asserted before the second press so this states the contract rather
        // than reporting its consequence: a modified press builds a set, and an
        // opened detail replaces the list in the stacked composition, which
        // would leave the next row unreachable.
        expect(locations.slice(before)).toEqual([]);

        await pressRow('Migrate the sessions list', { ctrlKey: true });

        expect(selectedLabels()).toEqual([
            expect.stringContaining('Replace the duplicated normalizer'),
            expect.stringContaining('Migrate the sessions list'),
        ]);
        // The detail cursor never moved, so the route owner wrote nothing: a set
        // is not a selection, and collapsing the two would open an entry the
        // reader did not ask for.
        expect(locations.slice(before)).toEqual([]);
    });

    it('extends a contiguous run from the anchor with Shift', async () => {
        const { locations } = await mountShell(createHarness());
        const before = locations.length;

        await pressRow('Replace the duplicated normalizer', { ctrlKey: true });
        expect(locations.slice(before)).toEqual([]);

        await pressRow('Migrate the sessions list', { shiftKey: true });

        expect(selectedLabels()).toHaveLength(3);
        expect(locations.slice(before)).toEqual([]);
    });

    it('mounts the bulk action bar with all three destinations as soon as a set exists', async () => {
        // Anti-dormancy: the bar, the action catalog it reads and the bulk
        // executor behind it are reachable from the mounted list, not just
        // present in the tree. Before this they were built and consumed by
        // nothing.
        const { locations } = await mountShell(createHarness());
        const before = locations.length;

        expect(document.querySelector('[data-testid="triage-bulk-action-bar"]')).toBeNull();

        await pressRow('Replace the duplicated normalizer', { ctrlKey: true });

        expect(document.querySelector('[data-testid="triage-bulk-action-bar"]')).not.toBeNull();
        for (const destination of [
            'oneSessionForAllEntries',
            'oneSessionPerEntry',
            'attachAllToNewSession',
        ]) {
            expect(
                document.querySelector(`[data-testid="triage-bulk-${destination}"]`),
                destination,
            ).not.toBeNull();
        }
        // Building a set never opened a detail, so the bar cannot have arrived
        // by replacing the list.
        expect(locations.slice(before)).toEqual([]);
    });

    it('offers only the configured actions the selected subjects are offered', async () => {
        // `appliesTo` answers WHICH SUBJECTS an action is offered on
        // (`PLAN.md` §0a). The seeded `Review` action is pull-request-only, so
        // an issue-only set must not be offered it: a control whose every
        // reachable outcome is `actionInapplicable` is a dead end the offer
        // owner already knows about.
        await mountShell(createHarness({ kindId: 'issue' }));

        await pressRow('Replace the duplicated normalizer', { ctrlKey: true });

        const offered = offeredBulkActionLabels();
        expect(offered).toEqual(['Ask', 'Fix']);
    });

    it('still offers a pull-request-only action to a pull-request set', async () => {
        // The positive twin: the filter above must narrow by subject, not
        // simply stop offering the third action.
        await mountShell(createHarness());

        await pressRow('Replace the duplicated normalizer', { ctrlKey: true });

        const offered = offeredBulkActionLabels();
        expect(offered).toEqual(['Ask', 'Fix', 'Review']);
    });

    it('keeps the count and the clear control when nothing configured applies', async () => {
        // Narrowing the offer must not be able to take the shared bar away: a
        // reader who has selected rows still has to see how many and be able to
        // let them go, and the reason nothing is offered is said rather than
        // left as an empty footer.
        const harness = createHarness({
            actions: {
                v: 1,
                actions: [{
                    actionId: 'triage-errors',
                    label: 'Triage errors',
                    enabled: true,
                    appliesTo: ['errorIssue'],
                    profileId: null,
                    workspaceMode: 'reference_only',
                    target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
                }],
            },
        });
        await mountShell(harness);

        await pressRow('Replace the duplicated normalizer', { ctrlKey: true });

        expect(document.querySelector('[data-testid="triage-bulk-action-bar"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="triage-bulk-oneSessionForAllEntries"]')).toBeNull();
        expect(document.body.textContent).toContain('1 selected');
        expect(document.body.textContent).toContain('None of your configured actions');
    });

    it('settles applicability before it spends a host read on the action\u2019s references', async () => {
        // The reachable ordering case: the rows were retained from a source
        // contribution the host no longer admits, so no selected entry resolves
        // a workflow subject. Resolving the action's launch profile first spends
        // a host read on a press that can start nothing and then reports the
        // profile as the reason, which sends the reader to Configure actions to
        // fix something that is not what stopped them.
        const harness = createHarness({
            actions: {
                v: 1,
                actions: [{
                    actionId: 'ask',
                    label: 'Ask',
                    enabled: true,
                    appliesTo: ['issue', 'pullRequest', 'errorIssue', 'other'],
                    profileId: 'profile-that-is-gone',
                    workspaceMode: 'reference_only',
                    target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
                }],
            },
        });
        const { shell } = await mountShell(harness, { sourceContributions: 'absent' });

        await pressRow('Replace the duplicated normalizer', { ctrlKey: true });
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'One session for all' }));
        });
        await settle();

        expect(harness.referenceReads).toEqual([]);
        expect(document.body.textContent).toContain('1 could not be used');
        expect(document.body.textContent).not.toContain('launch profile no longer exists');
    });

    it('hands every selected entry to the host-owned New Session seed', async () => {
        const harness = createHarness();
        const { shell, locations } = await mountShell(harness);

        await pressRow('Replace the duplicated normalizer', { ctrlKey: true });
        await pressRow('Extract the selection reducer', { ctrlKey: true });

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Attach to New Session' }));
        });
        await settle();

        // The plugin asks the host once; it does not create a Session, a link
        // or a second draft owner while the reader is still editing the seed.
        expect(harness.newSessionSeeds).toHaveLength(1);
        expect(harness.newSessionSeeds[0]).toMatchObject({
            attachments: [{
                value: {
                    value: { entryRef: expect.objectContaining({ entryId: '17' }) },
                },
            }, {
                value: {
                    value: { entryRef: expect.objectContaining({ entryId: '18' }) },
                },
            }],
        });
        expect(locations).toEqual([]);
    });

    it('still opens a detail on an unmodified press while no set is being built', async () => {
        const { locations } = await mountShell(createHarness());
        const before = locations.length;

        await pressRow('Replace the duplicated normalizer');

        expect(locations.slice(before).length).toBeGreaterThan(0);
    });
});
