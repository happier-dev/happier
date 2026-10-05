// @vitest-environment jsdom
import { act, cloneElement, type ReactElement } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';
import type { RenderSurface, SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageConfiguredSourceInstanceV1,
    type TriageEntryRepositoryRefV1,
    type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../settings/actions.js';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import type { TriageSessionActionInvokerV1 } from '../sessions/entrySessionOpen.js';
import { linkEntryToSession } from '../sessions/entrySessionLinks.js';
import { refreshTriageListWindow } from './window/mountedWindow.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';
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
const PREPARE_REVIEW_WORKSPACE_OPERATION = Object.freeze({
    point: {
        pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
        protocol: SOURCE_PROTOCOL,
    },
    contributor: {
        pluginId: SOURCE.pluginId,
        contributionId: SOURCE.localId,
        occurrenceId: 'example-forge-generation',
        sourceCustody: { kind: 'development' as const, registeredRootId: 'example-source-root' },
    },
    role: 'prepareReviewWorkspace',
    action: { pluginId: SOURCE.pluginId, localId: 'prepare-review-workspace' },
});

/**
 * The host-projected source snapshot for this list mount. Bulk planning only
 * admits entries whose source currently declares the matching workflow
 * subject; the generic testkit snapshot intentionally contains no sources.
 */
const SOURCE_TARGETED_CONTRIBUTIONS = {
    target: {
        pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
        occurrenceId: 'triage-list-target-generation',
        sourceCustody: { kind: 'development' as const, registeredRootId: 'triage-root' },
    },
    points: [{
        pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
        protocols: [{
            protocol: SOURCE_PROTOCOL,
            contributions: [{
                contributor: {
                    pluginId: SOURCE.pluginId,
                    contributionId: SOURCE.localId,
                    occurrenceId: 'example-forge-generation',
                    sourceCustody: { kind: 'development' as const, registeredRootId: 'example-source-root' },
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
                operations: [PREPARE_REVIEW_WORKSPACE_OPERATION],
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
    /** Launch Profile rows returned to the action-reference owner. */
    profiles?: JsonValue;
    /** Host settlement returned for a New Session seed request. */
    newSessionSeedResult?: unknown;
    /** One-based spawn invocation whose transport answer is lost once. */
    failSpawnAttempt?: number;
    /** Optional exact repository identity projected by each observation. */
    repositories?: Readonly<Record<string, TriageEntryRepositoryRefV1>>;
    /** Holds the project registry at its boundary until the mounted request is cancelled. */
    deferProjectsRead?: boolean;
    sessionStates?: Record<string, SessionStateV1 | null>;
    /** A Collection transport outage after an earlier successful mounted read. */
    sessionLinkReadFails?: () => boolean;
}> = {}) {
    const kindId = options.kindId ?? 'pull-request';
    const { collections, control } = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
    const accountKv = createTestkitAccountKv(
        options.actions === undefined ? {} : { [TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1]: options.actions },
    );
    const referenceReads: string[] = [];
    const newSessionSeeds: unknown[] = [];
    const preparedNewSessionSelections: unknown[] = [];
    const lifecycle: string[] = [];
    const composerTransactions: unknown[] = [];
    const spawnInputs: unknown[] = [];
    const sentInputs: unknown[] = [];
    let nextSessionNumber = 1;
    let spawnAttempt = 0;
    let retired = false;
    let projectsSignal: AbortSignal | undefined;
    let retireMounted: (() => Promise<void>) | null = null;
    control.sourceInstances.seed(toCorpusStoredValue(instanceRow()));
    const collectionsById = new Map<string, unknown>([
        ['source-instances', collections.sourceInstances],
        ['session-links', {
            ...collections.sessionLinks,
            query: async (...args: Parameters<typeof collections.sessionLinks.query>) => {
                if (options.sessionLinkReadFails?.()) throw new Error('Session links unavailable');
                return await collections.sessionLinks.query(...args);
            },
        }],
        ['user-marks', collections.userMarks],
    ]);
    const dataClient = {
        collection(definition: Readonly<{ id: string }>) {
            const collection = collectionsById.get(definition.id);
            if (collection === undefined) throw new Error(`Undeclared Collection: ${definition.id}`);
            return collection as ReturnType<PluginUiDataClient['collection']>;
        },
        async openCollectionQuery() {
            throw new Error('This mounted journey opens no declared UI query.');
        },
        accountKv: accountKv.kv,
    } as unknown as PluginUiDataClient;

    // The actual Session-link writer runs below. This records its real durable
    // Collection boundary, including the primary link that travels inside the
    // start Action rather than through the secondary-link Action.
    const sessionLinks = {
        ...collections.sessionLinks,
        batch: async (...args: Parameters<typeof collections.sessionLinks.batch>) => {
            lifecycle.push('link');
            return await collections.sessionLinks.batch(...args);
        },
    };

    /**
     * The three generic Session Actions are the only external boundary the
     * real start owner crosses. `session.open` retires this exact mounted
     * fixture before it resolves, modelling the host navigation that made the
     * old bulk ordering lose the rest of its work.
     */
    const executeSessionAction: TriageSessionActionInvokerV1 = async (actionId, input) => {
        if (actionId === 'session.spawn_new') {
            lifecycle.push('session.spawn_new');
            spawnInputs.push(input);
            spawnAttempt += 1;
            if (spawnAttempt === options.failSpawnAttempt) {
                throw new Error('triage:test:spawnAnswerLost');
            }
            const sessionId = `session-${nextSessionNumber}`;
            nextSessionNumber += 1;
            return {
                type: 'success',
                disposition: 'created',
                sessionId,
                executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: { status: 'notRequested' },
            } as never;
        }
        if (actionId === 'session.message.send') {
            lifecycle.push('session.message.send');
            sentInputs.push(input);
            return { status: 'accepted', localId: `input-${sentInputs.length}` } as never;
        }
        lifecycle.push('session.open');
        retired = true;
        // Retire the host boundary synchronously, then physically retire the
        // React fixture as soon as this Action dispatch unwinds. Calling the
        // fixture's unmount reentrantly from the Action it is currently
        // dispatching makes the fixture wait on its own request; the next
        // microtask is the earliest real host lifecycle can dispose it.
        void Promise.resolve()
            .then(async () => await retireMounted?.())
            .catch(() => undefined);
        return null as never;
    };

    const admitted = [{
        contributor: {
            pluginId: SOURCE.pluginId,
            contributionId: SOURCE.localId,
            occurrenceId: 'generation-1',
            sourceCustody: { kind: 'development', registeredRootId: 'example-source-root' },
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
                ...(options.repositories?.['17'] === undefined
                    ? {}
                    : { repository: options.repositories['17'] }),
                locator: testkitLocator(),
                snapshot: {
                    ...testkitSnapshot({ title: 'Replace the duplicated normalizer' }),
                    reviewRevision: { baseSha: 'base', headSha: 'head-17', nativeRevision: 'rev-17' },
                },
                viewer: testkitViewer(),
                sourceUpdatedAtMs: 3_000,
            }, {
                kind: 'present',
                localRef: { kindId, collisionScope: 'example/repository', entryId: '18' },
                ...(options.repositories?.['18'] === undefined
                    ? {}
                    : { repository: options.repositories['18'] }),
                locator: testkitLocator(),
                snapshot: {
                    ...testkitSnapshot({ title: 'Extract the selection reducer' }),
                    reviewRevision: { baseSha: 'base', headSha: 'head-18', nativeRevision: 'rev-18' },
                },
                viewer: testkitViewer(),
                sourceUpdatedAtMs: 2_000,
            }, {
                kind: 'present',
                localRef: { kindId, collisionScope: 'example/repository', entryId: '19' },
                ...(options.repositories?.['19'] === undefined
                    ? {}
                    : { repository: options.repositories['19'] }),
                locator: testkitLocator(),
                snapshot: {
                    ...testkitSnapshot({ title: 'Migrate the sessions list' }),
                    reviewRevision: { baseSha: 'base', headSha: 'head-19', nativeRevision: 'rev-19' },
                },
                viewer: testkitViewer(),
                sourceUpdatedAtMs: 1_000,
            }],
            evidence: { kind: 'walkFinished' },
        } satisfies TriageScanResultV1));

    async function executeAction(request: Readonly<{
        action: unknown;
        input: unknown;
        signal?: AbortSignal;
    }>) {
        const action = String(request.action);
        if (retired) throw new Error('triage:test:surfaceRetired');
        if (action === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1) {
            return await readTriageActionsForSurface(
                TriageReadActionsInputV1Schema.parse(request.input),
                { catalog: accountKv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) },
            );
        }
        if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
            return await listTriagePinnedEntries(
                TriageListPinnedEntriesInputV1Schema.parse(request.input),
                { collections, nowMs: () => 2_000 },
            );
        }
        if (action === 'sessions/start-entry-v1') {
            const [{ startTriageEntrySession }, { TriageStartEntrySessionInputV1Schema }] = await Promise.all([
                import('../actions/entrySession.js'),
                import('../actions/entrySessionProtocol.js'),
            ]);
            return await startTriageEntrySession(
                TriageStartEntrySessionInputV1Schema.parse(request.input),
                {
                    collections: { sessionLinks },
                    execute: executeSessionAction,
                    nowMs: () => 2_000,
                },
            );
        }
        if (action === 'sessions/link-entry-v1') {
            const [{ linkTriageEntryToSession }, { TriageLinkEntryToSessionInputV1Schema }] = await Promise.all([
                import('../actions/sessionLinks.js'),
                import('../actions/sessionLinksProtocol.js'),
            ]);
            return await linkTriageEntryToSession(
                TriageLinkEntryToSessionInputV1Schema.parse(request.input),
                { collections: { sessionLinks }, nowMs: () => 2_000 },
            );
        }
        if (action === 'session.spawn_new' || action === 'session.message.send' || action === 'session.open') {
            return await executeSessionAction(action, request.input as never);
        }
        if (action === 'projects.list') {
            projectsSignal = request.signal;
            if (options.deferProjectsRead === true) {
                await new Promise<never>((_resolve, reject) => request.signal?.addEventListener(
                    'abort',
                    () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                    { once: true },
                ));
            }
            return { items: [], truncated: false };
        }
        if (action === 'sessions.spawn.profiles.list') {
            referenceReads.push('sessions.spawn.profiles.list');
            return { items: options.profiles ?? [], truncated: false };
        }
        if (action === 'prompts.invocations.list') {
            referenceReads.push(action);
            return { items: [], truncated: false };
        }
        if (action === 'prompts.invocation.resolve') {
            referenceReads.push(action);
            return { status: 'resolved', text: 'Investigate the selected entries.' };
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
        sessionStates: options.sessionStates ?? {},
        dataClient,
        executeAction,
        newSessionSeeds,
        preparedNewSessionSelections,
        referenceReads,
        lifecycle,
        composerTransactions,
        spawnInputs,
        sentInputs,
        newSessionSeedResult: options.newSessionSeedResult,
        replaceActions: (actions: JsonValue) => {
            accountKv.seed(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1, actions);
        },
        get wasRetired() {
            return retired;
        },
        get projectsSignal() {
            return projectsSignal;
        },
        setMountRetirement: (retire: () => Promise<void>) => {
            retireMounted = retire;
        },
    };
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
    const ephemeralSharedScope = createTriageEphemeralSharedScopeFixture();
    const surfaceWithDataClient: RenderSurface = (context) => cloneElement(
        // This visible semantic mount supplies the same host activity fact as
        // the real surface; the generic testkit RenderContext omits it.
        renderShellSurface({ ...context, activity: { active: true } }) as ReactElement<{ dataClient?: PluginUiDataClient }>,
        { dataClient: harness.dataClient },
    );
    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: { instanceId: 'fixture-instance-187', mountNonce: 'fixture-mount-187' },
            authorPlugin: { id: 'happier.triage', version: '0.0.0' },
            surface: surfaceWithDataClient,
            surfaceContext: createSurfaceContextFixture(
                options.sourceContributions === 'absent'
                    ? {}
                    : { targetedContributions: SOURCE_TARGETED_CONTRIBUTIONS },
            ),
            adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope }),
            handlers: {
                publishCurrentUiContext: () => undefined,
                readSession: ({ sessionId }) => harness.sessionStates[sessionId] ?? null,
                watchSession: () => undefined,
                executeAction: async ({ action, input, signal }) => await harness.executeAction({ action, input, signal }),
                openNewSession: async ({ request, preparedReviewWorkspace }) => {
                    harness.newSessionSeeds.push(request);
                    if (preparedReviewWorkspace !== undefined) {
                        harness.preparedNewSessionSelections.push(preparedReviewWorkspace);
                    }
                    if (harness.newSessionSeedResult !== undefined) throw new Error('New Session unavailable');
                },
                selectActionInput: async ({ request }) => {
                    if ('operation' in request) {
                        return {
                            kind: 'submitted',
                            action: request.operation.action,
                            input: request.draft ?? {},
                            selection: {
                                target: {
                                    pluginId: SOURCE_TARGETED_CONTRIBUTIONS.target.pluginId,
                                    sourceCustody: SOURCE_TARGETED_CONTRIBUTIONS.target.sourceCustody,
                                },
                                point: request.operation.point,
                                contributor: {
                                    pluginId: request.operation.contributor.pluginId,
                                    contributionId: request.operation.contributor.contributionId,
                                    sourceCustody: request.operation.contributor.sourceCustody,
                                },
                            },
                            connectedAccount: { kind: 'none' },
                            // The host stamps what the reader actually saw
                            // beside their choice; the canonical result schema
                            // requires it.
                            presentation: { connectedAccountLabel: null, machineDisplayName: 'Development Mac' },
                        } as never;
                    }
                    return {
                        kind: 'serverStartDraft',
                        draft: {
                            executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                            agentTarget: {
                                kind: 'agent',
                                identity: { pluginId: 'happier.test.agent', localId: 'agent' },
                            },
                            directory: { kind: 'path', path: '/workspaces/example' },
                        },
                    } as never;
                },
                readComposer: async ({ ref }) => {
                    if (harness.wasRetired) throw new Error('triage:test:surfaceRetired');
                    harness.lifecycle.push('composer.read');
                    return {
                        status: 'ready' as const,
                        snapshot: {
                            revision: 1,
                            ref,
                            text: '',
                            references: [],
                            attachments: [],
                            layout: 'wrap' as const,
                            capabilities: {
                                text: true,
                                references: true,
                                attachments: true,
                                submit: true,
                            },
                            state: {
                                focused: false,
                                editable: true,
                                submittable: true,
                                submitting: false,
                                running: false,
                            },
                        },
                    };
                },
                applyComposer: async ({ ref, transaction }) => {
                    if (harness.wasRetired) throw new Error('triage:test:surfaceRetired');
                    harness.lifecycle.push('composer.apply');
                    harness.composerTransactions.push({ ref, transaction });
                    return { status: 'applied' as const, revision: 2 };
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
    // `session.open` cannot resolve until this shell has actually retired. The
    // regression cases therefore fail if any bulk continuation is scheduled
    // after automatic open, just as it does in the live host.
    harness.setMountRetirement(async () => { await fixture.retire('session_opened'); });
    await act(async () => {
        await refreshTriageListWindow('view', fixture.context.hostApi, ephemeralSharedScope);
    });
    return { shell: fixture, locations };
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});


const gridRows = () => Array.from(
    document.querySelectorAll<HTMLElement>('[role="grid"] [role="row"]'),
);
const rowNamed = (label: string) => gridRows().find(
    (row) => row.textContent?.includes(label),
);
const selectedLabels = () => gridRows()
    .filter((row) => row.getAttribute('aria-selected') === 'true')
    .map((row) => row.textContent ?? '');

async function pressRow(
    label: string,
    modifiers: Readonly<{ shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }> = {},
): Promise<void> {
    const row = rowNamed(label);
    const primaryAction = row?.querySelector<HTMLElement>('[role="gridcell"] [role="button"]');
    expect(row).toBeDefined();
    expect(primaryAction).not.toBeNull();
    await act(async () => {
        primaryAction?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }));
    });
}

