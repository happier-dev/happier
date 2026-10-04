// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type { TriageEntryRepositoryRefV1 } from '@happier-dev/triage-protocol/v1';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from '@happier-dev/triage-protocol/v1';
import { TESTKIT_OBSERVED_REVISION, testkitConfiguredInstance } from '../../sessions/testkit/entrySessionTestkit.test-support.js';
import { testkitLocator } from '../../corpus/testkit/observations.test-support.js';
import type { TriageStartEntrySessionInputV1 } from '../../actions/entrySessionProtocol.js';

const mocked = vi.hoisted(() => ({
    host: null as PluginUiHostApi | null,
}));

vi.mock('@happier-dev/plugin-ui', () => ({
    usePluginHostApi: () => {
        if (mocked.host === null) throw new Error('triage:test:hostNotInstalled');
        return mocked.host;
    },
}));

import {
    resolveTriageBulkStartRouteV1,
    useTriageBulkEntrySessions,
    type TriageBulkSessionsControllerV1,
} from './useBulkEntrySessions.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('bulk authoring route', () => {
    it('lets an explicit direct destination override compose only when a real instruction exists', () => {
        expect(resolveTriageBulkStartRouteV1(
            'oneSessionForAllEntries',
            'reuseWorkspace',
            'Compare both entries.',
        )).toBe('direct');
        expect(resolveTriageBulkStartRouteV1(
            'oneSessionPerEntry',
            'none',
            null,
        )).toBe('refusedCompose');
        expect(resolveTriageBulkStartRouteV1(
            'attachAllToNewSession',
            'ask',
            null,
        )).toBe('seedNewSession');
        expect(resolveTriageBulkStartRouteV1(
            'oneSessionPerEntry',
            'reuseWorkspace',
            'Fix this entry.',
        )).toBe('direct');
    });
});

const ENTRY = Object.freeze({
    key: 'entry-17',
    entryRef: {
        source: { pluginId: 'happier.example.source', localId: 'example-forge' },
        kindId: 'pull-request',
        collisionScope: 'example/repository',
        entryId: '17',
    },
    display: { scopeLabel: 'example/repository' },
    sourceInstance: {
        source: { pluginId: 'happier.example.source', localId: 'example-forge' },
        sourceInstanceId: '11111111-1111-4111-8111-111111111111',
    },
    presentation: { label: 'Entry 17' },
    workflowSubject: 'pullRequest' as const,
});

const REPOSITORY_A = Object.freeze({
    kind: 'github' as const,
    deployment: 'https://example.test',
    repository: 'example/repository-a',
});
const REPOSITORY_B = Object.freeze({
    kind: 'github' as const,
    deployment: 'https://example.test',
    repository: 'example/repository-b',
});

function repositoryEntry(
    entryId: string,
    repository: TriageEntryRepositoryRefV1,
) {
    return Object.freeze({
        ...ENTRY,
        key: `entry-${entryId}`,
        entryRef: { ...ENTRY.entryRef, entryId },
        repository,
    });
}

function action(profileId: string | null) {
    return Object.freeze({
        actionId: 'bulk-cancel',
        label: 'Bulk cancel',
        enabled: true,
        appliesTo: ['pullRequest' as const],
        profileId,
        workspaceMode: 'reference_only' as const,
        target: {
            kind: 'agent' as const,
            promptInvocationId: null,
            seededFallbackInstruction: 'Start this entry.',
            delivery: 'send' as const,
        },
    });
}

function repositoryAction() {
    return Object.freeze({
        ...action(null),
        workspaceMode: 'repository' as const,
    });
}

function deferredHost(deferredAction: 'sessions.spawn.profiles.list' | 'projects.list') {
    let observedSignal: AbortSignal | undefined;
    const host = {
        executeAction: async (
            actionId: string,
            _input: unknown,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) => {
            if (actionId !== deferredAction) {
                throw new Error(`triage:test:unexpectedAction:${actionId}`);
            }
            observedSignal = options?.signal;
            await new Promise<never>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => reject(
                    Object.assign(new Error('aborted'), { name: 'AbortError' }),
                ), { once: true });
            });
        },
    } as unknown as PluginUiHostApi;
    return { host, readSignal: () => observedSignal };
}

let root: Root | null = null;
let controller: TriageBulkSessionsControllerV1 | null = null;
let nextCreationKey = 1;

function MountedController(): React.ReactElement | null {
    controller = useTriageBulkEntrySessions({
        mintCreationKey: () => `creation-${nextCreationKey++}`,
    });
    return null;
}

async function mount(host: PluginUiHostApi): Promise<void> {
    mocked.host = host;
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<MountedController />); });
}

