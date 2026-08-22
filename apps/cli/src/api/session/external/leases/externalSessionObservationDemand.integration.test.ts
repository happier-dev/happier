import { getEventListeners, setMaxListeners } from 'node:events';

import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import type {
    AgentExternalSessionObservationContribution,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';
import type {
    ExternalAgentObservationSnapshotV1,
    ExternalSessionStatusDemandDaemonMessageV1,
} from '@happier-dev/protocol';

import type {
    ExternalSessionObservationLinkInput,
    ExternalSessionObservationLinkedSession,
} from './resolveExternalSessionObservationLinkInput';
import type { Credentials } from '@/persistence';
import type {
    LoadedLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type {
    tryDecryptSessionOwnerMetadataView,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    acquireCanonicalExternalSessionFollowLease,
} from './acquireCanonicalExternalSessionFollowLease';
import { createExternalSessionFollowLeaseManager } from './createExternalSessionFollowLeaseManager';
import { createExternalSessionObservationReconciler } from './createExternalSessionObservationReconciler';

type CapturedProjection = Readonly<{
    reconcileLink(input: ExternalSessionObservationLinkInput & Readonly<{
        demand: Readonly<{
            passiveEvent: boolean;
            persistedPolicy: boolean;
            fallbackDemand: boolean;
            transcriptDemand?: boolean;
        }>;
    }>): Promise<unknown>;
    flush(): Promise<void>;
}>;

type CapturedDemandBinding = Readonly<{
    flush(): Promise<void>;
}>;

type Publication = Readonly<{
    sessionId: string;
    fieldId: 'runtime.externalAgent';
    value: ExternalAgentObservationSnapshotV1;
}>;

type OwnerMetadataRawSession = Parameters<
    typeof tryDecryptSessionOwnerMetadataView
>[0]['rawSession'];

const seams = vi.hoisted(() => ({
    nowMs: 1_000,
    projection: null as unknown,
    demandBinding: null as unknown,
    contributionsByResourceKey: new Map<string, unknown>(),
    currentLinksBySessionId: new Map<string, unknown>(),
    resolvedInputsBySessionId: new Map<string, unknown>(),
    rawSessionsBySessionId: new Map<string, RawSessionRecord>(),
    ownerMetadataByRawSession: new Map<
        OwnerMetadataRawSession,
        Record<string, unknown>
    >(),
    publications: [] as unknown[],
    nextTimerId: 0,
    timers: new Map<number, unknown>(),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/session/transport/http/sessionsHttp')
    >();
    return {
        ...actual,
        fetchSessionById: async (
            input: Parameters<typeof actual.fetchSessionById>[0],
        ) =>
            seams.rawSessionsBySessionId.get(input.sessionId) ?? null,
    };
});

vi.mock('@/session/transport/encryption/sessionEncryptionContext', async (
    importOriginal,
) => {
    const actual = await importOriginal<
        typeof import('@/session/transport/encryption/sessionEncryptionContext')
    >();
    return {
        ...actual,
        tryDecryptSessionOwnerMetadataView: (
            input: Parameters<
                typeof actual.tryDecryptSessionOwnerMetadataView
            >[0],
        ) => seams.ownerMetadataByRawSession.get(input.rawSession) ?? null,
    };
});

vi.mock('./createExternalSessionObservationDaemonProjection', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('./createExternalSessionObservationDaemonProjection')
    >();
    return {
        ...actual,
        createExternalSessionObservationDaemonProjection: () => {
            const projection = actual.createExternalSessionObservationDaemonProjection({
                acquireObservationContribution: async (resource) => {
                    const contribution = seams.contributionsByResourceKey.get(
                        resource.resourceKey,
                    ) as AgentExternalSessionObservationContribution | undefined;
                    return contribution
                        ? { contribution, release: async () => {} }
                        : null;
                },
                publishField: async (input) => {
                    seams.publications.push(input);
                },
                now: () => seams.nowMs,
                setTimer: ((callback: () => void) => {
                    const id = seams.nextTimerId += 1;
                    seams.timers.set(id, callback);
                    return id as unknown as ReturnType<typeof setTimeout>;
                }) as typeof setTimeout,
                clearTimer: ((timer: ReturnType<typeof setTimeout>) => {
                    seams.timers.delete(timer as unknown as number);
                }) as typeof clearTimeout,
            });
            seams.projection = projection;
            return projection;
        },
    };
});

vi.mock('./applyExternalSessionStatusDemandBatch', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('./applyExternalSessionStatusDemandBatch')
    >();
    return {
        ...actual,
        applyExternalSessionStatusDemandBatch: async (
            params: Parameters<typeof actual.applyExternalSessionStatusDemandBatch>[0],
        ) => await actual.applyExternalSessionStatusDemandBatch({
            ...params,
            loadCurrentLink: async ({ sessionId, machineId }) => {
                const current = seams.currentLinksBySessionId.get(sessionId) as
                    | Readonly<{
                        machineId: string;
                        linkGeneration: string;
                        linked: ExternalSessionObservationLinkedSession;
                    }>
                    | undefined;
                return current?.machineId === machineId ? current : null;
            },
            resolveLinkInput: async ({ sessionId }) => (
                seams.resolvedInputsBySessionId.get(sessionId) as
                    | ExternalSessionObservationLinkInput
                    | undefined
            ) ?? null,
        }),
    };
});

vi.mock('@/daemon/machine/externalSessionStatusDemandBinding', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/daemon/machine/externalSessionStatusDemandBinding')
    >();
    return {
        ...actual,
        bindExternalSessionStatusDemand: (
            params: Parameters<typeof actual.bindExternalSessionStatusDemand>[0],
        ) => {
            const binding = actual.bindExternalSessionStatusDemand({
                ...params,
                loadCurrentLink: async ({ sessionId, machineId }) => {
                    const current = seams.currentLinksBySessionId.get(sessionId) as
                        | Readonly<{
                            machineId: string;
                            linkGeneration: string;
                        }>
                        | undefined;
                    return current?.machineId === machineId ? current : null;
                },
                subscribeRuntimeReload: () => () => {},
            });
            seams.demandBinding = binding;
            return binding;
        },
    };
});

