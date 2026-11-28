import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import type { ScmWorkingSnapshot } from '@happier-dev/plugin-sdk/scm';
import {
    TriageConfiguredSourceInstanceV1Schema,
    TriageSourceInstanceDraftV1Schema,
    projectTriagePrepareReviewWorkspaceInputV1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    type TriageConfiguredSourceInstanceV1,
    type TriagePrepareReviewWorkspaceInputV1,
    type TriagePrepareReviewWorkspaceResultV1,
    type TriageReviewWorkspaceObservedRevisionV1,
    type TriageSourceFailureV1,
    type TriageSelectedWorkspaceScopeV1,
} from '@happier-dev/triage-protocol/v1';

import {
    TESTKIT_SOURCE_INSTANCE_ID,
    TRIAGE_TESTKIT_SOURCE,
    testkitEntryRef,
    testkitLocator,
} from '../../corpus/testkit/observations.test-support.js';
import type { TriageEntrySessionLinkDisplayV1 } from '../entrySessionLinks.js';
import type { TriageEntrySessionDepsV1 } from '../entrySessionOrchestrator.js';
import { createTriageSourceSessionRelations } from '../sourceSessionRelations.js';
import type { CorpusCollectionsV1 } from '../../corpus/collections/bindCorpusCollections.js';
import type { TriageSessionActionIdV1, TriageSessionActionInvokerV1 } from '../entrySessionOpen.js';
import type {
    TriagePrepareReviewWorkspaceOperationV1,
    TriageReviewWorkspacePreparationDepsV1,
} from '../entrySessionWorkspace.js';
import { TriageStartEntrySessionInputV1Schema } from '../../actions/entrySessionProtocol.js';
import { createTriageReadSourceSessionLinksActionHandler } from '../../actions/sessionLinks.js';
import { TriageReadSourceSessionLinksInputV1Schema } from '../../actions/sessionLinksProtocol.js';
import type { TriageDataActionContext } from '../../actions/dataContext.js';
import { administerConfiguredSourceInstance } from '../../corpus/configuration/administerConfiguredSourceInstance.js';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { JsonValue, PluginApi, PluginAccountApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { activate } from '../../activate.js';
import { activate as activateAccount } from '../../accountRuntime.js';
import { createTestkitCorpusCollections } from '../../corpus/testkit/corpusCollections.test-support.js';
import { testkitSnapshot, testkitViewer } from '../../corpus/testkit/observations.test-support.js';
import { CORPUS_SESSION_LINKS_COLLECTION_ID, CORPUS_SOURCE_INSTANCES_COLLECTION_ID } from '../../corpus/collections/ids.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, TriageReadEntryDetailResultV1Schema } from '../../actions/entryDetailProtocol.js';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReobserveEntryResultV1Schema } from '../../actions/reobserveEntryProtocol.js';
import { TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1, TriageResolveResourceActionResultV1Schema } from '../../actions/resolveResourceProtocol.js';

/** A real Workflow admission receipt; engine launches have not happened yet. */
export const TESTKIT_REVIEW_WORKFLOW_RECEIPT = { reviewRound: { reviewId: 'review-standard-workflow', roundOrdinal: 1 },
    admission: 'created', run: {
        id: 'review-workflow', sourceArtifactId: null, ownerAccountId: 'account', visibleTeamId: null,
        attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        origin: { kind: 'direct' }, state: 'running', revision: 1, machineId: 'machine',
        workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
} as const;

/** The Action transport accepts built-ins and exact qualified Triage self-calls. */
export function testkitTriageActionId(ref: unknown): string {
    if (typeof ref === 'string') return ref;
    return ref && typeof ref === 'object' && 'pluginId' in ref && ref.pluginId === 'happier.triage'
        && 'localId' in ref && typeof ref.localId === 'string' ? ref.localId : '';
}

/** The host-admitted read-only fixture source; opaque operation handles stay at the RPC boundary. */
export function testkitReadOnlySourceSnapshot() {
    return { contributions: [{
        contributor: { pluginId: TRIAGE_TESTKIT_SOURCE.pluginId, contributionId: TRIAGE_TESTKIT_SOURCE.localId },
        descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example source', kinds: [
            { id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' },
            { id: 'issue', workflowSubject: 'issue', displayName: 'Issue' },
        ] }, operations: {},
    }] };
}

/** Real relation owner with only its admitted-registry transport replaced. */
type TestkitRelationOwnerInput = Readonly<{
    collections: Pick<CorpusCollectionsV1, 'sourceInstances' | 'sessionLinks'>;
    contributions?: readonly unknown[];
    signal?: AbortSignal;
}>;
export function createTestkitSourceSessionRelations(input: TestkitRelationOwnerInput): ReturnType<typeof createTriageSourceSessionRelations>;
export function createTestkitSourceSessionRelations(collections: TestkitRelationOwnerInput['collections'], snapshot?: unknown): ReturnType<typeof createTriageSourceSessionRelations>;
export function createTestkitSourceSessionRelations(
    input: TestkitRelationOwnerInput | TestkitRelationOwnerInput['collections'],
    snapshot?: unknown,
) {
    const options: TestkitRelationOwnerInput = 'collections' in input ? input : { collections: input };
    // The boundary fixture supplies the subset of the invocation used by this owner.
    const context = { signal: options.signal ?? new AbortController().signal, services: {
        targetedContributions: { observeForSelf: () => ({
            readCurrent: async () => snapshot ?? { contributions: options.contributions ?? testkitReadOnlySourceSnapshot().contributions },
            dispose() {},
        }) },
        actions: { executeAdmittedTargetedOperation: async () => { throw new Error('No source relation role was scripted'); } },
    } } as unknown as Parameters<typeof createTriageSourceSessionRelations>[0];
    return createTriageSourceSessionRelations(context, options.collections);
}

/** The same required callback production supplies, using the real relation owner. */
export function createTestkitEntrySessionLinkWriter(
    collections: TestkitRelationOwnerInput['collections'],
): TriageEntrySessionDepsV1['linkSession'] {
    const instance = testkitConfiguredInstance();
    const draft = testkitSourceInstanceDraft();
    // Starts carry the selected configured-instance identity. Populate that
    // genuine persistence boundary through its lifecycle owner before linking.
    let ready: ReturnType<typeof administerConfiguredSourceInstance> | undefined;
    const relations = createTestkitSourceSessionRelations(collections);
    return async (input) => {
        await (ready ??= administerConfiguredSourceInstance({ collections, source: instance.instance.source,
            declaredPurpose: instance.binding.purpose, request: { kind: 'create', draft }, nowMs: 1,
            mintSourceInstanceId: () => instance.instance.sourceInstanceId }));
        const result = await relations.write({ ...input, linked: true });
        return { status: result.status === 'linked' ? 'linked' : 'failed' };
    };
}

/** The real portable Action with only storage and admitted-registry transports supplied. */
export async function readTestkitSourceSessionLinks(input: unknown, options: TestkitRelationOwnerInput) {
    const context = { surface: 'ui', caller: { kind: 'plugin', pluginId: 'happier.triage' },
        signal: options.signal ?? new AbortController().signal, services: {
            storage: { account: { collection: (definition: { id: string }) => definition.id === 'session-links'
                ? options.collections.sessionLinks : options.collections.sourceInstances } },
            targetedContributions: { observeForSelf: () => ({
                readCurrent: async () => ({ contributions: options.contributions ?? testkitReadOnlySourceSnapshot().contributions }),
                dispose() {},
            }) },
            actions: { executeAdmittedTargetedOperation: async () => { throw new Error('No source relation role was scripted'); } },
        },
    } as unknown as TriageDataActionContext; // Host transport fixture; no domain logic is substituted.
    return await createTriageReadSourceSessionLinksActionHandler()(TriageReadSourceSessionLinksInputV1Schema.parse(input), context);
}

/**
 * Fixtures for the Session start vertical.
 *
 * The two boundaries a Session start actually crosses are replaced here and
 * nowhere else: the Account Collection store (through the corpus testkit) and
 * the host Action RPC. Every Triage decision — intent and subject gating,
 * directory authority, creation-result consumption, link identity and phase
 * retry — runs for real against those boundaries.
 */

/** The projected facts a start carries into the link, as one pass rendered them. */
export const TESTKIT_LINK_DISPLAY: TriageEntrySessionLinkDisplayV1 = Object.freeze({
    locator: testkitLocator(),
    scopeLabel: 'example/repository',
});

export type RecordedActionCall = Readonly<{
    actionId: TriageSessionActionIdV1;
    input: PluginActionInputById[TriageSessionActionIdV1];
}>;

export type TestkitActionInvoker = Readonly<{
    execute: TriageSessionActionInvokerV1;
    calls: readonly RecordedActionCall[];
    callsFor: (actionId: TriageSessionActionIdV1) => readonly RecordedActionCall[];
}>;

/**
 * Records every host Action invocation and answers from a scripted queue, so a
 * test can assert both what was invoked and — just as importantly — what was
 * never invoked.
 */
export function createTestkitActionInvoker(script: Readonly<{
    spawn?: readonly PluginActionResultById['session.spawn_new'][];
    openFails?: boolean;
    /**
     * What the canonical Session-input admission answers, in order. Absent means
     * a plain acceptance, so a test that is not about delivery says nothing
     * about it; `sendThrows` is the boundary never answering at all.
     */
    send?: readonly PluginActionResultById['session.message.send'][];
    sendThrows?: boolean;
}> = {}): TestkitActionInvoker {
    const calls: RecordedActionCall[] = [];
    const spawnResults = [...(script.spawn ?? [])];
    const sendResults = [...(script.send ?? [])];

    const execute = (async (actionId, input) => {
        calls.push({ actionId, input });
        if (actionId === 'session.open') {
            if (script.openFails === true) throw new Error('session_open_failed');
            return null as PluginActionResultById[typeof actionId];
        }
        if (actionId === 'session.message.send') {
            if (script.sendThrows === true) throw new Error('session_message_send_failed');
            const answer = sendResults.shift()
                ?? { status: 'accepted' as const, localId: 'pending-local-id' };
            return answer as PluginActionResultById[typeof actionId];
        }
        const next = spawnResults.shift();
        if (!next) throw new Error('No scripted session.spawn_new result remains');
        return next as PluginActionResultById[typeof actionId];
    }) as TriageSessionActionInvokerV1;

    return {
        execute,
        get calls() {
            return calls;
        },
        callsFor: (actionId) => calls.filter((call) => call.actionId === actionId),
    };
}

export function spawnSuccess(
    overrides: Readonly<{
        sessionId?: string;
        disposition?: 'created' | 'rejoined';
        initialInput?: Extract<
            PluginActionResultById['session.spawn_new'],
            Readonly<{ type: 'success' }>
        >['initialInput'];
    }> = {},
): PluginActionResultById['session.spawn_new'] {
    return {
        type: 'success',
        disposition: overrides.disposition ?? 'created',
        sessionId: overrides.sessionId ?? 'session-a',
        executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
        organizationPlacement: { sectionId: null, tagIds: [] },
        initialInput: overrides.initialInput ?? { status: 'notRequested' },
    };
}

/** The exact configured instance a pull-request preparation is invoked for. */
export function testkitConfiguredInstance(
    overrides: Readonly<{ accountId?: string }> = {},
): TriageConfiguredSourceInstanceV1 {
    return TriageConfiguredSourceInstanceV1Schema.parse({
        v: 1,
        instance: { source: TRIAGE_TESTKIT_SOURCE, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID },
        binding: {
            purpose: 'triage-source',
            account: {
                service: { pluginId: TRIAGE_TESTKIT_SOURCE.pluginId, localId: 'accounts' },
                accountId: overrides.accountId ?? 'account-1',
            },
        },
        localInstanceKey: 'example/repository',
        configuration: { v: 1, token: 'routing-token' },
    });
}

/** Discovery metadata required by the lifecycle writer, unlike a retained configured context. */
export function testkitSourceInstanceDraft() {
    const { instance: _identity, ...scope } = testkitConfiguredInstance();
    return TriageSourceInstanceDraftV1Schema.parse({
        ...scope,
        keyStability: 'stable',
        locator: { v: 1, displayLabel: scope.localInstanceKey },
    });
}

/** The provider revision the pass observed, target-stamped for this one start. */
export const TESTKIT_OBSERVED_REVISION: TriageReviewWorkspaceObservedRevisionV1 = Object.freeze({
    baseSha: '1111111111111111111111111111111111111111',
    headSha: '2222222222222222222222222222222222222222',
    nativeRevision: 'pr-17@2',
    observedAtMs: 1_760_000_800_000,
});

/** The one saved workspace the user picked, projected from the incumbent selector. */
export const TESTKIT_SELECTED_WORKSPACE: TriageSelectedWorkspaceScopeV1 = Object.freeze({
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/workspaces/example-review',
});

export type RecordedPrepareCall = Readonly<{
    input: TriagePrepareReviewWorkspaceInputV1;
    options: Readonly<{ expectedSelectedConnectedAccountRef?: unknown; signal?: AbortSignal }>;
}>;

export type TestkitPrepareReviewWorkspace = Readonly<{
    deps: TriageReviewWorkspacePreparationDepsV1;
    calls: readonly RecordedPrepareCall[];
}>;

/**
 * Replaces exactly one boundary: the host execution of an admitted source
 * operation. The handle is opaque by construction — only the original
 * host-created value can execute — so a fixture stands in for it and the test
 * asserts what Triage handed the host, including what it never invoked.
 */
export function createTestkitPrepareReviewWorkspace(script: Readonly<{
    results: readonly TriagePrepareReviewWorkspaceResultV1[];
    operation?: 'present' | 'absent';
    throws?: Error;
}>): TestkitPrepareReviewWorkspace {
    const calls: RecordedPrepareCall[] = [];
    const results = [...script.results];
    const handle = { identity: { role: 'prepareReviewWorkspace' } } as unknown as
        TriagePrepareReviewWorkspaceOperationV1;

    return {
        deps: {
            ...(script.operation === 'absent' ? {} : { operation: handle }),
            execute: async (operation, input, options) => {
                if (operation !== handle) throw new Error('a copied handle has no execution authority');
                calls.push({ input, options });
                if (script.throws) throw script.throws;
                const next = results.shift();
                if (!next) throw new Error('No scripted prepareReviewWorkspace result remains');
                return next;
            },
        },
        get calls() {
            return calls;
        },
    };
}

/**
 * What a `send` action asks the start to deliver once the Session exists. The
 * attachment's other two halves come from the start's own `entryRef` and link
 * display, so only these travel.
 */
export const TESTKIT_DELIVERY_REQUEST = Object.freeze({
    text: 'Repair the failing parser test.',
    attachments: Object.freeze([{
        entryRef: testkitEntryRef(),
        display: TESTKIT_LINK_DISPLAY,
        sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
        title: 'Replace the duplicated normalizer',
    }]),
    idempotencyKey: 'delivery-key-a',
});

export const TESTKIT_SPAWN_REQUEST = Object.freeze({
    executionTarget: Object.freeze({ serverId: 'server-a', machineId: 'machine-a' }),
    agentTarget: Object.freeze({
        kind: 'agent' as const,
        identity: Object.freeze({ pluginId: 'happier.claude', localId: 'claude' }),
    }),
});

/** The selected-PR input produced by the start controller, with identity-only Account binding. */
export function createTriageSelectedPrStartApprovalInput() {
    const entryRef = testkitEntryRef();
    const instance = testkitConfiguredInstance();
    if (!('account' in instance.binding)) throw new Error('Expected the Connected Account test binding');
    const sourceInput = projectTriagePrepareReviewWorkspaceInputV1({
        instance, entryRef, lastKnownLocator: testkitLocator(), observed: TESTKIT_OBSERVED_REVISION,
        workspace: TESTKIT_SELECTED_WORKSPACE,
    });
    const { account: _selectedAccount, ...binding } = instance.binding;
    const selectedInput = { ...sourceInput, instance: { ...sourceInput.instance, binding } };
    return TriageStartEntrySessionInputV1Schema.parse({
        v: 1, workspaceMode: 'pull_request', entryRef,
        display: TESTKIT_LINK_DISPLAY,
        destination: {
            kind: 'new', creationKey: 'creation-key-1', spawn: TESTKIT_SPAWN_REQUEST,
            materialization: { kind: 'reviewWorkspace', request: {
                instance, entryRef, workflowSubject: 'pullRequest', lastKnownLocator: testkitLocator(),
                observed: TESTKIT_OBSERVED_REVISION, workspace: TESTKIT_SELECTED_WORKSPACE,
            } },
        },
        prepareReviewWorkspaceSelection: {
            selection: {
                target: { pluginId: 'happier.triage', sourceCustody: { kind: 'development', registeredRootId: 'triage-root-1' } },
                point: { pointId: 'sources', protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: 1 } },
                contributor: { pluginId: entryRef.source.pluginId, contributionId: entryRef.source.localId,
                    sourceCustody: { kind: 'development', registeredRootId: 'source-root-1' } },
            },
            input: selectedInput, credentialRef: instance.binding.account,
        },
    });
}

