import { ManagedMachineActionOutputSchemasV1, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { View } from 'react-native';
import 'fake-indexeddb/auto';

import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createDeferred, renderHook, renderScreen } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createExistingSessionDirectoryPreflightResult } from '@/dev/testkit/fixtures/sessionFixtures';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { SessionSpawnNewResultV1, SessionAuthoringCheckoutCreationDraftV1 } from '@happier-dev/protocol';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import type { HomeViewStateV1, ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { RPC_METHODS, DaemonProviderModelProjectionRequestV1Schema } from '@happier-dev/protocol/rpc';

installTokenStorageWebPlatformMocks();

// Match the nearest real screen-model fixture's native SDK boundary. This
// hook-only journey never renders Markdown; do not fabricate reveal/parser
// behavior if a new consumer starts using the patched SDK during the test.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Markdown streaming rendering is outside this hook-only journey'); },
}));

const socketBoundary = vi.hoisted(() => ({
    connects: vi.fn(),
    emits: vi.fn(),
    fetches: vi.fn(),
    result: null as SessionSpawnNewResultV1 | null,
    providerProjection: null as import('@happier-dev/protocol/rpc').DaemonProviderModelProjectionResponseV1 | null,
    nativeSignInStatus: 'signedIn' as 'signedIn' | 'signedOut',
    controls: new Map<string, Readonly<{ disconnect: () => void; reconnect: () => void }>>(),
}));
const modalBoundary = vi.hoisted(() => ({
    alert: vi.fn((..._args: unknown[]) => { modalBoundary.alertStacks.push(new Error('Alert boundary').stack); }),
    alertStacks: [] as Array<string | undefined>,
    confirm: vi.fn(async (..._args: unknown[]) => false),
    show: vi.fn((_params: unknown) => 'composed-modal'),
}));
const observabilityBoundary = vi.hoisted(() => ({ capture: vi.fn() }));
const routeBoundary = vi.hoisted(() => ({
    params: {} as Record<string, string | undefined>,
    push: vi.fn(),
    replace: vi.fn(),
}));

vi.mock('@/text', async () => createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: {
        alert: (...args) => modalBoundary.alert(...args),
        confirm: (...args) => modalBoundary.confirm(...args),
        show: (params) => modalBoundary.show(params),
    } }).module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const router = createExpoRouterMock({
        params: () => routeBoundary.params,
        pathname: '/new',
        navigation: { dispatch: vi.fn(), getState: () => undefined },
        router: { push: routeBoundary.push, replace: routeBoundary.replace, setParams: (params) => { Object.assign(routeBoundary.params, params); } },
    });
    return {
        ...router.module,
        // Each case owns a fresh route; prior picker overrides must not survive it.
        useLocalSearchParams: () => routeBoundary.params,
    };
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        InteractionManager: {
            runAfterInteractions: (callback: () => void) => {
                callback();
                return { cancel: () => {} };
            },
        },
        useWindowDimensions: () => ({ width: 900, height: 800 }),
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@react-navigation/native', async (importOriginal) => {
    const React = await import('react');
    return {
        ...await importOriginal<typeof import('@react-navigation/native')>(),
        useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
        useIsFocused: () => true,
    };
});
vi.mock('@/utils/system/sentry', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/sentry')>(),
    captureExceptionIfEnabled: (error: unknown, context?: unknown) => observabilityBoundary.capture(error, context),
}));
vi.mock('socket.io-client', async () => {
    const { createSocketIoManagerBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: (serverUrl: string, options: { auth?: { token?: string } }) => {
        const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
        const publish = (event: string, ...args: unknown[]) => {
            for (const listener of listeners.get(event) ?? []) listener(...args);
        };
        const socket = {
            io: createSocketIoManagerBoundaryStub(),
            connected: false,
            id: 'composed-socket',
            connect() {
                socket.connected = true;
                socketBoundary.connects(serverUrl, options.auth?.token);
                publish('connect');
            },
            disconnect() {
                socket.connected = false;
                publish('disconnect', 'io client disconnect');
            },
            on(event: string, listener: (...args: unknown[]) => void) {
                const registered = listeners.get(event) ?? new Set();
                registered.add(listener);
                listeners.set(event, registered);
            },
            off(event: string, listener: (...args: unknown[]) => void) {
                listeners.get(event)?.delete(listener);
            },
            async emitWithAck(event: string, payload: unknown) {
                socketBoundary.emits({
                    serverUrl,
                    token: options.auth?.token,
                    event,
                    payload,
                });
                if (typeof payload === 'object' && payload !== null
                    && 'method' in payload && typeof payload.method === 'string'
                    && 'params' in payload) {
                    if (payload.method.endsWith(`:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`)) {
                        return { ok: true, result: createExistingSessionDirectoryPreflightResult(payload.params) };
                    }
                    if (payload.method.endsWith(`:${RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION}`) && socketBoundary.providerProjection) {
                        const request = DaemonProviderModelProjectionRequestV1Schema.parse(payload.params);
                        return { ok: true, result: socketBoundary.providerProjection.status === 'success' && request.teamCredentialResources
                            ? { ...socketBoundary.providerProjection, teamCredentialResources: request.teamCredentialResources }
                            : socketBoundary.providerProjection };
                    }
                    if (payload.method.includes('contributionRegistryProjection.describe')) {
                        const { BUNDLED_CANONICAL_AGENT_DECLARATIONS } = await import('@/agents/registry/generatedBundledPluginEntries');
                        return { ok: true, result: { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({
                            v: 2, generation: 1, installedPackagesById: {},
                            agentsById: Object.fromEntries(Object.entries(BUNDLED_AGENT_CONTRIBUTION_IDENTITIES).map(([id, identity]) => [id, {
                                id, identity, title: id,
                                // The real daemon projects the Agent's binding requirements.
                                // Omitting them makes Team readiness unknown even after consent.
                                providerRequirements: BUNDLED_CANONICAL_AGENT_DECLARATIONS[id as keyof typeof BUNDLED_CANONICAL_AGENT_DECLARATIONS]?.providerRequirements ?? undefined,
                                // Match projection/v2.ts: manifest-local services become qualified on the wire.
                                connectedAccounts: (BUNDLED_CANONICAL_AGENT_DECLARATIONS[id as keyof typeof BUNDLED_CANONICAL_AGENT_DECLARATIONS]?.connectedAccounts ?? [])
                                    .map(declaration => ({ ...declaration, service: typeof declaration.service === 'string'
                                        ? { pluginId: identity.pluginId, localId: declaration.service } : declaration.service })),
                                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                            }])),
                            actionsById: {}, familiesById: {},   resourcesById: {}, settingsById: {}, diagnostics: [],
                        }) } };
                    }
                    if (payload.method.endsWith(`:${RPC_METHODS.CAPABILITIES_DETECT}`)) {
                        return { ok: true, result: { protocolVersion: 1,
                            results: Object.fromEntries(Object.keys(BUNDLED_AGENT_CONTRIBUTION_IDENTITIES).map(agentId => [`cli.${agentId}`, {
                                ok: true, checkedAt: Date.now(), data: { agentId, title: agentId, installed: true,
                                    version: '1', latestVersion: null, update: { supported: false, command: null },
                                    signIn: { status: socketBoundary.nativeSignInStatus, loginSupport: 'status_only' }, platform: { supported: true },
                                    install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] },
                            }])),
                        } };
                    }
                    if (payload.method.includes('agentInstallJobs.list')) return { ok: true, result: { jobs: [] } };
                }
                return {
                    ok: true,
                    result: socketBoundary.result ?? { type: 'error', code: 'spawn_failed', retryable: false },
                };
            },
            timeout() {
                return socket;
            },
            emit: vi.fn(),
        };
        socketBoundary.controls.set(serverUrl, {
            disconnect: () => {
                socket.connected = false;
                publish('disconnect', 'transport close');
            },
            reconnect: () => socket.connect(),
        });
        return socket;
    } };
});

