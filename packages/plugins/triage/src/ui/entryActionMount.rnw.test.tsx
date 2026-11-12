// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { Button } from '@happier-dev/plugin-ui';
import { createPluginUiTestkit, createPluginUiActionControlTestHost, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit, PluginUiTestkitOpenSurfaceInput } from '@happier-dev/plugin-sdk/testing';
import { TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1 } from '../actions/resolveResourceProtocol.js';
import { createTriageMountedUiActionHandler } from '../actions/mountedUi.js';
import { createTriageRunConfiguredActionHandler } from '../actions/configuredActionRun.js';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1, TriageMountedUiInputV1Schema } from '../actions/mountedUiProtocol.js';
import type {
    PluginUiSessionServerStartDraftV1,
    PluginUiTargetedContributionContributorV1,
    PluginUiTargetedContributionOperationV1,
    PluginUiTargetedContributionTargetV1,
} from '@happier-dev/plugin-sdk/ui';
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
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
    TriageReadActionsResultV1Schema,
} from '../actions/actionsCatalogProtocol.js';
import {
    TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
    TriageReadEntryDetailResultV1Schema,
} from '../actions/entryDetailProtocol.js';
import {
    TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
    TriageStartEntrySessionInputV1Schema,
    type TriageStartEntrySessionInputV1,
    type TriageStartEntrySessionResultV1,
} from '../actions/entrySessionProtocol.js';
import {
    TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1,
    TriageRunConfiguredActionInputV1Schema,
    TriageRunConfiguredActionResultV1Schema,
    type TriageRunConfiguredActionInputV1,
} from '../actions/configuredActionRunProtocol.js';
import {
    listTriageEntries,
    type TriageAdmittedOperationExecutorV1,
    type TriageAdmittedSourceV1,
} from '../actions/listEntries.js';
import { TriageListEntriesInputV1Schema } from '../actions/listEntriesProtocol.js';
import { reobserveTriageEntry } from '../actions/reobserveEntry.js';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReobserveEntryInputV1Schema } from '../actions/reobserveEntryProtocol.js';
import { toTriageWireObservation } from '../projection/listWindowWire.js';
import { listTriagePinnedEntries } from '../actions/userMarks.js';
import {
    TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    TriageListPinnedEntriesInputV1Schema,
} from '../actions/userMarksProtocol.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { TRIAGE_DEFAULT_ACTIONS_V1 } from '../settings/actions.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitTriageActionId } from '../sessions/testkit/entrySessionTestkit.test-support.js';
import {
    testkitLocator,
    testkitSnapshot,
    testkitViewer,
} from '../corpus/testkit/observations.test-support.js';
import { refreshTriageListWindow } from './window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';
import { renderSurface as renderShellSurface } from './surface.js';
import { TRIAGE_DETAIL_ATTENTION_TEST_ID_V1, TRIAGE_DETAIL_FOOTER_TEST_ID_V1 } from './detail/region.js';
import { TRIAGE_SHELL_FILL_TEST_ID_V1 } from './shell/root.js';
import { triageActionImmediateRefusalV1 } from './header/useEntrySessionStart.js';
import {
    TRIAGE_ROUTE_DEFAULT_LENS_V1,
    buildTriageRouteSubPathV1,
} from './navigation/location.js';

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
const SECOND_ENTRY_TITLE = 'Remove the stale route mirror';
const SECOND_ENTRY_REF = Object.freeze({
    ...ENTRY_REF,
    entryId: '18',
});

const TARGET_IDENTITY = Object.freeze({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    occurrenceId: 'target-occurrence-1',
    sourceCustody: { kind: 'managed', immutableGenerationId: 'target-generation-1', installSource: 'npm' },
} as const) satisfies PluginUiTargetedContributionTargetV1;
const SOURCE_CONTRIBUTOR = Object.freeze({
    pluginId: SOURCE.pluginId,
    contributionId: SOURCE.localId,
    occurrenceId: 'source-occurrence-1',
    sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-1', installSource: 'npm' },
} as const) satisfies PluginUiTargetedContributionContributorV1;

const PREPARE_REVIEW_WORKSPACE_OPERATION = Object.freeze({
    point: {
        pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
        protocol: {
            id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
            version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
        },
    },
    contributor: SOURCE_CONTRIBUTOR,
    role: 'prepareReviewWorkspace',
    action: { pluginId: SOURCE.pluginId, localId: 'prepare-review-workspace' },
}) satisfies PluginUiTargetedContributionOperationV1;

const GET_OPERATION = Object.freeze({
    ...PREPARE_REVIEW_WORKSPACE_OPERATION,
    role: 'get',
    action: { pluginId: SOURCE.pluginId, localId: 'get' },
}) satisfies PluginUiTargetedContributionOperationV1;

const PR_COMPARISON = { kind: 'pullRequest', locator: {
    providerId: 'forge', repository: 'example/repository', number: 17,
    baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40),
} } as const;

/**
 * The source's own declared descriptor, as this mount's targeted snapshot
 * carries it.
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

/**
 * A complete start (owner ruling "Agent actions: one shared flow", 2026-11-07): a profile whose Agent
 * resolves plus one reachable checkout. Anything less opens the prefilled New Session composer instead.
 */
function resolveDirectStart(harness: Readonly<{
    setProfiles: (profiles: readonly unknown[]) => void;
    setBackends: (backends: readonly unknown[]) => void;
    setRegistry: (registry: unknown) => void;
}>, rootPath = '/checkouts/repository'): void {
    harness.setProfiles([{ id: 'profile-1', name: 'Repair', placement: 'automatic',
        checkout: 'reuse_workspace', preferredAgentTargetKey: 'backend:claude' }]);
    harness.setBackends([{ targetKey: 'backend:claude', label: 'Claude Code', enabled: true,
        identity: { pluginId: 'happier.claude', localId: 'claude' } }]);
    harness.setRegistry({ items: [projectRow({ rootPath })], truncated: false });
}

/** What the host settles once the reader has picked an Agent and a directory. */
const SETTLED_DRAFT = Object.freeze({
    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
    directory: { kind: 'path', path: '/workspaces/example' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude', localId: 'claude' } },
} as const) satisfies PluginUiSessionServerStartDraftV1;

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
    descriptor: typeof DESCRIPTOR;
    executeAction: (request: Readonly<{ action: unknown; input: unknown }>) => Promise<unknown>;
    /** Every start request that actually left this mount, in order. */
    startRequests: readonly TriageStartEntrySessionInputV1[];
    configuredRequests: readonly TriageRunConfiguredActionInputV1[];
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
    /** Whether this fixture publishes the complete formal-review producer chain. */
    formalReviewReady: boolean;
    /** Every chooser engine-list request reached through this physical mount. */
    reviewEngineListRequests: readonly unknown[];
    comparisonOpens: readonly unknown[];
    setEntryListed(listed: boolean): void;
}>;