import {
    registerMachineExternalSessionsRpcHandlers,
} from '@/api/machine/rpcHandlers.externalSessions';

type OpenCodeEventDelivery = Readonly<{
    provenance: 'accepted-live' | 'connection-boundary' | 'untrusted-observation';
    connectionGeneration: number;
}>;

type OpenCodeSubscription = Readonly<{
    baseUrl: string;
    signal: AbortSignal;
    onEvent(event: unknown, delivery: OpenCodeEventDelivery): void;
    onUnavailable?(error: unknown): void;
}>;

type CreateOpenCodeObservationContribution = (params: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    fetchFn(input: string, init?: RequestInit): Promise<Response>;
    now(): number;
    subscribeGlobalEvents(params: OpenCodeSubscription): Promise<void>;
}>) => AgentExternalSessionObservationContribution;

function readProjection(): CapturedProjection {
    if (!seams.projection || typeof seams.projection !== 'object') {
        throw new Error('The registrar did not create the observation projection');
    }
    return seams.projection as CapturedProjection;
}

function readDemandBinding(): CapturedDemandBinding {
    if (!seams.demandBinding || typeof seams.demandBinding !== 'object') {
        throw new Error('The registrar did not bind status demand');
    }
    return seams.demandBinding as CapturedDemandBinding;
}

function publications(): Publication[] {
    return seams.publications as Publication[];
}

async function loadOpenCodeObservationFactory(): Promise<
    CreateOpenCodeObservationContribution
