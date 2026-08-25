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
    TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
    TriageReadActionsResultV1Schema,
} from '../actions/actionsCatalogProtocol.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from '../actions/entryDetailProtocol.js';
import {
    TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
    TriageStartEntrySessionInputV1Schema,
    type TriageStartEntrySessionInputV1,
} from '../actions/entrySessionProtocol.js';
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
import { triageActionImmediateRefusalV1 } from './header/useEntrySessionStart.js';

/**
 * The product's headline feature, pressed.
 *
 * `startEntrySession`, its Action, its workspace-mode gate, the New Session
 * settlement projection and the action controls were all complete and
 * unit-tested, and NOTHING rendered them: a reader could open an entry and
 * start nothing from it. A component no surface mounts is a dormant feature no
 * unit test can catch, which is why this case drives the real vertical — the
 * real shell, the real selection reducer, the real list Action over real
 * Collections, the real detail read, the real header projection and the real
 * controls — and presses a real button.
 *
 * The boundaries replaced are genuine host ones: the Action transport and the
 * host's own New Session selection. Every Triage decision between a press and
 * the request that leaves — which actions this subject is offered, which are
 * blocked, and what each press declares it needs on disk — runs for real.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: 'happier.example.source', localId: 'example-forge' });
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const ENTRY_TITLE = 'Replace the duplicated normalizer';
const ENTRY_REF = Object.freeze({
    source: SOURCE,
    kindId: 'pull-request',
    collisionScope: 'example/repository',
    entryId: '17',
});

/**
 * The source's own declared descriptor, as the detail read carries it back.
 *
 * `workflowSubject` reaches the controls only through this. The entry's kind is
 * the source's word, never a guess from the row, and the section is
 * deliberately absent until the descriptor answers — so this fixture is what
 * makes the offered set falsifiable rather than universal.
 */
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

/**
 * The forge repository this entry belongs to, exactly as its source declares
 * it. It is the left half of the launch-placement join.
 */
const REPOSITORY = Object.freeze({
    kind: 'github',
    deployment: 'https://example.test',
    repository: 'example/repository',
});

/** One persisted project whose working snapshot resolved the SAME repository. */
function projectRow(overrides: Readonly<Record<string, unknown>> = {}) {
    return {
        projectKey: { id: 'workspace-1' },
        serverId: 'server-a',
        machineId: 'machine-a',
        rootPath: '/checkouts/repository',
        label: 'repository',
        reachable: true,
        forge: REPOSITORY,
        worktrees: [],
        ...overrides,
    };
}

/** What the host settles once the reader has picked an Agent and a directory. */
const SETTLED_DRAFT = Object.freeze({
    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
    directory: '/workspaces/example',
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude', localId: 'claude' } },
});

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

type Harness = Readonly<{
    executeAction: (request: Readonly<{ action: unknown; input: unknown }>) => Promise<unknown>;
    /** Every start request that actually left this mount, in order. */
    startRequests: readonly TriageStartEntrySessionInputV1[];
    /** Set false to make the reader close the host's New Session surface. */
    setDraftSettles: (settles: boolean) => void;
    draftSettles: () => boolean;
    /** What `projects.list` answers, and whether it admits it truncated. */
    setRegistry: (registry: Readonly<{ items: readonly unknown[]; truncated: boolean }>) => void;
    /** The configured catalogue this mount reads, when the test pins one. */
    setActions: (actions: readonly unknown[] | null) => void;
    /** What the Launch Profile catalogue answers. */
    setProfiles: (profiles: readonly unknown[]) => void;
    /** What the Agent inventory answers. */
    setBackends: (backends: readonly unknown[]) => void;
    /** Typed start outcomes returned in order; the last one is then retained. */
    setStartResults: (results: readonly unknown[]) => void;
}>;