function createHarness(options: Readonly<{
    formalReviewReady?: boolean;
    reviewRevisionOnlyOnGet?: boolean;
    includeSecondEntry?: boolean;
    issue?: boolean;
    involvement?: readonly ('author' | 'assignee' | 'reviewRequested')[];
    /** The durable detail read answers `unavailable`, so the detail never becomes ready. */
    detailUnavailable?: boolean;
    comparisonRead?: () => Promise<unknown>;
    comparisonOpen?: () => Promise<unknown>;
}> = {}): Harness {
    const descriptor = options.issue === true
        ? { ...DESCRIPTOR, kinds: DESCRIPTOR.kinds.map((kind) => ({ ...kind, workflowSubject: 'issue' })) }
        : DESCRIPTOR;
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow()));
    const startRequests: TriageStartEntrySessionInputV1[] = [];
    const configuredRequests: TriageRunConfiguredActionInputV1[] = [];
    const reviewEngineListRequests: unknown[] = [];
    const comparisonOpens: unknown[] = [];
    const formalReviewReady = options.formalReviewReady === true;
    let draftSettles = true;
    let registry: Readonly<{ items: readonly unknown[]; truncated: boolean }> = {
        items: [],
        truncated: false,
    };
    let actions: readonly unknown[] | null = TRIAGE_DEFAULT_ACTIONS_V1;
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
    let entryListed = true;

    const admitted = [{
        contributor: SOURCE_CONTRIBUTOR,
        protocol: {
            id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
            version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
        },
        descriptor,
        operations: { listInstances: {}, scan: { role: 'scan' }, get: {} },
        surfaces: { detail: {} },
    } as unknown as TriageAdmittedSourceV1];

    const executeScan: TriageAdmittedOperationExecutorV1 = async () => ({
        kind: 'complete',
        observations: [
            ...(entryListed ? [{
                kind: 'present',
                localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
                locator: testkitLocator(),
                snapshot: testkitSnapshot({
                    title: ENTRY_TITLE,
                    ...(formalReviewReady && !options.reviewRevisionOnlyOnGet ? {
                        reviewRevision: {
                            baseSha: 'a'.repeat(40),
                            headSha: 'b'.repeat(40),
                            nativeRevision: 'revision-1',
                        },
                    } : {}),
                }),
                viewer: testkitViewer(options.involvement === undefined ? {} : { involvement: [...options.involvement] }),
                sourceUpdatedAtMs: 3_000,
                repository: REPOSITORY,
            } as const] : []),
            ...(options.includeSecondEntry === true ? [{
                kind: 'present' as const,
                localRef: { kindId: 'pull-request', collisionScope: 'example/repository', entryId: '18' },
                locator: testkitLocator(),
                snapshot: testkitSnapshot({ title: SECOND_ENTRY_TITLE }),
                viewer: testkitViewer(),
                sourceUpdatedAtMs: 2_000,
                repository: REPOSITORY,
            }] : []),
        ],
        evidence: { kind: 'walkFinished' },
    } satisfies TriageScanResultV1);

    async function executeAction(request: Readonly<{ action: unknown; input: unknown }>): Promise<unknown> {
        if (typeof request.action === 'object' && request.action !== null
            && 'localId' in request.action && request.action.localId === 'get') {
            return options.comparisonRead?.();
        }
        const action = testkitTriageActionId(request.action);
        if (action === TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1) {
            const result = await reobserveTriageEntry(TriageReobserveEntryInputV1Schema.parse(request.input), {
                readConfiguredInstance: async () => configuredInstance(),
                readSourceSnapshot: async () => ({ contributions: admitted }),
                // The external source's authoritative get can carry revision facts absent from its scan.
                executeGet: async (_operation, input) => ({
                    kind: 'present', localRef: input.localRef, locator: testkitLocator(),
                    snapshot: testkitSnapshot({ title: input.localRef.entryId === '18' ? SECOND_ENTRY_TITLE : ENTRY_TITLE,
                        ...(formalReviewReady ? {
                            reviewRevision: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), nativeRevision: 'revision-1' },
                        } : {}) }),
                    viewer: testkitViewer(options.involvement === undefined ? {} : { involvement: [...options.involvement] }),
                    repository: REPOSITORY,
                }),
                nowMs: () => Date.now() + 1,
            });
            if (result.kind !== 'observed') return result;
            const { entryRef, ...observation } = result.observation;
            return { kind: 'observed', entryRef, observation: toTriageWireObservation(observation) };
        }
        if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
            return await listTriagePinnedEntries(
                TriageListPinnedEntriesInputV1Schema.parse(request.input),
                { collections, nowMs: () => 2_000 },
            );
        }
        if (action === TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1) {
            if (options.detailUnavailable === true) return { kind: 'unavailable' };
            // The descriptor is what the offered controls are chosen from; the
            // instance is the one the window selected for this row.
            return TriageReadEntryDetailResultV1Schema.parse({
                kind: 'read',
                instance: configuredInstance(),
                linkedSessions: [],
            });
        }
        if (action === 'projects.list') return registry;
        if (action === 'session.open') { comparisonOpens.push(request.input); return options.comparisonOpen?.() ?? null; }
        if (action === 'sessions.spawn.profiles.list') return { items: profiles };
        if (action === 'agents.backends.list') return { items: backends };
        if (action === 'prompts.invocation.resolve') {
            return { status: 'resolved', text: 'Review the exact selected pull request.' };
        }
        if (action === 'review.engines.list') {
            reviewEngineListRequests.push(request.input);
            return {
                sessionId: 'session-review',
                items: [{ engineId: 'codex', label: 'Codex', enabled: true }],
            };
        }
        // The default answer is an authoritative absent-catalog projection of
        // the shipped seed. A seed is never exposed merely because this read
        // failed; `null` remains available to tests that need that outage.
        if (action === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1 && actions !== null) {
            return { v: 1, availability: 'parsed', actions, revision: 'revision-1' };
        }
        if (action === TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1) {
            // Admitted by the Action's own published input schema, so a request
            // the wire would reject cannot be recorded as one that left.
            const startInput = TriageStartEntrySessionInputV1Schema.parse(request.input);
            startRequests.push(startInput);
            const scripted = startResults[Math.min(startResultIndex, startResults.length - 1)];
            startResultIndex += 1;
            return typeof scripted === 'function' ? scripted(startInput) : scripted;
        }
        if (action === TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1) {
            // The host Action transport is the boundary; the mounted UI and
            // controller must hand it the canonical Session selector. Home
            // routing is execution metadata, covered by the controller suite;
            // this testkit handler exposes only the Action and its input.
            const input = TriageRunConfiguredActionInputV1Schema.parse(request.input);
            configuredRequests.push(input);
            if (input.handoff.sessionChoice.kind !== 'existing'
                || input.handoff.sessionChoice.session !== pickedSession?.sessionId) throw new Error('Expected picked Session handoff');
            return TriageRunConfiguredActionResultV1Schema.parse({
                v: 1,
                handoff: { kind: 'sendResult', session: pickedSession,
                    result: { status: 'accepted', localId: 'native-receipt' } },
            });
        }
        return await listTriageEntries(TriageListEntriesInputV1Schema.parse(request.input), {
            sourceInstances: collections.sourceInstances,
            readSourceSnapshot: async () => ({ contributions: admitted }),
            executeScan,
            nowMs: () => Date.now(),
        });
    }

    return {
        descriptor,
        executeAction,
        get startRequests() {
            return startRequests;
        },
        get configuredRequests() {
            return configuredRequests;
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
        formalReviewReady,
        get reviewEngineListRequests() {
            return reviewEngineListRequests;
        },
        comparisonOpens,
        setEntryListed: (listed) => { entryListed = listed; },
    };
}

