import { definePlugin, PluginError, type JsonValue, type PluginAccountApi, type PluginServices } from '@happier-dev/plugin-sdk';
import type { StorageService } from '@happier-dev/plugin-sdk/storage';
import { createPluginClientTestkit, createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import {
    TriageGetResultV1Schema,
    TriageSourceDescriptorV1Schema,
    TriageSourcesContributionProtocolV1,
    TriageTaskWriteResultV1Schema,
    TriageConfiguredSourceInstanceV1Schema,
    type TriageTaskWriteResultV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { createTestkitCorpusCollections, selectTestkitConfiguredSources } from '../corpus/testkit/corpusCollections.test-support.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { CORPUS_SESSION_LINKS_INDEX_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { TriageListEntriesResultV1Schema } from './listEntriesProtocol.js';
import { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 } from './sessionLinksProtocol.js';
import { TRIAGE_LIST_NO_FILTERS_V1, triageEntryRowKey } from '../projection/listWindow.js';
import { INTERNAL_TASK_DRAFT_V1, INTERNAL_TASK_SOURCE_V1 } from '../internalTasks/source.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../internalTasks/configuration.js';
import { administerConfiguredSourceInstance } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { buildTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { resolveTriageWorkItems, findLinkedTriageWorkItems, transitionTriageWorkItem, observeTriageWorkItems } from '../workItems/runtime.js';
import { activate as activateTriageWorkClient, TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1 } from '../ui/list/entryDragDrop.js';
import { settleTriageTaskDropResult } from '../ui/list/taskDropOutcome.js';

const fixture = createTriageSourceV1Fixture();
const configured = fixture.configuredInstance;
const source = configured.instance.source;
const instanceId = configured.instance.sourceInstanceId;
const secondInstanceId = 'ba9752ad-48f8-4a4c-9054-a9ff99a1fc12';
const protocol = TriageSourcesContributionProtocolV1;
const base = TriageGetResultV1Schema.parse(fixture.getResult);
if (base.kind !== 'present') throw new Error('The public fixture must provide a present entry');
const initialTask = { ...base, localRef: { ...base.localRef, kindId: 'issue', entryId: 'task-1' },
    snapshot: { ...base.snapshot, dueDate: '2026-10-25' } };
const entryRef = { source, ...initialTask.localRef };
const originError = {
    entryRef: { source: { pluginId: 'example.errors', localId: 'production' }, kindId: 'error', collisionScope: 'project-a', entryId: 'task-1' },
    display: { title: 'Checkout failed', scopeLabel: 'Production' },
};

/** A separately authored source: no aggregate imports or bundled source implementation. */
async function withExternalTaskSource(
    run: (fixture: Readonly<{
        aggregate: PluginTestkit;
        contributor: PluginTestkit;
        corpus: ReturnType<typeof createTestkitCorpusCollections>;
        writes: readonly Readonly<{ role: string; input: JsonValue }>[];
        readRequests: readonly string[];
        setWriteResult: (result: TriageTaskWriteResultV1 | null) => void;
        setAccountTasksUnavailable: (unavailable: boolean) => void;
        withContext: (run: (context: PluginAccountActionContext) => Promise<void>) => Promise<void>;
    }>) => Promise<void>,
    options: Readonly<{ readOnly?: boolean; retired?: boolean; secondInstance?: boolean; initialTaskPage?: boolean; firstInstanceKeepsPaging?: boolean; scopeSelection?: boolean; completedScan?: boolean; completedScanSupport?: boolean; unboundedCompleted?: boolean; machineUnavailable?: boolean; accountSource?: boolean; findings?: boolean;
        linkTransport?: 'failed' | 'lost' | 'malformed' | 'notStarted'; originLinkTransport?: 'failed' | 'lost'; reviewLinkConflict?: boolean; reviewReadApproval?: boolean; sourceWriteTransport?: 'notStarted' | 'responseLost' | 'denied' | 'cancelled'; setupReadFailure?: boolean; sourceWriteGate?: () => Promise<void>; accountEncryptionMode?: 'plain' | 'e2ee'; taskParent?: typeof entryRef; accountTasksAvailable?: boolean; accountTasksUnavailable?: boolean }> = {},
) {
    const configured = options.accountSource ? TriageConfiguredSourceInstanceV1Schema.parse({
        ...fixture.configuredInstance, binding: { purpose: fixture.descriptor.purpose, source: 'accountData' },
    }) : fixture.configuredInstance;
    const execution = options.accountSource ? { execution: {
        target: 'account', account: { artifactId: 'example-account-source', exportName: 'activate' },
    } as const } : {};
    const descriptor = TriageSourceDescriptorV1Schema.parse({
        ...fixture.descriptor,
        ...(options.scopeSelection ? { scopeUnit: { singularLabel: 'Team', pluralLabel: 'teams' } } : {}),
        kinds: [fixture.descriptor.kinds[0], {
            id: 'issue', workflowSubject: 'issue', displayName: 'Issue', task: true,
            taskCapabilities: {
                ...(options.completedScanSupport === false ? {} : { completedScan: true }),
                createFields: ['title'], editFields: ['title'],
                completingTransitionId: 'finish',
                transitions: [{ id: 'begin', label: 'Begin', state: { presentation: 'active', nativeLabel: 'Started', stage: 'started' } },
                    { id: 'finish', label: 'Finish', state: { presentation: 'resolved', completionReason: 'completed' } }],
            },
        }, ...(options.findings ? ['dependabot-alert', 'code-scanning-alert', 'external-finding'].map(id => ({
            id, workflowSubject: 'errorIssue', displayName: id,
        })) : [])],
    });
    let task = { ...initialTask, snapshot: { ...initialTask.snapshot,
        ...(options.taskParent === undefined ? {} : { relations: { parent: options.taskParent } }),
    } };
    const writes: { role: string; input: JsonValue }[] = [];
    const readRequests: string[] = [];
    let writeResult: TriageTaskWriteResultV1 | null = null;
    let accountTasksUnavailable = options.accountTasksUnavailable === true;
    const definition = definePlugin({
        id: source.pluginId, version: '0.0.0',
        actions: {
            discover: { ...execution, title: 'Discover', surfaces: protocol.operations.listInstances.declaration.surfaces,
                dangerLevel: protocol.operations.listInstances.declaration.dangerLevel,
                inputSchema: protocol.operations.listInstances.declaration.input.schema,
                resultSchema: protocol.operations.listInstances.declaration.resultSchema,
                run: async () => options.accountSource && fixture.listInstancesResult.kind === 'complete'
                    ? { ...fixture.listInstancesResult, candidates: fixture.listInstancesResult.candidates.map(candidate => ({ ...candidate, binding: configured.binding })) }
                    : fixture.listInstancesResult },
            scan: { ...execution, title: 'Scan', surfaces: protocol.operations.scan.declaration.surfaces,
                dangerLevel: protocol.operations.scan.declaration.dangerLevel,
                inputSchema: protocol.operations.scan.declaration.input.schema,
                resultSchema: protocol.operations.scan.declaration.resultSchema,
                run: async (input) => {
                    if (options.completedScan || options.unboundedCompleted) {
                        const selected = options.unboundedCompleted || input.completed?.kindIds.length === 1
                            && input.completed.kindIds[0] === 'issue' && input.completed.sinceMs <= 100;
                        return { kind: 'complete', observations: selected ? [{ ...task, snapshot: { ...task.snapshot,
                            state: { presentation: 'resolved', completionReason: 'completed' }, completedAtMs: 100 } }] : [],
                            evidence: { kind: 'walkFinished' } };
                    }
                    const selectedTask = input.instance.instance.sourceInstanceId === instanceId ? task
                        : { ...task, localRef: { ...task.localRef, entryId: 'task-2' } };
                    const observedTask = options.scopeSelection ? { ...selectedTask, snapshot: {
                        ...selectedTask.snapshot,
                        scopeUnitId: input.instance.instance.sourceInstanceId === instanceId ? 'team-a' : 'team-b',
                    } } : selectedTask;
                    if (options.firstInstanceKeepsPaging && input.instance.instance.sourceInstanceId === instanceId) {
                        return { kind: 'page', observations: [observedTask], evidence: { kind: 'partial', reason: 'pageLimit' },
                            continuation: { v: 1, token: input.page.kind === 'initial' ? 'after-task' : `${input.page.continuation.token}/next` } };
                    }
                    if (options.findings) {
                        const rows = [base, ...['dependabot-alert', 'code-scanning-alert', 'external-finding'].map(kindId => ({
                            ...base, localRef: { ...base.localRef, kindId, entryId: 'same-number' },
                        })), observedTask];
                        // The separately authored source owns this opaque continuation, including its admitted page size.
                        const [offset, limit] = input.page.kind === 'initial' ? [0, input.page.limit]
                            : input.page.continuation.token.split('/').map(Number);
                        if (offset === undefined || limit === undefined) throw new Error('Invalid fixture scan continuation');
                        const observations = rows.slice(offset, offset + limit);
                        return offset + limit >= rows.length
                            ? { kind: 'complete', observations, evidence: { kind: 'walkFinished' } }
                            : { kind: 'page', observations, evidence: { kind: 'partial', reason: 'pageLimit' },
                                continuation: { v: 1, token: `${offset + limit}/${limit}` } };
                    }
                    return input.page.kind === 'initial' && !options.initialTaskPage ? {
                        kind: 'page', observations: [base], evidence: { kind: 'partial', reason: 'pageLimit' },
                        continuation: { v: 1, token: 'after-pr' },
                    } : { kind: 'complete', observations: [observedTask], evidence: { kind: 'walkFinished' } };
                } },
            get: { ...execution, title: 'Get', surfaces: protocol.operations.get.declaration.surfaces,
                dangerLevel: protocol.operations.get.declaration.dangerLevel,
                inputSchema: protocol.operations.get.declaration.input.schema,
                resultSchema: protocol.operations.get.declaration.resultSchema,
                run: async () => { readRequests.push('get'); return task; } },
            ...(options.scopeSelection ? {
                scopes: { ...execution, title: 'List teams', surfaces: protocol.operations.listScopeUnits.declaration.surfaces,
                    dangerLevel: protocol.operations.listScopeUnits.declaration.dangerLevel,
                    inputSchema: protocol.operations.listScopeUnits.declaration.input.schema,
                    resultSchema: protocol.operations.listScopeUnits.declaration.resultSchema,
                    run: async (input) => {
                        readRequests.push(`scope:${input.mode}`);
                        if (input.mode !== 'configured') throw new Error('The aggregate must never discover provider units');
                        return { kind: 'page' as const, status: 'complete' as const,
                            selection: { kind: 'selected' as const, unitIds: ['team-a', 'team-b'] },
                            units: [{ id: 'team-a', label: 'Platform' }, { id: 'team-b', label: 'Mobile' }] };
                    } },
            } : {}),
            ...(!options.readOnly ? {
                create: { ...execution, title: 'Create', surfaces: protocol.operations.create.declaration.surfaces,
                    dangerLevel: protocol.operations.create.declaration.dangerLevel,
                    inputSchema: protocol.operations.create.declaration.input.schema,
                    resultSchema: protocol.operations.create.declaration.resultSchema,
                    confirmation: { title: 'Create issue?', body: 'Creates one provider issue.' },
                    run: async (input) => {
                        writes.push({ role: 'create', input });
                        if (writeResult) return writeResult;
                        task = { ...task, snapshot: { ...task.snapshot, title: input.fields.title } };
                        return { kind: 'applied', observation: task };
                    } },
                edit: { ...execution, title: 'Edit', surfaces: protocol.operations.edit.declaration.surfaces,
                    dangerLevel: protocol.operations.edit.declaration.dangerLevel,
                    inputSchema: protocol.operations.edit.declaration.input.schema,
                    resultSchema: protocol.operations.edit.declaration.resultSchema,
                    confirmation: { title: 'Edit issue?', body: 'Edits the selected provider issue.' },
                    run: async (input) => {
                        writes.push({ role: 'edit', input });
                        if (writeResult) return writeResult;
                        task = { ...task, snapshot: { ...task.snapshot, title: input.fields.title ?? task.snapshot.title } };
                        return { kind: 'applied', observation: task };
                    } },
                transition: { ...execution, title: 'Transition', surfaces: protocol.operations.transition.declaration.surfaces,
                    dangerLevel: protocol.operations.transition.declaration.dangerLevel,
                    inputSchema: protocol.operations.transition.declaration.input.schema,
                    resultSchema: protocol.operations.transition.declaration.resultSchema,
                    confirmation: { title: 'Change issue status?', body: 'Changes the native provider status.' },
                    run: async (input) => {
                        writes.push({ role: 'transition', input });
                        if (writeResult) return writeResult;
                        task = { ...task, snapshot: { ...task.snapshot,
                            ...(input.transitionId === 'finish' ? { completedAtMs: 100 } : {}),
                            state: input.transitionId === 'finish' ? { presentation: 'resolved', completionReason: 'completed' }
                                : { presentation: 'active', nativeLabel: input.transitionId, stage: 'started' } } };
                        return { kind: 'applied', observation: task };
                    } },
            } : {}),
        },
        ui: { renderers: [{ id: 'detail', kind: 'declarative', root: { kind: 'text', text: 'External task' } }] },
        contributesTo: { 'happier.triage': { sources: { [source.localId]: protocol.contribute({
            descriptor,
            operations: {
                listInstances: protocol.operations.listInstances.bind('discover'),
                scan: protocol.operations.scan.bind('scan'),
                get: protocol.operations.get.bind('get'),
                ...(options.scopeSelection ? { listScopeUnits: protocol.operations.listScopeUnits.bind('scopes') } : {}),
                ...(!options.readOnly ? {
                    create: protocol.operations.create.bind('create'),
                    edit: protocol.operations.edit.bind('edit'),
                    transition: protocol.operations.transition.bind('transition'),
                } : {}),
            },
            surfaces: { detail: { renderer: 'detail' } },
        }) } } },
    });
    const contributor = await createPluginTestkit({ manifest: definition.manifest, module: definition,
        ...(options.machineUnavailable || options.accountSource ? { resolveCurrentPluginMaterializationRef: () => null } : {}),
    });
    const corpus = createTestkitCorpusCollections({ accountEncryptionMode: options.accountEncryptionMode ?? 'plain' });
    corpus.control.sourceInstances.seed(toCorpusStoredValue({
        instanceTag: 'a'.repeat(43), sourceQualifiedId: `${source.pluginId}/${source.localId}`,
        lifecycle: options.retired ? CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired : CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1, configured,
        ...(options.retired ? { retiredReason: 'userRemoved' as const } : {}),
    }));
    if (options.machineUnavailable) await administerConfiguredSourceInstance({
        collections: corpus.collections, source: INTERNAL_TASK_SOURCE_V1, declaredPurpose: 'tasks',
        request: { kind: 'create', draft: INTERNAL_TASK_DRAFT_V1 }, nowMs: 2,
        mintSourceInstanceId: () => secondInstanceId,
    });
    if (options.secondInstance) {
        corpus.control.sourceInstances.seed(toCorpusStoredValue({
            instanceTag: 'b'.repeat(43), sourceQualifiedId: `${source.pluginId}/${source.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 2,
            configured: {
                ...configured, instance: { ...configured.instance, sourceInstanceId: secondInstanceId },
                localInstanceKey: `${configured.localInstanceKey}/second`,
                configuration: { v: 1, token: 'second-configuration-token' },
            },
        }));
    }
    let reviewConflictPending = options.reviewLinkConflict === true;
    const userMarks: typeof corpus.collections.userMarks = { ...corpus.collections.userMarks,
        batch: async (mutations, writeOptions) => {
            if (reviewConflictPending && mutations.some(mutation => mutation.kind === 'put' && mutation.value.originReview !== undefined)) {
                reviewConflictPending = false;
                return { status: 'conflict', conflicts: [] };
            }
            return corpus.collections.userMarks.batch(mutations, writeOptions);
        },
    };
    const storage = { account: { collection: (definition: { id: string }) => {
        if (definition.id === 'source-instances') return corpus.collections.sourceInstances;
        if (definition.id === 'session-links') return corpus.collections.sessionLinks;
        if (definition.id === 'user-marks') return userMarks;
        throw new Error(`Unexpected Collection ${definition.id}`);
    } } } as unknown as StorageService;
    let aggregate!: PluginTestkit;
    let contextRun: ((context: PluginAccountActionContext) => Promise<void>) | undefined;
    // The host service is a genuine boundary. The SDK issues and dispatches its
    // original opaque handles from the real source declaration + registration;
    // this adapter adds only descriptor semantics, which the testkit omits.
    let sourceObservationDisposed = false;
    const targetedContributions = { observeForSelf: () => { sourceObservationDisposed = false; return {
        readCurrent: async () => {
            if (options.setupReadFailure) throw new PluginError({ code: 'plugin_action_current_intent_unavailable', retryable: false });
            const snapshot = aggregate.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
            return { ...snapshot, contributions: snapshot.contributions.map((entry) => {
                const contributorManifest = [definition.manifest, PLUGIN_MANIFEST].find(
                    (manifest) => manifest.id === entry.contributor.pluginId,
                );
                const declaration = contributorManifest?.contributes?.targetedPluginContributions?.find(
                    (candidate) => candidate.id === entry.contributor.contributionId,
                );
                return { ...entry, descriptor: TriageSourceDescriptorV1Schema.parse(declaration?.descriptor), surfaces: {} };
            }) };
        }, dispose: () => { sourceObservationDisposed = true; },
    }; } } as unknown as PluginServices['targetedContributions'];
    try {
        aggregate = await createPluginTestkit({
            manifest: PLUGIN_MANIFEST, module: {
                ...TRIAGE_PLUGIN,
                activateAccount(api: PluginAccountApi) {
                    TRIAGE_PLUGIN.activateAccount({ ...api, actions: { register(id, handler, registrationOptions) {
                        api.actions.register(id, async (input, context) => {
                            const run = contextRun;
                            contextRun = undefined;
                            if (run) await run({ ...context, services: { ...context.services, targetedContributions } });
                            const deferredSourceWrite: PluginServices['actions']['executeAdmittedTargetedOperation'] = async (operation, sourceInput, executionOptions) => {
                                await options.sourceWriteGate?.();
                                if (sourceObservationDisposed) throw new PluginError({ code: 'plugin_action_generation_retired', retryable: false });
                                return await context.services.actions.executeAdmittedTargetedOperation(operation, sourceInput, executionOptions);
                            };
                            const reviewAwareActions = { ...context.services.actions,
                                // Review Actions cross the host transport; authorization and selected data are supplied by that host.
                                execute: (async (action, reviewInput, actionOptions) => {
                                    if (action === 'reviews.comments.list') {
                                        if (options.reviewReadApproval) return ActionApprovalRequestCreatedResultSchema.parse({
                                            kind: 'approval_request_created', artifactId: 'review-read-approval', actionId: action,
                                        });
                                        if (reviewInput === null || typeof reviewInput !== 'object' || !('reviewId' in reviewInput)
                                            || !('commentIds' in reviewInput) || !Array.isArray(reviewInput.commentIds)
                                            || reviewInput.reviewId !== 'review-selected') {
                                            throw new PluginError({ code: 'review_comment_permission_denied', retryable: false });
                                        }
                                        const selectedIds = reviewInput.commentIds;
                                        return { items: ['finding-1', 'finding-2', 'finding-3']
                                            .filter(id => selectedIds.includes(id)).map(id => ReviewCommentV1Schema.parse({
                                            v: 1, id, reviewId: reviewInput.reviewId, accountId: 'account-1',
                                            anchor: { kind: 'file', filePath: 'src/a.ts' },
                                            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 10, capBytes: 1, capturedAt: 1 },
                                            body: 'private finding body', bodyVersion: 1, edits: [], author: { kind: 'user', userId: 'user-1' },
                                            state: 'open', flags: {}, dispositions: {}, threadId: id,
                                            transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 1,
                                        })), cursor: null };
                                    }
                                    return context.services.actions.execute(action, reviewInput, actionOptions);
                                }) as typeof context.services.actions.execute,
                            };
                            return handler(input, {
                            ...context, services: { ...context.services, targetedContributions,
                                ...(id === 'tasks/create-v1' || id === 'tasks/set-origin-review-v1' ? { actions: reviewAwareActions } : {}),
                                ...(options.sourceWriteGate === undefined ? {} : { actions: { ...context.services.actions,
                                    executeAdmittedTargetedOperation: deferredSourceWrite,
                                } }),
                                ...(options.sourceWriteTransport === undefined ? {} : { actions: { ...context.services.actions,
                                    // Genuine Action RPC boundary: the aggregate admission and opaque source handles remain real.
                                    executeAdmittedTargetedOperation: async () => {
                                        const error = new PluginError({ code: options.sourceWriteTransport === 'denied' || options.sourceWriteTransport === 'cancelled'
                                            ? options.sourceWriteTransport : 'unavailable', retryable: false });
                                        // Mirrors the host's registration/actionHandlerInvocation.ts transport error, including its wire data.
                                        throw options.sourceWriteTransport === 'notStarted'
                                            ? Object.assign(error, { actionHandlerInvocation: 'notStarted',
                                                data: { ...error.data, actionHandlerInvocation: 'notStarted' } }) : error;
                                    },
                                } }),
                                ...(id !== 'tasks/create-v1' || options.linkTransport === undefined && options.originLinkTransport === undefined ? {} : { actions: { ...context.services.actions,
                                // Genuine Action RPC boundary: all creation, source admission and result handling stay real.
                                execute: async () => {
                                    if (options.originLinkTransport !== undefined) {
                                        if (options.originLinkTransport === 'failed') return { v: 1, status: 'conflict' };
                                        throw new Error('Origin link response lost');
                                    }
                                    if (options.linkTransport === 'notStarted') {
                                        const error = new PluginError({ code: 'unavailable', retryable: false });
                                        throw Object.assign(error, { actionHandlerInvocation: 'notStarted',
                                            data: { ...error.data, actionHandlerInvocation: 'notStarted' } });
                                    }
                                    if (options.linkTransport === 'lost') throw new Error('Link response lost');
                                    return options.linkTransport === 'failed' ? { v: 1, status: 'failed' } : { unexpected: true };
                                },
                            } as typeof context.services.actions }),
                            },
                        });
                        }, registrationOptions);
                    } } });
                },
            }, targetedContributionContributors: [contributor],
            services: { storage, ...(options.machineUnavailable || options.accountTasksAvailable || options.accountTasksUnavailable ? { actions: { execute: async (id: string) => {
                if (id !== 'tasks.internal.list') throw new Error(`Unexpected host Action ${id}`);
                if (accountTasksUnavailable) throw new Error('Account tasks unavailable at the host boundary');
                return { status: 'ok', scope: { serverId: 'home', accountId: 'account' },
                    todos: options.machineUnavailable ? [{ id: 'personal', title: 'My Account task', state: 'unstarted', done: false, createdAt: 1, updatedAt: 1 }] : [],
                    undoneOrder: options.machineUnavailable ? ['personal'] : [], completedOrder: [] };
            } } as unknown as PluginServices['actions'] } : {}) },
            ...(options.machineUnavailable || options.accountSource ? { resolveCurrentPluginMaterializationRef: () => null } : {}),
        });
        // The registered invocation adapter above supplies descriptor semantics
        // at every host entry, including nested link Actions, over real opaque handles.
        await run({ aggregate, contributor, corpus, writes, readRequests, setWriteResult: (result) => { writeResult = result; },
            setAccountTasksUnavailable: unavailable => { accountTasksUnavailable = unavailable; },
            withContext: async callback => {
                contextRun = callback;
                // The registered Account Action supplies the canonical testkit
                // invocation lifetime/services; no internal owner is mocked.
                await aggregate.invokeAction('sources/read-configured-v1', { v: 1 }, { surface: 'agent' });
            },
        });
    } finally {
        await aggregate?.dispose();
        await contributor.dispose();
    }
}

describe('Tasks through a separately authored source and registered aggregate Actions', () => {
    it.each(['create', 'edit', 'transition'] as const)('keeps admitted source observation alive until a deferred %s write settles', async role => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const pending = role === 'create' ? aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'A task' },
            }, { surface: 'agent' }) : role === 'edit' ? aggregate.invokeAction('tasks/edit-v1', {
                v: 1, entryRef, sourceInstanceId: instanceId, fields: { title: 'A task' },
            }, { surface: 'mcp' }) : aggregate.invokeAction('tasks/transition-v1', {
                v: 1, entryRef, sourceInstanceId: instanceId, transitionId: 'finish',
            }, { surface: 'cli' });
            await started;
            release();
            expect(await pending).toMatchObject({ kind: 'applied' });
            expect(writes.map(write => write.role)).toEqual([role]);
        }, { sourceWriteGate: async () => { entered(); await gate; } });
    });

    it('reports setup transport failure before create, edit or transition without implying a provider write', async () => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const expected = { kind: 'failed', failure: { class: 'unknown', code: 'plugin_action_current_intent_unavailable' } };
            expect(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'A task' },
            }, { surface: 'agent' })).toEqual(expected);
            expect(await aggregate.invokeAction('tasks/edit-v1', {
                v: 1, entryRef, sourceInstanceId: instanceId, fields: { title: 'A task' },
            }, { surface: 'mcp' })).toEqual(expected);
            expect(await aggregate.invokeAction('tasks/transition-v1', {
                v: 1, entryRef, sourceInstanceId: instanceId, transitionId: 'finish',
            }, { surface: 'cli' })).toEqual(expected);
            expect(writes).toEqual([]);
        }, { setupReadFailure: true });
    });

    it.each(['notStarted', 'responseLost', 'denied', 'cancelled'] as const)('preserves the source write transport outcome through registered create, edit and transition: %s', async sourceWriteTransport => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const expected = sourceWriteTransport === 'notStarted'
                // 8db81218583 preserves the host's author payload and retryability.
                ? { kind: 'refused', reason: 'unavailable', details: {}, retryable: false }
                : { kind: 'uncertain', failure: { class: 'unknown', code: sourceWriteTransport === 'responseLost' ? 'unavailable' : sourceWriteTransport } };
            expect(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'A task' },
            }, { surface: 'agent' })).toEqual(expected);
            expect(await aggregate.invokeAction('tasks/edit-v1', {
                v: 1, entryRef, sourceInstanceId: instanceId, fields: { title: 'A task' },
            }, { surface: 'mcp' })).toEqual(expected);
            expect(await aggregate.invokeAction('tasks/transition-v1', {
                v: 1, entryRef, sourceInstanceId: instanceId, transitionId: 'finish',
            }, { surface: 'cli' })).toEqual(expected);
            expect(writes).toEqual([]);
        }, { sourceWriteTransport });
    });

    it('exposes external task work through the registered client and its named native transition Action', async () => {
        await withExternalTaskSource(async ({ aggregate, withContext, writes }) => {
            const client = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST,
                target: { artifactId: TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1, exportName: 'activate', platform: 'web' },
                activate: activateTriageWorkClient });
            try {
                const runtime = client.registration('workItems', 'work-items');
                expect(runtime).toBeDefined();
                if (runtime === undefined) throw new Error('The declared Triage Work Items client is unavailable');
                const itemId = buildTriageEntryRouteSegmentV1(entryRef);
                await withContext(async context => {
                    expect((await runtime.resolve({ serverId: 'home', itemIds: [itemId] }, context))[itemId])
                        .toMatchObject({ title: initialTask.snapshot.title, category: 'unstarted' });
                });
                expect(await aggregate.invokeAction('work-items/transition-v1', {
                    serverId: 'home', itemId, transitionId: 'finish',
                }, { surface: 'ui' })).toMatchObject({ kind: 'applied' });
                expect(writes.map(write => write.role)).toEqual(['transition']);
            } finally { await client.dispose(); }
        }, { accountTasksAvailable: true });
    });

    it('retains proven linked Work Items while another source is unavailable and reports recovery', async () => {
        await withExternalTaskSource(async ({ aggregate, withContext, setAccountTasksUnavailable }) => {
            await aggregate.invokeAction(TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, {
                v: 1, entryRef, sessionId: 'session-linked',
                display: { locator: initialTask.locator, scopeLabel: initialTask.snapshot.scopeLabel },
            }, { surface: 'agent' });
            const client = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST,
                target: { artifactId: TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1, exportName: 'activate', platform: 'web' },
                activate: activateTriageWorkClient });
            try {
                const runtime = client.registration('workItems', 'work-items');
                if (runtime === undefined) throw new Error('The declared Triage Work Items client is unavailable');
                const itemId = buildTriageEntryRouteSegmentV1(entryRef);
                const linked: unknown[] = [];
                let resolved: unknown;
                await withContext(async context => {
                    linked.push(await runtime.findLinked?.({ serverId: 'home', sessionIds: ['session-linked', 'session-empty', 'session-linked'] }, context));
                    resolved = (await runtime.resolve({ serverId: 'home', itemIds: [itemId] }, context))[itemId];
                    linked.push(await runtime.findLinked?.({ serverId: 'home', sessionIds: ['session-empty'] }, context));
                });
                setAccountTasksUnavailable(false);
                await withContext(async context => {
                    linked.push(await runtime.findLinked?.({ serverId: 'home', sessionIds: ['session-linked'] }, context));
                });
                expect(linked).toEqual([
                    { itemIds: [itemId], complete: false },
                    { itemIds: [], complete: false },
                    { itemIds: [itemId], complete: true },
                ]);
                expect(resolved).toMatchObject({ title: initialTask.snapshot.title,
                    linkedSessions: [{ serverId: 'home', sessionId: 'session-linked' }] });
            } finally { await client.dispose(); }
        }, { accountTasksUnavailable: true });
    });

    it('keeps read-only Work Items visible without offering a native write', async () => {
        await withExternalTaskSource(async ({ withContext, writes }) => {
            const itemId = buildTriageEntryRouteSegmentV1(entryRef);
            await withContext(async context => {
                const item = (await resolveTriageWorkItems({ serverId: 'home', itemIds: [itemId] }, context))[itemId];
                expect(item?.title).toBe(initialTask.snapshot.title);
                expect(item?.transitions).toBeUndefined();
                expect(await transitionTriageWorkItem({ serverId: 'home', itemId, transitionId: 'finish' }, context))
                    .toEqual({ kind: 'refused', reason: 'unsupportedOperation' });
                expect(writes).toEqual([]);
            });
        }, { readOnly: true });
    });

    it('pushes only demanded Work Items relation changes and retires their observation', async () => {
        await withExternalTaskSource(async ({ withContext, aggregate, readRequests }) => {
            await withContext(async context => {
                let changes = 0;
                const observation = await observeTriageWorkItems({ serverId: 'home',
                    itemIds: [buildTriageEntryRouteSegmentV1(entryRef)] }, () => { changes++; }, context);
                const initial = changes;
                const link = async (ref: typeof entryRef, sessionId: string) => aggregate.invokeAction(TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, {
                    v: 1, entryRef: ref, sessionId,
                    display: { locator: initialTask.locator, scopeLabel: initialTask.snapshot.scopeLabel },
                }, { surface: 'agent' });
                await link({ ...entryRef, entryId: 'other-task' }, 'session-unrelated');
                expect(changes).toBe(initial);
                await link(entryRef, 'session-demanded');
                expect(changes).toBe(initial + 1);
                expect(readRequests).toEqual([]);
                await observation.dispose();
                await link(entryRef, 'session-after-close');
                expect(changes).toBe(initial + 1);
            });
        });
    });

    it('discovers only task-linked Work Items and dispatches one native transition through the existing writer', async () => {
        await withExternalTaskSource(async ({ withContext, aggregate, writes, readRequests }) => {
            for (const linkedRef of [entryRef, { source, ...base.localRef }]) {
                await aggregate.invokeAction(TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, {
                    v: 1, entryRef: linkedRef, sessionId: 'session-linked',
                    display: { locator: initialTask.locator, scopeLabel: initialTask.snapshot.scopeLabel },
                }, { surface: 'agent' });
            }
            const itemId = buildTriageEntryRouteSegmentV1(entryRef);
            await withContext(async context => {
                expect(await findLinkedTriageWorkItems({ serverId: 'home', sessionIds: ['session-linked', 'session-linked'] }, context)).toEqual({ itemIds: [itemId], complete: true });
                expect(readRequests).toEqual([]);
                expect(await transitionTriageWorkItem({ serverId: 'home', itemId, transitionId: 'finish' }, context)).toMatchObject({ kind: 'applied' });
                expect(writes.map(write => write.role)).toEqual(['transition']);
                expect((await resolveTriageWorkItems({ serverId: 'home', itemIds: [itemId] }, context))[itemId]?.category).toBe('completed');
            });
        }, { accountTasksAvailable: true });
    });

    it.each(['plain', 'e2ee'] as const)('projects a live external Work Item through the existing source and relation owners (%s)', async accountEncryptionMode => {
        const parent = { ...entryRef, entryId: 'parent,with/slash' };
        await withExternalTaskSource(async ({ withContext, aggregate, readRequests }) => {
            await aggregate.invokeAction(TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, {
                v: 1, entryRef, sessionId: 'session-linked',
                display: { locator: initialTask.locator, scopeLabel: initialTask.snapshot.scopeLabel },
            }, { surface: 'agent' });
            const itemId = buildTriageEntryRouteSegmentV1(entryRef);
            await withContext(async context => {
                const result = await resolveTriageWorkItems({ serverId: 'home', itemIds: [itemId, 'invalid'] }, context);
                expect(result.invalid).toBeNull();
                expect(result[itemId]).toMatchObject({ title: initialTask.snapshot.title,
                    category: 'unstarted', parentItemId: buildTriageEntryRouteSegmentV1(parent),
                    linkedSessions: [{ serverId: 'home', sessionId: 'session-linked' }],
                    page: { pageId: 'tasks', subPath: `tasks,mine/${itemId}` },
                    transitions: [{ id: 'begin', category: 'started' }, { id: 'finish', category: 'completed' }],
                });
            });
            expect(readRequests).toEqual(['get']);
        }, { accountEncryptionMode, taskParent: parent });
    });

    it.each(['plain', 'e2ee'] as const)('creates once with an exact origin error and keeps it readable after unpinning the task (%s)', async (accountEncryptionMode) => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const result = await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', placeId: 'native-project/native-type', fields: { title: 'Fix checkout' }, originError,
            }, { surface: 'agent' });
            expect(result).toMatchObject({ kind: 'createdAndLinkAttempted', originErrorLink: 'linked',
                creation: { kind: 'applied', observation: { localRef: initialTask.localRef } } });
            expect(writes.map(write => write.role)).toEqual(['create']);
            expect(writes[0]!.input).toMatchObject({ placeId: 'native-project/native-type' });
            expect(await aggregate.invokeAction('tasks/read-origin-error-v1', { v: 1, entryRef }, { surface: 'agent' }))
                .toEqual({ v: 1, originError });
            await aggregate.invokeAction('marks/set-pinned-v1', { v: 1, entryRef, pinned: true,
                displayAtMark: { title: 'Fix checkout', scopeLabel: initialTask.snapshot.scopeLabel } }, { surface: 'agent' });
            await aggregate.invokeAction('marks/set-pinned-v1', { v: 1, entryRef, pinned: false }, { surface: 'agent' });
            expect(await aggregate.invokeAction('tasks/read-origin-error-v1', { v: 1, entryRef }, { surface: 'agent' }))
                .toEqual({ v: 1, originError });
            for (const distinctRef of [
                { ...entryRef, source: { ...source, pluginId: 'another.plugin' } },
                { ...entryRef, source: { ...source, localId: 'another-source' } },
                { ...entryRef, kindId: 'another-kind' },
                { ...entryRef, collisionScope: 'another-project' },
                { ...entryRef, entryId: 'another-task' },
            ]) {
                expect(await aggregate.invokeAction('tasks/read-origin-error-v1', { v: 1, entryRef: distinctRef }, { surface: 'agent' }))
                    .toEqual({ v: 1, originError: null });
            }
            const fixPullRequest = { source, ...base.localRef };
            await aggregate.invokeAction('marks/set-fix-pull-request-v1', { v: 1, linked: true, entryRef,
                displayAtMark: originError.display, fixPullRequest, displayAtLink: originError.display }, { surface: 'agent' });
            expect(await aggregate.invokeAction('tasks/set-origin-error-v1', {
                v: 1, entryRef, displayAtMark: originError.display, originError: null,
            }, { surface: 'agent' })).toEqual({ v: 1, status: 'unlinked' });
            expect(await aggregate.invokeAction('tasks/read-origin-error-v1', { v: 1, entryRef }, { surface: 'agent' }))
                .toEqual({ v: 1, originError: null });
            expect(await aggregate.invokeAction('marks/read-fix-pull-requests-v1', { v: 1, entryRef }, { surface: 'agent' }))
                .toMatchObject({ candidates: [expect.objectContaining({ entryRef: fixPullRequest })] });
        }, { accountEncryptionMode });
    });

    it.each(['failed', 'lost'] as const)('recovers only the origin link after creation succeeds and its link is %s', async (originLinkTransport) => {
        await withExternalTaskSource(async ({ aggregate, writes, readRequests }) => {
            expect(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Fix checkout' }, originError,
            }, { surface: 'agent' })).toMatchObject({ kind: 'createdAndLinkAttempted',
                originErrorLink: originLinkTransport === 'failed' ? 'failed' : 'unknown',
                creation: { kind: 'applied', observation: { localRef: initialTask.localRef } } });
            const repair = { v: 1, entryRef, displayAtMark: { title: 'Fix checkout', scopeLabel: initialTask.snapshot.scopeLabel }, originError };
            expect(await aggregate.invokeAction('tasks/set-origin-error-v1', repair, { surface: 'agent' })).toEqual({ v: 1, status: 'linked' });
            expect(await aggregate.invokeAction('tasks/set-origin-error-v1', repair, { surface: 'agent' })).toEqual({ v: 1, status: 'linked' });
            expect(await aggregate.invokeAction('tasks/read-origin-error-v1', { v: 1, entryRef }, { surface: 'agent' }))
                .toEqual({ v: 1, originError });
            expect(writes.map(write => write.role)).toEqual(['create']);
            expect(readRequests).toEqual([]);
        }, { originLinkTransport });
    });

    it('creates a task with only the selected Review references, retaining no finding content', async () => {
        const originReview = { reviewId: 'review-selected', findingIds: ['finding-1', 'finding-2'] };
        await withExternalTaskSource(async ({ aggregate, corpus, writes }) => {
            expect(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Address selected findings' }, originReview,
            }, { surface: 'agent' })).toMatchObject({ kind: 'createdAndLinkAttempted', reviewLink: 'linked', creation: { kind: 'applied' } });
            expect(await aggregate.invokeAction('tasks/read-origin-review-v1', { v: 1, entryRef }, { surface: 'agent' }))
                .toEqual({ v: 1, originReview });
            expect(writes).toHaveLength(1);
            expect(writes[0].input).not.toHaveProperty('originReview');
            const rows = (await corpus.collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows;
            expect(JSON.stringify(rows)).not.toContain('finding-3');
            expect(JSON.stringify(rows)).not.toContain('private finding body');
        });
    });

    it('retries a failed Review link without creating a second task', async () => {
        const originReview = { reviewId: 'review-selected', findingIds: ['finding-1', 'finding-2'] };
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            expect(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Selected findings' }, originReview,
            }, { surface: 'agent' })).toMatchObject({ kind: 'createdAndLinkAttempted', reviewLink: 'failed', creation: { kind: 'applied' } });
            const repair = { v: 1, entryRef, displayAtMark: { title: 'Selected findings', scopeLabel: initialTask.snapshot.scopeLabel }, originReview };
            expect(await aggregate.invokeAction('tasks/set-origin-review-v1', repair, { surface: 'agent' })).toEqual({ v: 1, status: 'linked' });
            expect(await aggregate.invokeAction('tasks/set-origin-review-v1', repair, { surface: 'agent' })).toEqual({ v: 1, status: 'linked' });
            expect(await aggregate.invokeAction('tasks/read-origin-review-v1', { v: 1, entryRef }, { surface: 'agent' })).toEqual({ v: 1, originReview });
            expect(writes.map(write => write.role)).toEqual(['create']);
        }, { reviewLinkConflict: true });
    });

    it('refuses unauthorized selected findings before a task provider effect', async () => {
        await withExternalTaskSource(async ({ aggregate, writes, corpus }) => {
            await expect(aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Not allowed' },
                originReview: { reviewId: 'private-review', findingIds: ['finding-1'] },
            }, { surface: 'agent' })).rejects.toMatchObject({ code: 'review_comment_permission_denied' });
            expect(writes).toEqual([]);
            expect((await corpus.collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows).toEqual([]);
        });
    });

    it('waits for Review read approval before any task provider effect', async () => {
        await withExternalTaskSource(async ({ aggregate, writes, corpus }) => {
            await expect(aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Needs approval' },
                originReview: { reviewId: 'review-selected', findingIds: ['finding-1'] },
            }, { surface: 'agent' })).rejects.toMatchObject({ code: 'approval_required' });
            expect(writes).toEqual([]);
            expect((await corpus.collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows).toEqual([]);
        }, { reviewReadApproval: true });
    });

    it('rejects a selected finding outside the authorized Review before a provider effect', async () => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            await expect(aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Wrong finding' },
                originReview: { reviewId: 'review-selected', findingIds: ['finding-1', 'another-review-finding'] },
            }, { surface: 'agent' })).rejects.toMatchObject({ code: 'review_comment_not_found' });
            expect(writes).toEqual([]);
        });
    });

    it('does not link or replay an uncertain create from selected findings', async () => {
        await withExternalTaskSource(async ({ aggregate, corpus, writes, setWriteResult }) => {
            setWriteResult({ kind: 'uncertain', observation: initialTask });
            expect(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Maybe created' },
                originReview: { reviewId: 'review-selected', findingIds: ['finding-1'] },
            }, { surface: 'agent' })).toEqual({ kind: 'uncertain', observation: initialTask });
            expect(writes.map(write => write.role)).toEqual(['create']);
            expect((await corpus.collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows).toEqual([]);
        });
    });

    it('does not record an origin or replay when creation is unknown, even with a returned observation', async () => {
        await withExternalTaskSource(async ({ aggregate, corpus, writes, setWriteResult }) => {
            setWriteResult({ kind: 'uncertain', observation: initialTask });
            expect(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Maybe created' }, originError,
            }, { surface: 'agent' })).toEqual({ kind: 'uncertain', observation: initialTask });
            expect(writes.map(write => write.role)).toEqual(['create']);
            expect((await corpus.collections.userMarks.query({ index: 'by-pinned', order: 'asc' })).rows).toEqual([]);
        });
    });

    it('excludes findings from the real task list and refuses completion before provider reads or writes', async () => {
        await withExternalTaskSource(async ({ aggregate, writes, readRequests }) => {
            const input = { v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest' };
            const listed = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', input, { surface: 'agent' }));
            expect(listed.window.rows.map(row => row.entryRef.kindId)).toEqual(['issue']);
            const all = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('entries/list-v1', input, { surface: 'agent' }));
            expect(all.window.rows.map(row => row.entryRef.kindId)).toEqual(expect.arrayContaining(['dependabot-alert', 'code-scanning-alert', 'external-finding']));
            const reads = readRequests.length;
            for (const kindId of ['dependabot-alert', 'code-scanning-alert', 'external-finding']) {
                const result = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/transition-v1', {
                    v: 1, entryRef: { ...entryRef, kindId }, sourceInstanceId: instanceId, transitionId: 'finish',
                }, { surface: 'agent' }));
                expect(result).toEqual({ kind: 'refused', reason: 'unsupportedKind' });
            }
            expect(readRequests).toHaveLength(reads);
            expect(writes).toHaveLength(0);
        }, { findings: true });
    });

    it('retains personal Account rows and reports Machine-required per external source without executing it', async () => {
        await withExternalTaskSource(async ({ aggregate, readRequests, writes }) => {
            const result = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest',
            }, { surface: 'agent' }));
            expect(result.window.rows.map(row => row.entryRef.entryId)).toEqual(['personal']);
            expect(result.window.lanes.find(lane => lane.sourceInstanceId === instanceId)).toMatchObject({
                health: { kind: 'unavailable', error: { code: 'plugin_action_machine_required' } },
            });
            expect(result.window.lanes.find(lane => lane.sourceInstanceId === INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId))
                .toMatchObject({ health: { kind: 'walkFinished' } });
            expect(readRequests).toEqual([]);
            expect(writes).toEqual([]);
        }, { machineUnavailable: true, initialTaskPage: true });
    });
    it('sends the agent task lens completion boundary only to declared task kinds through admitted scan wiring', async () => {
        await withExternalTaskSource(async ({ aggregate }) => {
            const input = { v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest', tasks: { completedSinceMs: 100 } };
            const taskRead = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', input, { surface: 'agent' }));
            expect(taskRead.window.rows).toMatchObject([{ observation: { outcome: { kind: 'present', snapshot: { completedAtMs: 100 } } } }]);
            const ordinary = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('entries/list-v1', input, { surface: 'agent' }));
            expect(ordinary.window.rows).toEqual([]);
        }, { completedScan: true });
    });
    it('keeps completion coverage partial when an external task source has not declared the read capability', async () => {
        await withExternalTaskSource(async ({ corpus, aggregate }) => {
            // This external-only fixture does not supply personal Account data.
            const read = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                v: 1, sources: await selectTestkitConfiguredSources([instanceId], corpus.collections.sourceInstances), limit: 10, order: 'newest', tasks: { completedSinceMs: 100 },
            }, { surface: 'agent' }));
            expect(read.window.coverage).toBe('partial');
            expect(read.window.lanes).toMatchObject([{ exhausted: false,
                health: { kind: 'partial', reason: 'completedScanUnavailable' } }]);
            const older = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                v: 1, sources: await selectTestkitConfiguredSources([instanceId], corpus.collections.sourceInstances), limit: 10, order: 'newest', tasks: { completedSinceMs: 101 },
            }, { surface: 'agent' }));
            expect(older.window.rows).toEqual([]);
        }, { unboundedCompleted: true, completedScanSupport: false });
    });
    it('registers status-column drops as one existing domain transition Action with truthful settlement', async () => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const client = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST,
                target: { artifactId: TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1, exportName: 'activate', platform: 'web' },
                activate: activateTriageWorkClient });
            try {
                const runtime = client.registration('dropTargets', 'task-status');
                expect(runtime).toBeDefined();
                if (runtime === undefined) throw new Error('The status-column target is not registered');
                const admission = runtime.resolve({ item: { kind: 'plugin', scope: { serverId: 'home', accountId: 'account' },
                    contribution: { pluginId: 'happier.triage', localId: 'entry-reference' }, reference: {
                        entryRef, sourceInstance: configured.instance, lastKnownLocator: initialTask.locator,
                        title: initialTask.snapshot.title, subtitle: 'Example task',
                    } }, targetInput: { candidatesByEntry: { [triageEntryRowKey(entryRef)]: { v: 1, entryRef, sourceInstanceId: instanceId, transitionId: 'finish' } },
                    preview: { verb: 'Change status', target: 'Done' }, unavailableReason: 'Use the task status menu.' }, destination: null, input: 'pointer' });
                expect(admission).toMatchObject({ status: 'allowed', effect: { actionId: 'plugin:happier.triage/tasks/transition-v1' } });
                if (admission.status !== 'allowed') throw new Error('The offered native transition was refused');
                const result = await aggregate.invokeAction('tasks/transition-v1', admission.effect.input, { surface: 'ui' });
                expect(runtime.settle?.(result)).toEqual({ status: 'applied' });
                expect(writes.map(write => write.role)).toEqual(['transition']);
            } finally { await client.dispose(); }
        });
    });
    it('settles task drops from the real transition Action without turning refused or uncertain writes into Applied', async () => {
        await withExternalTaskSource(async ({ aggregate, writes, setWriteResult }) => {
            const input = { v: 1, entryRef, sourceInstanceId: instanceId, transitionId: 'finish' };
            expect(settleTriageTaskDropResult(await aggregate.invokeAction('tasks/transition-v1', input, { surface: 'agent' })))
                .toEqual({ status: 'applied' });
            setWriteResult({ kind: 'refused', reason: 'nativeFieldUnavailable' });
            expect(settleTriageTaskDropResult(await aggregate.invokeAction('tasks/transition-v1', input, { surface: 'agent' })))
                .toMatchObject({ status: 'refused', reason: { code: 'nativeFieldUnavailable' } });
            setWriteResult({ kind: 'uncertain' });
            expect(settleTriageTaskDropResult(await aggregate.invokeAction('tasks/transition-v1', input, { surface: 'agent' })))
                .toMatchObject({ status: 'unknown' });
            setWriteResult({ kind: 'failed', failure: { class: 'transient', code: 'provider_unavailable' } });
            expect(settleTriageTaskDropResult(await aggregate.invokeAction('tasks/transition-v1', input, { surface: 'agent' })))
                .toMatchObject({ status: 'refused', reason: { code: 'provider_unavailable' } });
            expect(writes.map(write => write.role)).toEqual(['transition', 'transition', 'transition', 'transition']);
            expect(settleTriageTaskDropResult({ kind: 'applied' })).toMatchObject({ status: 'unknown' });
        });
    });
    it('completes once through the declared role and rereads due/completion facts through the same strict list consumer', async () => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const result = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/transition-v1', {
                v: 1, entryRef, sourceInstanceId: instanceId, transitionId: 'finish',
            }, { surface: 'agent' }));
            expect(result).toMatchObject({ kind: 'applied', observation: { snapshot: {
                state: { presentation: 'resolved', completionReason: 'completed' }, dueDate: '2026-10-25', completedAtMs: 100,
            } } });
            const read = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest',
            }, { surface: 'agent' }));
            expect(read.window.rows[0]?.observation.outcome).toMatchObject({ kind: 'present',
                snapshot: { dueDate: '2026-10-25', completedAtMs: 100 } });
            expect(writes.map(write => write.role)).toEqual(['transition']);
        }, { initialTaskPage: true });
    });
    it('carries gathered native transition values through registered aggregate and source admission without replaying a refusal', async () => {
        await withExternalTaskSource(async ({ aggregate, writes, setWriteResult }) => {
            const fieldValues = [{ fieldId: 'resolution', value: 'fixed' }, { fieldId: 'estimate', value: 3 },
                { fieldId: 'reviewers', value: ['one', 'two'] }];
            const input = { v: 1, entryRef, sourceInstanceId: instanceId, transitionId: 'native-workflow', fieldValues };
            const applied = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/transition-v1', input, { surface: 'agent' }));
            expect(applied).toMatchObject({ kind: 'applied', observation: { snapshot: { state: { nativeLabel: 'native-workflow' } } } });
            expect(writes).toEqual([{ role: 'transition', input: {
                v: 1, instance: configured, localRef: initialTask.localRef, transitionId: 'native-workflow', fieldValues,
            } }]);
            setWriteResult({ kind: 'refused', reason: 'nativeFieldUnavailable' });
            expect(await aggregate.invokeAction('tasks/transition-v1', input, { surface: 'agent' }))
                .toEqual({ kind: 'refused', reason: 'nativeFieldUnavailable' });
            expect(writes).toHaveLength(2);
        });
    });
    it('projects configured scope choices before scanning and applies the same unit filter through agent admission', async () => {
        await withExternalTaskSource(async ({ corpus, aggregate, readRequests }) => {
            // Scope choices belong to these two external connections, not the built-in source.
            const input = { v: 1, sources: await selectTestkitConfiguredSources([instanceId, secondInstanceId], corpus.collections.sourceInstances), limit: 0, order: 'newest' };
            const cold = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', input, { surface: 'agent' }));
            expect(cold.window.rows).toEqual([]);
            expect(cold.configuredSources[0]?.scope).toMatchObject({
                unit: { singularLabel: 'Team', pluralLabel: 'teams' },
                projection: { selection: { kind: 'selected', unitIds: ['team-a', 'team-b'] },
                    units: [{ id: 'team-a', label: 'Platform' }, { id: 'team-b', label: 'Mobile' }] },
            });
            expect(readRequests).toEqual(['scope:configured', 'scope:configured']);
            const filtered = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                ...input, limit: 10, filters: { ...TRIAGE_LIST_NO_FILTERS_V1,
                    scopes: [{ source, sourceInstanceId: instanceId, unitId: 'team-a' }] },
            }, { surface: 'agent' }));
            expect(filtered.window.rows.map((row) => row.entryRef.entryId)).toEqual(['task-1']);
            expect(filtered.window.lanes).toHaveLength(2);
        }, { scopeSelection: true, secondInstance: true, initialTaskPage: true });
    });

    it('applies an agent instance filter after scanning both separately admitted source instances', async () => {
        await withExternalTaskSource(async ({ corpus, aggregate }) => {
            const result = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                v: 1, sources: await selectTestkitConfiguredSources([instanceId, secondInstanceId], corpus.collections.sourceInstances), limit: 10, order: 'newest',
                filters: { ...TRIAGE_LIST_NO_FILTERS_V1, sources: [{ source, sourceInstanceId: secondInstanceId }] },
            }, { surface: 'agent' }));
            expect(result.window.rows.map((row) => row.entryRef.entryId)).toEqual(['task-2']);
            expect(result.window.lanes.map((lane) => [lane.sourceInstanceId, lane.health.kind]))
                .toEqual([[instanceId, 'walkFinished'], [secondInstanceId, 'walkFinished']]);
            expect(result.configuredSources.map((summary) => summary.sourceInstanceId)).toEqual([instanceId, secondInstanceId]);
        }, { secondInstance: true, initialTaskPage: true });
    });

    it('lists tasks after an entire non-task page through the shared scan and strict result consumer', async () => {
        await withExternalTaskSource(async ({ corpus, aggregate }) => {
            const result = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                v: 1, sources: await selectTestkitConfiguredSources([instanceId], corpus.collections.sourceInstances), limit: 1, order: 'newest',
            }, { surface: 'agent' }));
            expect(result.window.rows.map((row) => row.entryRef)).toEqual([entryRef]);
            expect(result.window.coverage).toBe('complete');
        });
    });

    it.each([false, true])('reaches both source lanes at limit one when the first keeps paging: %s', async (firstInstanceKeepsPaging) => {
        await withExternalTaskSource(async ({ aggregate }) => {
            const input = { v: 1, sources: { kind: 'allConfigured' }, limit: 1, order: 'newest' };
            const first = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', input, { surface: 'agent' }));
            const second = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                ...input, resume: first.window.continuations ?? [],
            }, { surface: 'agent' }));
            expect(new Set([...first.window.rows, ...second.window.rows].map((row) => row.entryRef.entryId)))
                .toEqual(new Set(['task-1', 'task-2']));
        }, { secondInstance: true, initialTaskPage: true, firstInstanceKeepsPaging });
    });

    it.each([['agent', 'daemon'], ['mcp', 'daemon'], ['cli', 'daemon'], ['agent', 'account']] as const)(
        'creates, edits and uses a native transition through real source role handles from %s via %s', async (surface, placement) => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const created = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Created task' },
            }, { surface }));
            expect(created).toMatchObject({ kind: 'applied', observation: { snapshot: { title: 'Created task' } } });
            const edited = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/edit-v1', {
                v: 1, entryRef, sourceInstanceId: instanceId, fields: { title: 'Edited task' },
            }, { surface }));
            expect(edited).toMatchObject({ kind: 'applied', observation: { snapshot: { title: 'Edited task' } } });
            // Entry-specific native workflows stay source-owned; a stale static
            // descriptor must not map or suppress the selected native id.
            const transitioned = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/transition-v1', {
                v: 1, entryRef, sourceInstanceId: instanceId, transitionId: 'newly-available-native-transition',
            }, { surface }));
            expect(transitioned).toMatchObject({ kind: 'applied', observation: {
                snapshot: { state: { nativeLabel: 'newly-available-native-transition', stage: 'started' } },
            } });
            expect(writes.map((write) => write.role)).toEqual(['create', 'edit', 'transition']);
            expect(writes[0]?.input).toEqual({ v: 1, instance: placement === 'account'
                ? { ...configured, binding: { purpose: fixture.descriptor.purpose, source: 'accountData' } } : configured,
                kindId: 'issue', fields: { title: 'Created task' } });
            if (placement === 'account') {
                const listed = TriageListEntriesResultV1Schema.parse(await aggregate.invokeAction('tasks/list-v1', {
                    v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest',
                }, { surface }));
                expect(listed.window.rows).toMatchObject([{ entryRef, observation: { outcome: { kind: 'present', snapshot: { title: 'Edited task' } } } }]);
            }
        }, { accountSource: placement === 'account' });
    });

    it('preserves uncertain writes without issuing a second create or a confirming aggregate read', async () => {
        await withExternalTaskSource(async ({ aggregate, writes, readRequests, setWriteResult }) => {
            const uncertain = { kind: 'uncertain', failure: { class: 'transient', code: 'responseLost' } } as const;
            setWriteResult(uncertain);
            expect(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Maybe created' },
            }, { surface: 'agent' })).toEqual(uncertain);
            expect(writes).toHaveLength(1);
            expect(readRequests).toEqual([]);
        });
    });

    it('creates once then links the confirmed task and its origin through registered relationship Actions', async () => {
        await withExternalTaskSource(async ({ aggregate, writes, corpus }) => {
            const result = await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'From the Session' },
                linkSession: 'task-session', originError,
            }, { surface: 'agent' });
            expect(result).toMatchObject({ kind: 'createdAndLinkAttempted', sessionLink: 'linked', originErrorLink: 'linked',
                creation: { kind: 'applied', observation: { snapshot: { title: 'From the Session' } } } });
            expect(writes.map(write => write.role)).toEqual(['create']);
            const links = await corpus.collections.sessionLinks.query({
                index: CORPUS_SESSION_LINKS_INDEX_ID.bySession, prefix: ['task-session'], order: 'asc', limit: 10,
            });
            expect(links.rows).toHaveLength(1);
            expect(await aggregate.invokeAction('tasks/read-origin-error-v1', { v: 1, entryRef }, { surface: 'agent' }))
                .toEqual({ v: 1, originError });
        });
    });

    it('does not link or replay a create whose outcome is unknown', async () => {
        await withExternalTaskSource(async ({ aggregate, writes, corpus, setWriteResult }) => {
            setWriteResult({ kind: 'uncertain' });
            expect(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Maybe created' },
                linkSession: 'task-session',
            }, { surface: 'agent' })).toEqual({ kind: 'uncertain' });
            expect(writes).toHaveLength(1);
            const links = await corpus.collections.sessionLinks.query({
                index: CORPUS_SESSION_LINKS_INDEX_ID.bySession, prefix: ['task-session'], order: 'asc', limit: 10,
            });
            expect(links.rows).toEqual([]);
        });
    });

    it.each(['failed', 'lost', 'malformed', 'notStarted'] as const)('preserves confirmed creation when the optional link result is %s', async (linkTransport) => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            expect(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Created regardless of linking' },
                linkSession: 'task-session',
            }, { surface: 'agent' })).toMatchObject({ kind: 'createdAndLinkAttempted',
                creation: { kind: 'applied', observation: { snapshot: { title: 'Created regardless of linking' } } },
                sessionLink: linkTransport === 'failed' || linkTransport === 'notStarted' ? 'failed' : 'unknown' });
            expect(writes.map(write => write.role)).toEqual(['create']);
        }, { linkTransport });
    });

    it.each(['create', 'edit', 'transition'] as const)('keeps a miscorrelated applied %s result uncertain without replaying the write', async (role) => {
        await withExternalTaskSource(async ({ aggregate, writes, setWriteResult }) => {
            const localRef = role === 'create'
                ? { ...initialTask.localRef, kindId: 'pull-request' }
                : { ...initialTask.localRef, entryId: 'another-task' };
            setWriteResult({ kind: 'applied', observation: { ...initialTask, localRef } });
            const input = role === 'create'
                ? { v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Create' } }
                : role === 'edit'
                    ? { v: 1, entryRef, sourceInstanceId: instanceId, fields: { title: 'Edit' } }
                    : { v: 1, entryRef, sourceInstanceId: instanceId, transitionId: 'begin' };
            const result = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction(`tasks/${role}-v1`, input, { surface: 'agent' }));
            expect(result).toEqual({ kind: 'uncertain', failure: { class: 'unsupportedContract', code: 'taskObservationMismatch' } });
            expect(writes).toHaveLength(1);
        });
    });

    it.each([{ retired: true }, { readOnly: true }])('does not write without current configuration and an admitted role: %j', async (options) => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const result = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/create-v1', {
                v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'Refused' },
            }, { surface: 'agent' }));
            expect(['refused', 'failed']).toContain(result.kind);
            expect(writes).toEqual([]);
        }, options);
    });

    it('rejects a forged configuration, foreign source, non-task kind and unsupported field before writing', async () => {
        await withExternalTaskSource(async ({ aggregate, writes }) => {
            const input = { v: 1, source, sourceInstanceId: instanceId, kindId: 'issue', fields: { title: 'No write' } };
            await expect(aggregate.invokeAction('tasks/create-v1', { ...input, instance: configured }, { surface: 'agent' })).rejects.toThrow();
            for (const invalid of [
                { ...input, source: { ...source, pluginId: 'example.foreign.source' } },
                { ...input, kindId: 'pull-request' },
                { ...input, fields: { title: 'No write', priority: 1 } },
                { ...input, initialStatusId: 'not-advertised' },
            ]) {
                const result = TriageTaskWriteResultV1Schema.parse(await aggregate.invokeAction('tasks/create-v1', invalid, { surface: 'agent' }));
                expect(['refused', 'failed']).toContain(result.kind);
            }
            expect(writes).toEqual([]);
        });
    });

    it('links through the existing relation writer, so repeating through either Action produces one row', async () => {
        await withExternalTaskSource(async ({ aggregate, corpus }) => {
            const input = { v: 1, entryRef, sessionId: 'task-session', display: {
                locator: initialTask.locator, scopeLabel: initialTask.snapshot.scopeLabel,
            } };
            expect(await aggregate.invokeAction('tasks/link-v1', input, { surface: 'agent' })).toEqual({ v: 1, status: 'linked' });
            expect(await aggregate.invokeAction(TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1, input, { surface: 'agent' })).toEqual({ v: 1, status: 'linked' });
            const rows = await corpus.collections.sessionLinks.query({
                index: CORPUS_SESSION_LINKS_INDEX_ID.bySession, prefix: ['task-session'], order: 'asc', limit: 10,
            });
            expect(rows.rows).toHaveLength(1);
            expect(rows.rows[0]?.revision).toBe(1);
        });
    });
});