> {
    // Test-only source import: the observation leaf is intentionally not a public
    // package subpath, and production must not gain an export solely for this proof.
    const modulePath =
        '../../../../../../../packages/plugins/opencode/src/agent/surfaces/sessions/external/observation.js';
    const loaded: unknown = await import(modulePath);
    if (!loaded || typeof loaded !== 'object') {
        throw new Error('OpenCode observation source module did not load');
    }
    const factory = Reflect.get(loaded, 'createOpenCodeExternalSessionObservationContribution');
    if (typeof factory !== 'function') {
        throw new Error('OpenCode observation source module has no contribution factory');
    }
    return factory as CreateOpenCodeObservationContribution;
}

function createRpcHandlerManager() {
    return {
        registerHandler: vi.fn(),
    };
}

function linkedSource(
    remoteSessionId: string,
    baseUrl: string,
    directory: string,
): AgentExternalSessionsResolvedIdentity {
    return {
        source: {
            kind: 'opencodeServer',
            baseUrl,
            directory,
        },
        remoteSessionId,
        linkData: {},
    };
}

function demandMessage(
    clientConnectionId: string,
    entries: readonly Readonly<{
        sessionId: string;
        linkGeneration: string;
        demand: 'visible';
    }>[],
): ExternalSessionStatusDemandDaemonMessageV1 {
    return {
        v: 1,
        type: 'replace',
        clientConnectionId,
        revision: 1,
        entries: [...entries],
    };
}