function createHarness(): Harness {
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow()));
    const startRequests: TriageStartEntrySessionInputV1[] = [];
    let draftSettles = true;
    let registry: Readonly<{ items: readonly unknown[]; truncated: boolean }> = {
        items: [],
        truncated: false,
    };
    let actions: readonly unknown[] | null = null;
    let profiles: readonly unknown[] = [];
    let backends: readonly unknown[] = [];
    let startResults: readonly unknown[] = [{
        v: 1,
        type: 'opened',
        sessionId: 'session-a',
        disposition: 'created',
        delivery: 'notRequested',
    }];
    let startResultIndex = 0;

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
        descriptor: DESCRIPTOR,
        operations: { listInstances: {}, scan: { role: 'scan' }, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1];

    const executeScan: TriageAdmittedOperationExecutorV1 = async () => ({
        kind: 'complete',
        observations: [{
            kind: 'present',
            localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
            locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: ENTRY_TITLE }),
            viewer: testkitViewer(),
            sourceUpdatedAtMs: 3_000,
            repository: REPOSITORY,
        }],
        evidence: { kind: 'walkFinished' },
    } satisfies TriageScanResultV1);

    async function executeAction(request: Readonly<{ action: unknown; input: unknown }>): Promise<unknown> {
        const action = String(request.action);
        if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
            return await listTriagePinnedEntries(
                TriageListPinnedEntriesInputV1Schema.parse(request.input),
                { collections, nowMs: () => 2_000 },
            );
        }
        if (action === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) {
            // The descriptor is what the offered controls are chosen from; the
            // instance is the one the window selected for this row.
            return {
                kind: 'read',
                instance: configuredInstance(),
                linkedSessions: [],
                linkedSessionsHasMore: false,
                sourceDescriptor: DESCRIPTOR,
            };
        }
        if (action === 'projects.list') return registry;
        if (action === 'sessions.spawn.profiles.list') return { items: profiles };
        if (action === 'agents.backends.list') return { items: backends };
        // Only a test that PINS a catalogue answers here; otherwise the read
        // fails exactly as it did before and the mount shows the shipped seed.
        if (action === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1 && actions !== null) {
            return { v: 1, availability: 'parsed', actions, revision: 'revision-1' };
        }
        if (action === TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1) {
            // Admitted by the Action's own published input schema, so a request
            // the wire would reject cannot be recorded as one that left.
            startRequests.push(TriageStartEntrySessionInputV1Schema.parse(request.input));
            const result = startResults[Math.min(startResultIndex, startResults.length - 1)];
            startResultIndex += 1;
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
        executeAction,
        get startRequests() {
            return startRequests;
        },
        setDraftSettles: (settles: boolean) => { draftSettles = settles; },
        draftSettles: () => draftSettles,
        setRegistry: (next) => { registry = next; },
        setActions: (next) => {
            if (next === null) {
                actions = null;
                return;
            }
            const parsed = TriageReadActionsResultV1Schema.safeParse({
                    v: 1,
                    availability: 'parsed',
                    actions: next,
                    revision: 'revision-1',
                });
            if (!parsed.success) {
                throw new Error(JSON.stringify(parsed.error.issues));
            }
            actions = parsed.data.actions;
        },
        setProfiles: (next) => { profiles = next; },
        setBackends: (next) => { backends = next; },
        setStartResults: (next) => {
            startResults = next;
            startResultIndex = 0;
        },
    };
}

const mounted: PluginUiTestkit[] = [];

/** How many times this mount opened the host's New Session surface. */
let draftsOpened = 0;
/** Exactly what each of those openings was seeded with. */
let draftSeeds: unknown[] = [];
/** Seeds handed to the host-owned New Session authoring surface. */
let newSessionSeeds: unknown[] = [];

async function mountShell(harness: Harness): Promise<PluginUiTestkit> {
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId: 'triage',
                generation: 'triage-action-mount',
            },
            surface: renderShellSurface,
            surfaceContext: createSurfaceContextFixture(),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            handlers: {
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action, input }) =>
                    await harness.executeAction({ action, input }) as never,
                selectActionInput: async ({ request }) => {
                    if ('seed' in request) {
                        newSessionSeeds.push(request.seed);
                        return { kind: 'newSessionSeeded' } as never;
                    }
                    draftsOpened += 1;
                    draftSeeds.push(request.draft);
                    return harness.draftSettles()
                        ? { kind: 'serverStartDraft', draft: SETTLED_DRAFT } as never
                        : { kind: 'cancelled' } as never;
                },
                replacePageLocation: ({ subPath }) => subPath,
            },
        });
    });
    mounted.push(fixture);
    await act(async () => { await refreshTriageListWindow('view'); });
    return fixture;
}

async function settle(): Promise<void> {
    for (let turn = 0; turn < 6; turn += 1) {
        await act(async () => { await Promise.resolve(); });
    }
}