const mounted: PluginUiTestkit[] = [];
const mountedActionControls = new WeakMap<PluginUiTestkit, ReturnType<typeof createPluginUiActionControlTestHost>>();
const refreshMountedShell = new WeakMap<PluginUiTestkit, (trigger?: 'view' | 'manual') => Promise<unknown>>();

/** How many times this mount opened the host's New Session surface. */
let draftsOpened = 0;
/** Exactly what each of those openings was seeded with. */
let draftSeeds: unknown[] = [];
/** Seeds handed to the host-owned New Session authoring surface. */
let newSessionSeeds: unknown[] = [];

async function mountShell(harness: Harness, hostedDetail: boolean | Readonly<{ available: boolean }> = false, chooseDraft?: (signal: AbortSignal) => Promise<PluginUiSessionServerStartDraftV1 | null>,
    page?: Readonly<{ launchInput?: Parameters<typeof createPluginUiTestkit>[0]['launchInput']; opens?: PluginUiTestkitOpenSurfaceInput[] }>): Promise<PluginUiTestkit> {
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
    let fixture!: PluginUiTestkit;
    const controls = createPluginUiActionControlTestHost(async ({ action, input, signal }) => {
        const id = testkitTriageActionId(action);
        if (id === TRIAGE_RUN_CONFIGURED_ACTION_LOCAL_ID_V1) {
            // This replaces the external host executor only; the configured Action and its inner owners stay real.
            const result = await createTriageRunConfiguredActionHandler()(input, {
                plugin: { id: 'happier.triage', version: '0.0.0' },
                contribution: { id, qualifiedId: 'happier.triage/actions/' + id },
                invocationSurface: 'ui', signal: signal ?? fixture.context.signal, ui: fixture.context.hostApi,
            } as unknown as PluginAccountActionContext);
            return { ok: true, result };
        }
        return { ok: true, result: await harness.executeAction({ action, input }) as import('@happier-dev/plugin-sdk').JsonValue };
    });
    function HostSlots() {
        const slots = React.useSyncExternalStore(controls.subscribe, controls.getSnapshot, controls.getSnapshot);
        return <>{slots.map(({ id, presentation }) => <Button key={id}
            title={presentation.title} accessibilityLabel={presentation.accessibilityLabel ?? presentation.title}
            disabled={presentation.disabled} variant={presentation.variant}
            onPress={() => controls.pressById(id)} />)}</>;
    }
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-176', mountNonce: 'fixture-mount-176' },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: context => {
                const root = renderShellSurface(context);
                if (!React.isValidElement<{ children?: React.ReactNode }>(root)) throw new Error('Expected the public UI surface provider.');
                return React.cloneElement(root, undefined, <>{root.props.children}<HostSlots /></>);
            },
            ...(page?.launchInput === undefined ? {} : { launchInput: page.launchInput }),
            surfaceContext: createSurfaceContextFixture({
                targetedContributions: {
                    target: TARGET_IDENTITY,
                    points: [{
                        pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
                        protocols: [{
                            protocol: {
                                id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
                                version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
                            },
                            contributions: [{
                                contributor: SOURCE_CONTRIBUTOR,
                                protocol: {
                                    id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
                                    version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
                                },
                                descriptor: harness.descriptor,
                                operations: [GET_OPERATION, ...(harness.formalReviewReady
                                    ? [PREPARE_REVIEW_WORKSPACE_OPERATION]
                                    : [])],
                                surfaces: [],
                            }],
                        }],
                    }],
                },
            }),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({
                ephemeralSharedScope, overlays: true, actionBindings: controls,
                ...(hostedDetail ? { detailsPane: typeof hostedDetail === 'boolean' ? { available: true } : hostedDetail } : {}),
                // The native/web focus adapter is a genuine host boundary, as in the review chooser harness.
                physicalFocus(target) { target.focus(); return true; },
            }),
            handlers: {
                actionControl: controls.handler,
                publishCurrentUiContext: () => undefined,
                executeAction: async ({ action, input, signal }) => {
                    // The host routes this addressed Action back to this mount's real dispatcher;
                    // it is not a list read or a replacement for the pressed callback.
                    if (testkitTriageActionId(action) === TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1) {
                        return await createTriageMountedUiActionHandler()(TriageMountedUiInputV1Schema.parse(input), {
                            plugin: { id: 'happier.triage', version: '0.0.0' },
                            contribution: { id: TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1,
                                qualifiedId: `happier.triage/actions/${TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1}` },
                            invocationSurface: 'ui', signal: signal ?? fixture.context.signal,
                            ui: fixture.context.hostApi, ephemeralSharedScope,
                        }) as never;
                    }
                    return await harness.executeAction({ action, input }) as never;
                },
                selectActionInput: async ({ request, signal }) => {
                    if ('operation' in request) {
                        const operation = request.operation;
                        return {
                            kind: 'submitted',
                            action: operation.action,
                            input: request.draft ?? {},
                            selection: {
                                target: {
                                    pluginId: TARGET_IDENTITY.pluginId,
                                    sourceCustody: TARGET_IDENTITY.sourceCustody,
                                },
                                point: operation.point,
                                contributor: {
                                    pluginId: operation.contributor.pluginId,
                                    contributionId: operation.contributor.contributionId,
                                    sourceCustody: operation.contributor.sourceCustody,
                                },
                            },
                            connectedAccount: {
                                kind: 'selected',
                                fieldPath: 'instance.binding.account',
                                ref: configuredInstance().binding.account,
                            },
                            // The host stamps what the reader actually saw
                            // beside their choice; the canonical result schema
                            // requires it.
                            presentation: {
                                connectedAccountLabel: 'Example forge',
                                machineDisplayName: 'Development Mac',
                            },
                        } as never;
                    }
                    if ('hostAction' in request && request.hostAction.action === 'session.transcript.get') {
                        sessionPicks += 1;
                        return pickedSession === null
                            ? { kind: 'cancelled' } as never
                            : { kind: 'sessionAddress', session: pickedSession } as never;
                    }
                    draftsOpened += 1;
                    draftSeeds.push(request.draft);
                    if (chooseDraft) {
                        const draft = await chooseDraft(signal);
                        return draft === null ? { kind: 'cancelled' } : { kind: 'serverStartDraft', draft };
                    }
                    return harness.draftSettles()
                        ? { kind: 'serverStartDraft', draft: SETTLED_DRAFT } as never
                        : { kind: 'cancelled' } as never;
                },
                openNewSession: async ({ request }) => {
                    newSessionSeeds.push(request);
                },
                replacePageLocation: ({ subPath }) => subPath,
                ...(page?.opens === undefined ? {} : { openSurface: (input: PluginUiTestkitOpenSurfaceInput) => { page.opens!.push(input); } }),
            },
        });
    });
    mounted.push(fixture);
    mountedActionControls.set(fixture, controls);
    refreshMountedShell.set(fixture, (trigger = 'view') => refreshTriageListWindow(trigger, fixture.context.hostApi, ephemeralSharedScope));
    await act(async () => {
        await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope);
    });
    return fixture;
}

async function settle(): Promise<void> {
    for (let turn = 0; turn < 6; turn += 1) {
        await act(async () => { await Promise.resolve(); });
    }
}