describe('composed External Session observation demand', () => {
    let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

    beforeAll(async () => {
        runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
            resolveRuntimeRegistry: async () =>
                await resolveExecutablePluginRuntimeRegistry({
                    contributes: getResolvedContributionRegistry(),
                    pluginIds: ['happier.agent.opencode'],
                }),
        });
    });

    afterAll(async () => {
        await runtimeRegistryLease?.release();
        runtimeRegistryLease = null;
        await pluginReloadController.shutdown({ timeoutMs: 5_000 });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        seams.nowMs = 1_000;
        seams.projection = null;
        seams.demandBinding = null;
        seams.contributionsByResourceKey.clear();
        seams.currentLinksBySessionId.clear();
        seams.resolvedInputsBySessionId.clear();
        seams.rawSessionsBySessionId.clear();
        seams.ownerMetadataByRawSession.clear();
        seams.publications.length = 0;
        seams.nextTimerId = 0;
        seams.timers.clear();
    });

    it('shares fallback reconciliation demand without acquiring passive observers or transcript work', async () => {
        const createOpenCodeObservation = await loadOpenCodeObservationFactory();
        const statusFetches: string[] = [];
        const transcriptOrFollowFetches: string[] = [];
        const fetchFn = vi.fn(async (input: string) => {
            const url = new URL(input);
            if (url.pathname === '/session/status') {
                statusFetches.push(input);
                throw new Error('bounded status fixture unavailable');
            }
            transcriptOrFollowFetches.push(input);
            throw new Error(`unexpected transcript/follow request: ${input}`);
        });
        const subscribeGlobalEvents = vi.fn(async (_input: OpenCodeSubscription) => {});
        const endpointA = 'http://127.0.0.1:49196';
        const endpointB = 'http://127.0.0.1:49197';
        const realA = createOpenCodeObservation({
            env: { HAPPIER_OPENCODE_SERVER_URL: endpointA },
            fetchFn,
            now: () => seams.nowMs,
            subscribeGlobalEvents,
        });
        const realB = createOpenCodeObservation({
            env: { HAPPIER_OPENCODE_SERVER_URL: endpointB },
            fetchFn,
            now: () => seams.nowMs,
            subscribeGlobalEvents,
        });
        const reconcileA = vi.fn(realA.reconcileResource.bind(realA));
        const reconcileB = vi.fn(realB.reconcileResource.bind(realB));
        const contributionA: AgentExternalSessionObservationContribution = {
            ...realA,
            reconcileResource: reconcileA,
        };
        const contributionB: AgentExternalSessionObservationContribution = {
            ...realB,
            reconcileResource: reconcileB,
        };
        const inputs: ExternalSessionObservationLinkInput[] = [];

        for (let index = 0; index < 100; index += 1) {
            const endpoint = index < 50 ? endpointA : endpointB;
            const contribution = index < 50 ? contributionA : contributionB;
            const directory = index % 2 === 0 ? '/work/project-a' : '/work/project-b';
            const sessionId = `session-${index}`;
            const remoteSessionId = index < 2 ? 'native-shared' : `native-${index}`;
            const linkGeneration = `link-generation-${index}`;
            const source = linkedSource(remoteSessionId, endpoint, directory);
            const grouping = contribution.describeResource(source);
            const resolved: ExternalSessionObservationLinkInput = {
                resource: {
                    pluginId: 'happier.opencode',
                    agentLocalId: 'opencode',
                    pluginGeneration: 'plugin-generation-1',
                    resourceKey: grouping.resourceKey,
                },
                link: {
                    sessionId,
                    linkGeneration,
                    linkKey: grouping.linkKey,
                    linkedSource: source,
                },
                target: {
                    qualifiedLinkIdentity: {
                        v: 1,
                        agent: {
                            pluginId: 'happier.opencode',
                            localId: 'opencode',
                        },
                        source: {
                            kind: 'opencodeServer',
                            contractVersion: 1,
                        },
                    },
                    linkGeneration,
                },
            };
            inputs.push(resolved);
            seams.contributionsByResourceKey.set(grouping.resourceKey, contribution);
            seams.resolvedInputsBySessionId.set(sessionId, resolved);
            seams.currentLinksBySessionId.set(sessionId, {
                machineId: 'machine-1',
                linkGeneration,
                linked: {
                    agentId: 'opencode',
                    linkGeneration,
                    remoteSessionId,
                    source: {
                        kind: 'opencodeServer',
                        baseUrl: endpoint,
                        directory,
                    },
                    metadata: {},
                } satisfies ExternalSessionObservationLinkedSession,
            });
        }

        const messageListeners: Array<
            (message: ExternalSessionStatusDemandDaemonMessageV1) => void
        > = [];
        let connectionListenerCount = 0;
        const registration = registerMachineExternalSessionsRpcHandlers({
            rpcHandlerManager: createRpcHandlerManager() as never,
            statusDemand: {
                machineId: 'machine-1',
                channel: {
                    onExternalSessionStatusDemand(listener) {
                        messageListeners.push(listener);
                        return () => {};
                    },
                    onConnectionStateChange() {
                        connectionListenerCount += 1;
                        return () => {};
                    },
                },
            },
        });
        const projection = readProjection();

        expect(subscribeGlobalEvents).not.toHaveBeenCalled();

        const entries = inputs.map((input) => ({
            sessionId: input.link.sessionId,
            linkGeneration: input.link.linkGeneration,
            demand: 'visible' as const,
        }));
        messageListeners[0]?.(demandMessage('ui-client-1', entries));
        await readDemandBinding().flush();
        await projection.flush();

        expect(subscribeGlobalEvents).not.toHaveBeenCalled();
        expect(reconcileA).toHaveBeenCalledTimes(1);
        expect(reconcileB).toHaveBeenCalledTimes(1);
        expect(statusFetches).toHaveLength(4);
        expect(statusFetches.every((input) => (
            new URL(input).pathname === '/session/status'
        ))).toBe(true);
        expect(new Set(statusFetches.map((input) => (
            new URL(input).searchParams.get('directory')
        )))).toEqual(new Set(['/work/project-a', '/work/project-b']));
        expect(transcriptOrFollowFetches).toEqual([]);

        messageListeners[0]?.(demandMessage('ui-client-2', entries));
        await readDemandBinding().flush();
        await projection.flush();
        expect(reconcileA).toHaveBeenCalledTimes(1);
        expect(reconcileB).toHaveBeenCalledTimes(1);
        expect(statusFetches).toHaveLength(4);

        const fetchCountBeforeDisconnect = statusFetches.length;
        messageListeners[0]?.({
            v: 1,
            type: 'disconnect',
            clientConnectionId: 'ui-client-1',
        });
        await readDemandBinding().flush();
        expect(statusFetches).toHaveLength(fetchCountBeforeDisconnect);

        messageListeners[0]?.({
            v: 1,
            type: 'disconnect',
            clientConnectionId: 'ui-client-2',
        });
        await readDemandBinding().flush();
        expect(statusFetches).toHaveLength(fetchCountBeforeDisconnect);
        expect(subscribeGlobalEvents).not.toHaveBeenCalled();
        expect(transcriptOrFollowFetches).toEqual([]);
        expect(publications().every((publication) => (
            publication.fieldId === 'runtime.externalAgent'
        ))).toBe(true);

        await registration.dispose();
        expect(connectionListenerCount).toBe(1);
        expect(transcriptOrFollowFetches).toEqual([]);
    });

    it('admits correlated and gap refresh only through current transcript demand', async () => {
        let requestReconcile: (() => void) | undefined;
        let requestTranscriptRefresh: ((linkKey: string) => void) | undefined;
        let releaseFirstRefresh: (() => void) | undefined;
        const firstRefresh = new Promise<void>((resolve) => {
            releaseFirstRefresh = resolve;
        });
        const d4ContentFreeRefresh = vi.fn()
            .mockImplementationOnce(async (
                _cursor: string,
                _isCurrent: () => boolean,
            ) => await firstRefresh)
            .mockResolvedValue(undefined);
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => 'viewer-demand',
        });
        const followResource = {
            linkGeneration: 'link-demanded',
            pluginGeneration: 'plugin-generation-1',
        };
        await manager.attach({
            sessionId: 'session-demanded',
            ttlMs: 30_000,
            acceptedTailCursor: 'happier_external_cursor_v1:YzA',
            resource: followResource,
            requestTranscriptRefresh: d4ContentFreeRefresh,
        });

        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver: vi.fn(async (input) => {
                requestReconcile = input.requestReconcile;
                requestTranscriptRefresh = input.requestTranscriptRefresh;
                return { dispose: async () => {} };
            }),
            reconcileResource: vi.fn(async (input) => (
                input.purpose === 'resource_descriptors'
                    ? {
                        purpose: 'resource_descriptors' as const,
                        outcomes: [],
                    }
                    : {
                        purpose: 'observation_evidence' as const,
                        outcomes: [],
                    }
            )),
            isTranscriptRefreshDemanded: (input) =>
                manager.hasTranscriptDemand(input),
            requestTranscriptRefresh: async (input) =>
                await manager.requestTranscriptRefresh(input),
        });
        const resource = {
            pluginId: 'happier.opencode',
            agentLocalId: 'opencode',
            pluginGeneration: 'plugin-generation-1',
            resourceKey: 'resource-1',
        };
        const reconcile = async (
            sessionId: string,
            linkGeneration: string,
            linkKey: string,
        ) => await reconciler.reconcileLink({
            resource,
            link: {
                sessionId,
                linkGeneration,
                linkKey,
                linkedSource: linkedSource(
                    linkKey,
                    'http://127.0.0.1:49196',
                    `/work/${sessionId}`,
                ),
                changeObservation: 'observe_resource',
            },
            demand: {
                passiveEvent: false,
                persistedPolicy: false,
                fallbackDemand: false,
                transcriptDemand: sessionId === 'session-demanded',
            },
            onFacts: () => {},
        });
        await reconcile('session-demanded', 'link-demanded', 'native-demanded');
        await reconcile('session-status-only', 'link-status', 'native-status');

        requestTranscriptRefresh?.('native-status');
        requestTranscriptRefresh?.('unknown-native');
        requestTranscriptRefresh?.('native-demanded');
        requestReconcile?.();
        requestReconcile?.();

        await vi.waitFor(() => expect(d4ContentFreeRefresh).toHaveBeenCalledTimes(1));
        releaseFirstRefresh?.();
        await vi.waitFor(() => expect(d4ContentFreeRefresh).toHaveBeenCalledTimes(2));
        await Promise.resolve();
        expect(d4ContentFreeRefresh).toHaveBeenCalledTimes(2);
        expect(d4ContentFreeRefresh).toHaveBeenNthCalledWith(
            1,
            'happier_external_cursor_v1:YzA',
            expect.any(Function),
        );
        expect(d4ContentFreeRefresh).toHaveBeenNthCalledWith(
            2,
            'happier_external_cursor_v1:YzA',
            expect.any(Function),
        );
        expect(d4ContentFreeRefresh.mock.calls[0]?.[1]?.()).toBe(true);

        await reconciler.removeLink({
            sessionId: 'session-demanded',
            linkGeneration: 'link-demanded',
            linkKey: 'native-demanded',
            linkedSource: linkedSource(
                'native-demanded',
                'http://127.0.0.1:49196',
                '/work/session-demanded',
            ),
            changeObservation: 'observe_resource',
        });
        requestTranscriptRefresh?.('native-demanded');
        await Promise.resolve();
        expect(d4ContentFreeRefresh).toHaveBeenCalledTimes(2);

        await reconciler.dispose();
        await manager.dispose();
    });

    it('bounds and releases 100 real canonical follows pooled across two observation resources', async () => {
        let nextLeaseId = 0;
        let nextTimerId = 0;
        const activeTimers = new Set<number>();
        const manager = createExternalSessionFollowLeaseManager({
            randomId: () => `viewer-${nextLeaseId += 1}`,
            setTimer: ((() => {
                const timerId = nextTimerId += 1;
                activeTimers.add(timerId);
                return timerId as unknown as ReturnType<typeof setTimeout>;
            }) as unknown) as typeof setTimeout,
            clearTimer: ((timer) => {
                activeTimers.delete(timer as unknown as number);
            }) as typeof clearTimeout,
        });
        const generation = new AbortController();
        setMaxListeners(0, generation.signal);
        const observerDisposals = new Map<string, ReturnType<typeof vi.fn>>();
        const acquireObserver = vi.fn(async (input: Readonly<{
            resource: Readonly<{ resourceKey: string }>;
        }>) => {
            const dispose = vi.fn(async () => {});
            observerDisposals.set(input.resource.resourceKey, dispose);
            return { dispose };
        });
        const pageTranscript = vi.fn(async () => ({
            items: [],
            nextCursor: null,
            tailCursor: 'unexpected-baseline-cursor',
            hasMore: false,
            truncated: false,
        }));
        const readAfterTranscript = vi.fn(async () => ({
            outcome: 'already_current' as const,
            cursor: 'unexpected-refresh-cursor',
        }));
        const transcriptDemandReleases = vi.fn();
        const reconciler = createExternalSessionObservationReconciler({
            acquireObserver,
            reconcileResource: async (input) => input.purpose === 'resource_descriptors'
                ? {
                    purpose: 'resource_descriptors' as const,
                    outcomes: [],
                }
                : {
                    purpose: 'observation_evidence' as const,
                    outcomes: [],
                },
            isTranscriptRefreshDemanded: (input) =>
                manager.hasTranscriptDemand(input),
            requestTranscriptRefresh: async (input) =>
                await manager.requestTranscriptRefresh(input),
        });
        const credentials = {
            token: 'resource-proof-token',
            encryption: {
                type: 'legacy' as const,
                secret: new Uint8Array([1]),
            },
        } satisfies Credentials;
        const records: Array<Readonly<{
            sessionId: string;
            resourceKey: string;
            resource: Readonly<{
                linkGeneration: string;
                pluginGeneration: string;
                retirementSignal: AbortSignal;
            }>;
            observation: ExternalSessionObservationLinkInput;
            viewerLeaseIds: readonly [string, string];
            acquireFollowLease: ReturnType<typeof vi.fn>;
        }>> = [];

        for (let index = 0; index < 100; index += 1) {
            const sessionId = `follow-session-${index}`;
            const resourceKey = index < 50 ? 'endpoint-a' : 'endpoint-b';
            const linkedAtMs = index + 1;
            const linkGeneration = String(linkedAtMs);
            const remoteSessionId = `native-session-${index}`;
            const source = {
                kind: 'opencodeServer' as const,
                baseUrl: `https://${resourceKey}.example`,
                directory: `/work/${sessionId}`,
            };
            const resource = {
                linkGeneration,
                pluginGeneration: 'plugin-generation-real-follow',
                retirementSignal: generation.signal,
            };
            const observation: ExternalSessionObservationLinkInput = {
                resource: {
                    pluginId: 'happier.opencode',
                    agentLocalId: 'opencode',
                    pluginGeneration: resource.pluginGeneration,
                    resourceKey,
                    retirementSignal: generation.signal,
                },
                link: {
                    sessionId,
                    linkGeneration,
                    linkKey: remoteSessionId,
                    linkedSource: {
                        source,
                        remoteSessionId,
                        linkData: {},
                    },
                    changeObservation: 'observe_resource',
                },
                target: {
                    qualifiedLinkIdentity: {
                        v: 1,
                        agent: {
                            pluginId: 'happier.opencode',
                            localId: 'opencode',
                        },
                        source: {
                            kind: 'opencodeServer',
                            contractVersion: 1,
                        },
                    },
                    linkGeneration,
                },
            };
            const linked: LoadedLinkedExternalSession = {
                rawSession: {
                    id: sessionId,
                    currentStorageState: 'machine_only',
                } as LoadedLinkedExternalSession['rawSession'],
                metadata: {},
                sessionPath: null,
                agentId: 'opencode',
                machineId: 'machine-resource-proof',
                remoteSessionId,
                linkGeneration,
                source,
                linkData: {},
                codexBackendMode: null,
            };
            seams.rawSessionsBySessionId.set(sessionId, linked.rawSession);
            seams.ownerMetadataByRawSession.set(linked.rawSession, {
                externalSessionV1: {
                    v: 1,
                    agentId: linked.agentId,
                    machineId: linked.machineId,
                    remoteSessionId: linked.remoteSessionId,
                    source: linked.source,
                    linkData: linked.linkData,
                    linkedAtMs,
                },
            });
            const cursor = `cursor-${index}`;
            const observationProjection = {
                reconcileTranscriptDemand: async (input: Readonly<{
                    resolved: ExternalSessionObservationLinkInput;
                    demanded: boolean;
                }>) => {
                    if (!input.demanded) {
                        transcriptDemandReleases(sessionId);
                    }
                    return await reconciler.reconcileLink({
                        resource: input.resolved.resource,
                        link: input.resolved.link,
                        demand: {
                            passiveEvent: false,
                            persistedPolicy: false,
                            fallbackDemand: false,
                            transcriptDemand: input.demanded,
                        },
                        onFacts: () => {},
                    });
                },
            };
            const acquireFollowLease = vi.fn(async (
                reacquisitionCursor?: string | null,
            ) => await acquireCanonicalExternalSessionFollowLease({
                sessionId,
                machineId: linked.machineId,
                linked,
                resource,
                observation,
                providerOps: {
                    pageTranscript,
                    readAfterTranscript,
                },
                initialCursor: reacquisitionCursor ?? cursor,
                maxBytes: 64_000,
                maxItems: 200,
                observationProjection,
                credentials,
            }));
            const viewerLeaseIds = [
                `viewer-a-${index}`,
                `viewer-b-${index}`,
            ] as const;
            for (const leaseId of viewerLeaseIds) {
                await manager.attach({
                    sessionId,
                    leaseId,
                    ttlMs: 30_000,
                    acceptedTailCursor: cursor,
                    resource,
                    acquireFollowLease,
                });
            }
            records.push({
                sessionId,
                resourceKey,
                resource,
                observation,
                viewerLeaseIds,
                acquireFollowLease,
            });
        }

        expect(records.reduce(
            (count, record) => count + record.acquireFollowLease.mock.calls.length,
            0,
        )).toBe(100);
        expect(acquireObserver).toHaveBeenCalledTimes(2);
        expect(observerDisposals.size).toBe(2);
        expect(activeTimers.size).toBe(200);
        expect(getEventListeners(generation.signal, 'abort')).toHaveLength(102);
        expect(pageTranscript).not.toHaveBeenCalled();
        expect(readAfterTranscript).not.toHaveBeenCalled();

        const statusOnly = records[0]!;
        await reconciler.reconcileLink({
            resource: {
                ...statusOnly.observation.resource,
                resourceKey: 'status-only-resource',
                retirementSignal: undefined,
            },
            link: {
                ...statusOnly.observation.link,
                sessionId: 'status-only-session',
                linkGeneration: 'status-only-generation',
                linkKey: 'status-only-link',
            },
            demand: {
                passiveEvent: false,
                persistedPolicy: false,
                fallbackDemand: true,
                transcriptDemand: false,
            },
            onFacts: () => {},
        });
        expect(acquireObserver).toHaveBeenCalledTimes(2);
        expect(pageTranscript).not.toHaveBeenCalled();
        expect(readAfterTranscript).not.toHaveBeenCalled();

        for (const record of records.slice(0, 50)) {
            await manager.detach({
                sessionId: record.sessionId,
                leaseId: record.viewerLeaseIds[0],
            });
            expect(record.acquireFollowLease).toHaveBeenCalledTimes(1);
        }
        expect(transcriptDemandReleases).not.toHaveBeenCalled();
        expect(observerDisposals.get('endpoint-a')).not.toHaveBeenCalled();

        for (const record of records.slice(0, 50)) {
            await manager.detach({
                sessionId: record.sessionId,
                leaseId: record.viewerLeaseIds[1],
            });
        }
        expect(transcriptDemandReleases).toHaveBeenCalledTimes(50);
        expect(observerDisposals.get('endpoint-a')).toHaveBeenCalledTimes(1);
        expect(observerDisposals.get('endpoint-b')).not.toHaveBeenCalled();
        expect(activeTimers.size).toBe(100);

        expect(getEventListeners(generation.signal, 'abort')).toHaveLength(51);
        generation.abort();
        await vi.waitFor(() => {
            expect(transcriptDemandReleases).toHaveBeenCalledTimes(100);
            expect(observerDisposals.get('endpoint-b')).toHaveBeenCalledTimes(1);
        });
        expect(getEventListeners(generation.signal, 'abort')).toHaveLength(0);

        for (const record of records.slice(50)) {
            for (const leaseId of record.viewerLeaseIds) {
                await manager.detach({
                    sessionId: record.sessionId,
                    leaseId,
                });
            }
        }
        expect(activeTimers.size).toBe(0);
        expect(transcriptDemandReleases).toHaveBeenCalledTimes(100);
        expect(observerDisposals.get('endpoint-a')).toHaveBeenCalledTimes(1);
        expect(observerDisposals.get('endpoint-b')).toHaveBeenCalledTimes(1);
        expect(pageTranscript).not.toHaveBeenCalled();
        expect(readAfterTranscript).not.toHaveBeenCalled();

        await reconciler.removeLink({
            ...statusOnly.observation.link,
            sessionId: 'status-only-session',
            linkGeneration: 'status-only-generation',
            linkKey: 'status-only-link',
        });
        await reconciler.dispose();
        await manager.dispose();
    });
});