async function flush(): Promise<void> {
    for (let turn = 0; turn < 8; turn += 1) {
        await act(async () => { await Promise.resolve(); });
    }
}

beforeEach(() => {
    controller = null;
    mocked.host = null;
    nextCreationKey = 1;
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    document.body.replaceChildren();
});

describe('bulk cancellation ownership', () => {
    for (const deferredAction of [
        'sessions.spawn.profiles.list',
        'projects.list',
    ] as const) {
        it(`aborts the in-flight ${deferredAction} read when Stop is pressed`, async () => {
            const deferred = deferredHost(deferredAction);
            await mount(deferred.host);
            await act(async () => {
                controller?.run({
                    action: action(deferredAction === 'sessions.spawn.profiles.list' ? 'profile-1' : null),
                    destination: 'oneSessionPerEntry',
                    entries: [ENTRY],
                });
            });
            await flush();

            expect(deferred.readSignal()).toBeDefined();
            await act(async () => { controller?.cancel(); });
            expect(deferred.readSignal()?.aborted).toBe(true);
            await flush();
            expect(controller?.phase).toEqual({ kind: 'idle' });
        });
    }

    it('does not let reset hide an in-flight read before it has cancelled that read', async () => {
        const deferred = deferredHost('projects.list');
        await mount(deferred.host);
        await act(async () => {
            controller?.run({
                action: action(null),
                destination: 'oneSessionPerEntry',
                entries: [ENTRY],
            });
        });
        await flush();

        await act(async () => { controller?.reset(); });
        expect(deferred.readSignal()?.aborted).toBe(true);
        expect(controller?.phase).toEqual({ kind: 'idle' });
    });
});