async function openTheRow(shell: PluginUiTestkit): Promise<void> {
    await act(async () => {
        await shell.press(await shell.getByRole('option', { name: ENTRY_TITLE }));
    });
    // The detail read settles a turn after the press, and the descriptor it
    // carries is what the offered controls are chosen from.
    await settle();
}

async function pressAction(shell: PluginUiTestkit, name: string): Promise<void> {
    await act(async () => {
        await shell.press(await shell.getByRole('button', { name }));
    });
    await settle();
}

afterEach(async () => {
    draftsOpened = 0;
    draftSeeds = [];
    newSessionSeeds = [];
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the entry action controls on the mounted detail header', () => {
    it('renders the actions this entry subject is offered', async () => {
        const shell = await mountShell(createHarness());
        await openTheRow(shell);

        // The seeded catalogue, filtered by the source's own declared subject.
        // The seed contains only actions whose complete start paths are
        // reachable in current bytes. The formal `reviewStart` arm remains a
        // valid configured shape, but is not offered until its producers land.
        await expect(shell.getByRole('button', { name: 'Ask' })).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: 'Fix' })).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: 'Review' })).resolves.toBeDefined();
    }, 60_000);

    it('opens compose in New Session authoring with the selected entry and creates nothing', async () => {
        const harness = createHarness();
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Ask');

        // Compose hands editable authoring state to the host and stops. The
        // Session, link and Message do not exist unless the reader later sends
        // from that canonical screen, so closing it creates nothing.
        expect(harness.startRequests).toEqual([]);
        expect(newSessionSeeds).toHaveLength(1);
        expect(newSessionSeeds[0]).toMatchObject({
            attachments: [{
                value: {
                    value: {
                        v: 1,
                        entryRef: ENTRY_REF,
                        sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE },
                    },
                },
            }],
        });
    }, 60_000);

    it('keeps ambiguous repository placements as candidates in a compose seed', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'compose-ambiguous',
            label: 'Ask where',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: null,
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
        }]);
        harness.setRegistry({
            items: [
                projectRow({ projectKey: { id: 'workspace-api' }, machineId: 'machine-a', rootPath: '/checkouts/api' }),
                projectRow({ projectKey: { id: 'workspace-web' }, machineId: 'machine-b', rootPath: '/checkouts/web' }),
            ],
            truncated: false,
        });
        const shell = await mountShell(harness);
        await openTheRow(shell);

        // The Account-backed action catalog arrives asynchronously. Wait for
        // this exact configured action rather than asserting a race against the
        // mount's initial retained catalog, then press the real semantic
        // control.
        await act(async () => {
            await shell.press(await shell.findByRole('button', { name: 'Ask where' }));
        });
        await settle();

        expect(harness.startRequests).toEqual([]);
        expect(newSessionSeeds).toHaveLength(1);
        expect(newSessionSeeds[0]).toMatchObject({
            candidates: expect.arrayContaining([
                expect.objectContaining({
                    projectKey: { id: 'workspace-api' },
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/checkouts/api',
                }),
                expect.objectContaining({
                    projectKey: { id: 'workspace-web' },
                    serverId: 'server-a',
                    machineId: 'machine-b',
                    rootPath: '/checkouts/web',
                }),
            ]),
        });
        expect(newSessionSeeds[0]).not.toHaveProperty('placement');
    }, 60_000);

    it('retries a pending mounted start with the same logical identity', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'start',
            label: 'Start',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: null,
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'send' },
        }]);
        harness.setStartResults([
            { v: 1, type: 'creationPending', outcome: 'unknown' },
            {
                v: 1,
                type: 'opened',
                sessionId: 'session-a',
                disposition: 'created',
                delivery: 'notRequested',
            },
        ]);
        const shell = await mountShell(harness);
        await openTheRow(shell);

        const start = await shell.getByRole('button', { name: 'Start' });
        await act(async () => { await shell.press(start); });
        await settle();
        expect(harness.startRequests).toHaveLength(1);
        await act(async () => { await shell.press(start); });
        await settle();

        expect(harness.startRequests).toHaveLength(2);
        const [first, retry] = harness.startRequests;
        expect(retry?.destination).toEqual(first?.destination);
        expect(retry?.resume).toBeUndefined();
    }, 15_000);

    it('retries an unknown mounted delivery with the same creation and delivery identities', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'send',
            label: 'Send',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: null,
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'send' },
        }]);
        harness.setStartResults([
            {
                v: 1,
                type: 'opened',
                sessionId: 'session-a',
                disposition: 'created',
                delivery: 'outcomeUnknown',
            },
            {
                v: 1,
                type: 'opened',
                sessionId: 'session-a',
                disposition: 'created',
                delivery: 'alreadyAccepted',
            },
        ]);
        const shell = await mountShell(harness);
        await openTheRow(shell);

        const send = await shell.getByRole('button', { name: 'Send' });
        await act(async () => { await shell.press(send); });
        await settle();
        await act(async () => { await shell.press(send); });
        await settle();

        expect(harness.startRequests).toHaveLength(2);
        const [first, retry] = harness.startRequests;
        expect(retry?.destination).toEqual(first?.destination);
        expect(retry?.delivery?.idempotencyKey).toBe(first?.delivery?.idempotencyKey);
        expect(retry?.resume?.phase).toBe('openPending');
        expect(retry?.resume?.sessionId).toBe('session-a');
    }, 15_000);

    it('starts a repository session in the project the reader settled on', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'fix',
            label: 'Fix',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: null,
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'send' },
        }]);
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Fix');

        expect(harness.startRequests).toHaveLength(1);
        // Fix and Ask are two records differing in exactly one member, and that
        // member is what reaches the gate.
        expect(harness.startRequests[0]?.workspaceMode).toBe('repository');
        expect(harness.startRequests[0]?.destination.kind === 'new'
            ? harness.startRequests[0]?.destination.materialization
            : null).toEqual({ kind: 'selectedProject', directory: '/workspaces/example' });
    }, 60_000);

    it('blocks the pull-request action when the source cannot prepare a review workspace', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'pull-request-agent',
            label: 'Repair pull request',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: null,
            workspaceMode: 'pull_request',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'send' },
        }]);
        const shell = await mountShell(harness);
        await openTheRow(shell);

        // The blocked arm is the one whose DECLARED mode is `pull_request`,
        // independent of its label or target arm.
        const blocked = await shell.findByRole('button', { name: 'Repair pull request' });

        // This fixture admits no preparation operation, so this action would
        // resolve the workspace refusal every time. It is refused BEFORE the
        // press — an offered control that fails on contact is the failure this
        // states instead — so the disabled state is the assertion, and pressing
        // it is not something a reader can do.
        expect(blocked.state?.disabled).toBe(true);
        await expect(shell.press(blocked)).rejects.toThrow();

        expect(harness.startRequests).toEqual([]);
        await expect(shell.getByText(
            'This source cannot prepare a review workspace, so a pull request cannot be fixed here.',
        )).resolves.toBeDefined();
    }, 60_000);

    it('creates nothing when the reader later closes seeded New Session authoring', async () => {
        const harness = createHarness();
        const shell = await mountShell(harness);
        await openTheRow(shell);
        await pressAction(shell, 'Ask');

        // Opening authoring is the only host effect. Closing that screen later
        // cannot spend a creation key because this controller has already
        // stopped and never receives a settlement to start from.
        expect(harness.startRequests).toEqual([]);
        expect(newSessionSeeds).toHaveLength(1);
    }, 60_000);

    /**
     * The one-click launch, end to end (`PLAN.md` §0a A5/A8).
     *
     * Exactly one reachable checkout of this entry's repository, plus a Launch
     * Profile that names an Agent the inventory resolves, is a complete start:
     * every field the wire needs is known before the press finishes, so asking
     * the reader to confirm the two facts their own configuration already
     * stated is the interruption A5 exists to remove.
     */
    it('launches straight into the one reachable checkout when the profile resolves an agent', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'fix',
            label: 'Direct fix',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: 'profile-1',
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'send' },
        }]);
        harness.setProfiles([{
            id: 'profile-1',
            name: 'Repair',
            placement: 'automatic',
            checkout: 'reuse_workspace',
            preferredAgentTargetKey: 'backend:claude',
        }]);
        harness.setBackends([{
            targetKey: 'backend:claude',
            label: 'Claude Code',
            enabled: true,
            identity: { pluginId: 'happier.claude', localId: 'claude' },
        }]);
        // One reachable checkout, on a machine that is NOT the one this surface
        // is mounted on.
        harness.setRegistry({
            items: [projectRow({ machineId: 'machine-b', rootPath: '/checkouts/repository' })],
            truncated: false,
        });
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Direct fix');

        // The host's New Session surface was never opened: nothing was left for
        // the reader to settle.
        expect(draftSeeds).toEqual([]);
        expect(draftsOpened).toBe(0);
        expect(harness.startRequests).toHaveLength(1);
        const destination = harness.startRequests[0]?.destination;
        expect(destination?.kind === 'new' ? destination.spawn : null).toEqual({
            // The resolved checkout's OWN machine, not the surface's.
            executionTarget: { serverId: 'server-a', machineId: 'machine-b' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude', localId: 'claude' } },
            profileId: 'profile-1',
        });
        expect(destination?.kind === 'new' ? destination.materialization : null)
            .toEqual({ kind: 'selectedProject', directory: '/checkouts/repository' });
    }, 60_000);

    /**
     * A profile's CHECKOUT preference is answered, not resolved and dropped
     * (`PLAN.md` §0a A5/A8).
     *
     * `resolveTriageActionCheckoutV1` and `actionResolution.ts#readCheckoutPreference`
     * both existed and were unit-tested, and NOTHING on the press path read
     * either: a profile whose author asked for a fresh worktree got a one-click
     * launch straight into the reused checkout instead — silently doing
     * something other than what they configured.
     *
     * The reachable start wire carries no worktree creation
     * (`actions/entrySessionProtocol.ts` admits `referenceOnly` and
     * `selectedProject` only, and `checkoutCreationDraft` is a prohibited spawn
     * member), so the honest answer is the one A5 already names for every case
     * a one-click launch cannot serve: degrade to the host's New Session
     * surface with what IS known seeded, where the reader owns the checkout.
     * Launching anyway would be the false success.
     */
    it('degrades to the New Session surface when the profile asks for a worktree', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'fix',
            label: 'Worktree fix',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: 'profile-1',
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'send' },
        }]);
        harness.setProfiles([{
            id: 'profile-1',
            name: 'Repair',
            placement: 'automatic',
            // The member this case exists for. Every other fact below is
            // identical to the direct-launch case above, so this is the only
            // thing that can change the outcome.
            checkout: 'create_worktree',
            preferredAgentTargetKey: 'backend:claude',
        }]);
        harness.setBackends([{
            targetKey: 'backend:claude',
            label: 'Claude Code',
            enabled: true,
            identity: { pluginId: 'happier.claude', localId: 'claude' },
        }]);
        harness.setRegistry({
            items: [projectRow({ machineId: 'machine-b', rootPath: '/checkouts/repository' })],
            truncated: false,
        });
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Worktree fix');

        // The surface was opened, seeded with the resolved candidate — the
        // reader still gets the answer their configuration produced, they are
        // just the one who settles the checkout.
        expect(draftsOpened).toBe(1);
        expect(draftSeeds).toEqual([{
            profileId: 'profile-1',
            executionTarget: { serverId: 'server-a', machineId: 'machine-b' },
            directory: '/checkouts/repository',
            checkoutIntent: 'createWorktree',
            candidates: [{
                projectKey: { id: 'workspace-1' },
                serverId: 'server-a',
                machineId: 'machine-b',
                rootPath: '/checkouts/repository',
                label: 'repository',
                reachable: true,
                worktrees: [],
            }],
        }]);
        // And what left is what they settled, not the reused checkout.
        expect(harness.startRequests).toHaveLength(1);
        const destination = harness.startRequests[0]?.destination;
        expect(destination?.kind === 'new' ? destination.spawn.executionTarget : null)
            .toEqual({ serverId: 'server-a', machineId: 'machine-a' });
    }, 60_000);

    /**
     * The defect this vertical exists to remove, stated as a falsifier.
     *
     * The placement resolved a checkout on `machine-b`. Seeding only its path
     * left the host to compose against whichever machine this surface is
     * mounted on, which pairs a directory from one machine with an execution
     * target on another and starts an agent at a path that does not exist
     * there. The machine now rides with the path, and the host composes the
     * draft against it
     * (`apps/ui/sources/components/sessions/new/serverStartDraftComposer.ts`).
     */
    it('seeds the machine the checkout is on, not only its path', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'fix',
            label: 'Fix',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: null,
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'send' },
        }]);
        harness.setRegistry({
            items: [projectRow({ machineId: 'machine-b' })],
            truncated: false,
        });
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Fix');

        expect(draftSeeds).toEqual([{
            executionTarget: { serverId: 'server-a', machineId: 'machine-b' },
            directory: '/checkouts/repository',
            checkoutIntent: 'reuseWorkspace',
            candidates: [{
                projectKey: { id: 'workspace-1' },
                serverId: 'server-a',
                machineId: 'machine-b',
                rootPath: '/checkouts/repository',
                label: 'repository',
                reachable: true,
                worktrees: [],
            }],
        }]);
    });

    /**
     * The registry's completeness fact, consumed where it decides something.
     *
     * One reachable match in a PAGE of the project registry is not one
     * reachable match in the registry, so the press degrades to the surface
     * rather than launching. `SETTLED_DRAFT` is on `machine-a`, so the start
     * that follows is the reader's own settled choice.
     */
    /**
     * The declared arm decides, and the label decides nothing (`PLAN.md` §0a A1).
     *
     * `target.kind` was stored, carried through the wire, the editor and the
     * JSON Schema, and read by NOTHING on the press path — so a `reviewStart`
     * action started an ordinary agent Session and the reader was shown a
     * Session with an agent in it where they had asked for a formal code
     * review. Reporting a different product as the one that was started is the
     * false-success class this program keeps producing.
     *
     * The two records here are the falsifier: the shipped LABELS are swapped
     * onto the opposite arms, and both declare `repository`, so nothing but
     * `target.kind` distinguishes them. An implementation that inferred the arm
     * from the word "review" — or from the workspace mode — gets both cases
     * exactly backwards.
     */
    it('routes the arm the action declared, never the one its label suggests', async () => {
        const harness = createHarness();
        harness.setActions([
            {
                // Labelled `Fix`, and it is the FORMAL REVIEW arm.
                actionId: 'mislabelled-review-start',
                label: 'Fix',
                enabled: true,
                appliesTo: ['pullRequest'],
                profileId: null,
                workspaceMode: 'repository',
                target: { kind: 'reviewStart', promptInvocationId: null },
            },
            {
                // Labelled `Run code review`, and it is the ORDINARY AGENT arm.
                actionId: 'mislabelled-agent',
                label: 'Run code review',
                enabled: true,
                appliesTo: ['pullRequest'],
                profileId: null,
                workspaceMode: 'repository',
                target: { kind: 'agent', promptInvocationId: null, delivery: 'send' },
            },
            {
                actionId: 'catalogue-loaded',
                label: 'Configured catalogue loaded',
                enabled: true,
                appliesTo: ['pullRequest'],
                profileId: null,
                workspaceMode: 'reference_only',
                target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
            },
        ]);
        const shell = await mountShell(harness);
        await openTheRow(shell);
        await expect(shell.getByRole('button', { name: 'Configured catalogue loaded' }))
            .resolves.toBeDefined();

        // The `reviewStart` arm is unavailable BEFORE anything is created: no
        // control is offered, no creation key is spent, and the host's New
        // Session surface is never opened. `review.start` scopes to exact
        // commits in a source-prepared worktree, and those producers are not
        // complete in current bytes.
        await expect(shell.queryByRole('button', { name: 'Fix' })).resolves.toBeUndefined();
        expect(harness.startRequests).toEqual([]);
        expect(draftsOpened).toBe(0);
        expect(triageActionImmediateRefusalV1({
            target: { kind: 'reviewStart', promptInvocationId: null },
            workspaceMode: 'repository',
        })).toBe('reviewStartUnsupported');

        // The agent arm, under the label that says "review", starts normally.
        await pressAction(shell, 'Run code review');
        expect(harness.startRequests).toHaveLength(1);
        expect(harness.startRequests[0]?.workspaceMode).toBe('repository');
    });

    it('does not launch directly from a registry that admitted it was partial', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'fix',
            label: 'Partial-registry fix',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: 'profile-1',
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, delivery: 'send' },
        }]);
        harness.setProfiles([{ id: 'profile-1', name: 'Repair', placement: 'automatic', preferredAgentTargetKey: 'backend:claude' }]);
        harness.setBackends([{
            targetKey: 'backend:claude',
            label: 'Claude Code',
            enabled: true,
            identity: { pluginId: 'happier.claude', localId: 'claude' },
        }]);
        harness.setRegistry({ items: [projectRow()], truncated: true });
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Partial-registry fix');

        expect(draftsOpened).toBe(1);
        expect(harness.startRequests).toHaveLength(1);
        const destination = harness.startRequests[0]?.destination;
        expect(destination?.kind === 'new' ? destination.spawn.executionTarget : null)
            .toEqual({ serverId: 'server-a', machineId: 'machine-a' });
    });
});