async function openTheRow(shell: PluginUiTestkit): Promise<void> {
    await act(async () => {
        await shell.press(await shell.getByRole('button', { name: ENTRY_TITLE }));
    });
    // The detail read settles a turn after the press. Offered controls use the
    // exact descriptor already stamped on this physical mount.
    await settle();
}

async function pressAction(shell: PluginUiTestkit, name: string): Promise<void> {
    await act(async () => {
        const controls = mountedActionControls.get(shell);
        if (controls?.presentation(name)) await controls.press(name);
        else await shell.press(await shell.getByRole('button', { name }));
    });
    await settle();
}

async function pressMenuItem(shell: PluginUiTestkit, name: string): Promise<void> {
    await act(async () => {
        await shell.press(await shell.getByRole('menuitem', { name }));
    });
    await settle();
}

/** What the host's existing-Session picker answers ("Send to a Session…"); null is the reader closing it. */
let pickedSession: Readonly<{ serverId: string; sessionId: string }> | null = null;
let sessionPicks = 0;

afterEach(async () => {
    pickedSession = null;
    sessionPicks = 0;
    draftsOpened = 0;
    draftSeeds = [];
    newSessionSeeds = [];
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

const PREPARATION_UNSUPPORTED_COPY = 'This source cannot prepare a review workspace, so actions that need one cannot start here.';

describe('Edit action… opens the one actions editor through the Triage page', () => {
    const FIX_ONLY = [{ actionId: 'fix', label: 'Fix', enabled: true, appliesTo: ['pullRequest'], profileId: null,
        workspaceMode: 'reference_only', target: { kind: 'agent', promptInvocationId: null,
            seededFallbackInstruction: 'Fix this.', delivery: 'compose' } }];
    // The page every surface opens the editor on: core pages, the Triage list and its detail, and the standalone detail.
    const EDITOR = { view: { pluginId: 'happier.triage', localId: 'triage' }, input: { v: 1, kind: 'actionEditor', actionId: 'fix' } };

    it('from the mounted detail opens the editor on the pressed record, not a page-local copy', async () => {
        const harness = createHarness({});
        harness.setActions(FIX_ONLY);
        const opens: PluginUiTestkitOpenSurfaceInput[] = [];
        const shell = await mountShell(harness, false, undefined, { opens });
        await openTheRow(shell);
        await pressAction(shell, 'Fix options');
        await pressMenuItem(shell, 'Edit action…');
        expect(opens).toEqual([expect.objectContaining(EDITOR)]);
        await expect(shell.getByRole('button', { name: 'Fix options' })).resolves.toBeDefined();
        expect(harness.startRequests).toHaveLength(0);
        expect(harness.configuredRequests).toHaveLength(0);
    }, 60_000);

    it('from the standalone detail of a resolved resource', async () => {
        const harness = createHarness({});
        harness.setActions(FIX_ONLY);
        // The resource resolution Action answers this entry; every other read stays the harness's real owner path.
        const resolving: Harness = { ...harness, executeAction: async (request) => testkitTriageActionId(request.action) === TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1
            ? { kind: 'resolved', entryRef: ENTRY_REF, sourceInstance: { source: ENTRY_REF.source, sourceInstanceId: INSTANCE },
                locator: testkitLocator() }
            : await harness.executeAction(request) };
        const opens: PluginUiTestkitOpenSurfaceInput[] = [];
        const shell = await mountShell(resolving, false, undefined, { opens,
            launchInput: { resource: { kind: 'pullRequest', url: 'https://github.com/example/repository/pull/17' } } });
        await settle();
        await pressAction(shell, 'Fix options');
        await pressMenuItem(shell, 'Edit action…');
        expect(opens).toEqual([expect.objectContaining(EDITOR)]);
    }, 60_000);

    it('lands the Triage page on that record when it is opened with the editor launch', async () => {
        const harness = createHarness({});
        harness.setActions(FIX_ONLY);
        const shell = await mountShell(harness, false, undefined, { launchInput: { v: 1, kind: 'actionEditor', actionId: 'fix' } });
        await settle();
        await expect(shell.getByRole('button', { name: 'Save' })).resolves.toBeDefined();
        expect(Array.from(document.querySelectorAll<HTMLInputElement>('input')).map(input => input.value)).toContain('Fix');
    }, 60_000);
});

describe('the entry action controls on the mounted detail header', () => {
    // Walk through without a reachable linked Session opens the prefilled composer (owner ruling 16:50Z), so the
    // former draft-chooser lifecycle cases (pane relocation, entry retirement, refresh, resize) have no pending
    // chooser left to exercise; composer withdrawal on retirement is covered in useEntrySessionStart.rnw.test.tsx.
    it.each([false, true])('hands Walk through to the prefilled composer after the detail refreshes during its comparison read (hosted=%s)', async (hosted) => {
        let finishRead!: (result: unknown) => void;
        let reads = 0;
        const harness = createHarness({ comparisonRead: async () => {
            reads += 1;
            return await new Promise((resolve) => { finishRead = resolve; });
        } });
        harness.setStartResults([{ v: 1, type: 'linked', sessionId: 'session-a',
            disposition: 'created', delivery: 'none', finalOpen: 'deferred' } satisfies TriageStartEntrySessionResultV1]);
        const shell = await mountShell(harness, hosted);
        await openTheRow(shell);
        await pressAction(shell, 'More actions');
        await pressMenuItem(shell, 'Walk through');
        expect(reads).toBe(1);
        // Re-admission temporarily withdraws the source descriptor while the same selected entry reloads.
        const { targetedContributions: _targeted, ...readingSurface } = shell.context.surface;
        await act(async () => { await shell.updateSurface({ ...readingSurface, machineConnectionPending: true }); });
        await act(async () => { await refreshMountedShell.get(shell)!(); });
        await act(async () => { await shell.updateSurface(shell.context.surface); });
        await settle();
        await act(async () => { finishRead({
            kind: 'present',
            localRef: { kindId: ENTRY_REF.kindId, collisionScope: ENTRY_REF.collisionScope, entryId: ENTRY_REF.entryId },
            locator: testkitLocator(), snapshot: testkitSnapshot({ title: ENTRY_TITLE }), viewer: testkitViewer(),
            comparisonSource: PR_COMPARISON,
        }); });
        await settle();
        // No reachable linked Session: the prefilled composer opens and nothing starts until the person sends.
        expect(draftsOpened).toBe(0);
        expect(harness.startRequests).toEqual([]);
        expect(harness.comparisonOpens).toEqual([]);
        expect(newSessionSeeds).toHaveLength(1);
        expect(reads).toBe(1);
    }, 60_000);

    it('keeps a comparison failure visible after source re-admission', async () => {
        let failRead!: (reason: Error) => void;
        const shell = await mountShell(createHarness({ comparisonRead: async () =>
            await new Promise((_resolve, reject) => { failRead = reject; }) }));
        await openTheRow(shell);
        await pressAction(shell, 'More actions');
        await pressMenuItem(shell, 'Walk through');
        const { targetedContributions: _targeted, ...readingSurface } = shell.context.surface;
        await act(async () => { await shell.updateSurface({ ...readingSurface, machineConnectionPending: true }); });
        await act(async () => { failRead(new Error('Source unavailable')); });
        await act(async () => { await shell.updateSurface(shell.context.surface); });
        await settle();
        await expect(shell.getByText('This source cannot open a comparison for this pull request.')).resolves.toBeDefined();
        expect(draftsOpened).toBe(0);
    }, 60_000);

    it('retires a pending Walk through when the reader selects another entry', async () => {
        let finishRead!: (result: unknown) => void;
        const harness = createHarness({ includeSecondEntry: true, comparisonRead: async () =>
            await new Promise((resolve) => { finishRead = resolve; }) });
        const shell = await mountShell(harness);
        await openTheRow(shell);
        await pressAction(shell, 'More actions');
        await pressMenuItem(shell, 'Walk through');
        await act(async () => { await shell.updatePageLocation(buildTriageRouteSubPathV1({
            ...TRIAGE_ROUTE_DEFAULT_LENS_V1, selection: SECOND_ENTRY_REF,
        })); });
        await settle();
        await act(async () => { finishRead({
            kind: 'present',
            localRef: { kindId: ENTRY_REF.kindId, collisionScope: ENTRY_REF.collisionScope, entryId: ENTRY_REF.entryId },
            locator: testkitLocator(), snapshot: testkitSnapshot({ title: ENTRY_TITLE }), viewer: testkitViewer(),
            comparisonSource: PR_COMPARISON,
        }); });
        await settle();
        expect(draftsOpened).toBe(0);
        expect(harness.comparisonOpens).toEqual([]);
        expect(harness.startRequests).toEqual([]);
        await expect(shell.getByText(SECOND_ENTRY_TITLE)).resolves.toBeDefined();
    }, 60_000);
    it('makes formal review available after reading the selected source, even when its scan omitted revision facts', async () => {
        const harness = createHarness({ formalReviewReady: true, reviewRevisionOnlyOnGet: true });
        const shell = await mountShell(harness);
        await openTheRow(shell);
        await pressAction(shell, 'More actions');
        const review = await shell.getByRole('button', { name: 'Review' });
        expect(review.state?.disabled).not.toBe(true);
        await expect(shell.queryByText(PREPARATION_UNSUPPORTED_COPY)).resolves.toBeUndefined();
    });
    it('keeps Review leading, disabled, for someone else\'s pull request whose detail could not be read', async () => {
        // The source can prepare a review workspace; only this entry's read is missing. The verb belongs to the
        // entry's kind, so a failed read never swaps Review for the issue verb, nor says the source cannot prepare.
        const harness = createHarness({ formalReviewReady: true, detailUnavailable: true });
        const shell = await mountShell(harness);
        await openTheRow(shell);
        const review = await shell.getByRole('button', { name: 'Review' });
        expect(review.state?.disabled).toBe(true);
        await expect(shell.queryByRole('button', { name: 'Fix' })).resolves.toBeUndefined();
        await expect(shell.queryByText(PREPARATION_UNSUPPORTED_COPY)).resolves.toBeUndefined();
    }, 60_000);
    it('gives a newly selected entry its own action controller while the prior entry is still starting', async () => {
        const harness = createHarness({ includeSecondEntry: true });
        harness.setActions([{
            actionId: 'start',
            label: 'Start',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: 'profile-1',
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Start this entry.', delivery: 'send' },
        }]);
        let settleFirst!: (result: unknown) => void;
        let settleSecond!: (result: unknown) => void;
        harness.setStartResults([
            () => new Promise((resolve) => { settleFirst = resolve; }),
            () => new Promise((resolve) => { settleSecond = resolve; }),
        ]);
        resolveDirectStart(harness);
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await act(async () => {
            await shell.press(await shell.findByRole('button', { name: 'Start' }));
        });
        await settle();
        expect(harness.startRequests).toHaveLength(1);
        await expect(shell.getByText('Starting a session for this entry…')).resolves.toBeDefined();

        // The host settles a neighboring selection while A still owns an
        // unresolved start. B must not inherit A's synchronous in-flight gate,
        // phase notice, review chooser, or eventual result.
        await act(async () => {
            await shell.updatePageLocation(buildTriageRouteSubPathV1({
                ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
                selection: SECOND_ENTRY_REF,
            }));
        });
        await settle();
        await expect(shell.getByText(SECOND_ENTRY_TITLE)).resolves.toBeDefined();
        await expect(shell.queryByText('Starting a session for this entry…')).resolves.toBeUndefined();

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Start' }));
        });
        await settle();
        expect(harness.startRequests).toHaveLength(2);
        expect(harness.startRequests[1]?.entryRef).toEqual(SECOND_ENTRY_REF);

        settleFirst({
            v: 1,
            type: 'creationFailed',
            reason: 'failed',
        });
        settleSecond({
            v: 1,
            type: 'opened',
            sessionId: 'session-b',
            disposition: 'created',
            delivery: 'notRequested',
        });
        await settle();
        await expect(shell.queryByText('This session could not be created.')).resolves.toBeUndefined();
    }, 15_000);

    it.each([undefined, 'Plan only the migration; leave the UI unchanged.'])
    ('edits the issue orchestration prompt before opening the prefilled composer (%s)', async (replacement) => {
        const harness = createHarness({ issue: true });
        const shell = await mountShell(harness);
        await openTheRow(shell);
        await pressAction(shell, 'More actions');
        await pressMenuItem(shell, 'Orchestrate this');
        expect(harness.startRequests).toEqual([]);
        expect(draftsOpened).toBe(0);
        const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Orchestration prompt"]');
        expect(field).not.toBeNull();
        expect(document.activeElement === field).toBe(true);
        await expect(shell.getByText('The issue stays attached even if you replace the prompt.')).resolves.toBeDefined();
        // The canonical evidence builder owns the default prompt's formatting.
        expect(field!.value).toContain(ENTRY_TITLE);
        const prompt = replacement ?? field!.value;
        if (replacement !== undefined) {
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, replacement);
                field!.dispatchEvent(new Event('input', { bubbles: true }));
            });
        }
        await pressAction(shell, 'Start orchestration');
        // Unresolved placement (owner ruling 16:50Z): the prefilled composer carries the edited prompt and the issue.
        expect(harness.startRequests).toEqual([]);
        expect(draftsOpened).toBe(0);
        expect(newSessionSeeds).toEqual([expect.objectContaining({ prompt,
            attachments: [expect.objectContaining({ attachmentLocalId: 'entry' })] })]);
    }, 60_000);

    it('cancels the issue prompt without starting or choosing a Session', async () => {
        const harness = createHarness({ issue: true });
        const shell = await mountShell(harness);
        await openTheRow(shell);
        await pressAction(shell, 'More actions');
        await pressMenuItem(shell, 'Orchestrate this');
        await pressAction(shell, 'Cancel');
        expect(harness.startRequests).toEqual([]);
        expect(draftsOpened).toBe(0);
        await expect(shell.queryByRole('textbox', { name: 'Orchestration prompt' })).resolves.toBeUndefined();
    }, 60_000);

    it('renders the actions this entry subject is offered', async () => {
        const shell = await mountShell(createHarness());
        await openTheRow(shell);

        // The seeded catalogue, filtered by the source's own declared subject.
        // The seed contains only actions whose complete start paths are
        // reachable in current bytes. The formal `reviewStart` arm remains a
        // valid configured shape, but is not offered until its producers land.
        // Someone else's pull request would lead with Review, but this source cannot prepare a review workspace,
        // so Fix leads, Ask sits beside it, and Review is one press behind More actions with its reason stated.
        await expect(shell.getByRole('button', { name: 'Fix' })).resolves.toBeDefined();
        await expect(shell.getByRole('button', { name: 'Ask' })).resolves.toBeDefined();
        await expect(shell.queryByRole('button', { name: 'Review' })).resolves.toBeUndefined();
        // The reason belongs to the action it explains: while Review is out of sight, the header row does not say
        // that something cannot start beside a Fix that can.
        await expect(shell.queryByText(PREPARATION_UNSUPPORTED_COPY)).resolves.toBeUndefined();
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'More actions' })); });
        // A row of the shared menu, disabled, its reason as the row's own subtitle (part of its accessible name).
        const review = (await shell.getAllByRole('menuitem')).find((row) => row.name?.startsWith('Review') === true);
        expect(review?.state?.disabled).toBe(true);
        await expect(shell.getByText(PREPARATION_UNSUPPORTED_COPY)).resolves.toBeDefined();
    }, 60_000);

    it('pins the entry actions at the foot of a pushed detail and keeps them in the header beside the list', async () => {
        // Pushed (a phone, the detail is the page): the primary and its row sit in the pinned footer, below the story.
        const pushedShell = await mountShell(createHarness());
        await openTheRow(pushedShell);
        const footer = document.querySelector(`[data-testid="${TRIAGE_DETAIL_FOOTER_TEST_ID_V1}"]`);
        expect(footer).not.toBeNull();
        await expect(pushedShell.getByRole('button', { name: 'Fix' })).resolves.toBeDefined();
        expect(footer!.textContent).toContain('Fix');
        expect(footer!.querySelector('[aria-label="Ask"]')).not.toBeNull();
        await pushedShell.dispose();

        // Why the entry is here is a fact about it, not an action: on the pushed page it stays with the title and
        // the facts above the story, never in the thumb bar beside Fix.
        const askedShell = await mountShell(createHarness({ involvement: ['reviewRequested'] }));
        await openTheRow(askedShell);
        const askedFooter = document.querySelector(`[data-testid="${TRIAGE_DETAIL_FOOTER_TEST_ID_V1}"]`);
        const attention = document.querySelector(`[data-testid="${TRIAGE_DETAIL_ATTENTION_TEST_ID_V1}"]`);
        expect(askedFooter).not.toBeNull();
        expect(attention).not.toBeNull();
        expect(askedFooter!.contains(attention)).toBe(false);
        await askedShell.dispose();
        mounted.splice(mounted.indexOf(pushedShell), 1);
        mounted.splice(mounted.indexOf(askedShell), 1);

        // Beside the list (the in-page split) nothing changes: the actions stay in the header and no footer is drawn.
        const wideShell = await mountShell(createHarness());
        const stage = document.querySelector(`[data-testid="${TRIAGE_SHELL_FILL_TEST_ID_V1}:stage"]`)!;
        const onLayout = (stage as unknown as { __reactLayoutHandler: (event: unknown) => void }).__reactLayoutHandler;
        await act(async () => { onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 800 } } }); });
        await openTheRow(wideShell);
        await expect(wideShell.getByRole('button', { name: 'Fix' })).resolves.toBeDefined();
        expect(document.querySelector(`[data-testid="${TRIAGE_DETAIL_FOOTER_TEST_ID_V1}"]`)).toBeNull();
    }, 60_000);

    it('revalidates a visible action at Account KV so a remote deletion cannot execute', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'delete-remotely',
            label: 'Delete remotely',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: null,
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Start this entry.', delivery: 'send' },
        }]);
        const shell = await mountShell(harness);
        await openTheRow(shell);
        await expect(shell.getByRole('button', { name: 'Delete remotely' })).resolves.toBeDefined();

        // Another device deletes it after this mount rendered the control.
        harness.setActions([]);
        await pressAction(shell, 'Delete remotely');

        expect(harness.startRequests).toEqual([]);
        expect(draftsOpened).toBe(0);
        expect(newSessionSeeds).toEqual([]);
        await expect(shell.queryByRole('button', { name: 'Delete remotely' }))
            .resolves.toBeUndefined();
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
            profileId: 'profile-1',
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Start this entry.', delivery: 'send' },
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
        resolveDirectStart(harness);
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
        expect(retry?.resume).toEqual({ phase: 'creationPending' });
    }, 15_000);

    it('retries an unknown mounted delivery against the linked Session with the same delivery identity', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'send',
            label: 'Send',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: 'profile-1',
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Start this entry.', delivery: 'send' },
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
        resolveDirectStart(harness);
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
        expect(retry?.resume).toEqual({
            phase: 'openPending',
            sessionId: 'session-a',
            disposition: 'created',
        });
    }, 15_000);

    it('carries a settled spawn delivery through a mounted open retry', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'send',
            label: 'Send',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: 'profile-1',
            workspaceMode: 'reference_only',
            target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Start this entry.', delivery: 'send' },
        }]);
        harness.setStartResults([
            {
                v: 1,
                type: 'openPending',
                sessionId: 'session-a',
                disposition: 'created',
                delivery: 'accepted',
            },
            {
                v: 1,
                type: 'opened',
                sessionId: 'session-a',
                disposition: 'created',
                delivery: 'accepted',
            },
        ]);
        resolveDirectStart(harness);
        const shell = await mountShell(harness);
        await openTheRow(shell);

        const send = await shell.getByRole('button', { name: 'Send' });
        await act(async () => { await shell.press(send); });
        await settle();
        await act(async () => { await shell.press(send); });
        await settle();

        expect(harness.startRequests).toHaveLength(2);
        expect(harness.startRequests[1]?.resume).toMatchObject({
            phase: 'openPending',
            sessionId: 'session-a',
            delivery: 'accepted',
        });
    }, 15_000);

    it('starts a repository session in the one resolved project', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'fix',
            label: 'Fix',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: 'profile-1',
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Fix this.', delivery: 'send' },
        }]);
        resolveDirectStart(harness, '/workspaces/example');
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Fix with Claude Code');

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
            target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Repair this pull request.', delivery: 'send' },
        }]);
        const shell = await mountShell(harness);
        await openTheRow(shell);

        // The blocked arm is the one whose DECLARED mode is `pull_request`,
        // independent of its label or target arm.
        await pressAction(shell, 'More actions');
        // A disabled row of the shared menu; its reason is the row's subtitle, so it starts the accessible name.
        const blocked = (await shell.getAllByRole('menuitem')).find((row) => row.name?.startsWith('Repair pull request') === true)!;

        // This fixture admits no preparation operation, so this action would
        // resolve the workspace refusal every time. It is refused BEFORE the
        // press — an offered control that fails on contact is the failure this
        // states instead — so the disabled state is the assertion, and pressing
        // it is not something a reader can do.
        expect(blocked.state?.disabled).toBe(true);
        await expect(shell.press(blocked)).rejects.toThrow();

        expect(harness.startRequests).toEqual([]);
        // Every blocked row behind More (this one and the seeded Review) carries the reason as its own subtitle.
        expect(document.body.textContent).toContain(PREPARATION_UNSUPPORTED_COPY);
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
        const directory = 'C:\\checkouts\\repository';
        harness.setActions([{
            actionId: 'fix',
            label: 'Direct fix',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: 'profile-1',
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Fix this.', delivery: 'send' },
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
            items: [projectRow({ machineId: 'machine-b', rootPath: directory })],
            truncated: false,
        });
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Direct fix with Claude Code');

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
            .toEqual({ kind: 'selectedProject', directory });
    }, 60_000);

    /** The Start split's second half (lab t1 `tasks-start`), behind the row's one ⋯. */
    function oneClickHarness(): Harness {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'fix',
            label: 'Direct fix',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: 'profile-1',
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Fix this.', delivery: 'send' },
        }]);
        harness.setProfiles([{ id: 'profile-1', name: 'Repair', placement: 'automatic',
            checkout: 'reuse_workspace', preferredAgentTargetKey: 'backend:claude' }]);
        harness.setBackends([{ targetKey: 'backend:claude', label: 'Claude Code', enabled: true,
            identity: { pluginId: 'happier.claude', localId: 'claude' } }]);
        harness.setRegistry({ items: [projectRow({ machineId: 'machine-b', rootPath: '/checkouts/repository' })], truncated: false });
        return harness;
    }

    it('opens the prefilled composer from the primary\'s chevron even when the profile resolves a one-click start', async () => {
        const harness = oneClickHarness();
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Direct fix options');
        await pressMenuItem(shell, 'Add instructions…');

        // Add instructions is the action in review-first mode (owner ruling 2026-11-07): the same New Session
        // composer as Ask, prefilled with the action's task and the entry, and nothing exists until the person sends.
        expect(draftsOpened).toBe(0);
        expect(harness.startRequests).toEqual([]);
        expect(newSessionSeeds).toHaveLength(1);
        expect(JSON.stringify(newSessionSeeds[0])).toContain('Fix this.');
    }, 60_000);

    it('sends the entry to the Session the reader picks, creating none', async () => {
        const harness = oneClickHarness();
        pickedSession = { serverId: 'server-a', sessionId: 'session-picked' };
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Direct fix options');
        await pressMenuItem(shell, 'Send to a Session…');

        expect(sessionPicks).toBe(1);
        expect(draftsOpened).toBe(0);
        expect(harness.startRequests).toHaveLength(0);
        await vi.waitFor(() => expect(harness.configuredRequests).toHaveLength(1));
        expect(harness.configuredRequests[0]?.handoff).toMatchObject({
            task: 'fix',
            configuredActionId: 'fix',
            context: { kind: 'entry', entry: { entryRef: ENTRY_REF, sourceInstanceId: INSTANCE } },
            sessionChoice: { kind: 'existing', session: 'session-picked' },
            agentChoice: { kind: 'configured' },
            delivery: 'configured',
        });
        expect(harness.configuredRequests[0]?.handoff.evidence).toEqual([
            { kind: 'entry', entry: { entryRef: ENTRY_REF, sourceInstanceId: INSTANCE } },
        ]);
    }, 60_000);

    it('starts nothing when the reader closes the Session picker', async () => {
        const harness = oneClickHarness();
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Direct fix options');
        await pressMenuItem(shell, 'Send to a Session…');

        expect(sessionPicks).toBe(1);
        expect(harness.startRequests).toHaveLength(0);
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
    it('opens the prefilled composer when the profile asks for a worktree', async () => {
        const harness = createHarness();
        harness.setActions([{
            actionId: 'fix',
            label: 'Worktree fix',
            enabled: true,
            appliesTo: ['pullRequest', 'issue', 'errorIssue'],
            profileId: 'profile-1',
            workspaceMode: 'repository',
            target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Fix this.', delivery: 'send' },
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

        await pressAction(shell, 'Worktree fix with Claude Code');

        // The composer opens seeded with the resolved candidate — the reader
        // still gets the answer their configuration produced, they are just the
        // one who settles the checkout and sends. Nothing starts before that.
        expect(draftsOpened).toBe(0);
        expect(harness.startRequests).toEqual([]);
        expect(newSessionSeeds).toEqual([expect.objectContaining({
            profileId: 'profile-1',
            checkoutIntent: 'createWorktree',
            placement: { kind: 'exactTarget', serverId: 'server-a', machineId: 'machine-b', directory: '/checkouts/repository' },
            candidates: [expect.objectContaining({ machineId: 'machine-b', rootPath: '/checkouts/repository' })],
        })]);
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
            target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Fix this.', delivery: 'send' },
        }]);
        harness.setRegistry({
            items: [projectRow({ machineId: 'machine-b' })],
            truncated: false,
        });
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Fix');

        expect(draftsOpened).toBe(0);
        expect(newSessionSeeds).toEqual([expect.objectContaining({
            checkoutIntent: 'reuseWorkspace',
            placement: { kind: 'exactTarget', serverId: 'server-a', machineId: 'machine-b', directory: '/checkouts/repository' },
            candidates: [expect.objectContaining({ machineId: 'machine-b', rootPath: '/checkouts/repository' })],
        })]);
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
                target: {
                    kind: 'reviewStart',
                    promptInvocationId: null,
                    seededFallbackInstruction: 'Review this change.',
                },
            },
            {
                // Labelled `Run code review`, and it is the ORDINARY AGENT arm.
                actionId: 'mislabelled-agent',
                label: 'Run code review',
                enabled: true,
                appliesTo: ['pullRequest'],
                profileId: 'profile-1',
                workspaceMode: 'repository',
                target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Start this entry.', delivery: 'send' },
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
        resolveDirectStart(harness);
        const shell = await mountShell(harness);
        await openTheRow(shell);
        await expect(shell.getByRole('button', { name: 'Configured catalogue loaded' }))
            .resolves.toBeDefined();

        // The formal arm is excluded because its declared `repository` mode
        // cannot satisfy its pull-request workspace requirement. There is no
        // blanket formal-review refusal anymore: a correctly configured
        // `pull_request` arm is admitted by the current producer chain.
        await expect(shell.queryByRole('button', { name: 'Fix' })).resolves.toBeUndefined();
        expect(harness.startRequests).toEqual([]);
        expect(draftsOpened).toBe(0);
        expect(triageActionImmediateRefusalV1({
            target: {
                kind: 'reviewStart',
                promptInvocationId: null,
                seededFallbackInstruction: 'Review this change.',
            },
            workspaceMode: 'repository',
            appliesTo: ['pullRequest'],
        })).toBe('preparedWorkspaceUnsupported');
        expect(triageActionImmediateRefusalV1({
            target: { kind: 'reviewStart', promptInvocationId: null },
            workspaceMode: 'pull_request',
            appliesTo: ['pullRequest'],
        })).toBe('instructionMissing');
        expect(triageActionImmediateRefusalV1({
            target: { kind: 'agent', promptInvocationId: null, delivery: 'send' },
            workspaceMode: 'repository',
            appliesTo: ['pullRequest'],
        })).toBe('instructionMissing');

        // The agent arm, under the label that says "review", starts normally.
        await pressAction(shell, 'Run code review with Claude Code');
        expect(harness.startRequests).toHaveLength(1);
        expect(harness.startRequests[0]?.workspaceMode).toBe('repository');
    });

    it('starts a resolved formal review directly and carries its admitted selected-PR preparation into the review chooser', async () => {
        const harness = createHarness({ formalReviewReady: true });
        harness.setActions([{
            actionId: 'formal-review',
            label: 'Formal review',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: 'profile-1',
            workspaceMode: 'pull_request',
            target: { kind: 'reviewStart', promptInvocationId: 'review-prompt' },
        }]);
        // A complete start: the Profile's Agent and one reachable checkout (no draft modal).
        resolveDirectStart(harness, '/workspaces/example');
        harness.setStartResults([(input: TriageStartEntrySessionInputV1) => {
            if (input.destination.kind !== 'new'
                || input.destination.materialization.kind !== 'reviewWorkspace'
                || input.destination.materialization.request.workspace === null) {
                throw new Error('expected a selected review workspace request');
            }
            const request = input.destination.materialization.request;
            return {
                v: 1,
                type: 'linked',
                sessionId: 'session-review',
                disposition: 'created',
                delivery: 'notRequested',
                finalOpen: 'deferred',
                review: {
                    instance: request.instance,
                    entryRef: request.entryRef,
                    lastKnownLocator: request.lastKnownLocator,
                    observed: request.observed,
                    workspace: request.workspace,
                    repositoryPath: '/workspaces/example-review',
                    pullRequest: { number: 17 },
                },
            };
        }]);
        const shell = await mountShell(harness);
        await openTheRow(shell);

        const review = await shell.findByRole('button', {
            name: 'Formal review',
        });
        await act(async () => { await shell.press(review); });
        await settle();

        await expect.poll(
            () => harness.reviewEngineListRequests.length,
            { timeout: 60_000 },
        ).toBe(1);
        await settle();
        await expect(shell.getByRole('checkbox', { name: 'Codex' })).resolves.toBeDefined();
        expect(harness.startRequests).toHaveLength(1);
        expect(harness.startRequests[0]).toMatchObject({
            workspaceMode: 'pull_request',
            finalOpen: 'deferred',
            destination: {
                kind: 'new',
                materialization: {
                    kind: 'reviewWorkspace',
                    request: {
                        entryRef: ENTRY_REF,
                        workflowSubject: 'pullRequest',
                        observed: {
                            baseSha: 'a'.repeat(40),
                            headSha: 'b'.repeat(40),
                            nativeRevision: 'revision-1',
                        },
                        workspace: {
                            serverId: 'server-a',
                            machineId: 'machine-a',
                            rootPath: '/workspaces/example',
                        },
                    },
                },
            },
            prepareReviewWorkspaceSelection: {
                selection: {
                    contributor: {
                        pluginId: SOURCE_CONTRIBUTOR.pluginId,
                        contributionId: SOURCE_CONTRIBUTOR.contributionId,
                        sourceCustody: SOURCE_CONTRIBUTOR.sourceCustody,
                    },
                    point: PREPARE_REVIEW_WORKSPACE_OPERATION.point,
                },
                credentialRef: configuredInstance().binding.account,
            },
        });
        expect(harness.reviewEngineListRequests).toEqual([{ sessionId: 'session-review' }]);
        expect(draftsOpened).toBe(0);
    }, 60_000);

    it('opens the prepared-review composer for a custom ordinary-agent action keyed only by workspaceMode', async () => {
        const harness = createHarness({ formalReviewReady: true });
        harness.setActions([{
            actionId: 'custom-agent-pr-workspace',
            label: 'Investigate with custom agent',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: null,
            workspaceMode: 'pull_request',
            target: { kind: 'agent', promptInvocationId: 'review-prompt', delivery: 'send' },
        }]);
        harness.setRegistry({
            items: [projectRow({ rootPath: '/workspaces/example' })],
            truncated: false,
        });
        const shell = await mountShell(harness);
        await openTheRow(shell);

        await pressAction(shell, 'Investigate with custom agent');
        await settle();

        // A prepared review checkout is never a one-click start: the composer opens with it prepared.
        expect(harness.startRequests).toEqual([]);
        expect(newSessionSeeds).toEqual([expect.objectContaining({ checkoutIntent: 'preparedReviewWorkspace',
            placement: { kind: 'exactTarget', serverId: 'server-a', machineId: 'machine-a' } })]);
        expect(harness.reviewEngineListRequests).toEqual([]);
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
            target: { kind: 'agent', promptInvocationId: null, seededFallbackInstruction: 'Fix this.', delivery: 'send' },
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

        await pressAction(shell, 'Partial-registry fix with Claude Code');

        expect(draftsOpened).toBe(0);
        expect(harness.startRequests).toEqual([]);
        expect(newSessionSeeds).toHaveLength(1);
    });

    it('retains the resolved review instructions when a pending formal start is resumed', async () => {
        const harness = createHarness({ formalReviewReady: true });
        harness.setActions([{
            actionId: 'formal-review',
            label: 'Formal review',
            enabled: true,
            appliesTo: ['pullRequest'],
            profileId: 'profile-1',
            workspaceMode: 'pull_request',
            target: { kind: 'reviewStart', promptInvocationId: 'review-prompt' },
        }]);
        // A complete start: the Profile's Agent and one reachable checkout (no draft modal).
        resolveDirectStart(harness, '/workspaces/example');
        harness.setStartResults([
            {
                v: 1,
                type: 'linkPending',
                sessionId: 'session-review',
                disposition: 'created',
                preparedReviewWorkspace: {
                    repositoryPath: '/workspaces/example-review',
                    branch: 'review/pr-17',
                    created: true,
                    pullRequest: { number: 17 },
                    currentness: { kind: 'currentAtObservedHead' },
                },
            },
            (input: TriageStartEntrySessionInputV1) => {
                if (input.destination.kind !== 'new'
                    || input.destination.materialization.kind !== 'reviewWorkspace'
                    || input.destination.materialization.request.workspace === null) {
                    throw new Error('expected the retained selected review workspace request');
                }
                const request = input.destination.materialization.request;
                return {
                    v: 1,
                    type: 'linked',
                    sessionId: 'session-review',
                    disposition: 'created',
                    delivery: 'notRequested',
                    finalOpen: 'deferred',
                    review: {
                        instance: request.instance,
                        entryRef: request.entryRef,
                        lastKnownLocator: request.lastKnownLocator,
                        observed: request.observed,
                        workspace: request.workspace,
                        repositoryPath: '/workspaces/example-review',
                        pullRequest: { number: 17 },
                    },
                };
            },
        ]);
        const shell = await mountShell(harness);
        await openTheRow(shell);

        const review = await shell.findByRole('button', {
            name: 'Formal review',
        });
        await act(async () => { await shell.press(review); });
        await settle();
        await act(async () => { await shell.press(review); });
        await settle();

        expect(harness.startRequests).toHaveLength(2);
        expect(harness.startRequests[1]?.resume).toMatchObject({
            phase: 'linkPending',
            sessionId: 'session-review',
            preparedReviewWorkspace: {
                repositoryPath: '/workspaces/example-review',
                currentness: { kind: 'currentAtObservedHead' },
            },
        });
        expect('prepareReviewWorkspaceSelection' in (harness.startRequests[1] ?? {})).toBe(false);
        expect(draftsOpened).toBe(0);
        await expect.poll(
            () => harness.reviewEngineListRequests.length,
            { timeout: 60_000 },
        ).toBe(1);
        await settle();
        await expect(shell.getByRole('checkbox', { name: 'Codex' })).resolves.toBeDefined();
    });
});