describe('bulk placement ownership', () => {
    it.each(['lostReply', 'cancelledSelection'] as const)('starts ordinary PR repairs through selected preparation and preserves per-unit recovery: %s', async (recovery) => {
        const starts: TriageStartEntrySessionInputV1[] = [];
        const selections: unknown[] = [];
        const carriers: unknown[] = [];
        let authorizationCalls = 0;
        const source = ENTRY.entryRef.source;
        const operation = {
            point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol: { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 } },
            contributor: { pluginId: source.pluginId, contributionId: source.localId, immutableGenerationId: 'source-generation' },
            role: 'prepareReviewWorkspace',
            action: { pluginId: source.pluginId, localId: 'prepare-review-workspace' },
        };
        const entries = (recovery === 'cancelledSelection' ? ['17', '18', '19'] : ['17', '18']).map((id) => {
            const entry = repositoryEntry(id, REPOSITORY_A);
            return { ...entry, reviewWorkspace: { operation, preparation: {
                instance: testkitConfiguredInstance(), entryRef: entry.entryRef,
                lastKnownLocator: testkitLocator(), observed: TESTKIT_OBSERVED_REVISION,
            } } };
        });
        const host = {
            version: () => ({ methods: ['selectActionInput'] }),
            selectActionInput: async (request: { operation?: typeof operation; draft?: unknown }) => {
                if (request.operation !== undefined) {
                    authorizationCalls += 1;
                    if (recovery === 'cancelledSelection' && authorizationCalls === 2) return { kind: 'cancelled' };
                    const result = {
                        kind: 'submitted', action: operation.action, input: request.draft,
                        selection: { target: { pluginId: 'happier.triage', immutableGenerationId: 'triage-generation' }, point: operation.point, contributor: operation.contributor },
                        connectedAccount: { kind: 'selected', fieldPath: 'instance.binding.account', ref: testkitConfiguredInstance().binding.account },
                    };
                    selections.push(result);
                    return result;
                }
                return { kind: 'serverStartDraft', draft: {
                    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.test.agent', localId: 'agent' } },
                    directory: { kind: 'path', path: '/workspace' },
                } };
            },
            executeAction: async (actionId: string, input: TriageStartEntrySessionInputV1, options?: { selectedActionInput?: unknown }) => {
                if (actionId === 'projects.list') return { truncated: false, items: [{
                    projectKey: { id: 'project-a' }, serverId: 'server-a', machineId: 'machine-a', rootPath: '/workspace',
                    forge: REPOSITORY_A, reachable: true, worktrees: [],
                }] };
                if (actionId !== 'sessions/start-entry-v1') throw new Error('unexpected action');
                starts.push(input);
                carriers.push(options?.selectedActionInput);
                if (recovery === 'lostReply' && starts.length === 2) throw new Error('lost reply');
                return { v: 1, type: 'linked', sessionId: `session-${input.entryRef.entryId}`, disposition: starts.length === 1 ? 'created' : 'rejoined', delivery: 'accepted', finalOpen: 'suppressed' };
            },
        } as unknown as PluginUiHostApi;
        await mount(host);
        await act(async () => { controller?.run({ action: { ...repositoryAction(), workspaceMode: 'pull_request' }, destination: 'oneSessionPerEntry', entries }); });
        await flush();
        if (recovery === 'cancelledSelection') {
            expect(starts).toHaveLength(1);
            expect(controller?.phase).toMatchObject({ kind: 'settled', results: [
                { status: 'settled' }, { status: 'settled', outcome: { start: { type: 'workspacePreparationFailed' } } }, { status: 'notStarted' },
            ] });
            expect(controller?.retryable).toBe(true);
            await act(async () => { controller?.retry(); });
            await flush();
            expect(starts.map((start) => start.entryRef.entryId)).toEqual(['17', '18', '19']);
            expect(carriers).toEqual(selections.map((result) => ({ operation, result })));
            return;
        }
        expect(starts).toHaveLength(2);
        expect(starts.map((start) => start.entryRef.entryId)).toEqual(['17', '18']);
        expect(starts.map((start) => start.destination)).toEqual(entries.map((entry) => expect.objectContaining({
            materialization: { kind: 'reviewWorkspace', request: expect.objectContaining({ entryRef: entry.entryRef, workspace: { serverId: 'server-a', machineId: 'machine-a', rootPath: '/workspace' } }) },
        })));
        expect(starts[0]?.destination).not.toEqual(starts[1]?.destination);
        expect(controller?.retryable).toBe(true);
        await act(async () => { controller?.retry(); });
        await flush();
        expect(starts).toHaveLength(3);
        expect(starts[2]?.destination).toEqual(starts[1]?.destination);
        expect(starts[2]?.delivery).toEqual(starts[1]?.delivery);
        expect(selections).toHaveLength(3);
        expect(carriers).toEqual(selections.map((result) => ({ operation, result })));
    });

    it('rejoins the original start after response loss and an early offline retry refusal', async () => {
        const starts: Array<Readonly<{ destination: { creationKey: string }; delivery: { idempotencyKey: string } }>> = [];
        const sessions = new Set<string>();
        const inputs = new Set<string>();
        let choices = 0;
        const host = {
            version: () => ({ methods: ['selectActionInput'] }),
            selectActionInput: async () => {
                choices += 1;
                return {
                    kind: 'serverStartDraft',
                    draft: {
                        executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.test.agent', localId: 'agent' } },
                        directory: { kind: 'path', path: '/workspace' },
                    },
                };
            },
            executeAction: async (actionId: string, input: typeof starts[number]) => {
                if (actionId === 'projects.list') return { items: [], truncated: false };
                if (actionId !== 'sessions/start-entry-v1') throw new Error('unexpected action');
                starts.push(input);
                if (starts.length === 2) return { v: 1, type: 'creationFailed' };
                sessions.add(input.destination.creationKey);
                inputs.add(input.delivery.idempotencyKey);
                if (starts.length === 1) throw new Error('reply lost after admission');
                return { v: 1, type: 'linked', sessionId: 'session-original', disposition: 'rejoined', delivery: 'alreadyAccepted', finalOpen: 'suppressed' };
            },
        } as unknown as PluginUiHostApi;
        await mount(host);
        await act(async () => { controller?.run({ action: action(null), destination: 'oneSessionPerEntry', entries: [ENTRY] }); });
        await flush();
        expect(controller?.retryable).toBe(true);
        await act(async () => { controller?.retry(); });
        await flush();
        expect(controller?.retryable).toBe(true);
        await act(async () => { controller?.retry(); });
        await flush();
        expect(starts).toHaveLength(3);
        expect(starts[1]).toEqual(starts[0]);
        expect(starts[2]).toEqual(starts[0]);
        expect(sessions.size).toBe(1);
        expect(inputs.size).toBe(1);
        expect(choices).toBe(1);
        expect(controller?.phase).toMatchObject({ kind: 'settled', results: [{ status: 'settled', outcome: { start: { sessionId: 'session-original' } } }] });
    });

    it('keeps promptless Ask on the authoring destination instead of sending attachments alone', async () => {
        let hostCalls = 0;
        const host = {
            executeAction: async () => {
                hostCalls += 1;
                throw new Error('triage:test:shouldNotCallHost');
            },
        } as unknown as PluginUiHostApi;
        await mount(host);
        await act(async () => {
            controller?.run({
                action: {
                    actionId: 'ask',
                    label: 'Ask',
                    enabled: true,
                    appliesTo: ['pullRequest'],
                    profileId: null,
                    workspaceMode: 'reference_only',
                    target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
                },
                destination: 'oneSessionPerEntry',
                entries: [ENTRY],
            });
        });
        await flush();

        expect(hostCalls).toBe(0);
        expect(controller?.phase).toEqual({ kind: 'unavailable', reason: 'instructionMissing' });
    });

    it('settles each one-per-entry destination against that entry\'s own placement candidates', async () => {
        const draftSeeds: unknown[] = [];
        const startInputs: unknown[] = [];
        let selection = 0;
        const host = {
            version: () => ({ methods: ['selectActionInput'] }),
            selectActionInput: async (request: Readonly<{ draft?: unknown }>) => {
                draftSeeds.push(request.draft);
                selection += 1;
                return {
                    kind: 'serverStartDraft',
                    draft: {
                        executionTarget: { serverId: 'server-a', machineId: `machine-${selection}` },
                        agentTarget: {
                            kind: 'agent',
                            identity: { pluginId: 'happier.test.agent', localId: 'agent' },
                        },
                        directory: { kind: 'path', path: `/workspaces/repository-${selection}` },
                    },
                };
            },
            executeAction: async (actionId: string, input: unknown) => {
                if (actionId === 'projects.list') {
                    return {
                        truncated: false,
                        items: [
                            {
                                projectKey: { id: 'project-a' },
                                serverId: 'server-a',
                                machineId: 'machine-1',
                                rootPath: '/workspaces/repository-1',
                                forge: REPOSITORY_A,
                                reachable: true,
                                worktrees: [],
                            },
                            {
                                projectKey: { id: 'project-b' },
                                serverId: 'server-a',
                                machineId: 'machine-2',
                                rootPath: '/workspaces/repository-2',
                                forge: REPOSITORY_B,
                                reachable: true,
                                worktrees: [],
                            },
                        ],
                    };
                }
                if (actionId === 'sessions/start-entry-v1') {
                    startInputs.push(input);
                    return {
                        v: 1,
                        type: 'linked',
                        sessionId: `session-${startInputs.length}`,
                        disposition: 'created',
                        delivery: 'accepted',
                        finalOpen: 'suppressed',
                    };
                }
                throw new Error(`triage:test:unexpectedAction:${actionId}`);
            },
        } as unknown as PluginUiHostApi;
        await mount(host);
        await act(async () => {
            controller?.run({
                action: repositoryAction(),
                destination: 'oneSessionPerEntry',
                entries: [
                    repositoryEntry('17', REPOSITORY_A),
                    repositoryEntry('18', REPOSITORY_B),
                ],
            });
        });
        await flush();

        expect(draftSeeds).toEqual([
            expect.objectContaining({
                executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
                directory: '/workspaces/repository-1',
            }),
            expect.objectContaining({
                executionTarget: { serverId: 'server-a', machineId: 'machine-2' },
                directory: '/workspaces/repository-2',
            }),
        ]);
        expect(startInputs).toHaveLength(2);
        expect(controller?.phase.kind).toBe('settled');
    });

    it.each(['differentRepositories', 'mixedErrorAndRepository'] as const)('asks for an explicit shared project without inferring one from mismatched identities: %s', async (selection) => {
        let selected = false;
        let started = false;
        const host = {
            version: () => ({ methods: ['selectActionInput'] }),
            selectActionInput: async () => {
                selected = true;
                return { kind: 'serverStartDraft', draft: {
                    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.test.agent', localId: 'agent' } },
                    directory: { kind: 'path', path: '/user-selected-project' },
                } };
            },
            executeAction: async (actionId: string) => {
                if (actionId === 'projects.list') return { items: [], truncated: false };
                if (actionId === 'sessions/start-entry-v1') {
                    started = true;
                    return { v: 1, type: 'opened', sessionId: 'shared-session', disposition: 'created', delivery: 'accepted' };
                }
                return null;
            },
        } as unknown as PluginUiHostApi;
        await mount(host);
        await act(async () => {
            controller?.run({
                action: { ...repositoryAction(), appliesTo: ['pullRequest', 'errorIssue'] },
                destination: 'oneSessionForAllEntries',
                entries: [
                    repositoryEntry('17', REPOSITORY_A),
                    selection === 'differentRepositories' ? repositoryEntry('18', REPOSITORY_B) : {
                        ...ENTRY, key: 'error-18', entryRef: { ...ENTRY.entryRef, entryId: 'error-18' }, workflowSubject: 'errorIssue',
                    },
                ],
            });
        });
        await flush();

        expect(selected).toBe(true);
        expect(started).toBe(true);
        expect(controller?.phase.kind).toBe('settled');
    });
});