/** Real activation and Action schema admission, with only the host registry replaced. */
export function registeredTriageActionHandler(localId: string): ActionHandler<JsonValue, JsonValue> {
    const handlers = new Map<string, ActionHandler<JsonValue, JsonValue>>();
    const api = {
        actions: { register: (id: string, handler: ActionHandler<JsonValue, JsonValue>) => { handlers.set(id, handler); } },
        composerAttachments: { register: () => {} }, resources: { registerDynamicResource: () => {} },
        backgroundServices: { register: () => {} }, hooks: { register: () => {} },
    } as unknown as PluginApi & PluginAccountApi; // Host registration transport boundary.
    activate(api);
    activateAccount(api);
    const handler = handlers.get(localId);
    if (handler === undefined) throw new Error(`Activation registers no handler for "${localId}"`);
    return handler;
}

/**
 * Real registered prepare/reobserve/finalizer Actions for plugin and coordinator acceptance.
 * Storage, source dispatch and SCM capture are system boundaries; internal qualification,
 * preparation, currentness and strict scope production are never stubbed.
 */
export async function createTriagePullRequestReviewActionTestkit(options: Readonly<{
    signal?: AbortSignal;
    executeReview?: (input: unknown) => Promise<unknown>;
    baseRules?: Record<string, unknown>;
    rejectPreparation?: () => TriagePrepareReviewWorkspaceResultV1 | undefined;
    observationFailure?: TriageSourceFailureV1;
    repositoryConnected?: () => boolean;
    resolveManualResourceNumber?: (resource: Readonly<{ kind: string; url: string }>) => string | undefined;
    manualCheckout?: Readonly<{ repository?: string; localHome?: boolean; prState?: 'closed' | 'merged'; remotes?: ScmWorkingSnapshot['repo']['remotes'] }>;
    /** The host-stamped caller, as a workflow run's Action invocation carries it. */
    caller?: Readonly<{ kind: 'automationRun'; runId: string; automationId: string; cause: unknown }>;
}> = {}) {
    const start = createTriageSelectedPrStartApprovalInput();
    if (start.destination.kind !== 'new' || start.destination.materialization.kind !== 'reviewWorkspace'
        || start.prepareReviewWorkspaceSelection === undefined) throw new Error('Expected selected PR fixture');
    const request = start.destination.materialization.request;
    const selected = start.prepareReviewWorkspaceSelection;
    const { collections } = createTestkitCorpusCollections();
    await administerConfiguredSourceInstance({ collections, source: request.entryRef.source,
        declaredPurpose: request.instance.binding.purpose, request: { kind: 'create', draft: testkitSourceInstanceDraft() },
        nowMs: 1, mintSourceInstanceId: () => request.instance.instance.sourceInstanceId });
    let currentRevision = TESTKIT_OBSERVED_REVISION;
    let currentEntryRef = request.entryRef;
    let currentPullRequestNumber = 17;
    const currentLocator = () => options.manualCheckout
        ? testkitLocator({ webUrl: `https://github.com/example/repository/pull/${currentPullRequestNumber}` })
        : request.lastKnownLocator;
    const events: string[] = [];
    const prepareInputs: unknown[] = [];
    const verifyInputs: unknown[] = [];
    const captureInputs: unknown[] = [];
    const rulesReads: unknown[] = [];
    const executionOptions: unknown[] = [];
    const getOperation = { role: 'get' };
    const resolveOperation = { role: 'resolveResource' };
    const prepareOperation = { identity: { target: { pluginId: selected.selection.target.pluginId },
        point: selected.selection.point, contributor: { ...selected.selection.contributor, occurrenceId: 'source-1' },
        role: 'prepareReviewWorkspace' } };
    const verifyOperation = { role: 'verifyReviewWorkspace' };
    const comparisonSource = { kind: 'pullRequest' as const, locator: {
        providerId: 'example-forge', repository: 'example/repository', number: 17,
        baseOid: request.observed.baseSha, headOid: request.observed.headSha,
    } };
    const preparedWorkspace = { kind: 'prepared' as const, repositoryPath: TESTKIT_SELECTED_WORKSPACE.rootPath,
        branch: 'pr-17', created: false, pullRequest: { number: 17 }, currentness: { kind: 'currentAtObservedHead' as const } };
    const signal = options.signal ?? new AbortController().signal;
    const context = { surface: 'cli', signal, ...(options.caller === undefined ? {} : { caller: options.caller }), services: {
        sessions: { get: async (id: string) => id === 'session-a' && options.manualCheckout ? {
            summary: async () => ({
                machineId: TESTKIT_SELECTED_WORKSPACE.machineId,
                ...(options.manualCheckout?.localHome
                    ? { serverId: TESTKIT_SELECTED_WORKSPACE.serverId }
                    : { address: { sessionId: id, serverId: TESTKIT_SELECTED_WORKSPACE.serverId, serverUrl: 'https://home.example.test' } }),
            }),
        } : null },
        storage: { account: { collection: (definition: { id: string }) => definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
            ? collections.sourceInstances : definition.id === CORPUS_SESSION_LINKS_COLLECTION_ID
                ? collections.sessionLinks : collections.userMarks } },
        targetedContributions: { observeForSelf: () => ({
            readCurrent: async () => ({ occurrenceId: 'target-1', sourceCustody: selected.selection.target.sourceCustody,
                contributions: [{ contributor: { ...selected.selection.contributor, occurrenceId: 'source-1' },
                    descriptor: testkitReadOnlySourceSnapshot().contributions[0]!.descriptor,
                    protocol: selected.selection.point.protocol,
                    operations: { get: getOperation, prepareReviewWorkspace: prepareOperation, verifyReviewWorkspace: verifyOperation,
                        ...(options.manualCheckout ? { resolveResource: resolveOperation } : {}) } }] }),
            dispose() {},
        }) },
        actions: {
            executeAdmittedTargetedOperation: async (operation: unknown, input: unknown, invocationOptions: unknown) => {
                signal.throwIfAborted();
                if (operation === resolveOperation) {
                    const resource = input as { resource: { kind: string; url: string } }; // Source RPC boundary fixture.
                    const number = options.resolveManualResourceNumber
                        ? options.resolveManualResourceNumber(resource.resource)
                        : resource.resource.url === currentLocator().webUrl ? currentEntryRef.entryId : undefined;
                    return options.repositoryConnected?.() !== false && number !== undefined
                        ? { kind: 'resolved', localRef: { kindId: currentEntryRef.kindId,
                            collisionScope: currentEntryRef.collisionScope, entryId: number },
                            locator: testkitLocator({ webUrl: resource.resource.url }) } : { kind: 'unavailable' };
                }
                if (operation === getOperation) {
                    events.push('source.get');
                    const { localRef } = input as { localRef: Pick<typeof currentEntryRef, 'kindId' | 'collisionScope' | 'entryId'> };
                    if (options.manualCheckout && localRef.entryId !== currentEntryRef.entryId) return {
                        kind: 'unresolved', localRef, failure: { class: 'unknown', code: 'github_not_found' },
                    };
                    if (options.observationFailure) return { kind: 'unresolved', failure: options.observationFailure, localRef };
                    return { kind: 'present', localRef: { kindId: currentEntryRef.kindId,
                        collisionScope: currentEntryRef.collisionScope, entryId: currentEntryRef.entryId },
                        locator: currentLocator(), nativeRevision: currentRevision.nativeRevision,
                        snapshot: testkitSnapshot({ reviewRevision: { baseSha: currentRevision.baseSha,
                            headSha: currentRevision.headSha, nativeRevision: currentRevision.nativeRevision },
                            ...(options.manualCheckout?.prState ? { state: { presentation: 'closed' as const,
                                nativeLabel: options.manualCheckout.prState } } : {}) }), viewer: testkitViewer(),
                        ...(options.manualCheckout ? {
                            repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/repository' },
                            comparisonSource: { ...comparisonSource, locator: { ...comparisonSource.locator,
                                number: currentPullRequestNumber, baseOid: currentRevision.baseSha, headOid: currentRevision.headSha } },
                        } : {}) };
                }
                executionOptions.push(invocationOptions);
                if (operation === prepareOperation) {
                    const requested = input as TriagePrepareReviewWorkspaceInputV1;
                    const refused = options.rejectPreparation?.();
                    if (refused) return refused;
                    if (requested.observed.headSha !== currentRevision.headSha) return { kind: 'refused', reason: 'observedHeadMoved' };
                    events.push('source.prepareReviewWorkspace'); prepareInputs.push(input);
                    return preparedWorkspace;
                }
                if (operation !== verifyOperation) throw new Error('Unexpected source operation');
                events.push('source.verifyReviewWorkspace'); verifyInputs.push(input);
                return { kind: 'verified', pullRequest: preparedWorkspace.pullRequest };
            },
            execute: async (actionId: unknown, input: unknown) => {
                const action = testkitTriageActionId(actionId);
                switch (action) {
                    case TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1:
                    case TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1:
                    case TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1:
                        return await registeredTriageActionHandler(action)(input as JsonValue, context);
                }
                if (action === 'scm.status.snapshot' && options.manualCheckout) {
                    return { success: true, snapshot: { repo: { isRepo: true, rootPath: TESTKIT_SELECTED_WORKSPACE.rootPath,
                        remotes: options.manualCheckout.remotes ?? [] }, ...(options.manualCheckout.repository === undefined ? {} : {
                            hostingProvider: { id: 'github', kind: 'github', baseUrl: 'https://github.com',
                                nameWithOwner: options.manualCheckout.repository },
                        }) } };
                }
                if (actionId === 'scm.diffSummary.capture') {
                    events.push('scm.diffSummary.capture'); captureInputs.push(input);
                    const source = { ...comparisonSource, locator: { ...comparisonSource.locator,
                        number: currentPullRequestNumber, baseOid: currentRevision.baseSha, headOid: currentRevision.headSha } };
                    return { success: true, comparison: { id: 'c'.repeat(64), source,
                        repository: { rootPath: preparedWorkspace.repositoryPath },
                        endpoints: { before: 'c'.repeat(40), after: currentRevision.headSha },
                        pullRequest: { baseOid: currentRevision.baseSha }, inventory: { state: 'complete', files: [], reasons: [] } } };
                }
                if (actionId === 'scm.file.read') {
                    rulesReads.push(input);
                    if (options.baseRules === undefined) return { success: false, errorCode: 'not_found' };
                    const bytes = Buffer.from(JSON.stringify(options.baseRules));
                    return { success: true, contentBase64: bytes.toString('base64'), sizeBytes: bytes.length, sha256: 'a'.repeat(64) };
                }
                if (actionId === 'review.start' && options.executeReview) {
                    events.push('review.start'); return await options.executeReview(input);
                }
                throw new Error(`Unexpected Action: ${JSON.stringify(actionId)}`);
            },
        },
    } } as unknown as PluginInvocationContext; // Host services and external source/SCM transports.
    const invoke = async (localId: string, input: JsonValue) => await registeredTriageActionHandler(localId)(input, context);
    return { context, collections, events, prepareInputs, verifyInputs, captureInputs, rulesReads, executionOptions, preparedWorkspace,
        removeReviewSource: () => administerConfiguredSourceInstance({ collections, source: request.entryRef.source,
            declaredPurpose: request.instance.binding.purpose,
            request: { kind: 'remove', sourceInstanceId: request.instance.instance.sourceInstanceId }, nowMs: 2,
            mintSourceInstanceId: () => { throw new Error('Removing a source does not mint an instance'); } }),
        savedInput: { v: 1 as const, request, prepareReviewWorkspaceSelection: selected,
            sessionId: 'session-a', reviewTarget: { entryRef: request.entryRef,
                lastKnownLocator: request.lastKnownLocator, comparisonSource } },
        setRevision: (revision: typeof TESTKIT_OBSERVED_REVISION) => { currentRevision = revision; },
        setPullRequestNumber: (number: number) => {
            currentPullRequestNumber = number;
            currentEntryRef = { ...request.entryRef, entryId: String(number) };
            preparedWorkspace.pullRequest.number = number;
            preparedWorkspace.branch = `pr-${number}`;
        },
        invoke,
        resolveManualInput: async (reference: string | number = '17') => {
            const sessionId = 'session-a';
            const resolved = TriageResolveResourceActionResultV1Schema.parse(await invoke(TRIAGE_RESOLVE_RESOURCE_ACTION_LOCAL_ID_V1,
                { v: 1, kind: 'pullRequestForSession', reference, sessionId }));
            if (resolved.kind !== 'resolved') throw new Error('Expected a connected pull request');
            const exact = { v: 1, entryRef: resolved.entryRef, sourceInstanceId: resolved.sourceInstance.sourceInstanceId };
            const detail = TriageReadEntryDetailResultV1Schema.parse(await invoke(TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, exact));
            const observed = TriageReobserveEntryResultV1Schema.parse(await invoke(TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
                { ...exact, lastKnownLocator: resolved.locator, includeComparisonSource: true }));
            if (detail.kind !== 'read' || observed.kind !== 'observed' || !observed.comparisonSource) {
                throw new Error('Expected an observed pull request with a comparison');
            }
            return { v: 1, kind: 'resolvedPullRequestForSession', sessionId, instance: detail.instance,
                entryRef: observed.entryRef, observation: observed.observation, comparisonSource: observed.comparisonSource } as const;
        },
    };
}