function tokenFor(accountId: string): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'none' })}.${encode({ sub: accountId, tokenEpoch: 1,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`;
}

function sessionSpawnCalls() {
    return socketBoundary.emits.mock.calls.filter(([request]) => (
        request.payload?.method?.endsWith(`:${RPC_METHODS.SESSION_SPAWN_NEW}`)
    ));
}

// Collect the real cold module graph after installing its platform boundaries.
// Imports are setup work, not part of the timed Home/creation behavior.
const localStorageHandle: LocalStorageMockHandle = installLocalStorageMock();
const navigatorLocksDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
let pendingSpawnCustodyLock: Readonly<{ wait: Promise<void>; requested(): void }> | null = null;
const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
        // Web Locks admits both `request(name, callback)` and `request(name, options, callback)`.
        request: async function request<T>(
            name: string,
            optionsOrCallback: LockOptions | (() => T | Promise<T>),
            maybeCallback?: () => T | Promise<T>,
        ): Promise<T> {
            const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
            if (!callback) throw new Error('navigator.locks.request stub requires a callback');
            if (pendingSpawnCustodyLock && name.startsWith('happier:session-spawn-attempts-v2:')) {
                pendingSpawnCustodyLock.requested();
                await pendingSpawnCustodyLock.wait;
            }
            return await callback();
        },
    },
});
process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `multi_home_create_${Date.now()}_${Math.random()}`;
routeBoundary.params = {
    machineId: 'machine-b',
    directory: '/workspace/project',
    spawnServerId: 'srv_home_b',
};
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/syncEngine');
const profiles = await import('@/sync/domains/server/serverProfiles');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
await prepareSessionDraftPersistenceStorage();
const { useNewSessionScreenModel } = await import('./useNewSessionScreenModel');
const { useTemporaryComputerLaunch } = await import('./useTemporaryComputerLaunch');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
// HTTP is the system boundary; draft reopening, Send, hydration and tuple publication stay real.
let sessionHttpBoundary: ((url: string, init?: RequestInit) => Response | null | Promise<Response | null>) | null = null;
let accountHttpSettings: Record<string, unknown> | null = null;
let artifactHttpBoundary: ((url: string, init?: RequestInit) => Promise<Response> | null) | null = null;
// The HTTP snapshot fixture is independent of the client projection under test.
const machineHttpSnapshots = new Map<string, readonly Machine[]>();

async function selectHomeView(state: HomeViewStateV1): Promise<void> {
    await profiles.saveHomeViewState(state);
    const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
    await updateEffectiveHomeViewState(() => state, { scope: 'tab' });
}

describe('multi-Home Session creation composition', () => {

    afterEach(() => {
        // This file owns the real Sync singleton, including background bootstrap.
        // Retire the previous Account before the next case replaces Home HTTP.
        sync?.disconnectServer();
    });

    beforeEach(async () => {
        pendingSpawnCustodyLock = null;
        modalBoundary.alert.mockClear();
        observabilityBoundary.capture.mockClear();
        modalBoundary.alertStacks = [];
        socketBoundary.fetches.mockClear();
        sessionHttpBoundary = null;
        accountHttpSettings = null;
        artifactHttpBoundary = null;
        machineHttpSnapshots.clear();
        socketBoundary.result = null;
        socketBoundary.providerProjection = null;
        socketBoundary.nativeSignInStatus = 'signedIn';
        routeBoundary.replace.mockClear();
        routeBoundary.push.mockClear();
        routeBoundary.params = { machineId: 'machine-b', directory: '/workspace/project', spawnServerId: 'srv_home_b' };
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { resetMachinePoolSyncRuntimeForTests } = await import('@/sync/engine/machines/machinePoolSyncRuntime');
        resetServerFeaturesClientForTests();
        resetMachinePoolSyncRuntimeForTests();
        await resetServerReachabilitySupervisors();
        const {
            CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            MACHINE_PLAIN_DATA_KEY_MARKER,
            encodePlainMachineStoredContent,
        } = await import('@happier-dev/protocol');
        const { buildServerFeaturesResponse } = await import('@/hooks/server/serverFeaturesTestUtils');
        const { MachineAccessGrantsListResponseV1Schema } = await import('@happier-dev/protocol/machines/machineAccessV1');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const features = buildServerFeaturesResponse();
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const authoringMemoryHttp = createAuthoringMemoryHttpBoundary();
        setRuntimeFetch(createSessionReadBatchFetchBoundary(async (input, init) => {
            const authoringResponse = await authoringMemoryHttp.handle(input, init);
            if (authoringResponse) return authoringResponse;
            const url = String(input);
            socketBoundary.fetches(url, init?.method ?? 'GET');
            const artifactResponse = artifactHttpBoundary?.(url, init);
            if (artifactResponse) return await artifactResponse;
            const sessionResponse = await sessionHttpBoundary?.(url, init);
            if (sessionResponse) return sessionResponse;
            if (url.endsWith('/v1/features')) {
                return Response.json({
                    ...features,
                    capabilities: {
                        ...features.capabilities,
                        accountStoredContentCompatibility: {
                            v: 1,
                            minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                            declarationTransport: 'http-header-and-socket-auth-v1',
                        },
                    },
                });
            }
            if (url.endsWith('/v1/machines/machine-b/access')) {
                const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
                const custodian = { accountId: parseToken(token), displayName: 'Machine owner' };
                return Response.json(MachineAccessGrantsListResponseV1Schema.parse({
                    machineId: 'machine-b', custodian,
                    access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                    canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
                }));
            }
            if (url.endsWith('/v1/machines/read-batch') && init?.method === 'POST') {
                const token = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
                return createMachineReadBatchResponseFixture(init.body,
                    id => id === 'machine-b' ? createPlainMachineRowFixture({ id, accountId: parseToken(token),
                        machine: machineHttpSnapshots.get(new URL(url).origin)?.find(machine => machine.id === id) }) : null);
            }
            if (url.endsWith('/v1/machines/machine-b')) {
                return Response.json({
                    machine: { id: 'machine-b', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
                });
            }
            if (url.endsWith('/v1/machines/pools/list')) return Response.json({ pools: [] });
            if (new URL(url).pathname === managedMachineActionEndpointPathV1('machines.managed.list')) {
                return Response.json(ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse({ machines: [] }));
            }
            if (new URL(url).pathname === '/v1/machines') return Response.json((machineHttpSnapshots.get(new URL(url).origin) ?? []).map((machine) => ({
                ...machine, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                metadata: encodePlainMachineStoredContent(machine.metadata),
                daemonState: machine.daemonState ? encodePlainMachineStoredContent(machine.daemonState) : null,
            })));
            if (url.endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.endsWith('/v1/account/encryption/currentness')) return Response.json({ mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (url.endsWith('/v1/account/entity-rows/connected-accounts/purposes')) {
                const { ConnectedAccountCatalogRowReadResponseV1Schema, emptyConnectedAccountCatalogRecordV1 } = await import('@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1');
                return Response.json(ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
                    content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1('purposes') } }));
            }
            if (url.endsWith('/v1/account/entity-rows/prompt-library')) return Response.json({ rows: [] });
            if (url.endsWith('/v2/account/settings') && (!init?.method || init.method === 'GET')) return Response.json({
                content: accountHttpSettings ? { t: 'plain', v: accountHttpSettings } : null, version: 1 });
            if (url.endsWith('/v1/auth/ping') || url.endsWith('/health')) return Response.json({ ok: true });
            return Response.json({ error: 'not_found' }, { status: 404 });
        }));
    });

    afterAll(async () => {
        restoreExecutorModuleLoader();
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
        sync?.disconnectServer();
        localStorageHandle?.restore();
        if (navigatorLocksDescriptor) Object.defineProperty(globalThis.navigator, 'locks', navigatorLocksDescriptor);
        else Reflect.deleteProperty(globalThis.navigator, 'locks');
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        socketBoundary.controls.clear();
    });

    async function arrangeFocusedHomeA(fixtureSuffix = '', options: Readonly<{ applyConnectionManager?: boolean }> = {}) {
        const normalizedSuffix = fixtureSuffix ? `_${fixtureSuffix.replace(/-/g, '_')}` : '';
        const urlSuffix = fixtureSuffix ? `-${fixtureSuffix}` : '';
        const homeA = await profiles.adoptHomeProfile({
            descriptor: {
                v: 1,
                homeServerIdentityId: `srv_home_a${normalizedSuffix}`,
                canonicalServerUrl: `https://home-a${urlSuffix}.example.test`,
                revision: 1,
                endpoints: [{ kind: 'https', url: `https://home-a${urlSuffix}.example.test` }],
            },
            source: 'manual',
            preserveUserLabel: true,
        });
        const homeAScopeId = profiles.resolveServerProfileScopeId(homeA);
        const homeAToken = tokenFor('account-a');
        await expect(TokenStorage.setCredentialsForServerUrl(
            homeA.serverUrl,
            { serverId: homeAScopeId },
            { token: homeAToken },
        )).resolves.toBe(true);
        await profiles.setActiveServerId(homeAScopeId, { scope: 'device' });
        await profiles.setActiveServerId(homeAScopeId, { scope: 'tab' });
        await selectHomeView({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: homeAScopeId,
            groups: [{ id: `home-a-group${urlSuffix}`, name: 'Home A', serverIds: [homeAScopeId] }],
        });
        if (options.applyConnectionManager) {
            // Descriptor-backed foreground HTTP needs the transport publication
            // the real connection owner establishes before Sync bootstrap.
            const { syncSwitchServer } = await import('@/sync/sync');
            const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
            await syncSwitchServer(null);
            await restoreConnectionToActiveServer({ token: homeAToken });
        } else {
            await sync!.switchServer({ token: homeAToken });
            // Hook-only creation journeys drive the applied-scope producer;
            // foreground admission journeys also require its HTTP transport.
            const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
            publishAppliedActiveServerSnapshot(profiles.getActiveServerSnapshot());
        }
        return { profiles, homeA, homeAScopeId, homeAToken };
    }

    async function createDraftSurfaceCoreHttpBoundary() {
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const { createPlainProjectAccountRowListFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
        return (path: string): Response | null => {
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'account-a' });
            if (path === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture());
            if (path === '/v2/cursor') return Response.json({ cursor: 0 });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends') return Response.json({ friends: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            return null;
        };
    }

    async function renderProductionCreateCaller(params: Readonly<{
        activeServerId: string;
        accountId?: string;
        targetServerId?: string;
        draftId?: string;
        mountTemporaryController?: boolean;
        authoringOriginAtBirth?: boolean;
    }>) {
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().activateProfileScope({ serverId: params.activeServerId, accountId: params.accountId ?? 'account-a' });
        await storage.getState().activateSettingsScope({ serverId: params.activeServerId, accountId: params.accountId ?? 'account-a' });
        storage.getState().applySettings(storage.getState().settings, 1);
        if (params.targetServerId) {
            const machines = [
                createMachineFixture({
                    id: 'machine-b',
                    ...(params.authoringOriginAtBirth ? { operationProtocolCapabilities: {
                        sessionSpawnAuthoringOrigin: { protocolVersions: [1] },
                    }, operationProtocolCapabilitiesRevision: 1 } : {}),
                    activeAt: Date.now(),
                    metadata: {
                        host: 'home-b-machine',
                        platform: 'linux',
                        happyCliVersion: '0.0.0-test',
                        happyHomeDir: '/workspace/.happy',
                        homeDir: '/workspace',
                    },
                }),
            ];
            const targetProfile = profiles.getServerProfileById(params.targetServerId);
            if (!targetProfile) throw new Error('Creation fixture has no target Home profile');
            machineHttpSnapshots.set(new URL(targetProfile.serverUrl).origin, machines);
            storage.getState().applyMachines(machines, true, { sourceServerId: params.targetServerId });
        }
        const draftId = params.draftId ?? crypto.randomUUID();
        const activeProfile = profiles.getServerProfileById(params.activeServerId);
        if (!activeProfile) throw new Error('Creation fixture has no active Home profile');
        const credentials = await TokenStorage.getCredentialsForServerUrl(activeProfile.serverUrl, { serverId: params.activeServerId });
        if (!credentials) throw new Error('Creation fixture has no active Home credentials');
        return await renderHook(() => {
            const model = useNewSessionScreenModel({ draftId: params.draftId ?? draftId });
            // Mount the same controller and imperative handoff as the launch
            // surface; this fixture omits presentation, not preparation logic.
            if (params.mountTemporaryController) {
                if (!model.temporaryComputerLaunch) throw new Error('Missing production temporary launch input');
                const controller = useTemporaryComputerLaunch(model.temporaryComputerLaunch.input);
                React.useImperativeHandle(model.temporaryComputerLaunch.controlRef, () => controller, [controller]);
            }
            return model;
        }, {
            wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
        });
    }

    function readProductionCreateAction(model: ReturnType<Awaited<ReturnType<typeof renderProductionCreateCaller>>['getCurrent']>) {
        return model.variant === 'simple'
            ? model.simpleProps.handleCreateSession
            : model.wizardProps.footer.handleCreateSession;
    }

    let homeA!: ServerProfile;
    let homeB!: ServerProfile;
    let homeAScopeId = '';
    let homeBScopeId = '';
    let homeAToken = '';
    let homeBToken = '';

    async function arrangeHomeB() {
        const { adoptHomeProfileWithCredentials } = await import('@/sync/domains/server/adoptHomeProfile');
        homeBToken = tokenFor('account-b');

        homeB = await adoptHomeProfileWithCredentials({
                descriptor: {
                    v: 1,
                    homeServerIdentityId: 'srv_home_b',
                    canonicalServerUrl: 'https://home-b.example.test',
                    revision: 1,
                    endpoints: [{ kind: 'https', url: 'https://home-b.example.test' }],
                },
                source: 'account-directory',
                preserveUserLabel: true,
                credentials: { token: homeBToken },
        });
        homeBScopeId = profiles.resolveServerProfileScopeId(homeB);
    }

    it('opens an answering-client authoring seed on its exact target instead of a remembered directory', async () => {
        const coreHttp = await createDraftSurfaceCoreHttpBoundary();
        sessionHttpBoundary = url => coreHttp(new URL(url).pathname);
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA('answering-client-authoring'));
        const { storage } = await import('@/sync/domains/state/storage');
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { openSessionAuthoringDraft } = await import('@/sync/ops/actions/sessionAuthoringOpenAction');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const machines = ['remembered-machine', 'machine-b'].map(id => createMachineFixture({ id }));
        machineHttpSnapshots.set(new URL(homeA.serverUrl).origin, machines);
        storage.getState().applyMachines(machines, true, { sourceServerId: homeAScopeId });
        storage.getState().applySettingsLocal({ recentMachinePaths: [{ machineId: 'remembered-machine', path: '/retained/other-project' }] });
        const opened = await openSessionAuthoringDraft({ input: { seed: { prompt: 'Inspect this checkout',
            placement: { kind: 'exactTarget', serverId: homeAScopeId, machineId: 'machine-b', directory: '/requested/checkout' },
        } }, context: { surface: 'cli', serverId: homeAScopeId, runtimeAccountId: 'account-a' } });
        expect(opened.kind).toBe('opened');
        if (opened.kind !== 'opened') throw new Error('Authoring did not open');
        const route = routeBoundary.push.mock.calls.at(-1)?.[0] as { params: Record<string, string> };
        expect(route.params.draftId).toBe(opened.draftId);
        routeBoundary.params = route.params;
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId: route.params.draftId });
        try {
            const model = hook.getCurrent();
            const machine = model.variant === 'wizard' ? model.wizardProps.machine : model.simpleProps;
            expect(machine).toMatchObject({ selectedMachineId: 'machine-b', selectedPath: '/requested/checkout' });
            expect(readNewSessionDraftFromRepository({ scope: { serverId: homeAScopeId, accountId: 'account-a' }, draftId: opened.draftId }))
                .toMatchObject({ selectedMachineId: 'machine-b', selectedPath: '/requested/checkout', input: 'Inspect this checkout' });
            expect(socketBoundary.emits.mock.calls.filter(([request]) => request.payload?.method?.endsWith(':session.spawnNew'))).toEqual([]);
        } finally { await hook.unmount(); }
    });

    it.each(['offline', 'absent'] as const)('reopens a seeded authoring draft on its persisted exact placement when the Machine is %s', async (availability) => {
        const coreHttp = await createDraftSurfaceCoreHttpBoundary();
        sessionHttpBoundary = url => coreHttp(new URL(url).pathname);
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA(`reopened-authoring-${availability}`));
        const { storage } = await import('@/sync/domains/state/storage');
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { openSessionAuthoringDraft } = await import('@/sync/ops/actions/sessionAuthoringOpenAction');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const remembered = createMachineFixture({ id: 'remembered-machine', activeAt: Date.now(), metadata: { homeDir: '/other/home' } });
        const target = createMachineFixture({ id: 'd4ac', activeAt: Date.now(), metadata: { homeDir: '/home/happier' } });
        const publishMachines = (machines: Machine[]) => {
            machineHttpSnapshots.set(new URL(homeA.serverUrl).origin, machines);
            storage.getState().applyMachines(machines, true, { sourceServerId: homeAScopeId });
        };
        publishMachines([remembered, target]);
        storage.getState().applySettingsLocal({ recentMachinePaths: [{ machineId: remembered.id, path: '/other/checkout' }] });
        const opened = await openSessionAuthoringDraft({ input: { seed: {
            prompt: 'Help me set up this checkout for Happier.',
            placement: { kind: 'exactTarget', serverId: homeAScopeId, machineId: target.id, directory: '/home/happier/d-dd-ky' },
        } }, context: { surface: 'cli', serverId: homeAScopeId, runtimeAccountId: scope.accountId } });
        if (opened.kind !== 'opened') throw new Error('Authoring did not open');
        const route = routeBoundary.push.mock.calls.at(-1)?.[0] as { params: Record<string, string> };
        expect(route.params.draftId).toBe(opened.draftId);
        routeBoundary.params = route.params;
        const initial = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId: opened.draftId });
        try {
            const model = initial.getCurrent();
            expect(model.variant === 'wizard' ? model.wizardProps.machine : model.simpleProps)
                .toMatchObject({ selectedMachineId: target.id, selectedPath: '/home/happier/d-dd-ky' });
        } finally { await initial.unmount(); }
        publishMachines(availability === 'absent' ? [remembered]
            : [remembered, { ...target, active: false, activeAt: Date.now() - 10 * 60_000 }]);
        if (availability === 'offline') {
            const { recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
            recordMachineRequestFailed({ ...scope, machineId: target.id });
        }
        resetSessionDraftRepositoryForTests();
        // A saved /new?draftId= entrance has no one-shot placement or temp-data carrier.
        routeBoundary.params = { draftId: opened.draftId };
        const reopened = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId: opened.draftId });
        try {
            const model = reopened.getCurrent();
            expect(model.variant === 'wizard' ? model.wizardProps.machine : model.simpleProps)
                .toMatchObject({ selectedMachineId: target.id, selectedPath: '/home/happier/d-dd-ky' });
            expect(readNewSessionDraftFromRepository({ scope, draftId: opened.draftId }))
                .toMatchObject({ selectedMachineId: target.id, selectedPath: '/home/happier/d-dd-ky',
                    executionTarget: { kind: 'machine', target: { serverId: homeAScopeId, machineId: target.id } } });
            await act(async () => {
                const { recordMachineRequestSucceeded } = await import('@/sync/domains/machines/reachability/machineReachability');
                recordMachineRequestSucceeded({ ...scope, machineId: target.id });
                publishMachines([remembered, target]);
            });
            const reconnected = reopened.getCurrent();
            expect(reconnected.variant === 'wizard' ? reconnected.wizardProps.machine : reconnected.simpleProps)
                .toMatchObject({ selectedMachineId: target.id, selectedPath: '/home/happier/d-dd-ky' });
            expect(socketBoundary.emits.mock.calls.filter(([request]) => request.payload?.method?.endsWith(':session.spawnNew'))).toEqual([]);
        } finally { await reopened.unmount(); }
    });

    it.each(['send', 'route-send', 'manual-send', 'use', 'cancel', 'cancel-start'] as const)('continues a managed Machine receipt through the real composer (%s)', async intent => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA('FIX30-COMPOSER-START', { applyConnectionManager: true }));
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture, flushHookEffects } = await import('@/dev/testkit');
        const { createManagedMachineSelectionDraft } = await import('@/sync/domains/state/newSessionManagedMachineDraft');
        const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
        const { createDefaultCollectionSpaceV1 } = await import('@happier-dev/protocol/collections/spaces/collectionSpacesV1');
        const { SessionOrganizationSnapshotResponseSchema } = await import('@happier-dev/protocol/sessions/organization/snapshot');
        const { seedNewSessionDraftV1 } = await import('../newSessionDraftSeed');
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const spaceMembership = { spaceId: 'managed-captured-space', spaceSettingsTarget: scope };
        const catalog = { v: 1 as const, spaces: [{ ...createDefaultCollectionSpaceV1('sessionWork'),
            id: spaceMembership.spaceId, membership: { mode: 'manual_only' as const, tags: [{ ...scope, tagId: 'managed-space-tag' }] } }] };
        accountHttpSettings = { collectionSpacesV1: catalog };
        storage.getState().applySettingsLocal({ collectionSpacesV1: catalog });
        const draftId = seedNewSessionDraftV1({ scope, seed: { spaceMembership } });
        if (!draftId) throw new Error('Expected captured managed draft');
        const seeded = readNewSessionDraftFromRepository({ scope, draftId });
        if (!seeded) throw new Error('Expected retained managed draft');
        writeNewSessionDraftToRepository({ scope, draftId,
            draft: { ...seeded, organizationPlacement: { folderId: null, tagIds: ['ordinary-managed-label'] } } });
        const organization = SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
            schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], orderEntries: [], labels: [], tagAssignments: [],
            tags: [{ tagId: 'managed-space-tag', tagKey: 'managed-space-tag', sortKey: null,
                display: { t: 'plain', v: { kind: 'space_membership', ...spaceMembership } }, archivedAt: null, createdAt: 1, updatedAt: 1 },
            { tagId: 'ordinary-managed-label', tagKey: 'ordinary-managed-label', sortKey: null,
                display: { t: 'plain', v: { label: 'Ordinary label' } }, archivedAt: null, createdAt: 1, updatedAt: 1 }],
        } });
        const coreHttp = await createDraftSurfaceCoreHttpBoundary();
        const joined = createDeferred<void>();
        const acquisitions: unknown[] = [];
        const controller = { machineId: 'machine-b', installationId: 'test-installation' };
        const acquireHttp = await createExternalActionAccountHttpBoundary({
            serverUrl: homeA.serverUrl, serverIdentityId: homeA.serverIdentityId!, accountId: 'account-a',
            machineId: controller.machineId, actionId: 'machines.managed.acquire', tokenEpoch: 1,
            execute: input => { acquisitions.push(input); return { managedId: 'FIX30-paid' }; },
        });
        const selection = createManagedMachineSelectionDraft({
            enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' },
            selection: { kind: 'one-off', homeId: homeA.serverIdentityId!, controller,
                launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'FIX30 guest', choices: {} },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            receipt: { controller, launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'FIX30 guest', choices: {} },
                optionStatus: 'current', prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' },
                retentionCapabilities: { supportedIntents: ['delete'] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            archiveEffect: 'keep',
        });
        const guest = createMachineFixture({ id: 'FIX30-guest', activeAt: Date.now(), metadata: {
            ...createMachineFixture().metadata!, homeDir: '/guest', host: 'FIX30-guest',
        } });
        const managed = ManagedMachineV1Schema.parse({ id: 'FIX30-paid', homeId: homeA.serverIdentityId, controller,
            custodianAccountId: 'account-a', launch: selection.receipt.launch, allocation: 'bound',
            resource: { contributionRef: selection.receipt.launch.provider, schemaVersion: 1, value: {} },
            creationState: 'active', enrolledMachineId: guest.id, desired: 'start', desiredWhen: 'now', intentRevision: 1,
            observation: { observedAt: Date.now(), availability: 'present', power: 'running', storage: 'retained' },
            retention: selection.receipt.retention, wakeOnAcceptedMessage: false });
        sessionHttpBoundary = async (url, init) => {
            const path = new URL(url).pathname;
            if (path === '/v2/session-organization') return Response.json(organization);
            if (path.startsWith('/v1/actions/machines.managed.acquire')) {
                return await acquireHttp.handle(new URL(url), init);
            }
            if (path === managedMachineActionEndpointPathV1('machines.managed.get')) {
                await joined.promise;
                return Response.json(managed);
            }
            if (path === managedMachineActionEndpointPathV1('machines.managed.list')) {
                return Response.json(ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse({ machines: [managed] }));
            }
            if (path === '/v1/machines') return Response.json((machineHttpSnapshots.get(new URL(url).origin) ?? [])
                .map(machine => machine.id === controller.machineId ? acquireHttp.machine
                    : createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine })));
            if (path === `/v1/machines/${guest.id}`) return Response.json({
                machine: createPlainMachineRowFixture({ id: guest.id, accountId: 'account-a', machine: guest }),
            });
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
                return createMachineReadBatchResponseFixture(init.body, id => {
                    if (id === controller.machineId) return acquireHttp.machine;
                    const machine = machineHttpSnapshots.get(new URL(url).origin)?.find(row => row.id === id);
                    return machine ? createPlainMachineRowFixture({ id, accountId: 'account-a', machine }) : null;
                });
            }
            if (path === `/v1/machines/${guest.id}/access`) {
                const custodian = { accountId: 'account-a', displayName: 'Account A' };
                return Response.json({ machineId: guest.id, custodian, canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
                    access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
            }
            return coreHttp(path) ?? createEmptyAccountBootstrapHttpResponse(path, init);
        };
        await storage.getState().activateSettingsScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().applySettingsLocal({ useEnhancedSessionWizard: false });
        routeBoundary.params = { spawnServerId: homeAScopeId, directory: '/workspace/project' };
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, targetServerId: homeAScopeId, draftId });
        try {
            const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
            await act(async () => {
                const origin = new URL(homeA.serverUrl).origin;
                const machines = (machineHttpSnapshots.get(origin) ?? []).map(machine => ({ ...machine, installationId: controller.installationId }));
                machineHttpSnapshots.set(origin, machines);
                storage.getState().applyMachines(machines, true, { sourceServerId: homeAScopeId });
                observeMachinePresenceForTest({ serverId: homeAScopeId, accountId: 'account-a' }, ['machine-b']);
            });
            const { getConnectedAccountCatalogValue } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
            await vi.waitFor(() => expect(getConnectedAccountCatalogValue({ serverId: homeAScopeId, accountId: 'account-a' }, 'purposes')).toMatchObject({ status: 'ready', stale: false }));
            await flushHookEffects();
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected the real simple composer');
            const renderPicker = model.simpleProps.machinePopover?.renderContent;
            if (!renderPicker) throw new Error('Expected the production Machine picker');
            const picker = renderPicker({ requestClose() {}, maxHeight: 420 }) as React.ReactElement<import('../components/NewSessionMachineSelectionContent').NewSessionMachineSelectionContentProps>;
            // The receipt starts the session only while the composer holds a drafted prompt (58d receipt, Q2).
            expect(picker.props.managedMachineStartsSession?.()).toBe(false);
            await act(async () => { model.simpleProps.setSessionPrompt('FIX30 drafted work'); });
            expect(picker.props.managedMachineStartsSession?.()).toBe(true);
            socketBoundary.emits.mockClear();
            socketBoundary.fetches.mockClear();
            await act(async () => {
                if (intent === 'route-send') {
                    const { setNewSessionPickerReturnParams } = await import('../navigation/setNewSessionPickerReturnParams');
                    setNewSessionPickerReturnParams({
                        navigation: { getState: () => ({ index: 1, routes: [
                            { key: 'composer', name: '(app)/new/index' }, { key: 'picker', name: '(app)/new/pick/machine' },
                        ] }), dispatch: event => { routeBoundary.params = { ...routeBoundary.params, ...event.payload.params }; } },
                        router: { replace: routeBoundary.replace }, currentParams: routeBoundary.params,
                        routeParams: { machineId: undefined, spawnServerId: homeAScopeId },
                        managedMachineSelection: selection, managedMachineUseOptions: { send: true },
                    });
                } else {
                    picker.props.onSelectManagedMachine?.(selection, intent === 'send' || intent === 'cancel-start' ? { send: true } : undefined);
                    if (intent === 'cancel') hook.getCurrent().managedMachineDraft?.cancel?.();
                }
            });
            if (intent === 'route-send') await hook.rerender();
            await flushHookEffects();
            if (intent === 'manual-send') await act(async () => { void readProductionCreateAction(hook.getCurrent())(); });
            if (intent === 'use' || intent === 'cancel') {
                expect(acquisitions).toEqual([]);
                expect(sessionSpawnCalls()).toEqual([]);
                expect(model.simpleProps.promptStore.getPrompt()).toBe('FIX30 drafted work');
                expect(hook.getCurrent().managedMachineDraft?.selection ?? null).toEqual(intent === 'use' ? selection : null);
                const selectedComposer = hook.getCurrent();
                if (selectedComposer.variant !== 'simple') throw new Error('Expected the real simple composer');
                if (intent === 'use') expect(selectedComposer.simpleProps.machineName).toBe('FIX30 guest');
                return;
            }
            await vi.waitFor(() => {
                const current = hook.getCurrent();
                expect(acquisitions.length, JSON.stringify({
                    progress: current.managedMachineDraft?.progress,
                    composer: current.variant === 'simple' ? current.simpleProps.connectionStatus : null,
                    alerts: modalBoundary.alert.mock.calls, exceptions: observabilityBoundary.capture.mock.calls.map(([error]) => error instanceof Error ? error.stack : error),
                    requests: socketBoundary.fetches.mock.calls,
                })).toBe(1);
            });
            expect(acquisitions[0]).toMatchObject({ agentStart: { initialInput: { text: 'FIX30 drafted work' },
                organizationPlacement: { folderId: null, tagIds: ['ordinary-managed-label', 'managed-space-tag'] } } });
            expect(hook.getCurrent().managedMachineDraft?.selection).toEqual(selection);
            expect(sessionSpawnCalls()).toEqual([]);
            expect(model.simpleProps.promptStore.getPrompt()).toBe('FIX30 drafted work');
            if (intent === 'cancel-start') {
                await act(async () => { hook.getCurrent().managedMachineDraft?.cancel?.(); joined.resolve(); });
                await flushHookEffects();
                expect(sessionSpawnCalls()).toEqual([]);
                expect(model.simpleProps.promptStore.getPrompt()).toBe('FIX30 drafted work');
                return;
            }
            socketBoundary.result = { type: 'success', disposition: 'created', sessionId: 'FIX30-session',
                executionTarget: { serverId: homeAScopeId, machineId: guest.id }, organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: { status: 'accepted', localId: 'FIX30-input' } };
            await act(async () => {
                machineHttpSnapshots.set(new URL(homeA.serverUrl).origin, [guest]);
                await sync.refreshMachinesThrottled({ staleMs: 0 });
                const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
                observeMachinePresenceForTest({ serverId: homeAScopeId, accountId: 'account-a' }, [guest.id]);
                joined.resolve();
            });
            await vi.waitFor(() => expect(sessionSpawnCalls(), JSON.stringify({
                progress: hook.getCurrent().managedMachineDraft?.progress,
                rpcMethods: socketBoundary.emits.mock.calls.map(([request]) => request.payload?.method),
                capabilityInvocations: socketBoundary.emits.mock.calls.filter(([request]) => request.payload?.method?.endsWith(':capabilities.invoke'))
                    .map(([request]) => request.payload.params),
                alerts: modalBoundary.alert.mock.calls, exceptions: observabilityBoundary.capture.mock.calls.map(([error]) => error instanceof Error ? error.stack : error),
                requests: socketBoundary.fetches.mock.calls,
            })).toHaveLength(1));
            expect(sessionSpawnCalls()[0][0].payload.params).toMatchObject({
                executionTarget: { serverId: homeAScopeId, machineId: guest.id }, initialInput: { text: 'FIX30 drafted work' },
                organizationPlacement: { folderId: null, tagIds: ['ordinary-managed-label', 'managed-space-tag'] },
            });
            await flushHookEffects();
            expect(acquisitions).toHaveLength(1);
            expect(sessionSpawnCalls()).toHaveLength(1);
        } finally { joined.resolve(); await hook.unmount(); }
    });

    it('keeps the mounted embedded composer quiet across unrelated Machine and Session arrivals', async () => {
        const coreHttp = await createDraftSurfaceCoreHttpBoundary();
        sessionHttpBoundary = url => coreHttp(new URL(url).pathname);
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA('composer-publication-locality', { applyConnectionManager: true }));
        const { storage } = await import('@/sync/domains/state/storage');
        const { createMachineFixture, createSessionFixture, flushHookEffects } = await import('@/dev/testkit');
        await storage.getState().activateSettingsScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().applySettingsLocal({ useEnhancedSessionWizard: false, newSessionDraftEntryMode: 'alwaysFresh' });
        const machineMetadata = createMachineFixture().metadata!;
        const selected = createMachineFixture({ id: 'composer-selected', activeAt: Date.now(),
            metadata: { ...machineMetadata, displayName: 'Selected', homeDir: '/selected' } });
        let others = Array.from({ length: 127 }, (_, index) => createMachineFixture({ id: `composer-other-${index}`,
            metadata: { ...machineMetadata, displayName: `Other ${index}` } }));
        const publishMachines = () => {
            machineHttpSnapshots.set(new URL(homeA.serverUrl).origin, [selected, ...others]);
            storage.getState().applyMachines([selected, ...others], true, { sourceServerId: homeAScopeId });
        };
        publishMachines();
        const sessions = Array.from({ length: 1000 }, (_, index) => createSessionFixture({ id: `composer-session-${index}`,
            serverId: homeAScopeId, metadata: { machineId: others[0]!.id, path: `/other/${index}`, host: 'other' } }));
        storage.getState().applySessions(sessions);
        routeBoundary.params = { machineId: selected.id, directory: '/authored' };
        const { NewSessionScreen } = await import('../NewSessionScreen');
        const { NewSessionLaunchSurface } = await import('../components/NewSessionLaunchSurface');
        const { NewSessionComposerCard } = await import('../components/NewSessionComposerCard');
        const { SessionAuthoringComposer } = await import('@/components/sessions/authoring/SessionAuthoringComposer');
        const { NewSessionEmbeddedHostProvider } = await import('../navigation/newSessionHost');
        const { useNewSessionEmbeddedHostState } = await import('../navigation/useNewSessionEmbeddedHostState');
        const initialParams = { machineId: selected.id, directory: '/authored', spawnServerId: homeAScopeId };
        function EmbeddedComposerFixture() {
            const { host } = useNewSessionEmbeddedHostState(initialParams);
            return <NewSessionEmbeddedHostProvider host={host}><NewSessionScreen presentation="embedded" /></NewSessionEmbeddedHostProvider>;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={{ token: homeAToken }}>
            <EmbeddedComposerFixture />
        </InjectedAuthProvider>);
        try {
            // Join the focus effect's existing refresh, so its selected-row
            // hydration is not confused with the unrelated-arrival window.
            await act(async () => { await sync.refreshMachinesThrottled({ staleMs: 15_000 }); });
            await flushHookEffects();
            expect(storage.getState().machineListByServerId[homeAScopeId]?.find(machine => machine.id === selected.id))
                .toMatchObject({ metadata: { displayName: 'Selected', homeDir: '/selected' }, availability: { kind: 'available' } });
            expect(screen.root.findByType(NewSessionComposerCard).props.panelProps.machineName).toBe('Selected');
            const readOutputs = () => [screen.root.findByType(NewSessionLaunchSurface).props,
                screen.root.findByType(NewSessionComposerCard).props,
                screen.root.findByType(SessionAuthoringComposer).props];
            // These are the actual output boundaries of Inner, EmbeddedCard and
            // ComposerCard, respectively; each execution publishes fresh JSX props.
            let previous = readOutputs();
            const renders = [0, 0, 0];
            const stop = screen.subscribe(() => {
                const next = readOutputs();
                next.forEach((props, index) => { if (props !== previous[index]) renders[index]! += 1; });
                previous = next;
            });
            try {
                for (let index = 0; index < 5; index += 1) {
                    others = others.map((machine, position) => position === index ? { ...machine, metadataVersion: machine.metadataVersion + 1,
                        metadata: { ...machine.metadata!, displayName: `Changed other ${index}` } } : machine);
                    const incumbent = storage.getState().machineListByServerId[homeAScopeId]?.find(machine => machine.id === selected.id);
                    await act(async () => { storage.getState().applyMachines([others[index]!], false, { sourceServerId: homeAScopeId }); });
                    expect(storage.getState().machineListByServerId[homeAScopeId]?.find(machine => machine.id === selected.id)).toBe(incumbent);
                    await act(async () => { storage.getState().applySessions([{ ...sessions[index]!, metadataVersion: 2,
                        metadata: { ...sessions[index]!.metadata!, name: `Unrelated ${index}` } }]); });
                }
                expect(renders).toEqual([0, 0, 0]);
                const incumbent = storage.getState().machineListByServerId[homeAScopeId]?.find(machine => machine.id === selected.id);
                if (!incumbent) throw new Error('Missing selected Machine');
                await act(async () => { storage.getState().applyMachines([{ ...incumbent, metadataVersion: incumbent.metadataVersion + 1,
                    metadata: { ...incumbent.metadata!, displayName: 'Selected renamed' } }], false, { sourceServerId: homeAScopeId }); });
                expect(storage.getState().machineListByServerId[homeAScopeId]?.find(machine => machine.id === selected.id))
                    .toMatchObject({ metadata: { displayName: 'Selected renamed' }, availability: { kind: 'available' } });
                expect(renders.every(count => count > 0)).toBe(true);
                expect(screen.root.findByType(NewSessionComposerCard).props.panelProps.machineName).toBe('Selected renamed');
                expect(screen.root.findByType(NewSessionComposerCard).props.panelProps.selectedPath).toBe('/authored');
            } finally { stop(); }
        } finally { await screen.unmount(); }
    });

    it.each([false, true])('admits a fresh New Session without Account-wide draft readiness and retains its generated route identity (seeded=%s)', async (seeded) => {
        const heldList = createDeferred<void>();
        let listRequested = false;
        const readAddresses: unknown[] = [];
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const features = createRootLayoutFeaturesResponse({ features: { sessions: { drafts: { enabled: true } } } });
        const coreHttp = await createDraftSurfaceCoreHttpBoundary();
        sessionHttpBoundary = async (url, init) => {
            const path = new URL(url).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json({ ...features,
                capabilities: { ...features.capabilities,
                    serverIdentity: { serverIdentityId: profiles.getActiveServerSnapshot().serverId } } });
            if (path === '/v2/account/session-drafts/list') { listRequested = true; await heldList.promise; return Response.json({ items: [] }); }
            if (path === '/v2/account/session-drafts/read') {
                readAddresses.push(JSON.parse(String(init?.body)).address);
                return Response.json({ status: 'absent' });
            }
            return coreHttp(path);
        };
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA(`surface-ready-${seeded}`, { applyConnectionManager: true }));
        const { storeTempData, peekTempData } = await import('@/utils/sessions/tempDataStore');
        const dataId = seeded ? storeTempData({ prompt: 'seeded input' }) : undefined;
        routeBoundary.params = dataId ? { dataId } : {};
        const { storage } = await import('@/sync/domains/state/storage');
        await storage.getState().activateSettingsScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().applySettingsLocal({ newSessionDraftEntryMode: 'alwaysFresh' });
        const { NewSessionScreen } = await import('../NewSessionScreen');
        const { AgentInput } = await import('@/components/sessions/agentInput');
        const element = () => React.createElement(InjectedAuthProvider, { credentials: { token: homeAToken },
            children: React.createElement(NewSessionScreen, { presentation: 'embedded' }) });
        const screen = await renderScreen(element());
        try {
            await vi.waitFor(() => expect(routeBoundary.params.draftId).toEqual(expect.any(String)));
            await vi.waitFor(() => expect(listRequested).toBe(true));
            expect(storage.getState().isSessionDraftsReady).toBe(false);
            expect(readAddresses).toEqual([]);
            const draftId = routeBoundary.params.draftId;
            const composer = screen.root.findByType(AgentInput);
            expect(composer.props.value).toBe(seeded ? 'seeded input' : '');
            if (dataId) expect(peekTempData(dataId)).toBeNull();
            await act(async () => { composer.props.onChangeText('newer local input'); });
            await screen.update(element());
            expect(routeBoundary.params.draftId).toBe(draftId);
            expect(screen.root.findByType(AgentInput)).toBe(composer);
            expect(screen.root.findByType(AgentInput).props.value).toBe('newer local input');
            // Settle the same background repository owner that bootstrap uses;
            // unrelated core projection queues do not own this continuity check.
            const hydration = (sync as unknown as { refreshSessionDraftRepositoryForSync(): Promise<void> })
                .refreshSessionDraftRepositoryForSync();
            await act(async () => { heldList.resolve(); await hydration; });
            expect(storage.getState().isSessionDraftsReady).toBe(true);
            expect(screen.root.findByType(AgentInput)).toBe(composer);
            expect(screen.root.findByType(AgentInput).props.value).toBe('newer local input');
        } finally { heldList.resolve(); await screen.unmount(); }
    });

    it.each(['explicit', 'resumePrevious', 'resumeAbsent'] as const)('hydrates only the %s New Session before assigning or mounting its composer', async (entry) => {
        const draftId = '00000000-0000-4000-8000-000000000921';
        const secondId = '00000000-0000-4000-8000-000000000922';
        const heldRead = createDeferred<void>();
        const heldList = createDeferred<void>();
        const addresses: unknown[] = [];
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const features = createRootLayoutFeaturesResponse({ features: { sessions: { drafts: { enabled: true } } } });
        const coreHttp = await createDraftSurfaceCoreHttpBoundary();
        const { NewSessionDraftDocumentV2Schema } = await import('@happier-dev/protocol/drafts/sessionDraftsV2');
        const fieldId = '00000000-0000-4000-8000-000000000923';
        const document = NewSessionDraftDocumentV2Schema.parse({ v: 2, target: { kind: 'newSession', authoring: {} },
            composer: { text: { mutationId: fieldId, value: 'remembered remote input' },
                mentions: { mutationId: fieldId, value: [] }, attachments: { mutationId: fieldId, value: [] } }, extensions: {} });
        sessionHttpBoundary = async (url, init) => {
            const path = new URL(url).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json({ ...features,
                capabilities: { ...features.capabilities,
                    serverIdentity: { serverIdentityId: profiles.getActiveServerSnapshot().serverId } } });
            if (path === '/v2/account/session-drafts/list') { await heldList.promise; return Response.json({ items: [] }); }
            if (path === '/v2/account/session-drafts/read') {
                const { address } = JSON.parse(String(init?.body));
                addresses.push(address);
                await heldRead.promise;
                return Response.json(address.draftId === draftId && entry !== 'resumeAbsent' ? { status: 'present', record: { address, revision: 1,
                    createdAt: 1, updatedAt: 1, content: { t: 'plain', v: { v: 2, address, document } } } } : { status: 'absent' });
            }
            return coreHttp(path);
        };
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA(`surface-${entry}`, { applyConnectionManager: true }));
        const { storage } = await import('@/sync/domains/state/storage');
        await storage.getState().activateSettingsScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().applySettingsLocal({ newSessionDraftEntryMode: entry === 'explicit' ? 'alwaysFresh' : 'resumePrevious',
            newSessionOrdinaryEntryDraftId: draftId });
        routeBoundary.params = entry === 'explicit' ? { draftId } : {};
        const { NewSessionScreen } = await import('../NewSessionScreen');
        const { AgentInput } = await import('@/components/sessions/agentInput');
        const element = () => React.createElement(InjectedAuthProvider, { credentials: { token: homeAToken },
            children: React.createElement(NewSessionScreen, { presentation: 'embedded' }) });
        const screen = await renderScreen(element());
        try {
            await vi.waitFor(() => expect(addresses).toEqual([{ kind: 'newSession', draftId }]));
            expect(screen.root.findAllByType(AgentInput)).toHaveLength(0);
            expect(routeBoundary.params.draftId).toBe(entry === 'explicit' ? draftId : undefined);
            await act(async () => { heldRead.resolve(); });
            await vi.waitFor(() => expect(screen.root.findAllByType(AgentInput)).toHaveLength(1));
            if (entry === 'resumeAbsent') {
                expect(routeBoundary.params.draftId).toEqual(expect.any(String));
                expect(routeBoundary.params.draftId).not.toBe(draftId);
            } else expect(routeBoundary.params.draftId).toBe(draftId);
            const composer = screen.root.findByType(AgentInput);
            expect(composer.props.value).toBe(entry === 'resumeAbsent' ? '' : 'remembered remote input');
            await act(async () => { composer.props.onChangeText('newer local input'); });
            await screen.update(element());
            expect(screen.root.findByType(AgentInput)).toBe(composer);
            expect(screen.root.findByType(AgentInput).props.value).toBe('newer local input');
            routeBoundary.params = { draftId: secondId };
            await screen.update(element());
            await vi.waitFor(() => expect(addresses).toContainEqual({ kind: 'newSession', draftId: secondId }));
            expect(routeBoundary.params.draftId).toBe(secondId);
            await act(async () => { sync!.disconnectServer(); });
            expect(screen.root.findAllByType(AgentInput)).toHaveLength(0);
        } finally { heldRead.resolve(); heldList.resolve(); await screen.unmount(); }
    });

    it('keeps one New Session composer for a Home draft through image paste and deletion', async () => {
        const { SessionDraftMutateRequestV2Schema, SessionDraftMutateResponseV2Schema } = await import('@happier-dev/protocol/drafts/sessionDraftsV2');
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const features = createRootLayoutFeaturesResponse({ features: { sessions: { drafts: { enabled: true } } } });
        const coreHttp = await createDraftSurfaceCoreHttpBoundary();
        const records = new Map<string, Extract<import('@happier-dev/protocol/drafts/sessionDraftsV2').SessionDraftMutateResponseV2, { status: 'updated' }>['record']>();
        sessionHttpBoundary = async (url, init) => {
            const path = new URL(url).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json({ ...features,
                capabilities: { ...features.capabilities, serverIdentity: { serverIdentityId: profiles.getActiveServerSnapshot().serverId } } });
            if (path === '/v2/account/session-drafts/list') return Response.json({ items: [] });
            if (path === '/v2/account/session-drafts/read') {
                const { address } = JSON.parse(String(init?.body));
                const record = records.get(address.draftId);
                return Response.json(record ? { status: record.content === null ? 'deleted' : 'present', record } : { status: 'absent' });
            }
            if (path === '/v1/account/session-drafts/mutate' || path === '/v2/account/session-drafts/mutate') {
                const input = SessionDraftMutateRequestV2Schema.parse(JSON.parse(String(init?.body)));
                if (input.address.kind !== 'newSession') throw new Error('Expected a New Session draft');
                const current = records.get(input.address.draftId);
                if ((current?.revision ?? 'absent') !== input.expectedRevision) return Response.json({ status: 'conflict', current: current ?? { status: 'absent' } });
                const result = SessionDraftMutateResponseV2Schema.parse({ status: 'updated', record: {
                    address: input.address, revision: (current?.revision ?? 0) + 1, createdAt: 1, updatedAt: Date.now(), content: input.content,
                } });
                if (result.status !== 'updated') throw new Error('Expected updated draft');
                records.set(input.address.draftId, result.record);
                return Response.json(result);
            }
            return coreHttp(path);
        };
        accountHttpSettings = { experiments: true, featureToggles: { 'attachments.uploads': true } };
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA('composer-image-delete', { applyConnectionManager: true }));
        const { storage } = await import('@/sync/domains/state/storage');
        await storage.getState().activateSettingsScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'attachments.uploads': true } });
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = '00000000-0000-4000-8000-000000000941';
        const address = { kind: 'newSession' as const, draftId };
        const { getSessionDraftSnapshot, writeNewSessionDraft, flushSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        writeNewSessionDraft({ scope, draftId, materializationIntent: 'userEdit', patch: { text: 'Describe this picture' } });
        await expect(flushSessionDraft({ scope, address })).resolves.toMatchObject({ status: 'clean' });
        storage.getState().applySettingsLocal({ newSessionDraftEntryMode: 'resumePrevious', newSessionOrdinaryEntryDraftId: draftId });
        routeBoundary.params = { draftId, draftOrigin: 'ordinary' };
        const { HubComposerSection } = await import('@/components/hub/composer/HubComposerSection');
        const { DestinationInstanceContext } = await import('@/components/appShell/workspace/destinationInstanceContext');
        const { NewSessionScreen } = await import('../NewSessionScreen');
        const { NewSessionDraftComposerActions } = await import('@/components/sessions/drafts/NewSessionDraftComposerActions');
        const { AgentInput } = await import('@/components/sessions/agentInput');
        const { MultiTextInput } = await import('@/components/ui/forms/MultiTextInput');
        const navigation = { push: routeBoundary.push, replace: routeBoundary.replace, back: () => {} };
        const element = (routeOpen: boolean, homeFocused = !routeOpen) => <InjectedAuthProvider credentials={{ token: homeAToken }}>
            <DestinationInstanceContext.Provider value={{ tabId: 'home', ref: { kind: 'home', params: {} }, pathname: '/', focused: homeFocused, visible: !routeOpen, navigation }}>
                <HubComposerSection suggestions="tiles" />
            </DestinationInstanceContext.Provider>
            {routeOpen ? <NewSessionScreen presentation="screen" /> : null}
        </InjectedAuthProvider>;
        const screen = await renderScreen(element(false));
        modalBoundary.confirm.mockResolvedValue(true);
        try {
            await vi.waitFor(() => expect(screen.root.findAllByType(AgentInput)).toHaveLength(1));
            const homeComposer = screen.root.findByType(AgentInput);
            await screen.update(element(false, false));
            expect(screen.root.findByType(AgentInput)).toBe(homeComposer);
            await screen.update(element(true));
            await vi.waitFor(() => expect(screen.root.findAllByType(AgentInput)).toHaveLength(1));
            await vi.waitFor(() => expect(screen.root.findByType(MultiTextInput).props.onFilesPasted).toBeTypeOf('function'));
            const input = screen.root.findByType(MultiTextInput);
            // Clipboard delivery is the browser boundary; New Session intake,
            // draft persistence, tray projection and reference insertion stay real.
            await act(async () => {
                await input.props.onFilesPasted([new File([new Uint8Array([1])], 'diagram.png', { type: 'image/png' })]);
            });
            expect(screen.root.findByType(AgentInput).props.attachmentRowItems).toMatchObject([{ attachmentId: expect.any(String), status: 'pending' }]);
            expect(screen.root.findByType(MultiTextInput).props.references).toMatchObject([{ readableMarker: '[Image #1]', state: 'ready' }]);
            expect(getSessionDraftSnapshot(scope, address)?.conflict).toBeNull();
            await act(async () => { await screen.findByType(NewSessionDraftComposerActions).props.onDelete(); });
            expect(getSessionDraftSnapshot(scope, address)).toBeNull();
            expect(records.get(draftId)?.content).toBeNull();
            await screen.update(element(false));
            await vi.waitFor(() => expect(screen.root.findAllByType(AgentInput)).toHaveLength(1));
            expect(screen.root.findByType(AgentInput).props.value).toBe('');
            expect(screen.root.findByType(AgentInput).props.attachmentRowItems).toEqual([]);
            expect(getSessionDraftSnapshot(scope, address)).toBeNull();
        } finally { await screen.unmount(); }
    });

    it.each(['disabled', 'waived', 'defaultApproved', 'defaultRejected', 'retargeted', 'pointerChanged'] as const)('routes the composer delete through the %s Action policy', async policy => {
        const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol');
        const { SessionDraftMutateRequestV2Schema, SessionDraftMutateResponseV2Schema } = await import('@happier-dev/protocol/drafts/sessionDraftsV2');
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const features = createRootLayoutFeaturesResponse({ features: { sessions: { drafts: { enabled: true } } } });
        const coreHttp = await createDraftSurfaceCoreHttpBoundary();
        const draftId = '00000000-0000-4000-8000-000000000931';
        const address = { kind: 'newSession' as const, draftId };
        const replacementDraftId = '00000000-0000-4000-8000-000000000932';
        const heldDelete = createDeferred<void>();
        const holdDeletion = policy === 'retargeted' || policy === 'pointerChanged';
        const mutations: unknown[] = [];
        sessionHttpBoundary = async (url, init) => {
            const path = new URL(url).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json({ ...features,
                capabilities: { ...features.capabilities,
                    serverIdentity: { serverIdentityId: profiles.getActiveServerSnapshot().serverId } } });
            if (path === '/v2/account/session-drafts/list') return Response.json({ items: [] });
            if (path === '/v2/account/session-drafts/read') return Response.json({ status: 'absent' });
            if (path === '/v1/account/session-drafts/mutate' || path === '/v2/account/session-drafts/mutate') {
                const input = SessionDraftMutateRequestV2Schema.parse(JSON.parse(String(init?.body)));
                // A draft autosave and its later tombstone share this endpoint.
                // Preserve normal saves and hold only the deletion this case owns.
                if (input.content === null) {
                    mutations.push(input);
                    if (holdDeletion) await heldDelete.promise;
                }
                return Response.json(SessionDraftMutateResponseV2Schema.parse({ status: 'updated', record: {
                    address: input.address, revision: input.expectedRevision === 'absent' ? 1 : input.expectedRevision + 1,
                    createdAt: 1, updatedAt: 2, content: input.content,
                } }));
            }
            return coreHttp(path);
        };
        accountHttpSettings = { actionsSettingsV1: normalizeActionsSettingsV1(policy === 'disabled'
            ? { v: 1, actions: { 'session.draft.delete': { enabled: false } } }
            : policy === 'waived' || holdDeletion ? { v: 1, approvalWaivedSurfaces: { 'session.draft.delete': ['ui'] } }
                : { v: 1 }) };
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA(`composer-delete-${policy}`, { applyConnectionManager: true }));
        const { storage } = await import('@/sync/domains/state/storage');
        await storage.getState().activateSettingsScope({ serverId: homeAScopeId, accountId: 'account-a' });
        routeBoundary.params = { draftId, draftOrigin: 'ordinary' };
        const { NewSessionScreen } = await import('../NewSessionScreen');
        const { NewSessionDraftComposerActions } = await import('@/components/sessions/drafts/NewSessionDraftComposerActions');
        const { AgentInput } = await import('@/components/sessions/agentInput');
        const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const element = () => React.createElement(InjectedAuthProvider, { credentials: { token: homeAToken },
            children: React.createElement(NewSessionScreen, { presentation: 'embedded' }) });
        const screen = await renderScreen(element());
        modalBoundary.confirm.mockClear();
        modalBoundary.confirm.mockResolvedValue(policy === 'defaultApproved');
        try {
            await vi.waitFor(() => expect(screen.root.findAllByType(AgentInput)).toHaveLength(1));
            const scope = { serverId: homeAScopeId, accountId: 'account-a' };
            await act(async () => { writeNewSessionDraft({ scope, draftId, materializationIntent: 'userEdit', patch: { text: 'Keep exact composer scope' } }); });
            await vi.waitFor(() => expect(screen.findAllByType(NewSessionDraftComposerActions)).toHaveLength(1));
            if (holdDeletion) {
                let deletion!: Promise<void>;
                await act(async () => { deletion = screen.findByType(NewSessionDraftComposerActions).props.onDelete(); });
                await vi.waitFor(() => expect(mutations).toHaveLength(1));
                await act(async () => {
                    storage.getState().applySettingsLocal({ newSessionOrdinaryEntryDraftId: replacementDraftId });
                    if (policy === 'retargeted') {
                        writeNewSessionDraft({ scope, draftId: replacementDraftId, materializationIntent: 'userEdit', patch: { text: 'Replacement composer' } });
                        routeBoundary.params = { draftId: replacementDraftId, draftOrigin: 'ordinary' };
                    }
                });
                if (policy === 'retargeted') await screen.update(element());
                await act(async () => { heldDelete.resolve(); await deletion; });
                expect(storage.getState().settings.newSessionOrdinaryEntryDraftId).toBe(replacementDraftId);
                if (policy === 'retargeted') {
                    expect(routeBoundary.replace).not.toHaveBeenCalled();
                    expect(screen.root.findByType(AgentInput).props.value).toBe('Replacement composer');
                } else expect(routeBoundary.replace).toHaveBeenCalledTimes(1);
                expect(getSessionDraftSnapshot(scope, address)).toBeNull();
                return;
            }
            await act(async () => { await screen.findByType(NewSessionDraftComposerActions).props.onDelete(); });
            if (policy === 'disabled' || policy === 'waived') expect(modalBoundary.confirm).not.toHaveBeenCalled();
            else expect(modalBoundary.confirm).toHaveBeenCalledTimes(1);
            if (policy === 'disabled' || policy === 'defaultRejected') {
                expect(getSessionDraftSnapshot(scope, address)).not.toBeNull();
                expect(mutations).toEqual([]);
                expect(routeBoundary.replace).not.toHaveBeenCalled();
            } else {
                expect(getSessionDraftSnapshot(scope, address)).toBeNull();
                expect(mutations).toMatchObject([{ address, content: null }]);
                expect(routeBoundary.replace).toHaveBeenCalledTimes(1);
            }
        } finally { heldDelete.resolve(); await screen.unmount(); }
    });

    async function primeMachinePoolsFeature(serverIds: readonly string[], enabled: boolean) {
        const { buildServerFeaturesResponse } = await import('@/hooks/server/serverFeaturesTestUtils');
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const features = buildServerFeaturesResponse();
        const featuresWithPools = {
            ...features,
            features: {
                ...features.features,
                machines: { ...features.features.machines, pools: { enabled } },
            },
        };
        for (const serverId of serverIds) {
            primeServerFeaturesSnapshot({
                serverId,
                snapshot: { status: 'ready', features: featuresWithPools },
            });
        }
    }

    it('changes the authoring model when an existing surface reopens a different Bot draft', async () => {
        const coreHttp = await createDraftSurfaceCoreHttpBoundary();
        sessionHttpBoundary = url => {
            const path = new URL(url).pathname;
            return path === '/v1/machines' ? Response.json([]) : coreHttp(path);
        };
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA('reopen-bot-identity', { applyConnectionManager: true }));
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const firstId = '00000000-0000-4000-8000-000000000931';
        const botId = '00000000-0000-4000-8000-000000000932';
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const baseDraft = { selectedMachineId: null, selectedPath: null, selectedProfileId: null, selectedSecretId: null,
            agentType: 'codex' as const, permissionMode: 'default' as const, acpSessionModeId: null, updatedAt: 1 };
        writeNewSessionDraftToRepository({ scope, draftId: firstId, materializationIntent: 'seeded', draft: { ...baseDraft, input: 'An ordinary question' } });
        writeNewSessionDraftToRepository({ scope, draftId: botId, materializationIntent: 'seeded', draft: { ...baseDraft,
            input: 'Look after releases', sessionName: 'Release captain', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true } } });
        const { NewSessionScreen } = await import('../NewSessionScreen');
        const { AgentInput } = await import('@/components/sessions/agentInput');
        const { NewBotDraftHeader } = await import('@/components/sessions/bots/NewBotDraftHeader');
        routeBoundary.params = { draftId: firstId };
        const element = () => React.createElement(InjectedAuthProvider, { credentials: { token: homeAToken },
            children: React.createElement(NewSessionScreen, { presentation: 'screen' }) });
        const screen = await renderScreen(element());
        try {
            await vi.waitFor(() => expect(screen.root.findAllByType(AgentInput)).toHaveLength(1));
            expect(screen.root.findByType(AgentInput).props.value).toBe('An ordinary question');
            expect(screen.findAllByType(NewBotDraftHeader)).toHaveLength(0);
            routeBoundary.params = { draftId: botId };
            await screen.update(element());
            await vi.waitFor(() => expect(screen.root.findByType(AgentInput).props.value).toBe('Look after releases'));
            expect(screen.root.findAllByType(AgentInput)).toHaveLength(1);
            expect(screen.findByType(NewBotDraftHeader).props.botCreation.nameStore.getPrompt()).toBe('Release captain');
            await act(async () => { screen.root.findByType(AgentInput).props.onChangeText('Keep the release notes current'); });
            expect(readNewSessionDraftFromRepository({ scope, draftId: botId })?.input).toBe('Keep the release notes current');
            expect(readNewSessionDraftFromRepository({ scope, draftId: firstId })?.input).toBe('An ordinary question');
        } finally { await screen.unmount(); }
    });

    it('exposes a leaf-local Bot name editor that persists edits and reopens an automatic empty title', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = {};
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = crypto.randomUUID();
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: '', sessionName: 'First title', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
            selectedMachineId: null, selectedPath: null, selectedProfileId: null, selectedSecretId: null,
            agentType: 'codex', permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId });
        try {
            const editor = hook.getCurrent().botCreation;
            expect(editor?.nameStore.getPrompt()).toBe('First title');
            if (!editor) throw new Error('Expected Bot creation editor model');
            socketBoundary.emits.mockClear();
            await act(async () => { editor.onSessionNameChange('Second title'); });
            expect(editor.nameStore.getPrompt()).toBe('Second title');
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.sessionName).toBe('Second title');
            await act(async () => { editor.onSessionNameChange(''); });
            expect(editor.nameStore.getPrompt()).toBe('');
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.sessionName).toBe('');
            expect(socketBoundary.emits).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
        resetSessionDraftRepositoryForTests();
        const reopened = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId });
        try {
            expect(reopened.getCurrent().botCreation?.nameStore.getPrompt()).toBe('');
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
                sessionName: '', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
            });
        } finally { await reopened.unmount(); }
    });

    it('offers Instructions creation before the first Bot input and opens its selected document in the existing editor', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = {};
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = crypto.randomUUID();
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: '', sessionName: 'Caretaker', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
            selectedMachineId: null, selectedPath: null, selectedProfileId: null, selectedSecretId: null,
            agentType: 'codex', permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
        artifactHttpBoundary = (url, init) => {
            const requestUrl = new URL(url);
            return requestUrl.origin === new URL(homeA.serverUrl).origin
                ? artifacts.handle(`${requestUrl.pathname}${requestUrl.search}`, init) : null;
        };
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId });
        const model = hook.getCurrent();
        if (model.variant !== 'simple') throw new Error('Bot creation must use the ordinary composer');
        const screen = await renderScreen(<View>{model.botCreation?.instructions}</View>);
        try {
            expect(artifacts.list()).toHaveLength(0);
            expect(screen.findByTestId('new-session-instructions-attach')).not.toBeNull();
            const create = screen.findByTestId('new-session-instructions-create');
            expect(create).not.toBeNull();
            await act(async () => { await create!.props.onPress(); });
            expect(artifacts.list()).toHaveLength(1);
            const stored = readNewSessionDraftFromRepository({ scope, draftId });
            const entry = stored?.promptStack?.find(candidate => candidate.id === 'session.instructions');
            expect(entry).toMatchObject({ enabled: true, required: true, ref: { kind: 'doc', serverId: homeAScopeId } });
            const { promptCollectionItemHref } = await import('@/components/settings/prompts/collection/promptCollectionModel');
            expect(routeBoundary.push).toHaveBeenCalledWith(promptCollectionItemHref('doc', entry!.ref.artifactId, { serverId: homeAScopeId }));
            expect(stored?.input).toBe('');
            expect(stored?.instructionsDraft).toBeNull();
        } finally { await screen.unmount(); await hook.unmount(); }
    });

    it('keeps Instructions editing local and reopens the authored draft without creating an Artifact', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = {};
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = crypto.randomUUID();
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: '', sessionName: 'Caretaker', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
            selectedMachineId: null, selectedPath: null, selectedProfileId: null, selectedSecretId: null,
            agentType: 'codex', permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId });
        const draft = { title: 'Caretaker instructions', markdown: 'Preserve the remit.' };
        try {
            const editor = hook.getCurrent().instructionsCreation;
            expect(editor?.getDraft()).toBeNull();
            if (!editor) throw new Error('Expected lazy Instructions editor model');
            const artifactReads = () => socketBoundary.fetches.mock.calls.filter(([url]) => String(url).includes('/artifacts'));
            const beforeArtifacts = artifactReads().length;
            socketBoundary.emits.mockClear();
            await act(async () => { editor.onDraftChange(draft); });
            expect(editor.titleStore.getPrompt()).toBe(draft.title);
            expect(editor.markdownStore.getPrompt()).toBe(draft.markdown);
            expect(editor.getDraft()).toEqual(draft);
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ instructionsDraft: draft });
            expect(readNewSessionDraftFromRepository({ scope, draftId })).not.toHaveProperty('promptStack');
            expect(artifactReads()).toHaveLength(beforeArtifacts);
            expect(socketBoundary.emits).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
        resetSessionDraftRepositoryForTests();
        const reopened = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId });
        try { expect(reopened.getCurrent().instructionsCreation?.getDraft()).toEqual(draft); }
        finally { await reopened.unmount(); }
    });

    it.each(['approve', 'reject'] as const)('settles Instructions Create through its real approval Artifact (%s)', async decision => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = {};
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = crypto.randomUUID();
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: '', sessionName: 'Reviewed caretaker', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
            selectedMachineId: null, selectedPath: null, selectedProfileId: null, selectedSecretId: null,
            agentType: 'codex', permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
        artifactHttpBoundary = (url, init) => {
            const requestUrl = new URL(url);
            return requestUrl.origin === new URL(homeA.serverUrl).origin
                ? artifacts.handle(`${requestUrl.pathname}${requestUrl.search}`, init) : null;
        };
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId });
        const { storage } = await import('@/sync/domains/state/storage');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const originalSettings = storage.getState().settings;
        await act(async () => { storage.getState().applySettingsForScope(scope, settingsParse({
            ...storage.getState().settings,
            actionsSettingsV1: { v: 1, actions: { 'prompt_doc.create': { approvalRequiredSurfaces: ['ui'] } } },
        }), 2); });
        const model = hook.getCurrent();
        if (model.variant !== 'simple') throw new Error('Expected ordinary Bot composer');
        const screen = await renderScreen(<View>{model.botCreation?.instructions}</View>);
        const { decodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
        const rowsOfKind = (kind: string) => artifacts.list().filter(row => {
            const header = decodePlainArtifactStoredContent(row.header);
            return header && typeof header === 'object' && 'kind' in header && header.kind === kind;
        });
        let creating: Promise<unknown> | undefined;
        try {
            act(() => { creating = screen.findByTestId('new-session-instructions-create')!.props.onPress(); });
            await vi.waitFor(() => expect(rowsOfKind('approval_request.v1')).toHaveLength(1));
            expect(rowsOfKind('prompt_doc.v2')).toHaveLength(0);
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.instructionsDraft).toEqual({ title: 'Reviewed caretaker', markdown: '' });
            expect(routeBoundary.push).not.toHaveBeenCalled();
            const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
            expect(await decideApprovalAsInbox(homeAScopeId, rowsOfKind('approval_request.v1')[0]!.id, decision))
                .toMatchObject({ ok: true, result: { status: decision === 'approve' ? 'executed' : 'rejected' } });
            await act(async () => { await creating; });
            if (decision === 'approve') {
                await vi.waitFor(() => expect(readNewSessionDraftFromRepository({ scope, draftId })?.promptStack)
                    .toMatchObject([{ id: 'session.instructions', ref: { artifactId: rowsOfKind('prompt_doc.v2')[0]!.id, serverId: homeAScopeId } }]));
                expect(rowsOfKind('prompt_doc.v2')).toHaveLength(1);
                expect(readNewSessionDraftFromRepository({ scope, draftId })?.instructionsDraft).toBeNull();
                expect(routeBoundary.push).toHaveBeenCalledTimes(1);
                expect(screen.findByTestId('new-session-instructions.attached')).not.toBeNull();
            } else {
                expect(rowsOfKind('prompt_doc.v2')).toHaveLength(0);
                expect(readNewSessionDraftFromRepository({ scope, draftId })?.instructionsDraft).toEqual({ title: 'Reviewed caretaker', markdown: '' });
                expect(routeBoundary.push).not.toHaveBeenCalled();
                expect(screen.findByTestId('new-session-instructions.failed')).not.toBeNull();
                expect(screen.findByTestId('new-session-instructions-create')?.props.disabled).toBe(false);
            }
        } finally {
            await screen.unmount(); await hook.unmount(); await creating;
            storage.getState().applySettingsForScope(scope, originalSettings, 3);
        }
    });

    it.each(['attach', 'detach', 'neighbor-only', 'newer-authoring'] as const)('keeps newer Instructions %s and neighboring context when Create acknowledges late', async intent => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = {};
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = crypto.randomUUID();
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository, writeNewSessionInstructionsToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: '', sessionName: 'Caretaker', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
            selectedMachineId: null, selectedPath: null, selectedProfileId: null, selectedSecretId: null,
            agentType: 'codex', permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
        artifactHttpBoundary = (url, init) => {
            const requestUrl = new URL(url);
            return requestUrl.origin === new URL(homeA.serverUrl).origin
                ? artifacts.handle(`${requestUrl.pathname}${requestUrl.search}`, init) : null;
        };
        const acknowledgement = createDeferred<void>();
        artifacts.afterNextCreate(() => acknowledgement.promise);
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId });
        const model = hook.getCurrent();
        if (model.variant !== 'simple') throw new Error('Expected Bot composer');
        const screen = await renderScreen(<View>{model.botCreation?.instructions}</View>);
        let creating: Promise<unknown> | undefined;
        try {
            act(() => { creating = screen.findByTestId('new-session-instructions-create')!.props.onPress(); });
            await vi.waitFor(() => expect(artifacts.list()).toHaveLength(1));
            const sibling = { id: 'neighbor', ref: { kind: 'doc', serverId: homeAScopeId, artifactId: 'neighbor-doc' }, enabled: true, placement: 'system_append' } as const;
            const laterAuthoring = { title: 'Newer remit', markdown: 'Continue editing this draft' };
            await act(async () => {
                writeNewSessionInstructionsToRepository({ scope, draftId,
                    instructionsDraft: hook.getCurrent().instructionsCreation!.getDraft(), promptStack: [sibling] });
                if (intent === 'newer-authoring') hook.getCurrent().instructionsCreation!.onDraftChange(laterAuthoring);
                else if (intent !== 'neighbor-only') hook.getCurrent().instructionsCreation!.selectReference(intent === 'attach'
                    ? { kind: 'doc', serverId: homeAScopeId, artifactId: 'newer-selected-doc' } : null);
            });
            const currentStack = readNewSessionDraftFromRepository({ scope, draftId })!.promptStack;
            await act(async () => { acknowledgement.resolve(); await creating; });
            if (intent === 'neighbor-only' || intent === 'newer-authoring') {
                expect(readNewSessionDraftFromRepository({ scope, draftId })?.promptStack).toMatchObject([
                    ...currentStack!, { id: 'session.instructions', ref: { artifactId: artifacts.list()[0]!.id } },
                ]);
                if (intent === 'neighbor-only') expect(routeBoundary.push).toHaveBeenCalledTimes(1);
                else expect(routeBoundary.push).not.toHaveBeenCalled();
            } else {
                expect(readNewSessionDraftFromRepository({ scope, draftId })?.promptStack).toEqual(currentStack);
                expect(routeBoundary.push).not.toHaveBeenCalled();
            }
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.instructionsDraft).toEqual(intent === 'newer-authoring' ? laterAuthoring : null);
            expect(artifacts.list()).toHaveLength(1);
            expect(screen.findByTestId('new-session-instructions.failed')).toBeNull();
        } finally { acknowledgement.resolve(); await creating; await screen.unmount(); await hook.unmount(); }
    });

    it.each([false, true])('keeps a late Instructions Save in its captured draft and preserves newer authoring (replaceDraft=%s)', async replaceDraft => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = {};
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const firstId = crypto.randomUUID();
        const secondId = crypto.randomUUID();
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const blank = { input: '', selectedMachineId: null, selectedPath: null, selectedProfileId: null, selectedSecretId: null,
            agentType: 'codex', permissionMode: 'default', acpSessionModeId: null, updatedAt: 1 } as const;
        for (const draftId of [firstId, secondId]) writeNewSessionDraftToRepository({ scope, draftId,
            materializationIntent: 'seeded', draft: blank });
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => scope.accountId, encryptionMode: 'plain' });
        artifactHttpBoundary = (url, init) => {
            const requestUrl = new URL(url);
            return requestUrl.origin === new URL(homeA.serverUrl).origin
                ? artifacts.handle(`${requestUrl.pathname}${requestUrl.search}`, init) : null;
        };
        const acknowledgement = createDeferred<void>();
        artifacts.afterNextCreate(() => acknowledgement.promise);
        let hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId: firstId });
        socketBoundary.emits.mockClear();
        let save: ReturnType<NonNullable<ReturnType<typeof hook.getCurrent>['instructionsCreation']>['saveDraft']> | undefined;
        try {
            await act(async () => {
                const editor = hook.getCurrent().instructionsCreation;
                if (!editor) throw new Error('Expected Instructions editor');
                editor.onDraftChange({ title: 'First remit', markdown: 'First document' });
                save = editor.saveDraft();
                await vi.waitFor(() => expect(artifacts.list()).toHaveLength(1));
            });
            if (replaceDraft) {
                // New Session owns a stable draft id for its mounted lifetime;
                // replacing the route opens a new model, not new props on it.
                await hook.unmount();
                hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId: secondId });
            }
            const secondDraft = { title: 'Second remit', markdown: 'Keep this unsaved draft' };
            await act(async () => { hook.getCurrent().instructionsCreation?.onDraftChange(secondDraft); });
            await act(async () => { acknowledgement.resolve(); await save; });
            expect(hook.getCurrent().instructionsCreation?.getDraft()).toEqual(secondDraft);
            const activeDraftId = replaceDraft ? secondId : firstId;
            expect(readNewSessionDraftFromRepository({ scope, draftId: activeDraftId })).toMatchObject({ instructionsDraft: secondDraft });
            if (replaceDraft) expect(readNewSessionDraftFromRepository({ scope, draftId: secondId })).not.toHaveProperty('promptStack');
            expect(readNewSessionDraftFromRepository({ scope, draftId: firstId })).toMatchObject({ instructionsDraft: replaceDraft ? null : secondDraft,
                promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', serverId: homeAScopeId, artifactId: artifacts.list()[0]!.id } }] });
            expect(socketBoundary.emits).not.toHaveBeenCalled();
        } finally { acknowledgement.resolve(); await save; await hook.unmount(); }
    });

    it('refuses a captured Instructions Save after another Account signs into the same Home', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = {};
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = crypto.randomUUID();
        const authored = { title: 'Private A remit', markdown: 'Only Account A may create this document.' };
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-b', encryptionMode: 'plain' });
        artifactHttpBoundary = (url, init) => {
            const requestUrl = new URL(url);
            return requestUrl.origin === new URL(homeA.serverUrl).origin
                ? artifacts.handle(`${requestUrl.pathname}${requestUrl.search}`, init) : null;
        };
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId });
        try {
            await act(async () => { hook.getCurrent().instructionsCreation?.onDraftChange(authored); });
            const capturedSave = hook.getCurrent().instructionsCreation?.saveDraft;
            if (!capturedSave) throw new Error('Expected captured Instructions Save');
            const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            const lifetimeA = captureActiveServerAccountScopeLifetime();
            if (!lifetimeA) throw new Error('Expected Account A lifetime');
            let result: Awaited<ReturnType<typeof capturedSave>> = null;
            await act(async () => {
                const token = tokenFor('account-b');
                expect(await TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: homeAScopeId }, { token })).toBe(true);
                await sync!.switchServer({ token });
                (await import('@/sync/runtime/orchestration/appliedActiveServerRuntime')).publishAppliedActiveServerSnapshot(profiles.getActiveServerSnapshot());
                expect(lifetimeA.isCurrent()).toBe(false);
                expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId: homeAScopeId, accountId: 'account-b' });
                // Connection restoration precedes React's next committed leaf.
                // An event on that captured editor must not borrow B's Account.
                result = await capturedSave();
            });
            expect(result, JSON.stringify(result)).toMatchObject({ createdRef: null,
                result: { ok: false, errorCode: 'action_account_scope_changed' } });
            expect(artifacts.list()).toHaveLength(0);
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ instructionsDraft: authored });
        } finally { await hook.unmount(); }
    });

    it('refuses captured Bot Instructions Send after the Account changes during ordinary launch custody', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = { machineId: 'machine-b', directory: '/workspace/project', spawnServerId: homeAScopeId };
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = crypto.randomUUID();
        const { writeNewSessionDraftToRepository, readNewSessionDraftFromRepository } =
            await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: '', sessionName: 'Private A helper', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
            promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', serverId: homeAScopeId, artifactId: 'account-a-remit' },
                enabled: true, required: true, placement: 'system_append' }], instructionsDraft: null,
            selectedMachineId: 'machine-b', selectedPath: '/workspace/project', targetServerId: homeAScopeId,
            selectedProfileId: null, selectedSecretId: null, agentType: 'codex', backendTarget: { kind: 'backend', backendId: 'codex' },
            permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, targetServerId: homeAScopeId, draftId });
        const releaseCustody = createDeferred<void>();
        let custodyReached = false;
        pendingSpawnCustodyLock = { wait: releaseCustody.promise, requested: () => { custodyReached = true; } };
        let send: Promise<void> | undefined;
        try {
            socketBoundary.emits.mockClear();
            await act(async () => { send = Promise.resolve(readProductionCreateAction(hook.getCurrent())({ initialMessage: 'skip' })); });
            await vi.waitFor(() => expect(custodyReached, JSON.stringify(modalBoundary.alert.mock.calls)).toBe(true));
            expect(socketBoundary.emits.mock.calls.filter(([request]) => request.payload?.method?.endsWith(`:${RPC_METHODS.SESSION_SPAWN_NEW}`))).toEqual([]);
            await act(async () => {
                const token = tokenFor('account-b');
                expect(await TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: homeAScopeId }, { token })).toBe(true);
                await sync!.switchServer({ token });
                (await import('@/sync/runtime/orchestration/appliedActiveServerRuntime')).publishAppliedActiveServerSnapshot(profiles.getActiveServerSnapshot());
            });
            await act(async () => { releaseCustody.resolve(); await send; });
            const spawns = socketBoundary.emits.mock.calls.filter(([request]) => request.payload?.method?.endsWith(`:${RPC_METHODS.SESSION_SPAWN_NEW}`));
            expect(spawns, JSON.stringify(spawns.map(([request]) => ({ token: request.token, method: request.payload?.method })))).toEqual([]);
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
                sessionName: 'Private A helper', promptStack: [{ ref: { artifactId: 'account-a-remit' } }],
            });
        } finally {
            releaseCustody.resolve(); await send; pendingSpawnCustodyLock = null; await hook.unmount();
        }
    });

    it.each(['signed_out', 'other_home_focused'] as const)('admits the routed source Account rather than ambient focus when %s', async (sourceState) => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await selectHomeView({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = crypto.randomUUID();
        const { writeNewSessionDraftToRepository, readNewSessionDraftFromRepository } =
            await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: '', sessionName: 'Routed source helper', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
            ...(sourceState === 'signed_out' ? { promptStack: [{ id: 'session.instructions',
                ref: { kind: 'doc', serverId: homeAScopeId, artifactId: 'source-a-remit' },
                enabled: true, required: true, placement: 'system_append' }] as const } : {}), instructionsDraft: null,
            selectedMachineId: 'machine-b', selectedPath: '/workspace/project', targetServerId: homeBScopeId,
            executionTarget: { kind: 'machine', target: { serverId: homeBScopeId, machineId: 'machine-b' } },
            selectedProfileId: null, selectedSecretId: null, agentType: 'codex', backendTarget: { kind: 'backend', backendId: 'codex' },
            permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        routeBoundary.params = { draftServerId: homeAScopeId, draftAccountId: scope.accountId,
            machineId: 'machine-b', directory: '/workspace/project', spawnServerId: homeBScopeId };
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        if (sourceState === 'other_home_focused') {
            await act(async () => {
                await profiles.setActiveServerId(homeBScopeId, { scope: 'device' });
                await profiles.setActiveServerId(homeBScopeId, { scope: 'tab' });
                await sync!.switchServer({ token: homeBToken });
                publishAppliedActiveServerSnapshot(profiles.getActiveServerSnapshot());
            });
        }
        const hook = await renderProductionCreateCaller({
            activeServerId: sourceState === 'other_home_focused' ? homeBScopeId : homeAScopeId,
            accountId: sourceState === 'other_home_focused' ? 'account-b' : scope.accountId,
            targetServerId: homeBScopeId, draftId,
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().botCreation?.nameStore.getPrompt()).toBe('Routed source helper'));
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                expect(model.variant === 'simple' ? model.simpleProps.targetServerId : model.wizardProps.machine.serverId).toBe(homeBScopeId);
                expect(model.variant === 'simple' ? model.simpleProps.selectedMachineId : model.wizardProps.machine.selectedMachine?.id).toBe('machine-b');
            });
            const capturedSend = readProductionCreateAction(hook.getCurrent());
            socketBoundary.result = { type: 'pending', outcome: 'unknown', retryWithSameCreationKey: true };
            socketBoundary.emits.mockClear();
            await act(async () => {
                if (sourceState === 'signed_out') {
                    expect(await TokenStorage.removeCredentialsForServerUrl(homeA.serverUrl, { serverId: homeAScopeId })).toBe(true);
                    sync!.disconnectServer();
                    expect((await import('@/sync/domains/scope/activeServerAccountScope')).captureActiveServerAccountScopeLifetime()).toBeNull();
                }
                // The mounted source handler was captured before this React commit.
                await capturedSend({ initialMessage: 'skip' });
            });
            const spawns = socketBoundary.emits.mock.calls.filter(([request]) => request.payload?.method?.endsWith(`:${RPC_METHODS.SESSION_SPAWN_NEW}`));
            if (sourceState === 'signed_out') {
                expect(spawns).toEqual([]);
                expect(modalBoundary.alert.mock.calls).toContainEqual(['common.error', 'action_home_signed_out']);
            } else {
                expect(spawns).toHaveLength(1);
                expect(spawns[0]?.[0]).toMatchObject({ serverUrl: homeB.serverUrl, token: homeBToken,
                    payload: { params: { title: 'Routed source helper', executionTarget: { serverId: homeBScopeId, machineId: 'machine-b' } } } });
            }
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({ sessionName: 'Routed source helper',
                ...(sourceState === 'signed_out' ? { promptStack: [{ ref: { artifactId: 'source-a-remit' } }] } : {}) });
        } finally { await hook.unmount(); }
    });

    it('does not resurrect an authored temporary handoff after explicitly selecting Instructions', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        const { storeTempData } = await import('@/utils/sessions/tempDataStore');
        routeBoundary.params = { dataId: storeTempData({ instructionsDraft: { title: 'Old draft', markdown: 'Old unsaved body' } }) };
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = crypto.randomUUID();
        const { writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        writeNewSessionDraftToRepository({ scope, draftId, materializationIntent: 'seeded', draft: {
            input: '', instructionsDraft: null, promptStack: [{ id: 'session.instructions',
                ref: { kind: 'doc', serverId: homeAScopeId, artifactId: 'saved-instructions' },
                enabled: true, required: true, placement: 'system_append' }],
            selectedMachineId: null, selectedPath: null, selectedProfileId: null, selectedSecretId: null,
            agentType: 'codex', permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
        } });
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId });
        try {
            expect(hook.getCurrent().instructionsCreation?.getDraft()).toBeNull();
            expect(hook.getCurrent().instructionsCreation?.markdownStore.getPrompt()).toBe('');
        } finally { await hook.unmount(); }
    });

    async function runTemporaryTeamModelJourney(journey: 'acquisition' | 'switch-agent' | 'remembered-control' | 'launch' | 'reopen' | 'resume' | 'refresh-selection' | 'run-refresh-selection') {
        const sourceCase = journey !== 'acquisition';
        const launchCase = journey === 'launch' || journey === 'reopen';
        const retainedTeamSelection = journey === 'reopen' || !sourceCase;
        const resourceRevision = journey === 'resume' ? 0 : 7;
        if (launchCase || journey === 'resume') socketBoundary.nativeSignInStatus = 'signedOut';
        // The first genuine Home baseline owns this preference. Re-publishing
        // changed bytes at the same Settings revision would correctly be ignored.
        accountHttpSettings = { useEnhancedSessionWizard: true };
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA(
            launchCase ? 'team-launch-signed-out' : 'temporary-account-capture', { applyConnectionManager: true }));
        // Account replacement during first-use acquisition is independent of
        // cross-Home selection. Keep this journey on its initiating Home; the
        // borrowed-Home material preparation contract is covered separately.
        homeB = homeA;
        homeBScopeId = homeAScopeId;
        homeBToken = homeAToken;
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { buildServerFeaturesResponse } = await import('@/hooks/server/serverFeaturesTestUtils');
        await vi.waitFor(() => expect(storage.getState().settings.useEnhancedSessionWizard).toBe(true));
        const { tryWriteServerEnabledBitInPlace, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } = await import('@happier-dev/protocol');
        const { bindHomeDomainActionHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainActionFamily');
        const { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema }
            = await import('@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1');
        const { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema, splitProviderSettingsV1 }
            = await import('@happier-dev/protocol/providers/connections/connectionRowsV1');
        const { DEFAULT_PROVIDER_SETTINGS_V1 } = await import('@happier-dev/protocol/providers/settings/v1');
        const { projectProviderModelSourceStateV1 } = await import('@happier-dev/protocol/providers/binding-compatibility');
        const { TeamsPageV1Schema, TeamCredentialResourceEntitledPageV1Schema, TeamCredentialResourceDiscoveryPageV1Schema,
            TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1,
            NO_TEAM_CAPABILITIES_V1, resolveTeamAdmissionProjectionV1 } = await import('@happier-dev/protocol/teams');
        const { RunnerArtifactAvailabilityProjectionV1Schema } = await import('@happier-dev/protocol/ephemeralRunner/runnerArtifact');
        const { EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1, EPHEMERAL_RUNNER_ACTIVATIONS_PATH_V1 } = await import('@happier-dev/protocol/ephemeralRunner/routes');
        const { writeNewSessionDraft, writeSessionDraftLocalSupplement } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const scope = { serverId: homeBScopeId, accountId: 'account-a' };
        const draftId = crypto.randomUUID();
        routeBoundary.params = { spawnServerId: homeBScopeId, draftServerId: homeBScopeId, draftAccountId: scope.accountId,
            backendTargetKey: 'agent:happier.agent.codex/codex' };
        writeNewSessionDraft({ scope, draftId, materializationIntent: 'userEdit', patch: {
            ...(launchCase ? { selectedPath: '/workspace/project' } : {}),
            text: 'Prepare on the original target Account', authoring: { agentTarget: { kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, profileId: null,
                ...(retainedTeamSelection ? { modelSelection: { v: 1, updatedAt: 1, ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5',
                } } } : {}),
                executionTarget: sourceCase
                    ? { kind: 'machine', target: { serverId: homeBScopeId, machineId: 'machine-b' } }
                    : { kind: 'temporary_computer', serverId: homeBScopeId,
                        artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' } } },
        } });
        if (retainedTeamSelection) writeSessionDraftLocalSupplement({ scope, address: { kind: 'newSession', draftId },
            patch: { newSessionLocalState: { teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' },
                teamId: 'runner-team', resourceId: 'runner-resource', expectedResourceRevision: 7, deliveryMode: 'brokered' }] } } });
        const features = buildServerFeaturesResponse();
        for (const id of ['sessions.ephemeralRunner', 'teams', 'teams.credentialResources'] as const) {
            expect(tryWriteServerEnabledBitInPlace(features, id, true)).toBe(true);
        }
        if (sourceCase) expect(tryWriteServerEnabledBitInPlace(features, 'providers', true)).toBe(true);
        const teams = TeamsPageV1Schema.parse({ items: [{ id: 'runner-team', name: 'Runner team', description: null,
            logo: null, archivedAt: null, recovery: null, viewerRole: 'member', counts: null,
            capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true }, admission: resolveTeamAdmissionProjectionV1(),
            policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
                defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null } }], nextCursor: null });
        const entitled = TeamCredentialResourceEntitledPageV1Schema.parse({ resources: [{ id: 'runner-resource', teamId: 'runner-team',
            displayName: 'Runner model', resourceRevision, readiness: { kind: 'available' }, recoveryAction: null,
            mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
            providerModels: [{ selection: { kind: 'team_credential_provider_model', resourceId: 'runner-resource', teamId: 'runner-team',
                expectedResourceRevision: resourceRevision, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5', deliveryMode: 'brokered' },
                descriptor: { id: 'gpt-5', name: 'GPT-5', ...(sourceCase ? { modelOptions: [{ id: 'reasoning_effort', name: 'Thinking',
                    type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] } : {}) },
                application: { agentTargetKey: 'agent:happier.agent.codex/codex',
                    implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai_responses' },
                compatibility: projectProviderModelSourceStateV1({ endpoint: { id: 'responses', protocol: 'openai-responses',
                    capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } } },
                    { id: 'gpt-5', name: 'GPT-5' }),
                sourceRevision: 'runner-source-7', availability: 'available' }], sourcePresentation: { kind: 'provider',
                provider: { identity: { pluginId: 'happier.provider.openai', localId: 'openai' }, definitionRevision: 1 } } }] });
        if (sourceCase) {
            const { createProviderModelProjectionFixture } = await import('@/dev/testkit/harness/providerSettingsHarness');
            socketBoundary.providerProjection = createProviderModelProjectionFixture({
                agentTargetKey: 'agent:happier.agent.codex/codex', groups: [],
            });
        }
        // D23: a Team choice never needs either member's experimental consent.
        const providerCatalog = splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog;
        const publication = RunnerArtifactAvailabilityProjectionV1Schema.parse({ status: 'available', artifacts: [{
            identity: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) }, channel: 'stable',
            url: 'https://runner-publication.test/happier-runner-v0.3.0-linux-x64.zip',
            checksumsUrl: 'https://runner-publication.test/checksums.txt', checksumsSignatureUrl: 'https://runner-publication.test/checksums.txt.minisig',
            sizeBytes: 1, entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 1, mode: 0o755 }] }] });
        const teamPath = bindHomeDomainActionHttpRequestV1('teams.list', {
            v: 1, scope: 'member', archived: 'active', limit: TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1,
        }).path;
        const resourcesPath = bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId: 'runner-team' }).path;
        const initiatingAccountReads: string[] = [];
        const activationEffects: string[] = [];
        const observedHomePaths = new Set<string>();
        let catalogRefreshGate: Promise<void> | null = null;
        let catalogReads = 0;
        let releaseSelectionGates: (() => void) | null = null;
        sessionHttpBoundary = (url, init) => {
            const parsed = new URL(url);
            observedHomePaths.add(`${parsed.pathname}${parsed.search}`);
            if (parsed.pathname === '/v1/features' || parsed.pathname === '/v1/features/authenticated') return Response.json({ ...features,
                capabilities: { ...features.capabilities, serverIdentity: { serverIdentityId: homeBScopeId }, accountStoredContentCompatibility: { v: 1,
                    minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    declarationTransport: 'http-header-and-socket-auth-v1' } } });
            if (`${parsed.pathname}${parsed.search}` === teamPath) return Response.json(teams);
            if ([resourcesPath, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1].includes(`${parsed.pathname}${parsed.search}`)) {
                catalogReads++;
                const catalogResponse = () => Response.json(parsed.pathname === TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1
                    ? TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: entitled.resources, nextCursor: null, failures: [] })
                    : entitled);
                return catalogRefreshGate
                    ? catalogRefreshGate.then(catalogResponse) : catalogResponse();
            }
            if (parsed.pathname === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 && (!init?.method || init.method === 'GET')) {
                return Response.json(ProviderConnectionsRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
                    content: { t: 'plain', v: providerCatalog } }));
            }
            if (parsed.pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) {
                return Response.json(ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
                    content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } }));
            }
            if (parsed.pathname === '/v2/account/settings' && (!init?.method || init.method === 'GET')) {
                // Background Settings refresh uses this same Home boundary;
                // it must retain the wizard preference selected for this flow.
                return Response.json({ content: { t: 'plain', v: { useEnhancedSessionWizard: true } }, version: 1 });
            }
            if (parsed.pathname === EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1) return Response.json(publication);
            if (parsed.pathname === EPHEMERAL_RUNNER_ACTIVATIONS_PATH_V1) {
                if (init?.method === 'POST') activationEffects.push(url);
                return Response.json({ error: 'not_found' }, { status: 404 });
            }
            if (parsed.pathname === '/v1/account/encryption' && parsed.origin === new URL(homeB.serverUrl).origin) {
                initiatingAccountReads.push(new Headers(init?.headers).get('authorization') ?? '');
            }
            return null;
        };
        // The Home's earlier public descriptor is persisted as well as cached.
        // Read this case's new HTTP response through the canonical refresh owner.
        const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        expect(await getServerFeaturesSnapshot({ serverId: homeBScopeId, force: true })).toMatchObject({
            status: 'ready', features: { features: { teams: { enabled: true } } },
        });
        const checksums = createDeferred<Response>();
        let checksumRequested = false;
        const publicationFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
            const url = String(input);
            if (url === publication.artifacts[0]!.checksumsUrl) { checksumRequested = true; return checksums.promise; }
            // Both authenticated-publication reads must remain pending until
            // credential replacement. A failed signature response would settle
            // Promise.all before this test exercised the acquisition lifetime.
            if (url === publication.artifacts[0]!.checksumsSignatureUrl) return checksums.promise;
            return new Response('Unavailable publication', { status: 503 });
        });
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, targetServerId: homeBScopeId,
            draftId, mountTemporaryController: !sourceCase });
        let hookMounted = true;
        let sending: Promise<void> | undefined;
        try {
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                expect(model.variant).toBe('wizard');
                if (model.variant === 'wizard') expect(model.wizardProps.agent.teamCredentialResources, JSON.stringify({
                    observedHomePaths: [...observedHomePaths], teamPath, resourcesPath,
                })).toHaveLength(1);
            });
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                if (model.variant !== 'wizard') throw new Error('Expected the production Agent selector');
                expect(model.wizardProps.agent.agentPickerSelectedOptionId).toBe(entitled.resources[0]!.providerModels[0]!.selection.agentTargetKey);
            });
            if (journey === 'resume') {
                for (const reason of ['manual', 'server-reachable', 'server-reachable'] as const) {
                    await act(async () => { await sync.resumeSync(reason); });
                    await vi.waitFor(() => {
                        const model = hook.getCurrent();
                        if (model.variant !== 'wizard') throw new Error('Expected the production model selector');
                        expect(model.wizardProps.agent.currentTeamCredentialResourceKeys?.has('runner-team:runner-resource')).toBe(true);
                    });
                }
            }
            // First-use acquisition has no worker to confirm a new Team
            // choice. Reopen its retained choice through the ordinary draft
            // reader; worker-backed source selection is covered below.
            if (journey === 'refresh-selection' || journey === 'run-refresh-selection') {
                const catalog = createDeferred<void>();
                releaseSelectionGates = () => { catalogRefreshGate = null; catalog.resolve(); };
                const model = hook.getCurrent();
                if (model.variant !== 'wizard') throw new Error('Expected the production model selector');
                expect(model.wizardProps.agent.currentTeamCredentialResourceKeys?.has('runner-team:runner-resource')).toBe(true);
                const { useExecutionRunTeamCredentialModel } = await import('@/components/sessions/runs/launcher/useExecutionRunTeamCredentialModel');
                const run = journey === 'run-refresh-selection' ? await renderHook(() => {
                    const [actionInput, setActionInput] = React.useState<Record<string, unknown>>({});
                    return useExecutionRunTeamCredentialModel({ sessionId: null, serverId: homeBScopeId, machineId: 'machine-b',
                        hasBackendChoices: true, selectedBackendChoice: {
                            backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                            targetKey: 'agent:happier.agent.codex/codex', backendId: 'codex', agentId: 'codex', title: 'Codex', disabled: false,
                        }, actionInput, setActionInput });
                }) : null;
                try {
                    if (run) await vi.waitFor(() => expect(run.getCurrent().pickerProps.currentTeamCredentialResourceKeys?.has('runner-team:runner-resource')).toBe(true));
                    let selecting!: Promise<void>;
                    await act(async () => {
                        selecting = Promise.resolve((run?.getCurrent().pickerProps.onSelectTeamCredentialModel
                            ?? model.wizardProps.agent.onSelectTeamCredentialModel)(entitled.resources[0]!.providerModels[0]!.selection));
                    });
                    await act(async () => { await selecting; });
                    catalogRefreshGate = catalog.promise;
                    if (run) {
                        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
                        await act(async () => { publishHomeAccountChange(homeBScopeId); });
                    } else {
                        const detail = model.wizardProps.agent.agentPickerOptions
                            .find(option => option.id === 'agent:happier.agent.codex/codex')
                            ?.renderDetailContent?.({ onRequestClose: () => {} });
                        type EngineDetailProps = React.ComponentProps<typeof import('@/components/sessions/new/components/NewSessionEngineOptionDetail').NewSessionEngineOptionDetail>;
                        if (!React.isValidElement<EngineDetailProps>(detail)) throw new Error('Expected production engine detail');
                        const readsBeforeRefresh = catalogReads;
                        entitled.resources[0]!.displayName = 'Refreshed Runner model';
                        await act(async () => { detail.props.refreshProbe?.onRefresh?.(); });
                        await vi.waitFor(() => expect(catalogReads).toBeGreaterThan(readsBeforeRefresh));
                    }
                    const refreshing = hook.getCurrent();
                    if (refreshing.variant !== 'wizard') throw new Error('Expected the production model selector');
                    expect(refreshing.wizardProps.agent.currentTeamCredentialResourceKeys?.has('runner-team:runner-resource')).toBe(true);
                    const selected = hook.getCurrent();
                    if (selected.variant !== 'wizard') throw new Error('Expected the production model selector');
                    expect(run ? run.getCurrent().selected : selected.wizardProps.agent.selectedTeamCredentialModel)
                        .toEqual(entitled.resources[0]!.providerModels[0]!.selection);
                    if (run) expect(run.getCurrent().available).toBe(false); // Selection is retained; launch still needs a current catalog.
                    catalogRefreshGate = null;
                    await act(async () => { catalog.resolve(); });
                    await vi.waitFor(() => {
                        if (run) expect(run.getCurrent().available).toBe(true);
                        const refreshed = hook.getCurrent();
                        if (refreshed.variant !== 'wizard') throw new Error('Expected the production model selector');
                        expect(refreshed.wizardProps.agent.currentTeamCredentialResourceKeys?.has('runner-team:runner-resource')).toBe(true);
                        if (!run) expect(refreshed.wizardProps.agent.teamCredentialResources?.[0]?.displayName).toBe('Refreshed Runner model');
                    });
                } finally { await run?.unmount(); }
                if (!run) {
                    await hook.unmount();
                    hookMounted = false;
                    const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
                    expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
                        modelSelection: { ref: { modelId: 'gpt-5' } },
                        teamCredentialBindings: [{ teamId: 'runner-team', resourceId: 'runner-resource', expectedResourceRevision: 7 }],
                    });
                }
                return;
            }
            if (!retainedTeamSelection) await act(async () => {
                const model = hook.getCurrent();
                if (model.variant !== 'wizard') throw new Error('Expected the production model selector');
                await model.wizardProps.agent.onSelectTeamCredentialModel(entitled.resources[0]!.providerModels[0]!.selection);
            });
            // Finish public selection and its background projections before
            // observing the distinct Send → preparation HTTP phase.
            await hook.rerender();
            if (sourceCase) {
                const selected = hook.getCurrent();
                if (selected.variant !== 'wizard') throw new Error('Expected the production Agent selector');
                expect(selected.wizardProps.agent.selectedTeamCredentialModel).toEqual(entitled.resources[0]!.providerModels[0]!.selection);
                if (journey === 'resume') return;
                if (launchCase) {
                    const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
                    const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
                    await vi.waitFor(() => {
                        const model = hook.getCurrent();
                        if (model.variant !== 'wizard') throw new Error('Expected the production composer');
                        const nativeAgent = machineAgentInventoryStore.read(serverAccountScopedResourceKey(scope, 'machine-agents', 'machine-b'))
                            .agents.find(agent => agent.agentId === 'codex');
                        expect(nativeAgent?.signIn.native?.status).toBe('signedOut');
                        expect(model.wizardProps.footer.canCreate, JSON.stringify(model.wizardProps.footer.connectionStatus)).toBe(true);
                    });
                    socketBoundary.result = { type: 'pending', outcome: 'unknown', retryWithSameCreationKey: true };
                    socketBoundary.emits.mockClear();
                    await act(async () => { await readProductionCreateAction(hook.getCurrent())({ initialMessage: 'skip' }); });
                    expect(sessionSpawnCalls()).toHaveLength(1);
                    expect(sessionSpawnCalls()[0]?.[0]).toMatchObject({ payload: { params: {
                        teamCredentialBindings: [{ resourceId: 'runner-resource', deliveryMode: 'brokered',
                            teamId: 'runner-team', expectedResourceRevision: 7, slot: { kind: 'provider_model' } }],
                    } } });
                    return;
                }
                if (journey === 'remembered-control') {
                    const detail = selected.wizardProps.agent.agentPickerOptions
                        .find(option => option.id === 'agent:happier.agent.codex/codex')?.renderDetailContent;
                    if (!detail) throw new Error('Expected the production engine detail renderer');
                    const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials: { token: homeAToken },
                        children: detail({ onRequestClose: () => {} }) }));
                    try {
                        const low = screen.root.findAllByProps({ testID: 'model-picker-overlay-selected-option-control-option:reasoning_effort:low' })
                            .find(node => typeof node.props.onPress === 'function');
                        if (!low) throw new Error('Expected the real selected Team reasoning control');
                        await act(async () => { low.props.onPress(); });
                        const updated = hook.getCurrent();
                        if (updated.variant !== 'wizard') throw new Error('Expected the production Agent selector');
                        expect(updated.wizardProps.agent.acpConfigOptionOverrides?.overrides.reasoning_effort?.value).toBe('low');
                        expect(updated.wizardProps.agent.selectedTeamCredentialModel).toEqual(entitled.resources[0]!.providerModels[0]!.selection);
                    } finally { await screen.unmount(); }
                    // Unmount flushes the real remembered-selection debounce while
                    // the initiating Account remains current; no fake timer or owner stub.
                    await hook.unmount();
                    hookMounted = false;
                    expect(Object.values(storage.getState().authoringMemory.currentRememberedEngineSelectionsByScopeV1 ?? {})
                        .some(selection => selection.modelSelection?.ref.modelId === 'gpt-5')).toBe(false);
                    return;
                }
                await act(async () => { selected.wizardProps.agent.setAgentType('claude'); });
                await vi.waitFor(() => {
                    const changed = hook.getCurrent();
                    if (changed.variant !== 'wizard') throw new Error('Expected the production Agent selector');
                    expect(changed.wizardProps.agent.agentType).toBe('claude');
                    expect(changed.wizardProps.agent.selectedTeamCredentialModel).toBeNull();
                });
                const changed = hook.getCurrent();
                if (changed.variant !== 'wizard') throw new Error('Expected the production Agent selector');
                await act(async () => { changed.wizardProps.agent.setAgentType('codex'); });
                await vi.waitFor(() => {
                    const returned = hook.getCurrent();
                    if (returned.variant !== 'wizard') throw new Error('Expected the production Agent selector');
                    expect(returned.wizardProps.agent.agentType).toBe('codex');
                    expect(returned.wizardProps.agent.selectedTeamCredentialModel).toBeNull();
                    expect(returned.wizardProps.agent.modelSelection?.ref.modelId).not.toBe('gpt-5');
                });
                return;
            }
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                const composer = model.variant === 'wizard' ? model.wizardProps.footer : model.simpleProps;
                expect(composer.canCreate, JSON.stringify({ connectionStatus: composer.connectionStatus,
                    statusBadges: composer.statusBadges })).toBe(true);
            });
            initiatingAccountReads.length = 0;
            await act(async () => { sending = Promise.resolve(readProductionCreateAction(hook.getCurrent())({ initialMessage: 'send',
                afterCreated: async () => undefined, temporaryComputerSubmission: {
                    composer: { revision: 1, ref: { kind: 'newSession', instanceId: draftId }, text: 'Prepare on the original target Account',
                        references: [], attachments: [], layout: 'wrap', capabilities: { text: true, references: true, attachments: true, submit: true },
                        state: { focused: false, editable: true, submittable: true, submitting: false, running: false } },
                    reviewComments: null, attachmentDrafts: [], attachmentDestination: { uploadLocation: 'workspace',
                        workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false }, maxFileBytes: 1_000_000,
                } })); });
            await vi.waitFor(() => expect(checksumRequested, JSON.stringify(modalBoundary.alert.mock.calls)).toBe(true));
            const capturedBeforeAcquisition = [...initiatingAccountReads];
            await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeBScopeId }, { token: `${homeBToken}-replacement` });
            checksums.resolve(new Response('Unavailable publication', { status: 503 }));
            await sending;
            expect(capturedBeforeAcquisition).toContain(`Bearer ${homeBToken}`);
            expect(activationEffects).toEqual([]);
        } catch (error) {
            const { getCachedServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
            const { readServerEnabledBit } = await import('@happier-dev/protocol/features/serverEnabledBit');
            const observed = getCachedServerFeaturesSnapshot({ serverId: homeBScopeId });
            const controller = hook.getCurrent().temporaryComputerLaunch?.controlRef.current;
            console.error('Temporary first-use fixture admission', {
                targetHome: homeBScopeId,
                launchStatus: controller?.status,
                launchError: controller?.error instanceof Error
                    ? { name: controller.error.name, message: controller.error.message }
                    : controller?.error,
                alertStacks: modalBoundary.alertStacks,
                featureSnapshot: observed?.status === 'ready' ? {
                    status: observed.status,
                    teams: readServerEnabledBit(observed.features, 'teams'),
                    credentialResources: readServerEnabledBit(observed.features, 'teams.credentialResources'),
                    runner: readServerEnabledBit(observed.features, 'sessions.ephemeralRunner'),
                } : observed,
                requests: socketBoundary.fetches.mock.calls.map(([url, method]) => ({ url, method }))
                    .filter(request => /\/features|\/teams|\/entity-rows|\/encryption|\/ephemeral-runners/.test(request.url)),
            });
            throw error;
        } finally {
            releaseSelectionGates?.();
            checksums.resolve(new Response('Unavailable publication', { status: 503 }));
            await sending?.catch(() => undefined);
            if (hookMounted) await hook.unmount();
            publicationFetch.mockRestore();
        }
    }

    it('captures the initiating target Account before temporary artifact acquisition can outlive its credential', async () => {
        await runTemporaryTeamModelJourney('acquisition');
    });

    it('retires a selected Team model when changing Agent without restoring its tuple as native on return', async () => {
        await runTemporaryTeamModelJourney('switch-agent');
    });

    it('does not remember selected Team reasoning as a native Account model tuple', async () => {
        await runTemporaryTeamModelJourney('remembered-control');
    });

    it('submits a worker-confirmed Team model from New Session without native Agent sign-in', async () => {
        await runTemporaryTeamModelJourney('launch');
    });

    it('keeps the Team catalog selectable after repeated same-Home resume refreshes', async () => {
        await runTemporaryTeamModelJourney('resume');
    });

    it('keeps a reopened Team source in the New Session submit instead of its native backing model', async () => {
        await runTemporaryTeamModelJourney('reopen');
    });

    it('applies a current Team row when a Home catalog refresh overlaps worker confirmation', async () => {
        await runTemporaryTeamModelJourney('refresh-selection');
    });

    it('retains a Run Team model selected during catalog revalidation without admitting launch early', async () => {
        await runTemporaryTeamModelJourney('run-refresh-selection');
    });

    it('reopens a Temporary computer draft without selecting or dispatching to an available Machine', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = {};
        const draftId = crypto.randomUUID();
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const executionTarget = {
            kind: 'temporary_computer',
            serverId: homeAScopeId,
            artifactTarget: 'darwin-arm64',
            workspace: { kind: 'choose_on_endpoint' },
        } as const;
        const temporaryComputerActivationRef = {
            v: 1,
            activationId: '1d79cf10-cabc-4132-a8b8-bafaa7d60b2e',
            createdOnDeviceLabel: 'Creating device',
        } as const;
        const { writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        writeNewSessionDraft({
            scope,
            draftId,
            patch: {
                text: 'Preserve this waiting request',
                authoring: { executionTarget, temporaryComputerActivationRef, directory: '/retained-directory' },
            },
            materializationIntent: 'userEdit',
        });
        const hook = await renderProductionCreateCaller({
            activeServerId: homeAScopeId,
            targetServerId: homeAScopeId,
            draftId,
        });
        try {
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected simple creator fixture');
            expect(model.simpleProps.canCreate).toBe(false);
            expect(model.simpleProps.selectedPath).toBe('/retained-directory');
            socketBoundary.emits.mockClear();
            await act(async () => { await readProductionCreateAction(hook.getCurrent())({ initialMessage: 'skip' }); });
            expect(socketBoundary.emits).not.toHaveBeenCalled();
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
                executionTarget,
                temporaryComputerActivationRef,
                selectedMachineId: null,
                selectedPath: '/retained-directory',
            });
        } finally {
            await hook.unmount();
        }
    });

    it('does not observe an active-Home activation reference through a different target Home', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await act(async () => { await arrangeHomeB(); });
        routeBoundary.params = {};
        const draftId = crypto.randomUUID();
        const sourceScope = { serverId: homeAScopeId, accountId: 'account-a' };
        const { writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        writeNewSessionDraft({
            scope: sourceScope,
            draftId,
            patch: {
                text: 'Move this request before activation',
                authoring: {
                    executionTarget: {
                        kind: 'temporary_computer',
                        serverId: homeBScopeId,
                        artifactTarget: 'darwin-arm64',
                        workspace: { kind: 'choose_on_endpoint' },
                    },
                    temporaryComputerActivationRef: {
                        v: 1,
                        activationId: '2d79cf10-cabc-4132-a8b8-bafaa7d60b2e',
                        createdOnDeviceLabel: 'Wrong Home',
                    },
                },
            },
            materializationIntent: 'userEdit',
        });

        const hook = await renderProductionCreateCaller({
            activeServerId: homeAScopeId,
            targetServerId: homeBScopeId,
            draftId,
        });
        try {
            expect(hook.getCurrent().launchOverlay).toBeNull();
        } finally {
            await hook.unmount();
        }
    });

    it('adopts two Homes and keeps explicit B creation scoped across A to B to A focus and reconnect', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        const focusBefore = profiles.getActiveServerSnapshot();
        const groupsBefore = profiles.loadHomeViewState()?.groups;
        await act(async () => { await arrangeHomeB(); });
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: focusBefore.serverId,
            serverUrl: focusBefore.serverUrl,
        });
        expect(profiles.loadHomeViewState()?.groups).toEqual(groupsBefore);
        await selectHomeView({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: homeBScopeId,
            groups: groupsBefore ?? [],
        });
        const createHook = await renderProductionCreateCaller({
            activeServerId: homeAScopeId,
            targetServerId: homeBScopeId,
        });
        const initialModel = createHook.getCurrent();
        expect(initialModel.variant === 'simple'
            ? initialModel.simpleProps.targetServerId
            : initialModel.wizardProps.machine.serverId).toBe(homeBScopeId);

        try {
            await act(async () => await profiles.setActiveServerId(homeB.id, { scope: 'device' }));
            expect(profiles.getActiveServerSnapshot().serverId).toBe(homeBScopeId);
            await act(async () => await profiles.setActiveServerId(homeA.id, { scope: 'device' }));
            expect(profiles.getActiveServerSnapshot().serverId).toBe(homeAScopeId);

            const homeBSocket = socketBoundary.controls.get(homeB.serverUrl);
            expect(homeBSocket).toBeDefined();
            const homeBConnectsBeforeOutage = socketBoundary.connects.mock.calls
                .filter(([url]) => url === homeB.serverUrl).length;
            await act(async () => {
                homeBSocket?.disconnect();
                homeBSocket?.reconnect();
            });
            expect(socketBoundary.connects.mock.calls.filter(([url]) => url === homeB.serverUrl)).toHaveLength(
                homeBConnectsBeforeOutage + 1,
            );
            expect(profiles.getActiveServerSnapshot().serverId).toBe(homeAScopeId);

            const { storage } = await import('@/sync/domains/state/storageStore');
            const originalPaths = storage.getState().authoringMemory.recentMachinePaths;
            socketBoundary.fetches.mockClear();
            socketBoundary.emits.mockClear();
            await act(async () => {
                await readProductionCreateAction(createHook.getCurrent())({ initialMessage: 'skip' });
            });
            // Account authoring refreshes may still read focused Home A. Only
            // target-Machine admission and the spawn must stay on exact Home B.
            expect(socketBoundary.fetches.mock.calls
                .filter(([url]) => new URL(String(url)).pathname.startsWith('/v1/machines/machine-b')
                    || new URL(String(url)).pathname === '/v1/machines/read-batch')
                .every(([url]) => new URL(String(url)).origin === new URL(homeB.serverUrl).origin)).toBe(true);
            expect(sessionSpawnCalls()).toHaveLength(1);
            expect(sessionSpawnCalls()[0]?.[0]).toMatchObject({
                serverUrl: homeB.serverUrl,
                token: homeBToken,
                payload: {
                    method: 'machine-b:session.spawnNew',
                    params: { executionTarget: { serverId: homeBScopeId, machineId: 'machine-b' } },
                },
            });
            expect(modalBoundary.alert).toHaveBeenCalled();
            expect(routeBoundary.replace).not.toHaveBeenCalled();
            expect(observabilityBoundary.capture).not.toHaveBeenCalled();
            expect(storage.getState().authoringMemory.recentMachinePaths).toEqual(originalPaths);
        } finally {
            await createHook.unmount().catch(() => undefined);
        }
    });

    it.each([false, true])('retains exact-Home pending launch custody with checkout selection %s', async (withCheckout) => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await selectHomeView({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
        routeBoundary.params = { machineId: 'machine-b', directory: '/workspace/project/packages/app', spawnServerId: homeBScopeId };
        const createHook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, targetServerId: homeBScopeId });
        const checkoutDraft: SessionAuthoringCheckoutCreationDraftV1 | null = withCheckout
            ? { kind: 'git_worktree', displayName: 'feature-session', baseRef: 'main', branchMode: 'new' }
            : null;
        try {
            const model = createHook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected simple creator fixture');
            await act(async () => { model.simpleProps.setCheckoutCreationDraft(checkoutDraft); });
            socketBoundary.result = { type: 'pending', outcome: 'unknown', retryWithSameCreationKey: true };
            socketBoundary.emits.mockClear();
            await act(async () => { await readProductionCreateAction(createHook.getCurrent())({ initialMessage: 'skip' }); });
            const { SessionSpawnNewInputV2Schema } = await import('@happier-dev/protocol');
            const first = SessionSpawnNewInputV2Schema.parse(sessionSpawnCalls()[0]?.[0]?.payload?.params);
            expect(first).toMatchObject({
                executionTarget: { serverId: homeBScopeId, machineId: 'machine-b' },
                directory: { kind: 'path', path: '/workspace/project/packages/app' },
                checkoutCreationDraft: checkoutDraft,
            });
            expect(first.creationKey).toBeTruthy();
            const pendingModel = createHook.getCurrent();
            const pendingProps = pendingModel.variant === 'simple' ? pendingModel.simpleProps : pendingModel.wizardProps.footer;
            expect(pendingProps.pendingLaunchAttempt?.status).toBe('failed_retryable');
            await act(async () => { await readProductionCreateAction(createHook.getCurrent())({ initialMessage: 'skip' }); });
            expect(sessionSpawnCalls()).toHaveLength(2);
            const retry = SessionSpawnNewInputV2Schema.parse(sessionSpawnCalls()[1]?.[0]?.payload?.params);
            expect(retry.creationKey).toBe(first.creationKey);
            expect(retry.checkoutCreationDraft).toEqual(checkoutDraft);
            expect(retry.executionTarget).toEqual(first.executionTarget);
        } finally {
            await createHook.unmount();
        }
    });

    it('mounts the durable source-context configuration without a recipe-only handoff replacing its folder', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await selectHomeView({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().activateProfileScope({ serverId: homeAScopeId, accountId: 'account-a' });
        const { createSessionFixture } = await import('@/dev/testkit');
        const { openNewSessionSourceContextNavigation } = await import('../navigation/newSessionSourceContextNavigation');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const bindingHook = await renderHook(() => useServerCredentialAccountScopeBindings([homeBScopeId]));
        await vi.waitFor(() => expect(bindingHook.getCurrent().get(homeBScopeId)?.scope)
            .toEqual({ serverId: homeBScopeId, accountId: 'account-b' }));
        const outcome = openNewSessionSourceContextNavigation({
            session: createSessionFixture({ id: 'replay-source', metadata: {
                path: '/source/replay', host: 'home-b-machine', machineId: 'machine-b', flavor: 'codex',
            } }),
            sourceSessionId: 'replay-source', forkPoint: { type: 'latest' }, serverId: homeBScopeId, machineId: 'machine-b',
            accountLifetime: bindingHook.getCurrent().get(homeBScopeId),
            restoredDraftText: 'Continue this edited message',
            navigateToNewSession: route => { routeBoundary.params = { ...route.params }; },
        });
        if (outcome.kind !== 'opened') throw new Error(JSON.stringify(outcome));
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, targetServerId: homeBScopeId, draftId: outcome.draftId });
        try {
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                if (model.variant !== 'simple') throw new Error('Expected simple creator fixture');
                expect(model.simpleProps.selectedPath).toBe('/source/replay');
                expect(model.simpleProps.promptStore.getPrompt()).toBe('Continue this edited message');
            });
        } finally { await hook.unmount(); await bindingHook.unmount(); }
    });

    it.each([true, false])('configures a foreign-Home fork only from its exact authorized current Session (access %s)', async (sourceAvailable) => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createSessionFixture } = await import('@/dev/testkit');
        const { openSessionForkStrategyFlow } = await import('@/components/sessions/fork/openSessionForkStrategyFlow');
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol/sessions/listing/response');
        const source = createSessionFixture({ id: 'same-session', serverId: homeBScopeId, metadata: {
            path: '/source/home-b', host: 'home-b-machine', machineId: 'machine-b', flavor: 'codex',
        } });
        if (!source.access) throw new Error('Source fixture requires canonical Session access');
        storage.getState().applySessions([createSessionFixture({ id: source.id, serverId: homeAScopeId,
            metadata: { path: '/focused/home-a', host: 'home-a-machine', machineId: 'machine-a', flavor: 'codex' } })]);
        const sourceResponse = SessionCurrentProjectionRecordV1Schema.parse({
            id: source.id, seq: source.seq, createdAt: source.createdAt, updatedAt: source.updatedAt,
            active: source.active, activeAt: source.activeAt, encryptionMode: 'plain', dataEncryptionKey: null,
            metadata: JSON.stringify(source.metadata), metadataVersion: source.metadataVersion, metadataLayoutVersion: 0,
            agentState: null, agentStateVersion: source.agentStateVersion, pendingVersion: source.pendingVersion,
            responsibleAccountId: null, responsibleAccount: null, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], audienceContext: null,
                capabilities: source.access.capabilities },
        });
        const sourceReads: Array<Readonly<{ home: string; authorization: string | null }>> = [];
        sessionHttpBoundary = (rawUrl, init) => {
            const url = new URL(rawUrl);
            if (url.pathname !== `/v2/sessions/${source.id}`) return null;
            sourceReads.push({ home: url.origin, authorization: new Headers(init?.headers).get('authorization') });
            if (url.origin !== 'https://home-b.example.test') return Response.json({ error: 'Session not found' }, { status: 404 });
            if (!sourceAvailable) return Response.json({ error: 'Access denied' }, { status: 403 });
            return Response.json({ session: sourceResponse });
        };
        modalBoundary.show.mockClear();
        openSessionForkStrategyFlow({
            sessionId: source.id, forkSupportSource: source,
            serverId: homeBScopeId, machineId: 'machine-b', forkPoint: { type: 'latest' },
            settings: null, replayEnabled: true, executionRunsEnabled: false, agentSwitchingEnabled: true,
            navigation: { push: routeBoundary.push }, navigateToSession: vi.fn(),
            navigateToNewSession: route => { routeBoundary.params = { ...route.params }; },
        });
        const modal = modalBoundary.show.mock.calls[0]?.[0];
        if (!modal || typeof modal !== 'object' || !('props' in modal)
            || !modal.props || typeof modal.props !== 'object' || !('onConfigureNewSession' in modal.props)
            || typeof modal.props.onConfigureNewSession !== 'function') throw new Error('Missing Configure action');
        const configureNewSession = modal.props.onConfigureNewSession;
        await act(async () => { configureNewSession(); });
        if (!sourceAvailable) {
            await vi.waitFor(() => expect(modalBoundary.alert).toHaveBeenCalledWith('common.error', 'common.unavailable'));
            expect(routeBoundary.params.draftId).toBeUndefined();
            return;
        }
        await vi.waitFor(() => expect(routeBoundary.params.draftId).toEqual(expect.any(String)));
        const draftId = routeBoundary.params.draftId;
        if (!draftId) throw new Error('Configure did not open a durable draft');
        expect(readNewSessionDraftFromRepository({ scope: { serverId: homeBScopeId, accountId: 'account-b' }, draftId }))
            .toMatchObject({ selectedPath: '/source/home-b', selectedMachineId: 'machine-b' });
        expect(readNewSessionDraftFromRepository({ scope: { serverId: homeAScopeId, accountId: 'account-a' }, draftId })).toBeNull();
        expect(sourceReads).toContainEqual({ home: 'https://home-b.example.test', authorization: `Bearer ${homeBToken}` });
        expect(sourceReads.every(read => read.home === 'https://home-b.example.test' && read.authorization === `Bearer ${homeBToken}`)).toBe(true);
    });

    it('pairs external authoring Action ingress with editable reopen and exactly one explicit Send', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await selectHomeView({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().activateProfileScope({ serverId: homeAScopeId, accountId: 'account-a' });
        await storage.getState().activateSettingsScope({ serverId: homeAScopeId, accountId: 'account-a' });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { SessionAuthoringOpenResultV1Schema } = await import('@happier-dev/protocol/plugins/ui');
        const { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { SessionSpawnNewInputV2Schema } = await import('@happier-dev/protocol');
        socketBoundary.emits.mockClear();
        const opened = await createDefaultActionExecutor().execute('session.authoring.open', {
            seed: { prompt: 'Help me update this review integration.' },
        }, { surface: 'ui', authority: 'present_user', serverId: homeAScopeId, expectedAccountId: 'account-a' });
        expect(opened.ok).toBe(true);
        if (!opened.ok) throw new Error(opened.errorCode);
        const acknowledgement = SessionAuthoringOpenResultV1Schema.parse(opened.result);
        if (acknowledgement.kind !== 'opened') throw new Error(JSON.stringify(acknowledgement));
        expect(routeBoundary.push).toHaveBeenCalledWith({ pathname: '/new', params: { draftId: acknowledgement.draftId } });
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draft = readNewSessionDraftFromRepository({ scope, draftId: acknowledgement.draftId });
        if (!draft) throw new Error('Expected the Action-owned draft');
        writeNewSessionDraftToRepository({ scope, draftId: acknowledgement.draftId, draft: { ...draft,
            input: 'My edited external integration request', selectedPath: '/external/review', selectedMachineId: 'machine-b',
            targetServerId: homeBScopeId, executionTarget: { kind: 'machine', target: { serverId: homeBScopeId, machineId: 'machine-b' } },
        } });
        resetSessionDraftRepositoryForTests();
        routeBoundary.params = {};
        const { createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol');
        const { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } =
            await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
        const metadata = { path: '/external/review', host: 'home-b-machine', machineId: 'machine-b', flavor: 'codex' };
        const admitted = createSessionOwnerMetadataV1({ metadata });
        if (!admitted.ok) throw new Error('Expected admitted created Session metadata');
        const record = SessionCurrentProjectionRecordV1Schema.parse({
            id: 'external-authoring-created', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
            encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 1,
            metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(admitted.ownerMetadata),
            agentStateVersion: 0, agentState: null, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
            responsibleAccountId: null, responsibleAccount: null,
        });
        sessionHttpBoundary = url => new URL(url).pathname === `/v2/sessions/${record.id}`
            ? Response.json({ session: record }) : null;
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, targetServerId: homeBScopeId, draftId: acknowledgement.draftId });
        try {
            expect(readNewSessionDraftFromRepository({ scope, draftId: acknowledgement.draftId })?.input).toBe('My edited external integration request');
            expect(socketBoundary.emits.mock.calls.filter(([request]) => request.payload?.method?.endsWith(':session.spawnNew'))).toHaveLength(0);
            socketBoundary.result = { type: 'success', disposition: 'created', sessionId: 'external-authoring-created',
                executionTarget: { serverId: homeBScopeId, machineId: 'machine-b' }, organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: { status: 'accepted', localId: 'external-first-turn' } };
            await act(async () => { await readProductionCreateAction(hook.getCurrent())(); });
            const spawns = socketBoundary.emits.mock.calls.filter(([request]) => request.payload?.method?.endsWith(':session.spawnNew'));
            expect(spawns).toHaveLength(1);
            expect(SessionSpawnNewInputV2Schema.parse(spawns[0][0].payload.params)).toMatchObject({
                directory: { kind: 'path', path: '/external/review' }, initialInput: { text: 'My edited external integration request' },
            });
            const destination = new URL(String(routeBoundary.replace.mock.calls[0]?.[0]), 'https://happier.invalid');
            expect(destination.pathname).toBe('/session/external-authoring-created');
            expect(destination.searchParams.get('serverId')).toBe(homeBScopeId);
            expect(modalBoundary.alert).not.toHaveBeenCalled();
            expect(observabilityBoundary.capture).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it.each([
        { edit: 'replace', launchHome: 'origin', birth: false, retireSource: false },
        { edit: 'clear-then-type', launchHome: 'origin', birth: false, retireSource: false },
        { edit: 'replace', launchHome: 'other', birth: false, retireSource: false },
        { edit: 'replace', launchHome: 'origin', birth: true, retireSource: false },
        { edit: 'replace', launchHome: 'other', birth: true, retireSource: false },
        { edit: 'replace', launchHome: 'other', birth: true, retireSource: true },
    ] as const)('explicit Send retains the seeded Project setup origin after $edit prompt editing and $launchHome launch Home selections (birth=$birth, retireSource=$retireSource)', async ({ edit, launchHome, birth, retireSource }) => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        const launchServerId = launchHome === 'origin' ? homeAScopeId : homeBScopeId;
        const launchProfile = launchHome === 'origin' ? homeA : homeB;
        const launchAccountId = launchHome === 'origin' ? 'account-a' : 'account-b';
        const launchToken = launchHome === 'origin' ? homeAToken : homeBToken;
        await selectHomeView({ version: 1, activeTargetKind: 'server', activeTargetId: launchServerId, groups: [] });
        const { writeNewSessionDraftToRepository, readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { SessionCurrentProjectionRecordV1Schema, SessionSpawnNewInputV2Schema } = await import('@happier-dev/protocol');
        const { projectSessionDisplayV1, sealSessionSharedDisplayEnvelopeV1, sealSessionOwnerDisplayEnvelopeV1 } =
            await import('@happier-dev/protocol');
        const { ConnectedAccountCatalogRowReadResponseV1Schema, emptyConnectedAccountCatalogRecordV1 } =
            await import('@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1');
        const { getConnectedAccountCatalogValue } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
        const { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1,
            SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = crypto.randomUUID();
        const origin = { kind: 'project', accountId: scope.accountId, page: 'scripts', comparisonId: 'original-comparison',
            layoutId: 'release-dashboard', surface: 'tabs', companion: 'files', resource: { kind: 'file', path: 'src/original.ts' },
            workspace: { serverId: homeAScopeId, workspaceId: 'original-workspace', machineId: 'original-machine', rootPath: '/original/project' } } as const;
        const setupPrompt = 'Review the original changes';
        const { seedAndOpenNewSession } = await import('@/components/sessions/new/newSessionSeedComposer');
        const { admitProjectAuthoringOrigin } = await import('@/components/projects/detail/projectRouteState');
        const { createProjectAccountRowsFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        storage.getState().activateProfileScope(scope);
        storage.getState().activateProjectAccountRowsScope(scope);
        storage.getState().applyProjectAccountRowsForScope(scope, createProjectAccountRowsFixture(scope, { workspaceRefs: [{
            id: origin.workspace.workspaceId, serverId: homeAScopeId, machineId: origin.workspace.machineId,
            rootPath: origin.workspace.rootPath, createdAtMs: 1,
        }] }));
        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(seedAndOpenNewSession({ scope, createDraftId: () => draftId, isCurrent: () => lifetime?.isCurrent() === true,
            admitOrigin: origin => admitProjectAuthoringOrigin(origin, scope),
            seed: { origin, sessionName: 'Set up the checkout', prompt: setupPrompt,
                placement: { kind: 'exactTarget', serverId: homeAScopeId,
                    machineId: 'original-machine', directory: '/original/project' } },
            navigateToNewSession: () => { routeBoundary.params = { draftId }; },
        })).toMatchObject({ kind: 'opened', draftId });
        // Real setup opens the still-mounted repository; keep that warm path
        // alongside the existing serialized reopen cases.
        const reopenRepository = edit === 'clear-then-type' || launchHome === 'other';
        if (reopenRepository) resetSessionDraftRepositoryForTests();
        const reopened = readNewSessionDraftFromRepository({ scope, draftId });
        if (!reopened) throw new Error('Expected the persisted authoring draft');
        writeNewSessionDraftToRepository({ scope, draftId, draft: { ...reopened, targetServerId: launchServerId,
            selectedMachineId: 'machine-b', selectedPath: '/edited/project',
            executionTarget: { kind: 'machine', target: { serverId: launchServerId, machineId: 'machine-b' } } } });
        if (reopenRepository) resetSessionDraftRepositoryForTests();
        routeBoundary.params = {};
        const metadata = { path: '/edited/project', host: 'home-b-machine', machineId: 'machine-b', flavor: 'codex',
            work: { memoryEnabled: false, viewPreferences: { showToolCalls: true } } };
        const admitted = createSessionOwnerMetadataV1({ metadata });
        if (!admitted.ok) throw new Error('Expected admitted created Session metadata');
        const sessionId = `created-origin-send-${edit}-${launchHome}-${birth}-${retireSource}`;
        let record = SessionCurrentProjectionRecordV1Schema.parse({
            id: sessionId, createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
            encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 1,
            metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(admitted.ownerMetadata),
            agentStateVersion: 0, agentState: null, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
            responsibleAccountId: null, responsibleAccount: null,
        });
        const writes: Array<{ url: string; patch: ReturnType<typeof SessionMetadataTuplePatchV1Schema.parse> }> = [];
        const originWrites: typeof writes = [];
        const relationships: unknown[] = [];
        sessionHttpBoundary = (url, init) => {
            if (new URL(url).pathname === '/v1/account/project-rows/authoring-session') {
                expect(new URL(url).origin).toBe(new URL(homeA.serverUrl).origin);
                expect(record.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { authoringOriginV1: origin } } });
                relationships.push(JSON.parse(String(init?.body)));
                return Response.json({ status: 'absent' });
            }
            if (new URL(url).pathname === '/v1/account/entity-rows/connected-accounts/purposes') {
                expect(new URL(url).origin).toBe(new URL(launchProfile.serverUrl).origin);
                expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${launchToken}`);
                return Response.json(ConnectedAccountCatalogRowReadResponseV1Schema.parse({
                    status: 'present', revision: 1,
                    content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1('purposes') },
                }));
            }
            if (new URL(url).pathname !== `/v2/sessions/${sessionId}`) return null;
            expect(new URL(url).origin).toBe(new URL(launchProfile.serverUrl).origin);
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${launchToken}`);
            if (init?.method === 'PATCH') {
                const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
                if (patch.mode !== 'owner') throw new Error('Expected the owner-private tuple writer');
                writes.push({ url, patch });
                const previousOrigin = record.ownerMetadata?.t === 'plain' ? record.ownerMetadata.v.work?.authoringOriginV1 : undefined;
                const nextOrigin = patch.ownerMetadata.t === 'plain' ? patch.ownerMetadata.v.work?.authoringOriginV1 : undefined;
                // Runtime/model publications also PATCH this tuple. Count the
                // observed origin transition, not those independent mutations.
                if (JSON.stringify(previousOrigin) !== JSON.stringify(nextOrigin)) originWrites.push({ url, patch });
                record = SessionCurrentProjectionRecordV1Schema.parse({ ...record,
                    metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata,
                    metadataVersion: record.metadataVersion + 1, agentState: patch.agentState.ciphertext,
                    agentStateVersion: (record.agentStateVersion ?? 0) + 1 });
                return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                    sharedMetadata: { version: record.metadataVersion }, agentState: { version: record.agentStateVersion } }));
            }
            return Response.json({ session: record });
        };
        socketBoundary.emits.mockClear();
        const createHook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, targetServerId: launchServerId, draftId,
            authoringOriginAtBirth: birth });
        try {
            // Send inherits the selected launch Account's defaults.
            // Let the real scoped reader admit its HTTP row before pressing the production action.
            await vi.waitFor(() => expect(getConnectedAccountCatalogValue({
                serverId: launchServerId, accountId: launchAccountId,
            }, 'purposes')).toMatchObject({ status: 'ready', stale: false }));
            const model = createHook.getCurrent();
            const composer = model.variant === 'simple' ? model.simpleProps : model.wizardProps.footer;
            if (edit === 'clear-then-type') {
                await act(async () => { composer.setSessionPrompt(''); });
                expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe('');
            }
            const editedPrompt = 'Please inspect the project setup after my edits.';
            await act(async () => { composer.setSessionPrompt(editedPrompt); });
            const readAgentControls = () => {
                const current = createHook.getCurrent();
                return current.variant === 'simple' ? current.simpleProps : current.wizardProps.agent;
            };
            const codex = readAgentControls().agentPickerOptions?.find(option => option.id.includes('codex'));
            if (!codex) throw new Error('Expected the available Codex picker option');
            const selectAgent = readAgentControls().onAgentPickerSelect;
            if (!selectAgent) throw new Error('Missing Agent picker selection action');
            await act(async () => { selectAgent(codex.id); });
            const selectModel = readAgentControls().setModelMode;
            if (!selectModel) throw new Error('Missing model selection action');
            await act(async () => { selectModel('gpt-6-luna'); });
            const poolId = '00000000-0000-4000-8000-000000001013';
            // Pool selection resolves to an exact Machine and hands these route
            // operands to New Session. Exercise that production route consumer.
            routeBoundary.params = { ...routeBoundary.params,
                machineId: 'machine-b', spawnServerId: launchServerId, machinePoolId: poolId };
            await createHook.rerender();
            const { resolveNewSessionDraftAutoPersistDelayMs } = await import('./useNewSessionDraftAutoPersist');
            // Exercise the real delayed authoring write as well as the immediate
            // Composer write; sending before autosave would miss lost local custody.
            await act(async () => {
                await new Promise(resolve => setTimeout(resolve, resolveNewSessionDraftAutoPersistDelayMs({
                    platformOS: 'web', draftTextLength: editedPrompt.length,
                }) + 1));
            });
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe(editedPrompt);
            expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
                agentType: 'codex', modelSelection: { ref: { modelId: 'gpt-6-luna' } },
                executionTarget: { kind: 'machine', target: { serverId: launchServerId, machineId: 'machine-b' },
                    selectionOrigin: { kind: 'machine_pool', poolId } },
            });
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.authoringOrigin).toEqual(origin);
            expect(writes).toHaveLength(0);
            expect(socketBoundary.emits.mock.calls.filter(([request]) =>
                request.payload?.method?.endsWith(':session.spawnNew'))).toHaveLength(0);
            socketBoundary.result = { type: 'success', disposition: 'created', sessionId: record.id,
                executionTarget: { serverId: launchServerId, machineId: 'machine-b' },
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'accepted', localId: 'origin-first-turn' } };
            if (birth) {
                const born = createSessionOwnerMetadataV1({ metadata: { ...metadata,
                    work: { ...metadata.work, authoringOriginV1: origin } } });
                if (!born.ok) throw new Error('Expected admitted daemon birth owner fixture');
                record = SessionCurrentProjectionRecordV1Schema.parse({ ...record,
                    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(born.ownerMetadata), metadataVersion: 13 });
                const display = projectSessionDisplayV1({ sharedMetadata: projectSessionSharedMetadataV1({ metadata }),
                    ownerMetadata: born.ownerMetadata });
                if (!display.owner) throw new Error('Expected daemon birth owner display');
                const shared = await sealSessionSharedDisplayEnvelopeV1({ sessionMode: 'plain', display: display.shared });
                const owner = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'plain', display: display.owner });
                if (!shared.ok || !owner.ok) throw new Error('Expected daemon birth display envelopes');
                record = SessionCurrentProjectionRecordV1Schema.parse({ ...record, displayProjectionV1: {
                    v: 1, sourceMetadataVersion: record.metadataVersion, metadataLayoutVersion: 1,
                    shared: shared.envelope, owner: owner.envelope,
                } });
            }
            socketBoundary.emits.mockClear();
            await act(async () => { await readProductionCreateAction(createHook.getCurrent())(); });
            const spawn = socketBoundary.emits.mock.calls.find(([request]) => request.payload?.method === 'machine-b:session.spawnNew');
            expect(spawn, JSON.stringify({ alerts: modalBoundary.alert.mock.calls,
                alertStacks: modalBoundary.alertStacks,
                errors: observabilityBoundary.capture.mock.calls.map(([error]) => error instanceof Error ? error.stack : error),
                requests: socketBoundary.fetches.mock.calls })).toBeDefined();
            expect(SessionSpawnNewInputV2Schema.parse(spawn?.[0]?.payload?.params)).toMatchObject({
                executionTarget: { serverId: launchServerId, machineId: 'machine-b' },
                directory: { kind: 'path', path: '/edited/project' },
                initialInput: { text: editedPrompt },
                ...(birth ? { authoringOrigin: origin } : {}),
            });
            if (!birth) expect(spawn?.[0]?.payload?.params).not.toHaveProperty('authoringOrigin');
            expect(record.ownerMetadata).toMatchObject({ t: 'plain', v: { work: {
                memoryEnabled: false, viewPreferences: { showToolCalls: true }, authoringOriginV1: origin,
            } } });
            if (birth) expect(originWrites).toHaveLength(0);
            else expect(writes.some(({ patch }) => patch.mode === 'owner' && patch.ownerMetadata.t === 'plain'
                && patch.ownerMetadata.v.work?.authoringOriginV1?.comparisonId === origin.comparisonId)).toBe(true);
            expect(relationships).toEqual([{ key: { kind: 'workspace-ref', serverId: homeAScopeId, id: origin.workspace.workspaceId },
                session: { serverId: launchServerId, sessionId: record.id } }]);
            expect(record.metadata).not.toContain('original-comparison');
            expect(record.metadata).not.toContain('/original/project');
            expect(record.metadata).not.toContain('release-dashboard');
            const { resolveProjectAuthoringReturn } = await import('@/components/projects/detail/projectRouteState');
            const destination = resolveProjectAuthoringReturn(origin, { scope, workspaceRefs: [{
                id: origin.workspace.workspaceId, serverId: origin.workspace.serverId, machineId: origin.workspace.machineId,
                rootPath: origin.workspace.rootPath, createdAtMs: 1,
            }] });
            expect(destination.kind).toBe('ready');
            if (destination.kind !== 'ready') throw new Error('Expected admitted original return');
            expect(Object.fromEntries(new URL(destination.href, 'https://happier.test').searchParams)).toMatchObject({
                serverId: homeAScopeId, layoutId: 'release-dashboard', right: 'files', mobileSurface: 'tabs', initialFile: 'src/original.ts',
            });
            expect(routeBoundary.replace, JSON.stringify({ alerts: modalBoundary.alert.mock.calls,
                errors: observabilityBoundary.capture.mock.calls.map(([error]) => error instanceof Error ? error.stack : error),
                draft: readNewSessionDraftFromRepository({ scope, draftId }), route: routeBoundary.params,
                settingsScope: storage.getState().settingsScope,
            })).toHaveBeenCalled();
            if (edit === 'replace') {
                await createHook.unmount();
                const recoveredDraftId = crypto.randomUUID();
                const recoveredAttemptId = crypto.randomUUID();
                writeNewSessionDraftToRepository({ scope, draftId: recoveredDraftId,
                    draft: { ...reopened, targetServerId: launchServerId,
                        executionTarget: { kind: 'machine', target: { serverId: launchServerId, machineId: 'machine-b' } },
                        launchUserAttemptId: recoveredAttemptId } });
                const { captureNewSessionDraftLaunchCurrentness } = await import('../modules/newSessionDraftLifecycle');
                captureNewSessionDraftLaunchCurrentness({ scope, draftId: recoveredDraftId, launchUserAttemptId: recoveredAttemptId });
                const { acquireSpawnAttemptCustody, markSpawnAttemptSubmitted } = await import('@/sync/domains/session/spawn/spawnAttemptNonceStore');
                const recoveredAttempt = { scope: { serverId: launchServerId, accountId: launchAccountId },
                    machineId: 'machine-b', targetFingerprint: `recovered:${recoveredAttemptId}`,
                    userAttemptId: recoveredAttemptId, seedNonce: `nonce:${recoveredAttemptId}` };
                await acquireSpawnAttemptCustody({ ...recoveredAttempt,
                    authoringOriginPersistence: birth ? 'daemon-birth' : 'legacy-checkpoint' });
                await markSpawnAttemptSubmitted({ ...recoveredAttempt, nonce: recoveredAttempt.seedNonce });
                if (!birth) record = SessionCurrentProjectionRecordV1Schema.parse({ ...record,
                    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(admitted.ownerMetadata),
                    metadataVersion: record.metadataVersion + 1 });
                const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
                const { ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
                const { projectSessionSpawnNewActionResultV1, SessionSpawnNewResultV1Schema } =
                    await import('@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1');
                actionOperationStore.mergeSnapshots({ serverId: launchServerId, snapshots: [ActionOperationSnapshotV1Schema.parse({
                    version: 1, operationId: `operation:${recoveredAttemptId}`, revision: 2,
                    actionId: 'session.spawn_new', state: 'succeeded', scope: { accountId: launchAccountId, machineId: 'machine-b' },
                    title: 'Create session', requestId: recoveredAttemptId, createdAt: 1, startedAt: 1, settledAt: 2,
                    cancellation: 'supported', result: projectSessionSpawnNewActionResultV1(SessionSpawnNewResultV1Schema.parse(socketBoundary.result)),
                })] });
                const { useNewSessionActionOperationReconciliation } = await import('./screenModel/useNewSessionActionOperationReconciliation');
                const disableDraftPersistence = vi.fn();
                const resetLaunchRequestId = vi.fn();
                const router = { replace: routeBoundary.replace };
                const originWritesBeforeRecovery = originWrites.length;
                const spawnCount = sessionSpawnCalls().length;
                if (retireSource) {
                    const boundaryBeforeRetirement = sessionHttpBoundary;
                    let armed = true;
                    sessionHttpBoundary = async (url, init) => {
                        if (armed && new URL(url).pathname === `/v2/sessions/${record.id}` && (!init?.method || init.method === 'GET')) {
                            armed = false;
                            await TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: homeAScopeId }, {
                                token: tokenFor('replacement-source-account'),
                            });
                        }
                        return await boundaryBeforeRetirement?.(url, init) ?? null;
                    };
                }
                const recovery = await renderHook(() => useNewSessionActionOperationReconciliation({
                    draftId: recoveredDraftId, requestId: recoveredAttemptId, draftScope: scope,
                    localCreationInFlight: false, disableDraftPersistence, resetLaunchRequestId, router,
                }));
                try {
                    if (retireSource) {
                        await vi.waitFor(() => expect(observabilityBoundary.capture.mock.calls.some(([error]) =>
                            typeof error === 'object' && error !== null && 'phase' in error && error.phase === 'authoring_origin')).toBe(true));
                        expect(relationships).toHaveLength(1);
                        expect(originWrites).toHaveLength(originWritesBeforeRecovery);
                        expect(disableDraftPersistence).not.toHaveBeenCalled();
                        expect(readNewSessionDraftFromRepository({ scope, draftId: recoveredDraftId })).not.toBeNull();
                        return;
                    }
                    await vi.waitFor(() => expect(relationships).toHaveLength(2));
                    await vi.waitFor(() => expect(disableDraftPersistence).toHaveBeenCalledOnce());
                    expect(originWrites.length - originWritesBeforeRecovery).toBe(birth ? 0 : 1);
                    expect(sessionSpawnCalls()).toHaveLength(spawnCount);
                    expect(record.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { authoringOriginV1: origin } } });
                } finally { await recovery.unmount(); }
            }
        } finally {
            await createHook.unmount();
        }
    });

    it('publishes the persisted origin during cold Session-shell Temporary computer recovery before retiring creator custody', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await selectHomeView({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
        const { writeNewSessionDraftToRepository, readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { createMaterializedRunnerProjectionFixture } = await import('@/dev/testkit/fixtures/runnerMaterializationFixtures');
        const { acceptRunnerCreatorActivationBinding, writePreparedRunnerCreatorLaunchCustody, readAcceptedRunnerCreatorActivationBinding } = await import('@/sync/domains/ephemeralRunner/runnerCreatorLaunchCustody');
        const { recoverMaterializedTemporaryComputerSessionForSession, settlePersistedMaterializedTemporaryComputerSession } = await import('@/components/sessions/new/navigation/settleMaterializedTemporaryComputerSession');
        const { createRunnerActivationClient } = await import('@/sync/api/ephemeralRunner/runnerActivationClient');
        const { ephemeralRunnerActivationPathV1 } = await import('@happier-dev/protocol/ephemeralRunner/routes');
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const { createServerRequestForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().activateProfileScope({ serverId: homeAScopeId, accountId: 'account-a' });
        await storage.getState().activateSettingsScope({ serverId: homeAScopeId, accountId: 'account-a' });
        const { createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { RunnerPreparedAuthoringV1Schema } = await import('@happier-dev/protocol/ephemeralRunner/launchManifest');
        const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol');
        const { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1,
            SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
        const scope = { serverId: homeBScopeId, accountId: 'account-b' };
        const draftId = crypto.randomUUID();
        const activationId = '00000000-0000-4000-8000-000000000095';
        const origin = { kind: 'project', accountId: 'account-a', page: 'scripts',
            workspace: { serverId: homeAScopeId, workspaceId: 'original-scripts', machineId: 'original-machine', rootPath: '/original/scripts' } } as const;
        const executionTarget = { kind: 'temporary_computer', serverId: homeBScopeId,
            artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' } } as const;
        writeNewSessionDraftToRepository({ scope, draftId, draft: {
            input: '', selectedMachineId: null, selectedPath: null, targetServerId: homeBScopeId,
            selectedProfileId: null, selectedSecretId: null, agentType: 'codex', permissionMode: 'default',
            acpSessionModeId: null, updatedAt: 1, authoringOrigin: origin, executionTarget,
            temporaryComputerActivationRef: { v: 1, activationId, createdOnDeviceLabel: 'Creating device' },
        } });
        const preparedAuthoring = RunnerPreparedAuthoringV1Schema.parse({
            v: 1, actionsSettings: { v: 1, actions: {} }, mcpMaterial: null, agentPluginDistribution: null,
            authoring: { targetType: 'new_session', executionTarget,
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.codex', localId: 'codex' } },
                permissionMode: 'default', modelSelection: null, transcriptStorage: 'persisted', profileId: null,
                environmentVariables: null, capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
                connectedServices: null, checkoutCreationDraft: null, resumeSessionId: null, terminal: null,
                windowsRemoteSessionLaunchMode: null, windowsRemoteSessionConsole: null, windowsTerminalWindowName: null,
                acpSessionModeId: null, sessionConfigOptionOverrides: null, access: null, primaryTeamId: null,
                organizationPlacement: { folderId: null, tagIds: [] } },
            composer: { text: '', references: [], attachments: [] }, files: [],
            attachmentDestination: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude', vcsIgnoreWritesEnabled: true },
        });
        const projection = createMaterializedRunnerProjectionFixture({ scope, activationId, draftId,
            sessionId: 'cold-origin-created', machineId: 'machine-b', preparedAuthoring });
        await writePreparedRunnerCreatorLaunchCustody({ scope, activationId, preparedAuthoring,
            attachmentUpload: { attachmentMessageLocalId: 'cold-attachments', firstTurnLocalId: 'cold-first-turn', maxFileBytes: 1024, files: [] } });
        await acceptRunnerCreatorActivationBinding(scope, projection);
        resetSessionDraftRepositoryForTests();
        const metadata = { path: '/temporary/edited', host: 'home-b-machine', machineId: 'machine-b', flavor: 'codex',
            work: { memoryEnabled: false } };
        const admitted = createSessionOwnerMetadataV1({ metadata });
        if (!admitted.ok) throw new Error('Expected admitted materialized Session');
        let record = SessionCurrentProjectionRecordV1Schema.parse({
            id: projection.sessionId, createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
            encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 1,
            metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(admitted.ownerMetadata),
            agentStateVersion: 0, agentState: null, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
            responsibleAccountId: null, responsibleAccount: null,
        });
        let refusePublication = true;
        let publicationAttempts = 0;
        sessionHttpBoundary = (url, init) => {
            if (new URL(url).pathname === ephemeralRunnerActivationPathV1(activationId)) return Response.json(projection);
            if (new URL(url).pathname !== `/v2/sessions/${record.id}`) return null;
            expect(new URL(url).origin).toBe(new URL(homeB.serverUrl).origin);
            if (init?.method === 'PATCH') {
                publicationAttempts += 1;
                if (refusePublication) return Response.json({ error: 'Forbidden' }, { status: 403 });
                const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
                if (patch.mode !== 'owner') throw new Error('Expected the owner tuple writer');
                record = SessionCurrentProjectionRecordV1Schema.parse({ ...record, metadata: patch.sharedMetadata.ciphertext,
                    ownerMetadata: patch.ownerMetadata, metadataVersion: record.metadataVersion + 1,
                    agentState: patch.agentState.ciphertext, agentStateVersion: (record.agentStateVersion ?? 0) + 1 });
                return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                    sharedMetadata: { version: record.metadataVersion }, agentState: { version: record.agentStateVersion } }));
            }
            return Response.json({ session: record });
        };
        const activationClient = createRunnerActivationClient(createServerRequestForServerAccountScope({ scope,
            activeRequest: createServerFetchAtEndpoint({ endpointUrl: homeB.serverUrl, serverId: homeBScopeId }),
        }));
        const recover = () => recoverMaterializedTemporaryComputerSessionForSession({ scope, sessionId: record.id,
            candidates: [{ draftId, activationId, launchUserAttemptId: null }], readActivation: activationClient.read,
        });
        // Session-shell recovery already owns presentation; the real cold
        // recovery admits its retained draft through HTTP and canonical custody.
        await expect(recover()).rejects.toMatchObject({ code: 'forbidden' });
        expect(publicationAttempts).toBeGreaterThan(0);
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.authoringOrigin).toEqual(origin);
        await expect(readAcceptedRunnerCreatorActivationBinding(scope, activationId)).resolves.toMatchObject({ sessionId: record.id });
        refusePublication = false;
        await expect(recover()).resolves.toBe('settled');
        expect(record.ownerMetadata).toMatchObject({ t: 'plain', v: { work: {
            memoryEnabled: false, authoringOriginV1: origin,
        } } });
        await expect(readAcceptedRunnerCreatorActivationBinding(scope, activationId)).rejects.toBeDefined();
        expect(record.metadata).not.toContain('/original/scripts');
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.temporaryComputerActivationRef ?? null).toBeNull();

        // A live Send supplies its own completion. Canonical recovery must
        // not add a second provenance writer after that caller's checkpoint.
        const hotDraftId = `${draftId}-hot`;
        const hotActivationId = '00000000-0000-4000-8000-000000000096';
        writeNewSessionDraftToRepository({ scope, draftId: hotDraftId, draft: {
            input: '', selectedMachineId: null, selectedPath: null, selectedProfileId: null,
            selectedSecretId: null, agentType: 'codex', permissionMode: 'default', acpSessionModeId: null, updatedAt: 1,
            authoringOrigin: origin, executionTarget, targetServerId: homeBScopeId } });
        const hotProjection = createMaterializedRunnerProjectionFixture({ scope, activationId: hotActivationId,
            draftId: hotDraftId, sessionId: 'hot-origin-created', machineId: 'machine-b', preparedAuthoring });
        await writePreparedRunnerCreatorLaunchCustody({ scope, activationId: hotActivationId, preparedAuthoring,
            attachmentUpload: { attachmentMessageLocalId: 'hot-attachments', firstTurnLocalId: 'hot-first-turn', maxFileBytes: 1024, files: [] } });
        await acceptRunnerCreatorActivationBinding(scope, hotProjection);
        record = SessionCurrentProjectionRecordV1Schema.parse({ ...record, id: hotProjection.sessionId,
            metadataVersion: 1, ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(admitted.ownerMetadata) });
        await settlePersistedMaterializedTemporaryComputerSession({ scope, draftId: hotDraftId,
            activationId: hotActivationId, sessionId: record.id, launchUserAttemptId: null, projection: hotProjection,
            complete: async () => sync!.patchSessionMetadataWithRetry(record.id,
                (value) => ({ ...value, work: { memoryEnabled: true } }), { serverId: scope.serverId }),
        });
        expect(record.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { memoryEnabled: true } } });
        if (record.ownerMetadata?.t !== 'plain') throw new Error('Expected plain owner metadata');
        expect(record.ownerMetadata.v.work?.authoringOriginV1).toBeUndefined();
    });

    it('preserves the creator after an accepted spawn when attachment follow-up fails', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await selectHomeView({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
        const createHook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, targetServerId: homeBScopeId });
        try {
            socketBoundary.result = {
                type: 'success', disposition: 'created', sessionId: 'created-with-follow-up',
                executionTarget: { serverId: homeBScopeId, machineId: 'machine-b' },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: { status: 'notRequested' },
            };
            const afterCreated = vi.fn(async () => { throw new Error('Attachment follow-up failed'); });
            socketBoundary.emits.mockClear();
            modalBoundary.alert.mockClear();
            await act(async () => {
                await readProductionCreateAction(createHook.getCurrent())({ initialMessage: 'skip', afterCreated });
            });
            expect(sessionSpawnCalls()).toHaveLength(1);
            expect(afterCreated).toHaveBeenCalledOnce();
            expect(routeBoundary.replace).not.toHaveBeenCalled();
            const model = createHook.getCurrent();
            const props = model.variant === 'simple' ? model.simpleProps : model.wizardProps.footer;
            expect(props.pendingLaunchAttempt?.createdSessionId).toBe('created-with-follow-up');
            expect(modalBoundary.alert).toHaveBeenCalledWith('common.error', 'Attachment follow-up failed');
        } finally {
            await createHook.unmount();
        }
    });

    it('keeps typed Provider refusal and retry scoped to the selected Home', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await selectHomeView({
            version: 1, activeTargetKind: 'group', activeTargetId: 'provider-homes',
            groups: [{ id: 'provider-homes', name: 'Provider Homes', serverIds: [homeAScopeId, homeBScopeId] }],
        });
        const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
        await updateEffectiveHomeViewState(() => profiles.loadHomeViewState()!, { scope: 'tab' });
        const createHook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, targetServerId: homeBScopeId });
        try {
            const { createProviderErrorV1, SessionSpawnNewResultV1Schema } = await import('@happier-dev/protocol');
            const providerError = createProviderErrorV1('provider_not_enabled_on_machine', {
                connectionId: 'pc_provider', machineId: 'machine-b',
            });
            socketBoundary.result = SessionSpawnNewResultV1Schema.parse({
                type: 'error', code: 'spawn_failed', retryable: providerError.retryable, providerError,
            });
            expect(socketBoundary.result).toHaveProperty('providerError', providerError);
            socketBoundary.emits.mockClear();
            const readSpawnRequests = () => socketBoundary.emits.mock.calls.filter(([request]) =>
                request.payload?.method === 'machine-b:session.spawnNew');
            modalBoundary.alert.mockClear();
            await act(async () => { await readProductionCreateAction(createHook.getCurrent())({ initialMessage: 'skip' }); });
            const refused = createHook.getCurrent();
            const refusedProps = refused.variant === 'simple' ? refused.simpleProps : refused.wizardProps.footer;
            expect(refusedProps.providerLaunchError).toEqual(providerError);
            expect(modalBoundary.alert).not.toHaveBeenCalled();
            await act(async () => {
                refusedProps.retryProviderLaunch?.();
                await vi.waitFor(() => expect(readSpawnRequests()).toHaveLength(2));
            });
            const { storage } = await import('@/sync/domains/state/storageStore');
            const { createMachineFixture } = await import('@/dev/testkit');
            const homeAMachine = createMachineFixture({ id: 'machine-b' });
            await act(async () => { storage.getState().applyMachines([homeAMachine], true, { sourceServerId: homeAScopeId }); });
            const current = createHook.getCurrent();
            const currentProps = current.variant === 'simple' ? current.simpleProps : current.wizardProps.footer;
            const renderPicker = currentProps.machinePopover?.renderContent;
            if (typeof renderPicker !== 'function') throw new Error('Missing Machine picker renderer');
            const picker = renderPicker({ maxHeight: 560, requestClose: () => {} });
            type PickerProps = React.ComponentProps<typeof import('../components/NewSessionMachineSelectionContent').NewSessionMachineSelectionContent>;
            if (!React.isValidElement<PickerProps>(picker)) throw new Error('Missing Machine picker');
            await act(async () => { picker.props.onSelectScopedMachine({ ...homeAMachine, serverId: homeAScopeId, serverName: 'Home A' }); });
            const retargeted = createHook.getCurrent();
            const retargetedProps = retargeted.variant === 'simple' ? retargeted.simpleProps : retargeted.wizardProps.footer;
            expect(retargetedProps.providerLaunchError).toBeNull();
            await act(async () => { refusedProps.retryProviderLaunch?.(); });
            expect(readSpawnRequests()).toHaveLength(2);
        } finally {
            await createHook.unmount();
        }
    });

    it('remembers a path when creation targets the hydrated settings Home', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await selectHomeView({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
        await profiles.setActiveServerId(homeBScopeId, { scope: 'device' });
        await profiles.setActiveServerId(homeBScopeId, { scope: 'tab' });
        await sync!.switchServer({ token: homeBToken });
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        publishAppliedActiveServerSnapshot(profiles.getActiveServerSnapshot());
        routeBoundary.params = { machineId: 'machine-b', directory: '/same-home/project', spawnServerId: homeBScopeId };
        const createHook = await renderProductionCreateCaller({ activeServerId: homeBScopeId, accountId: 'account-b', targetServerId: homeBScopeId });
        try {
            const { storage } = await import('@/sync/domains/state/storageStore');
            await act(async () => {
                await storage.getState().activateSettingsScope({ serverId: homeBScopeId, accountId: 'account-b' });
                storage.getState().applySettings(storage.getState().settings, 1);
            });
            socketBoundary.emits.mockClear();
            await act(async () => { await readProductionCreateAction(createHook.getCurrent())({ initialMessage: 'skip' }); });
            expect(sessionSpawnCalls()).toHaveLength(1);
            await vi.waitFor(() => expect(storage.getState().authoringMemory.recentMachinePaths[0]).toEqual({ machineId: 'machine-b', path: '/same-home/project' }));
        } finally {
            await createHook.unmount();
        }
    });

    it('keeps a pending screen attachment through Machine picker autosave and ordinary removal', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA('pending-screen-picker'));
        const { seedAndOpenNewSession } = await import('../newSessionSeedComposer');
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = crypto.randomUUID();
        const currentUiContext = { navigation: { area: 'sessions', screen: 'tab.sessions', title: 'Sessions' }, commands: [] };
        expect(seedAndOpenNewSession({ scope, seed: { currentUiContext }, createDraftId: () => draftId,
            isCurrent: () => true, navigateToNewSession: () => {},
        }).kind).toBe('opened');
        const seeds = readNewSessionDraftFromRepository({ scope, draftId })?.composerAttachmentSeeds;
        expect(seeds).toHaveLength(1);
        const machines = ['first-machine', 'other-machine'].map(id => createMachineFixture({ id,
            metadata: { host: id, platform: 'linux', homeDir: '/workspace' } }));
        machineHttpSnapshots.set(new URL(homeA.serverUrl).origin, machines);
        storage.getState().applyMachines(machines, true, { sourceServerId: homeAScopeId });
        routeBoundary.params = { draftId, spawnServerId: homeAScopeId, machineId: 'first-machine' };
        const hook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, draftId });
        const readProps = () => {
            const model = hook.getCurrent();
            return model.variant === 'simple' ? model.simpleProps : model.wizardProps.footer;
        };
        const readComposer = () => {
            const composer = readProps().composerDocument;
            if (!composer) throw new Error('Missing mounted Composer');
            return composer;
        };
        const selectMachine = async (machine: Machine) => {
            const renderPicker = readProps().machinePopover?.renderContent;
            if (!renderPicker) throw new Error('Missing Machine picker');
            const picker = renderPicker({ maxHeight: 560, requestClose: () => {} });
            type PickerProps = React.ComponentProps<typeof import('../components/NewSessionMachineSelectionContent').NewSessionMachineSelectionContent>;
            if (!React.isValidElement<PickerProps>(picker)) throw new Error('Missing Machine picker element');
            await act(async () => picker.props.onSelectScopedMachine({ ...machine, serverId: homeAScopeId, serverName: 'Home A' }));
            await hook.rerender();
            await vi.waitFor(() => expect(readNewSessionDraftFromRepository({ scope, draftId })?.selectedMachineId).toBe(machine.id));
        };
        try {
            expect(readComposer().attachmentRowItems).toMatchObject([{ kind: 'badge', label: 'Sessions' }]);
            expect(readComposer().readCurrentDocumentSnapshot()?.attachments).toMatchObject([{ availability: { status: 'unavailable' } }]);
            const otherMachine = machines[1];
            if (!otherMachine) throw new Error('Missing other Machine');
            // Observe the actual debounced write before checking pending custody.
            await selectMachine(otherMachine);
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.composerAttachmentSeeds).toEqual(seeds);
            expect(readComposer().attachmentRowItems).toMatchObject([{ kind: 'badge', label: 'Sessions' }]);
            await act(async () => readComposer().attachmentRowItems[0]?.onRemove?.());
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.composerAttachmentSeeds).toBeUndefined();
            expect(readComposer().attachmentRowItems).toEqual([]);
            const firstMachine = machines[0];
            if (!firstMachine) throw new Error('Missing first Machine');
            await selectMachine(firstMachine);
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.composerAttachmentSeeds).toBeUndefined();
            expect(readComposer().attachmentRowItems).toEqual([]);
        } finally { await hook.unmount(); }
    });

    it('places an embedded surface from its host\'s own params and writes placement back to the host, never the route', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await selectHomeView({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
        // Home embeds the surface: the route it sits on carries no New Session params at all.
        routeBoundary.params = {};
        const { NewSessionEmbeddedHostProvider, mergeNewSessionHostParams } = await import('../navigation/newSessionHost');
        const hostWrites: Array<Readonly<Record<string, unknown>>> = [];
        function EmbeddedHost(props: Readonly<{ children?: React.ReactNode }>) {
            const [params, setParamsState] = React.useState<Record<string, string | string[] | undefined>>({
                machineId: 'machine-b',
                directory: '/embedded/project',
                spawnServerId: homeBScopeId,
            });
            const host = React.useMemo(() => ({
                params,
                setParams: (patch: Readonly<Record<string, unknown>>) => {
                    hostWrites.push(patch);
                    setParamsState((current) => ({ ...mergeNewSessionHostParams(current, patch) }));
                },
                openDraft: () => undefined,
                onHandedOff: () => undefined,
                demanded: true,
            }), [params]);
            return <NewSessionEmbeddedHostProvider host={host}>{props.children}</NewSessionEmbeddedHostProvider>;
        }
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().activateProfileScope({ serverId: homeAScopeId, accountId: 'account-a' });
        await storage.getState().activateSettingsScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().applySettings(storage.getState().settings, 1);
        storage.getState().applyMachines([
            createMachineFixture({
                id: 'machine-b',
                metadata: { host: 'home-b-machine', platform: 'linux', happyCliVersion: '0.0.0-test', happyHomeDir: '/workspace/.happy', homeDir: '/workspace' },
            }),
        ], true, { sourceServerId: homeBScopeId });
        const draftId = crypto.randomUUID();
        const createHook = await renderHook(
            () => useNewSessionScreenModel({ draftId }),
            { wrapper: EmbeddedHost },
        );
        try {
            // The surface is placed from the host's params: Home B, its machine and the host's folder.
            const placed = createHook.getCurrent();
            expect(placed.variant).toBe('simple');
            if (placed.variant !== 'simple') throw new Error('Embedded surface must be the composer');
            expect(placed.simpleProps.targetServerId).toBe(homeBScopeId);
            expect(placed.simpleProps.selectedMachineId).toBe('machine-b');
            expect(placed.simpleProps.selectedPath).toBe('/embedded/project');

            // Choosing a Machine is a placement write: it lands in the host, and the route stays untouched.
            const model = createHook.getCurrent();
            const props = model.variant === 'simple' ? model.simpleProps : model.wizardProps.footer;
            const renderPicker = props.machinePopover?.renderContent;
            if (typeof renderPicker !== 'function') throw new Error('Missing Machine picker renderer');
            const picker = renderPicker({ maxHeight: 560, requestClose: () => {} });
            type PickerProps = React.ComponentProps<typeof import('../components/NewSessionMachineSelectionContent').NewSessionMachineSelectionContent>;
            if (!React.isValidElement<PickerProps>(picker)) throw new Error('Missing Machine picker');
            const machine = storage.getState().machineListByServerId[homeBScopeId]?.find((candidate) => candidate.id === 'machine-b');
            if (!machine) throw new Error('Missing Home B fixture');
            await act(async () => picker.props.onSelectScopedMachine({ ...machine, serverId: homeBScopeId, serverName: 'Home B' }));
            expect(hostWrites).toContainEqual(expect.objectContaining({ machineId: 'machine-b', spawnServerId: homeBScopeId }));
            expect(routeBoundary.params).toEqual({});
        } finally {
            await createHook.unmount();
            routeBoundary.params = { machineId: 'machine-b', directory: '/workspace/project', spawnServerId: homeBScopeId };
        }
    });

    it.each(['settings', 'sessions'] as const)('keeps the scoped picker Home when another Home has the same Machine id and hydrated %s', async (historySource) => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await selectHomeView({
            version: 1,
            activeTargetKind: 'group',
            activeTargetId: 'both',
            groups: [{ id: 'both', name: 'Both', serverIds: [homeAScopeId, homeBScopeId] }],
        });
        const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
        await updateEffectiveHomeViewState(() => profiles.loadHomeViewState()!, { scope: 'tab' });
        expect(profiles.loadHomeViewState()).toMatchObject({ activeTargetKind: 'group', activeTargetId: 'both', groups: [{ serverIds: [homeAScopeId, homeBScopeId] }] });
        routeBoundary.params = { machineId: 'machine-b', spawnServerId: homeAScopeId };
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit');
        storage.getState().activateProfileScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().applyMachines([createMachineFixture({
            id: 'machine-b',
            metadata: { host: 'home-a-machine', platform: 'linux', homeDir: '/home-a', happyHomeDir: '/home-a/.happy', happyCliVersion: 'test' },
        })], true, { sourceServerId: homeAScopeId });
        const createHook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, targetServerId: homeBScopeId });
        try {
            await act(async () => {
                if (historySource === 'settings') {
                    storage.getState().applyAuthoringMemory({
                        recentMachinePaths: [{ machineId: 'machine-b', path: '/home-a/recent' }],
                    });
                } else {
                    const { createSessionFixture } = await import('@/dev/testkit');
                    const session = createSessionFixture({
                        id: 'home-a-session',
                        metadata: { path: '/home-a/session-path', host: 'home-a-machine', machineId: 'machine-b' },
                    });
                    storage.setState({ sessions: { [session.id]: session }, isDataReady: true });
                }
            });
            expect(storage.getState().settingsScope?.serverId).toBe(homeAScopeId);
            if (historySource === 'settings') {
                expect(storage.getState().authoringMemory.recentMachinePaths).toEqual([{ machineId: 'machine-b', path: '/home-a/recent' }]);
            } else {
                expect(storage.getState().profileScope?.serverId).toBe(homeAScopeId);
                expect(storage.getState().sessions['home-a-session']?.metadata?.path).toBe('/home-a/session-path');
            }
            // Focus may change before the new Home's Account settings hydrate.
            await act(async () => { await profiles.setActiveServerId(homeBScopeId); });
            const model = createHook.getCurrent();
            const props = model.variant === 'simple' ? model.simpleProps : model.wizardProps.footer;
            await act(async () => { props.promptStore.setPrompt('Keep this newer draft'); });
            const renderPicker = props.machinePopover?.renderContent;
            if (typeof renderPicker !== 'function') throw new Error('Missing Machine picker renderer');
            const picker = renderPicker({ maxHeight: 560, requestClose: () => {} });
            type PickerProps = React.ComponentProps<typeof import('../components/NewSessionMachineSelectionContent').NewSessionMachineSelectionContent>;
            if (!React.isValidElement<PickerProps>(picker)) throw new Error('Missing Machine picker');
            const { loadEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
            expect(loadEffectiveHomeViewState()).toMatchObject({ activeTargetKind: 'group', activeTargetId: 'both' });
            const { NewSessionMachineSelectionContent } = await import('../components/NewSessionMachineSelectionContent');
            const pickerScreen = await renderScreen(<InjectedAuthProvider credentials={{ token: homeAToken }}>{picker}</InjectedAuthProvider>);
            try {
                const content = () => pickerScreen.root.findByType(NewSessionMachineSelectionContent);
                await vi.waitFor(() => expect(content().props.groups.map((group: { serverId: string }) => group.serverId)).toContain(homeBScopeId));
                const machine = storage.getState().machineListByServerId[homeBScopeId]?.find((candidate) => candidate.id === 'machine-b');
                if (!machine) throw new Error('Missing Home B fixture');
                await act(async () => content().props.onSelectScopedMachine({ ...machine, serverId: homeBScopeId, serverName: 'Home B' }));
            } finally { await pickerScreen.unmount(); }
            await createHook.rerender();
            const selected = createHook.getCurrent();
            expect(selected.variant === 'simple' ? selected.simpleProps.targetServerId : selected.wizardProps.machine.serverId)
                .toBe(homeBScopeId);
            expect(selected.variant === 'simple' ? selected.simpleProps.selectedPath : selected.wizardProps.machine.selectedPath)
                .toBe('/workspace');
            expect(props.promptStore.getPrompt()).toBe('Keep this newer draft');
        } finally {
            await createHook.unmount();
            routeBoundary.params = { machineId: 'machine-b', directory: '/workspace/project', spawnServerId: homeBScopeId };
        }
    });

    it('does not borrow an active-Home Machine when the exact target Home has no snapshot', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await selectHomeView({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: homeBScopeId,
            groups: [],
        });
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit');
        storage.getState().activateProfileScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().applyMachines([createMachineFixture({
            id: 'machine-b',
            metadata: { displayName: 'Wrong Home Machine', host: 'wrong-home-machine', platform: 'linux', homeDir: '/wrong-home', happyHomeDir: '/wrong-home/.happy', happyCliVersion: 'test' },
        })], true, { sourceServerId: homeAScopeId });
        const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
        await updateEffectiveHomeViewState(() => profiles.loadHomeViewState()!, { scope: 'tab' });
        storage.setState({ machineListByServerId: {} });
        routeBoundary.params = { machineId: 'machine-b', directory: '/workspace/project', spawnServerId: homeBScopeId };
        const createHook = await renderProductionCreateCaller({ activeServerId: homeAScopeId });
        try {
            const model = createHook.getCurrent();
            expect(model.variant === 'simple' ? model.simpleProps.machineName : model.wizardProps.machine.selectedMachine?.metadata?.displayName)
                .not.toBe('Wrong Home Machine');
            expect(model.variant === 'simple' ? model.simpleProps.targetServerId : model.wizardProps.machine.serverId).toBe(homeBScopeId);
            expect(model.variant === 'simple' ? model.simpleProps.canCreate : model.wizardProps.footer.canCreate).toBe(false);
            expect(model.variant === 'simple' ? model.simpleProps.selectedPath : model.wizardProps.machine.selectedPath)
                .toBe('/workspace/project');
            socketBoundary.emits.mockClear();
            await act(async () => { await readProductionCreateAction(model)({ initialMessage: 'skip' }); });
            expect(socketBoundary.emits).not.toHaveBeenCalled();
        } finally {
            await createHook.unmount();
        }
    });

    it('normalizes a rejected route Home without accepting its Machine from another exact Home', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit');
        storage.getState().activateProfileScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-b' })], true, { sourceServerId: homeAScopeId });
        routeBoundary.params = { selectedId: 'machine-b', spawnServerId: homeBScopeId };
        const { useMachinePickerScreenModel } = await import('./machines/useMachinePickerScreenModel');
        const picker = await renderHook(() => useMachinePickerScreenModel());
        try {
            expect(picker.getCurrent().content.props.selectedServerId).toBe(homeAScopeId);
            expect(picker.getCurrent().content.props.selectedMachine).toBeNull();
        } finally {
            await picker.unmount();
        }
    });

    it.each([
        { otherLabel: 'selectable', otherActiveAt: Date.now() },
        { otherLabel: 'offline', otherActiveAt: 1 },
    ])('does not auto-select one Home Machine while another Home has a rendered $otherLabel Machine', async ({ otherActiveAt }) => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await primeMachinePoolsFeature([homeAScopeId, homeBScopeId], false);
        await selectHomeView({
            version: 1,
            activeTargetKind: 'group',
            activeTargetId: 'both',
            groups: [{ id: 'both', name: 'Both', serverIds: [homeAScopeId, homeBScopeId] }],
        });
        const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
        await updateEffectiveHomeViewState(() => profiles.loadHomeViewState()!, { scope: 'tab' });
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit');
        const now = Date.now();
        machineHttpSnapshots.set(new URL(homeA.serverUrl).origin, [createMachineFixture({ id: 'machine-a', activeAt: now, updatedAt: now })]);
        machineHttpSnapshots.set(new URL(homeB.serverUrl).origin, [createMachineFixture({ id: 'machine-b', activeAt: otherActiveAt, updatedAt: otherActiveAt })]);
        storage.getState().activateProfileScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', activeAt: now, updatedAt: now })], true, { sourceServerId: homeAScopeId });
        storage.setState({
            machineListByServerId: {
                [homeBScopeId]: [createMachineFixture({ id: 'machine-b', activeAt: otherActiveAt, updatedAt: otherActiveAt })],
            },
            machineListStatusByServerId: { [homeAScopeId]: 'idle', [homeBScopeId]: 'idle' },
        });
        routeBoundary.params = { draftId: crypto.randomUUID() };
        routeBoundary.replace.mockClear();

        const { useMachinePickerScreenModel } = await import('./machines/useMachinePickerScreenModel');
        const picker = await renderHook(() => useMachinePickerScreenModel());
        try {
            await vi.waitFor(() => {
                expect(picker.getCurrent().content.props.groups).toHaveLength(2);
                expect(
                    picker.getCurrent().content.props.poolGroups.every((group: { projectionReady: boolean }) => group.projectionReady),
                    JSON.stringify({
                        groups: picker.getCurrent().content.props.groups,
                        poolGroups: picker.getCurrent().content.props.poolGroups,
                    }),
                ).toBe(true);
            });
            expect(routeBoundary.replace).not.toHaveBeenCalled();
        } finally {
            await picker.unmount();
        }
    });

    it.each([
        { label: 'cold', cachedPools: undefined },
        { label: 'cached empty', cachedPools: [] },
    ])('does not auto-select one Machine while the $label Pool projection refresh is pending', async ({ cachedPools }) => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
        await updateEffectiveHomeViewState(() => profiles.loadHomeViewState()!, { scope: 'tab' });
        const { buildServerFeaturesResponse } = await import('@/hooks/server/serverFeaturesTestUtils');
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { resetMachinePoolSyncRuntimeForTests } = await import('@/sync/engine/machines/machinePoolSyncRuntime');
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit');
        const features = buildServerFeaturesResponse();
        const featuresWithPools = {
            ...features,
            features: {
                ...features.features,
                machines: { ...features.features.machines, pools: { enabled: true } },
            },
        };
        let releasePoolList!: () => void;
        const poolListGate = new Promise<void>((resolve) => { releasePoolList = resolve; });
        let poolListRequestCount = 0;

        resetMachinePoolSyncRuntimeForTests();
        resetServerFeaturesClientForTests();
        await resetServerReachabilitySupervisors();
        await primeMachinePoolsFeature([homeAScopeId], true);
        setRuntimeFetch(async (input) => {
            const url = String(input);
            socketBoundary.fetches(url);
            if (url.endsWith('/v1/features')) {
                return Response.json(featuresWithPools);
            }
            if (url.endsWith('/v1/machines/pools/list')) {
                poolListRequestCount += 1;
                await poolListGate;
                return Response.json({
                    pools: [{
                        pool: {
                            id: '00000000-0000-4000-8000-000000000001',
                            name: 'Existing pool',
                            description: null,
                            revision: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            members: [],
                        },
                        availability: { state: 'known', connectedCount: 0, enabledCount: 0 },
                    }],
                });
            }
            if (url.endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.endsWith('/v1/auth/ping') || url.endsWith('/health')) return Response.json({ ok: true });
            return Response.json({ ok: false }, { status: 404 });
        });
        storage.getState().activateProfileScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().activateSettingsScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().applySettings(storage.getState().settings, 1);
        storage.getState().applyMachines([createMachineFixture({
            id: 'only-machine',
            activeAt: Date.now(),
            updatedAt: Date.now(),
            metadata: {
                displayName: 'Only Machine',
                host: 'only-machine',
                platform: 'linux',
                happyCliVersion: '0.0.0-test',
                happyHomeDir: '/workspace/.happy',
                homeDir: '/workspace',
            },
        })], true, { sourceServerId: homeAScopeId });
        storage.setState({
            machinePoolListByServerId: cachedPools === undefined ? {} : { [homeAScopeId]: cachedPools },
            machinePoolListStatusByServerId: { [homeAScopeId]: 'idle' },
            machinePoolAccountIdByServerId: cachedPools === undefined ? {} : { [homeAScopeId]: 'account-a' },
        });
        routeBoundary.params = { draftId: crypto.randomUUID() };
        routeBoundary.replace.mockClear();
        const { invalidateMachinePoolProjection } = await import('@/sync/engine/machines/machinePoolProjection');
        const refresh = invalidateMachinePoolProjection(homeAScopeId);
        await vi.waitFor(() => expect(poolListRequestCount).toBeGreaterThan(0));
        const { useMachinePickerScreenModel } = await import('./machines/useMachinePickerScreenModel');
        const picker = await renderHook(() => useMachinePickerScreenModel());
        try {
            const machineIdWhilePending = routeBoundary.params.machineId;
            const replacementsWhilePending = routeBoundary.replace.mock.calls.length;
            expect(picker.getCurrent().content.props.poolGroups[0]?.projectionReady).toBe(false);

            await act(async () => {
                releasePoolList();
                await refresh;
            });
            await vi.waitFor(() => {
                expect(picker.getCurrent().content.props.poolGroups[0]?.pools).toHaveLength(1);
            });
            expect(machineIdWhilePending).toBeUndefined();
            expect(replacementsWhilePending).toBe(0);
            expect(routeBoundary.params.machineId).toBeUndefined();
            expect(routeBoundary.replace).not.toHaveBeenCalled();
        } finally {
            await picker.unmount();
        }
    });

    it('keeps Home removal and push cleanup scoped, then fails the retired explicit B target closed', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await expect(TokenStorage.setCredentialsForServerUrl(
            homeB.serverUrl,
            { serverId: homeBScopeId },
            { token: homeBToken },
        )).resolves.toBe(true);
        const createHook = await renderProductionCreateCaller({
            activeServerId: homeAScopeId,
            targetServerId: homeBScopeId,
        });
        try {
            const { saveLastRegisteredExpoPushToken } = await import('@/sync/domains/state/pushTokenRegistration');
            saveLastRegisteredExpoPushToken('ExponentPushToken[multi-home]');
            socketBoundary.fetches.mockClear();
            const { removeServerProfileUiAction } = await import('@/components/serverProfiles/removeServerProfileUiAction');
            await act(async () => {
                await expect(removeServerProfileUiAction({
                    profileId: homeB.id,
                    serverUrl: homeB.serverUrl,
                })).resolves.toEqual({ kind: 'completed' });
            });
            await expect(TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: homeBScopeId }))
                .resolves.toBeNull();
            await expect(TokenStorage.getCredentialsForServerUrl(homeA.serverUrl, { serverId: homeAScopeId }))
                .resolves.toEqual({ token: homeAToken });
            await vi.waitFor(() => {
                expect(socketBoundary.fetches.mock.calls.some(([url, method]) => method === 'DELETE'
                    && String(url) === `${homeB.serverUrl}/v1/push-tokens/ExponentPushToken%5Bmulti-home%5D`)).toBe(true);
            });
            expect(socketBoundary.fetches.mock.calls.some(([url, method]) => method === 'DELETE'
                && String(url).startsWith(`${homeA.serverUrl}/v1/push-tokens`)),
                JSON.stringify(socketBoundary.fetches.mock.calls))
                .toBe(false);

            expect(profiles.getActiveServerSnapshot().serverId).toBe(homeAScopeId);
            expect(profiles.listServerProfiles().filter((profile) => profile.serverIdentityId === 'srv_home_b')).toHaveLength(0);
            await createHook.rerender();
            const retiredHomeModel = createHook.getCurrent();
            expect(retiredHomeModel.variant === 'simple'
                ? retiredHomeModel.simpleProps.targetServerId
                : retiredHomeModel.wizardProps.machine.serverId).toBe(homeAScopeId);
            socketBoundary.fetches.mockClear();
            socketBoundary.emits.mockClear();
            await act(async () => {
                await readProductionCreateAction(createHook.getCurrent())({ initialMessage: 'skip' });
            });
            expect(socketBoundary.emits).not.toHaveBeenCalled();
            expect(modalBoundary.alert).toHaveBeenCalledWith('common.error', 'newSession.noMachineSelected');
            expect(observabilityBoundary.capture).not.toHaveBeenCalled();
        } finally {
            await createHook.unmount().catch(() => undefined);
        }
    });
});