async function chooseRow(label: string): Promise<void> {
    const mode = document.querySelector<HTMLElement>('[data-testid="happier-list-selection-mode"]');
    if (!mode?.textContent?.includes('Done selecting')) {
        await act(async () => { mode?.click(); });
    }
    await pressRow(label);
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

async function chooseBulkAction(shell: PluginUiTestkit, label: string): Promise<void> {
    await act(async () => {
        await shell.press(await shell.getByRole('radio', { name: label }));
    });
    await settle();
}

describe('selecting several PRs & Issues rows', () => {
    it('groups linked working Sessions live without opening a detail', async () => {
        const working: SessionStateV1 = {
            sessionId: 'working-session', lifecycle: 'active', runtime: 'working',
            operational: 'working', pendingPermissions: [],
            workStatus: { bucket: 'working', tone: 'neutral', word: 'Working' },
        };
        const harness = createHarness({ sessionStates: { 'working-session': working } });
        await linkEntryToSession({
            collections: harness.collections,
            entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' },
            sessionId: 'working-session',
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
            nowMs: 1,
        });
        const { shell, locations } = await mountShell(harness);
        await vi.waitFor(async () => {
            await act(async () => { await Promise.resolve(); });
            expect(document.body.textContent).toContain('With an agent');
        });
        expect(rowNamed('Replace the duplicated normalizer')).toBeDefined();
        expect(locations).toEqual([]);

        harness.sessionStates['working-session'] = {
            ...working, runtime: 'idle', operational: 'ready',
            workStatus: { bucket: 'idle', tone: 'neutral', word: 'Ready' },
        };
        await act(async () => { shell.invalidateSession('working-session', `sha256:${'2'.repeat(64)}`); });
        await vi.waitFor(async () => {
            await act(async () => { await Promise.resolve(); });
            expect(document.body.textContent).not.toContain('With an agent');
        });
        expect(rowNamed('Replace the duplicated normalizer')).toBeDefined();
    });

    it('retains known working groups during a link read failure and recovers through explicit retry', async () => {
        let unreachable = false;
        const harness = createHarness({
            sessionLinkReadFails: () => unreachable,
            sessionStates: { 'working-session': {
                sessionId: 'working-session', lifecycle: 'active', runtime: 'working',
                operational: 'working', pendingPermissions: [],
                workStatus: { bucket: 'working', tone: 'neutral', word: 'Working' },
            } },
        });
        const entryRef = { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' };
        await linkEntryToSession({
            collections: harness.collections, entryRef, sessionId: 'working-session',
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' }, nowMs: 1,
        });
        const { shell } = await mountShell(harness);
        await vi.waitFor(async () => {
            await act(async () => { await Promise.resolve(); });
            expect(document.body.textContent).toContain('With an agent');
        });

        unreachable = true;
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Refresh' })); });
        await vi.waitFor(async () => {
            await act(async () => { await Promise.resolve(); });
            expect(document.body.textContent).toContain('Some linked Session activity could not be read.');
        });
        expect(document.body.textContent).toContain('With an agent');

        unreachable = false;
        await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Retry' })); });
        await vi.waitFor(async () => {
            await act(async () => { await Promise.resolve(); });
            expect(document.body.textContent).not.toContain('Some linked Session activity could not be read.');
        });
        expect(document.body.textContent).toContain('With an agent');
    });

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

    it('builds a keyed set in explicit selection mode without opening a detail', async () => {
        const { locations } = await mountShell(createHarness());
        const before = locations.length;

        await chooseRow('Replace the duplicated normalizer');
        // Asserted before the second press so this states the contract rather
        // than reporting its consequence: a selection-mode press builds a set, and an
        // opened detail replaces the list in the stacked composition, which
        // would leave the next row unreachable.
        expect(locations.slice(before)).toEqual([]);

        await chooseRow('Migrate the sessions list');

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

        await chooseRow('Replace the duplicated normalizer');
        expect(locations.slice(before)).toEqual([]);

        await pressRow('Migrate the sessions list', { shiftKey: true });

        expect(selectedLabels()).toHaveLength(3);
        expect(locations.slice(before)).toEqual([]);
    });

    it('offers direct destinations only after selecting an action with an instruction', async () => {
        // Anti-dormancy: the bar, the action catalog it reads and the bulk
        // executor behind it are reachable from the mounted list, not just
        // present in the tree. Before this they were built and consumed by
        // nothing.
        const { shell, locations } = await mountShell(createHarness({
            repositories: {
                '17': {
                    kind: 'github',
                    deployment: 'https://example.test',
                    repository: 'example/repository',
                },
            },
        }));
        const before = locations.length;

        expect(document.querySelector('[data-testid="triage-bulk-action-bar"]')).toBeNull();

        await chooseRow('Replace the duplicated normalizer');

        expect(document.querySelector('[data-testid="triage-bulk-action-bar"]')).not.toBeNull();
        // Ask deliberately opens an editable Composer without inventing a task
        // instruction. It can attach the selection, but it cannot direct-send
        // an empty task into one or several Sessions.
        expect(document.querySelector('[data-testid="triage-bulk-oneSessionForAllEntries"]')).toBeNull();
        expect(document.querySelector('[data-testid="triage-bulk-oneSessionPerEntry"]')).toBeNull();
        expect(document.querySelector('[data-testid="triage-bulk-attachAllToNewSession"]')).not.toBeNull();

        // Fix owns a shipped fallback instruction, so choosing it makes both
        // direct destinations real as well.
        await chooseBulkAction(shell, 'Fix');
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

    it('offers a shared Session with explicit project choice across different repositories', async () => {
        const harness = createHarness({
            actions: {
                v: 1,
                actions: [{
                    actionId: 'fix-repository',
                    label: 'Fix repository',
                    enabled: true,
                    appliesTo: ['pullRequest'],
                    profileId: null,
                    workspaceMode: 'repository',
                    target: {
                        kind: 'agent',
                        promptInvocationId: null,
                        seededFallbackInstruction: 'Start this entry.',
                        delivery: 'send',
                    },
                }],
            },
            repositories: {
                '17': { kind: 'github', deployment: 'https://example.test', repository: 'example/one' },
                '18': { kind: 'github', deployment: 'https://example.test', repository: 'example/two' },
            },
        });
        await mountShell(harness);

        await chooseRow('Replace the duplicated normalizer');
        await chooseRow('Extract the selection reducer');

        expect(document.querySelector('[data-testid="triage-bulk-oneSessionForAllEntries"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="triage-bulk-oneSessionPerEntry"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="triage-bulk-attachAllToNewSession"]')).not.toBeNull();
    });

    it('offers only the configured actions the selected subjects are offered', async () => {
        // `appliesTo` answers WHICH SUBJECTS an action is offered on
        // (`PLAN.md` §0a). The seeded `Review` action is pull-request-only, so
        // an issue-only set must not be offered it: a control whose every
        // reachable outcome is `actionInapplicable` is a dead end the offer
        // owner already knows about.
        await mountShell(createHarness({ kindId: 'issue' }));

        await chooseRow('Replace the duplicated normalizer');

        const offered = offeredBulkActionLabels();
        expect(offered).toEqual(['Ask', 'Fix']);
    });

    it('still offers a pull-request-only action to a pull-request set', async () => {
        // The positive twin: the filter above must narrow by subject, not
        // simply stop offering the third action.
        await mountShell(createHarness());

        await chooseRow('Replace the duplicated normalizer');

        const offered = offeredBulkActionLabels();
        expect(offered).toEqual(['Ask', 'Fix', 'Review']);
    });

    it('does not run a bulk action deleted from the authoritative catalog before the press', async () => {
        const harness = createHarness();
        const { shell } = await mountShell(harness);
        await chooseRow('Replace the duplicated normalizer');
        expect(offeredBulkActionLabels()).toContain('Fix');
        await chooseBulkAction(shell, 'Fix');

        // Another device replaces the catalog after this mount rendered the
        // seeded action. The press must re-read Account KV before any profile,
        // prompt, project, Session or Composer work begins.
        harness.replaceActions({ v: 1, actions: [] });
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'A session each' }));
        });
        await settle();

        expect(harness.referenceReads).toEqual([]);
        expect(harness.lifecycle).toEqual([]);
        expect(harness.spawnInputs).toEqual([]);
        expect(harness.composerTransactions).toEqual([]);
        expect(offeredBulkActionLabels()).toEqual([]);
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

        await chooseRow('Replace the duplicated normalizer');

        expect(document.querySelector('[data-testid="triage-bulk-action-bar"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="triage-bulk-oneSessionForAllEntries"]')).toBeNull();
        expect(document.body.textContent).toContain('1 selected');
        expect(document.body.textContent).toContain('None of your configured actions');
    });

    it('shows one truthful Stop control for live work without hiding the selection or its progress owner', async () => {
        const harness = createHarness({ deferProjectsRead: true });
        const { shell } = await mountShell(harness);
        await chooseRow('Replace the duplicated normalizer');
        await chooseBulkAction(shell, 'Fix');

        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'A session each' }));
        });
        await settle();
        expect(harness.projectsSignal).toBeDefined();
        expect(harness.projectsSignal?.aborted).toBe(false);

        await act(async () => {
            const buttons = await shell.getAllByRole('button');
            expect(buttons.filter((button) => button.name === 'Stop')).toHaveLength(1);
            expect(buttons.some((button) => button.name === 'Clear selection')).toBe(false);
            await shell.press(await shell.getByRole('button', { name: 'Stop' }));
        });
        await settle();

        expect(harness.projectsSignal?.aborted).toBe(true);
        expect(selectedLabels()).toHaveLength(1);
        expect(document.querySelector('[data-testid="triage-bulk-action-bar"]')).not.toBeNull();
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
                    target: { kind: 'agent', promptInvocationId: 'prompt-1', delivery: 'send' },
                }],
            },
        });
        const { shell } = await mountShell(harness, { sourceContributions: 'absent' });

        await chooseRow('Replace the duplicated normalizer');
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

        await chooseRow('Replace the duplicated normalizer');
        await chooseRow('Extract the selection reducer');

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

    it('carries a Launch Profile worktree answer into the attach-all seed', async () => {
        const harness = createHarness({
            actions: {
                v: 1,
                actions: [{
                    actionId: 'attach-worktree',
                    label: 'Attach in worktree',
                    enabled: true,
                    appliesTo: ['pullRequest'],
                    profileId: 'profile-worktree',
                    workspaceMode: 'repository',
                    target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
                }],
            },
            profiles: [{
                id: 'profile-worktree',
                name: 'Worktree repair',
                placement: 'automatic',
                checkout: 'create_worktree',
            }],
        });
        const { shell } = await mountShell(harness);
        await chooseRow('Replace the duplicated normalizer');
        await chooseRow('Extract the selection reducer');
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Attach to New Session' }));
        });
        await settle();

        expect(harness.newSessionSeeds).toHaveLength(1);
        expect(harness.newSessionSeeds[0]).toMatchObject({
            profileId: 'profile-worktree',
            checkoutIntent: 'createWorktree',
            attachments: [{
                value: { value: { entryRef: expect.objectContaining({ entryId: '17' }) } },
            }, {
                value: { value: { entryRef: expect.objectContaining({ entryId: '18' }) } },
            }],
        });
    });

    it('refuses a multi-PR prepared workspace before choosing one entry as the checkout owner', async () => {
        const harness = createHarness({
            actions: {
                v: 1,
                actions: [{
                    actionId: 'attach-prepared-review',
                    label: 'Attach in prepared review workspace',
                    enabled: true,
                    appliesTo: ['pullRequest'],
                    profileId: null,
                    workspaceMode: 'pull_request',
                    target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
                }],
            },
        });
        const { shell, locations } = await mountShell(harness);

        await chooseRow('Replace the duplicated normalizer');
        await chooseRow('Extract the selection reducer');
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Attach to New Session' }));
        });
        await settle();

        expect(harness.newSessionSeeds).toEqual([]);
        expect(harness.preparedNewSessionSelections).toEqual([]);
        expect(harness.lifecycle).toEqual([]);
        expect(harness.wasRetired).toBe(false);
        expect(locations).toEqual([]);
        expect(document.body.textContent).toContain('0 attached to New Session');
        expect(document.body.textContent).toContain('2 could not be used');
    });

    it('carries one bulk-selected PR through the exact prepared-workspace operation', async () => {
        const harness = createHarness({
            actions: {
                v: 1,
                actions: [{
                    actionId: 'attach-prepared-review',
                    label: 'Attach in prepared review workspace',
                    enabled: true,
                    appliesTo: ['pullRequest'],
                    profileId: null,
                    workspaceMode: 'pull_request',
                    target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
                }],
            },
        });
        const { shell } = await mountShell(harness);
        // Prepared checkout joins the current admitted source operation with
        // the durable configured-source row. Let that canonical Account read
        // settle before exercising the press.
        await settle();

        await chooseRow('Replace the duplicated normalizer');
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'Attach to New Session' }));
        });
        await settle();

        expect(harness.newSessionSeeds).toEqual([
            expect.objectContaining({
                checkoutIntent: 'preparedReviewWorkspace',
            }),
        ]);
        expect((harness.newSessionSeeds[0] as { placement?: { directory?: string } })
            .placement?.directory).toBeUndefined();
        expect(harness.preparedNewSessionSelections).toEqual([
            expect.objectContaining({ operation: PREPARE_REVIEW_WORKSPACE_OPERATION }),
        ]);
        expect(harness.lifecycle).toEqual([]);
    });

    it('honours a direct bulk destination even when the action defaults to compose', async () => {
        // The destination is an explicit reader choice. It overrides the
        // single-entry compose default and reaches the canonical structured
        // Session-input path; the default must not make two of three shipped
        // bulk destinations dead controls.
        const harness = createHarness({
            actions: {
                v: 1,
                actions: [{
                    actionId: 'compose-all',
                    label: 'Compose all',
                    enabled: true,
                    appliesTo: ['pullRequest'],
                    profileId: null,
                    workspaceMode: 'reference_only',
                    target: {
                        kind: 'agent',
                        promptInvocationId: 'prompt-1',
                        delivery: 'compose',
                    },
                }],
            },
        });
        const { shell } = await mountShell(harness);

        await chooseRow('Replace the duplicated normalizer');
        await chooseRow('Extract the selection reducer');
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'One session for all' }));
        });
        await settle();

        expect(harness.lifecycle.filter((step) => step === 'session.spawn_new')).toHaveLength(1);
        expect(harness.lifecycle.filter((step) => step === 'session.message.send')).toHaveLength(1);
        expect(harness.lifecycle.at(-1)).toBe('session.open');
        expect(harness.spawnInputs).toHaveLength(1);
        expect(harness.sentInputs).toMatchObject([
            {
                message: 'Investigate the selected entries.',
                attachments: [
                    { value: { value: { entryRef: { entryId: '17' } } } },
                    { value: { value: { entryRef: { entryId: '18' } } } },
                ],
            },
        ]);
        expect(harness.composerTransactions).toEqual([]);
        expect(harness.wasRetired).toBe(true);
    });

    it('omits incompatible formal-review bulk destinations with an announced reason', async () => {
        // A formal review has one selected-PR scope and one prepared workspace.
        // A multi-entry bulk destination cannot truthfully choose either fact,
        // so V1 reports the refusal and leaves Attach to New Session available
        // without creating a Triage-local collection of drafts.
        const harness = createHarness({
            actions: {
                v: 1,
                actions: [{
                    actionId: 'formal-review',
                    label: 'Formal review',
                    enabled: true,
                    appliesTo: ['pullRequest'],
                    profileId: null,
                    workspaceMode: 'pull_request',
                    target: {
                        kind: 'reviewStart',
                        promptInvocationId: null,
                        seededFallbackInstruction: 'Review this change.',
                    },
                }],
            },
        });
        const { shell, locations } = await mountShell(harness);

        await chooseRow('Replace the duplicated normalizer');
        await chooseRow('Extract the selection reducer');

        await expect(shell.getByRole('button', { name: 'One session for all' })).rejects.toThrow();
        await expect(shell.getByRole('button', { name: 'A session each' })).rejects.toThrow();
        await expect(shell.getByRole('button', { name: 'Attach to New Session' })).rejects.toThrow();

        expect(harness.referenceReads).toEqual([]);
        expect(harness.lifecycle).toEqual([]);
        expect(harness.spawnInputs).toEqual([]);
        expect(harness.composerTransactions).toEqual([]);
        expect(harness.newSessionSeeds).toEqual([]);
        expect(harness.wasRetired).toBe(false);
        expect(locations).toEqual([]);
        await expect(shell.getByRole('status', {
            name: 'A formal code review cannot be started in bulk from here, so nothing was started.',
        })).resolves.toBeDefined();
    });

    it('delivers every per-entry structured input through the canonical start owner', async () => {
        // The per-entry destination has no honest final destination to open:
        // guessing a first or last Session both retires the batch's owner and
        // drops the other units. Each unit therefore starts independently,
        // with its prompt and attachment admitted by the canonical start owner
        // after that owner's durable link. Bulk does not invent a second send
        // path and does not pick one unit as a navigation winner.
        const harness = createHarness({
            actions: {
                v: 1,
                actions: [{
                    actionId: 'send-each',
                    label: 'Send each',
                    enabled: true,
                    appliesTo: ['pullRequest'],
                    profileId: null,
                    workspaceMode: 'reference_only',
                    target: {
                        kind: 'agent',
                        promptInvocationId: 'prompt-1',
                        delivery: 'send',
                    },
                }],
            },
        });
        const { shell } = await mountShell(harness);

        await chooseRow('Replace the duplicated normalizer');
        await chooseRow('Extract the selection reducer');
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'A session each' }));
        });
        await settle();

        expect(harness.lifecycle.filter((step) => step === 'session.spawn_new')).toHaveLength(2);
        expect(harness.lifecycle.filter((step) => step === 'session.message.send')).toHaveLength(2);
        expect(harness.spawnInputs).toHaveLength(2);
        expect(harness.sentInputs).toMatchObject([
            {
                message: 'Investigate the selected entries.',
                attachments: [{ value: { value: { entryRef: expect.objectContaining({ entryId: '17' }) } } }],
            },
            {
                message: 'Investigate the selected entries.',
                attachments: [{ value: { value: { entryRef: expect.objectContaining({ entryId: '18' }) } } }],
            },
        ]);
        expect(harness.wasRetired).toBe(false);
        expect(document.body.textContent).toContain('2 started, 0 unconfirmed, 0 not started, 0 could not be used');
    });

    it('lets the reader retry only unfinished per-entry units with their original creation key', async () => {
        const harness = createHarness({
            failSpawnAttempt: 2,
            actions: {
                v: 1,
                actions: [{
                    actionId: 'send-each',
                    label: 'Send each',
                    enabled: true,
                    appliesTo: ['pullRequest'],
                    profileId: null,
                    workspaceMode: 'reference_only',
                    target: {
                        kind: 'agent',
                        promptInvocationId: 'prompt-1',
                        delivery: 'send',
                    },
                }],
            },
        });
        const { shell } = await mountShell(harness);

        await chooseRow('Replace the duplicated normalizer');
        await chooseRow('Extract the selection reducer');
        await act(async () => {
            await shell.press(await shell.getByRole('button', { name: 'A session each' }));
        });
        await settle();

        expect(harness.spawnInputs).toHaveLength(2);
        const firstCreationKey = (harness.spawnInputs[0] as { creationKey: string }).creationKey;
        const unfinishedCreationKey = (harness.spawnInputs[1] as { creationKey: string }).creationKey;
        const retry = await shell.getByRole('button', { name: 'Try again' });

        await act(async () => { await shell.press(retry); });
        await settle();

        expect(harness.spawnInputs).toHaveLength(3);
        expect((harness.spawnInputs[2] as { creationKey: string }).creationKey).toBe(unfinishedCreationKey);
        expect((harness.spawnInputs[2] as { creationKey: string }).creationKey).not.toBe(firstCreationKey);
        expect(document.body.textContent).toContain(
            '2 started, 0 unconfirmed, 0 not started, 0 could not be used',
        );
    });

    it('still opens a detail on an unmodified press while no set is being built', async () => {
        const { locations } = await mountShell(createHarness());
        const before = locations.length;

        await pressRow('Replace the duplicated normalizer');

        expect(locations.slice(before).length).toBeGreaterThan(0);
    });
});
