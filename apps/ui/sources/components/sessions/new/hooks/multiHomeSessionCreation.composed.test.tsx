import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';
import 'fake-indexeddb/auto';

import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { renderHook } from '@/dev/testkit';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { SessionSpawnNewResultV1, SessionAuthoringCheckoutCreationDraftV1 } from '@happier-dev/protocol';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

installTokenStorageWebPlatformMocks();

const socketBoundary = vi.hoisted(() => ({
    connects: vi.fn(),
    emits: vi.fn(),
    fetches: vi.fn(),
    result: null as SessionSpawnNewResultV1 | null,
    controls: new Map<string, Readonly<{ disconnect: () => void; reconnect: () => void }>>(),
}));
const modalBoundary = vi.hoisted(() => ({
    alert: vi.fn(),
    confirm: vi.fn(async () => false),
}));
const observabilityBoundary = vi.hoisted(() => ({ capture: vi.fn() }));
const routeBoundary = vi.hoisted(() => ({
    params: {} as Record<string, string | undefined>,
    replace: vi.fn(),
}));

vi.mock('@/text', async () => createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@/modal', () => ({ Modal: modalBoundary }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const router = createExpoRouterMock({
        params: () => routeBoundary.params,
        pathname: '/new',
        navigation: { dispatch: vi.fn(), getState: () => undefined },
        router: { replace: routeBoundary.replace, setParams: (params) => { Object.assign(routeBoundary.params, params); } },
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
    return `${encode({ alg: 'none' })}.${encode({ sub: accountId })}.signature`;
}

// Collect the real cold module graph after installing its platform boundaries.
// Imports are setup work, not part of the timed Home/creation behavior.
const localStorageHandle: LocalStorageMockHandle = installLocalStorageMock();
const navigatorLocksDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
        // Web Locks admits both `request(name, callback)` and `request(name, options, callback)`.
        request: async function request<T>(
            _name: string,
            optionsOrCallback: LockOptions | (() => T | Promise<T>),
            maybeCallback?: () => T | Promise<T>,
        ): Promise<T> {
            const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
            if (!callback) throw new Error('navigator.locks.request stub requires a callback');
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
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();

describe('multi-Home Session creation composition', () => {

    beforeEach(async () => {
        socketBoundary.result = null;
        routeBoundary.replace.mockClear();
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
        } = await import('@happier-dev/protocol');
        const { buildServerFeaturesResponse } = await import('@/hooks/server/serverFeaturesTestUtils');
        const features = buildServerFeaturesResponse();
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const authoringMemoryHttp = createAuthoringMemoryHttpBoundary();
        setRuntimeFetch(async (input, init) => {
            const authoringResponse = await authoringMemoryHttp.handle(input, init);
            if (authoringResponse) return authoringResponse;
            const url = String(input);
            socketBoundary.fetches(url);
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
            if (url.includes('/v1/machines/machine-b')) {
                return Response.json({
                    machine: { id: 'machine-b', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
                });
            }
            if (url.endsWith('/v1/machines/pools/list')) return Response.json({ pools: [] });
            if (url.endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.endsWith('/v2/account/settings') && (!init?.method || init.method === 'GET')) return Response.json({ content: null, version: 1 });
            if (url.endsWith('/v1/auth/ping') || url.endsWith('/health')) return Response.json({ ok: true });
            return Response.json({ ok: false }, { status: 404 });
        });
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

    async function arrangeFocusedHomeA(fixtureSuffix = '') {
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
        await profiles.saveHomeViewState({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: homeAScopeId,
            groups: [{ id: `home-a-group${urlSuffix}`, name: 'Home A', serverIds: [homeAScopeId] }],
        });
        await sync!.switchServer({ token: homeAToken });
        return { profiles, homeA, homeAScopeId, homeAToken };
    }

    let draftSequence = 0;
    async function renderProductionCreateCaller(params: Readonly<{
        activeServerId: string;
        accountId?: string;
        targetServerId?: string;
        draftId?: string;
    }>) {
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().activateProfileScope({ serverId: params.activeServerId, accountId: params.accountId ?? 'account-a' });
        await storage.getState().activateSettingsScope({ serverId: params.activeServerId, accountId: params.accountId ?? 'account-a' });
        storage.getState().applySettings(storage.getState().settings, 1);
        if (params.targetServerId) {
            storage.getState().applyMachines([
                createMachineFixture({
                    id: 'machine-b',
                    metadata: {
                        host: 'home-b-machine',
                        platform: 'linux',
                        happyCliVersion: '0.0.0-test',
                        happyHomeDir: '/workspace/.happy',
                        homeDir: '/workspace',
                    },
                }),
            ], true, { sourceServerId: params.targetServerId });
        }
        const draftId = params.draftId ?? `multi-home-composed-draft-${++draftSequence}`;
        const activeProfile = profiles.getServerProfileById(params.activeServerId);
        if (!activeProfile) throw new Error('Creation fixture has no active Home profile');
        const credentials = await TokenStorage.getCredentialsForServerUrl(activeProfile.serverUrl, { serverId: params.activeServerId });
        if (!credentials) throw new Error('Creation fixture has no active Home credentials');
        return await renderHook(() => useNewSessionScreenModel({ draftId }), {
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

    it('reopens a Temporary computer draft without selecting or dispatching to an available Machine', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = {};
        const draftId = `temporary-composed-draft-${++draftSequence}`;
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
        const draftId = `temporary-cross-home-ref-${++draftSequence}`;
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
        await profiles.saveHomeViewState({
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
            // The exact Home's Machine transport may already be cached. Any
            // additional HTTP must stay scoped; the spawn envelope below proves dispatch.
            expect(socketBoundary.fetches.mock.calls
                .every(([url]) => String(url).startsWith(homeB.serverUrl))).toBe(true);
            expect(socketBoundary.emits).toHaveBeenCalledTimes(1);
            expect(socketBoundary.emits.mock.calls[0]?.[0]).toMatchObject({
                serverUrl: homeB.serverUrl,
                token: homeBToken,
                payload: {
                    method: 'machine-b:session.spawnNew',
                    params: { executionTarget: { serverId: homeBScopeId, machineId: 'machine-b' } },
                },
            });
            expect(modalBoundary.alert).toHaveBeenCalledWith('common.error', 'newSession.failedToStart');
            expect(observabilityBoundary.capture).not.toHaveBeenCalled();
            expect(storage.getState().authoringMemory.recentMachinePaths).toEqual(originalPaths);
        } finally {
            await createHook.unmount().catch(() => undefined);
        }
    });

    it.each([false, true])('retains exact-Home pending launch custody with checkout selection %s', async (withCheckout) => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await profiles.saveHomeViewState({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
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
            const first = SessionSpawnNewInputV2Schema.parse(socketBoundary.emits.mock.calls[0]?.[0]?.payload?.params);
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
            expect(socketBoundary.emits).toHaveBeenCalledTimes(2);
            const retry = SessionSpawnNewInputV2Schema.parse(socketBoundary.emits.mock.calls[1]?.[0]?.payload?.params);
            expect(retry.creationKey).toBe(first.creationKey);
            expect(retry.checkoutCreationDraft).toEqual(checkoutDraft);
            expect(retry.executionTarget).toEqual(first.executionTarget);
        } finally {
            await createHook.unmount();
        }
    });

    it('preserves the creator after an accepted spawn when attachment follow-up fails', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await profiles.saveHomeViewState({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
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
            expect(socketBoundary.emits).toHaveBeenCalledOnce();
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
        await profiles.saveHomeViewState({
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
        await profiles.saveHomeViewState({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
        await profiles.setActiveServerId(homeBScopeId, { scope: 'device' });
        await profiles.setActiveServerId(homeBScopeId, { scope: 'tab' });
        await sync!.switchServer({ token: homeBToken });
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
            expect(socketBoundary.emits).toHaveBeenCalledOnce();
            await vi.waitFor(() => expect(storage.getState().authoringMemory.recentMachinePaths[0]).toEqual({ machineId: 'machine-b', path: '/same-home/project' }));
        } finally {
            await createHook.unmount();
        }
    });

    it('places an embedded surface from its host\'s own params and writes placement back to the host, never the route', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await profiles.saveHomeViewState({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
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
        const createHook = await renderHook(
            () => useNewSessionScreenModel({ draftId: `multi-home-composed-draft-${++draftSequence}` }),
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
        await profiles.saveHomeViewState({
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
            expect(picker.props.groups.map((group) => group.serverId)).toContain(homeBScopeId);
            const machine = storage.getState().machineListByServerId[homeBScopeId]?.find((candidate) => candidate.id === 'machine-b');
            if (!machine) throw new Error('Missing Home B fixture');
            await act(async () => picker.props.onSelectScopedMachine({ ...machine, serverId: homeBScopeId, serverName: 'Home B' }));
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
        await profiles.saveHomeViewState({
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
            if (model.variant === 'simple') expect(model.simpleProps.machineName).toBe('machine-b');
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
        await profiles.saveHomeViewState({
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
        storage.getState().activateProfileScope({ serverId: homeAScopeId, accountId: 'account-a' });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', activeAt: now, updatedAt: now })], true, { sourceServerId: homeAScopeId });
        storage.setState({
            machineListByServerId: {
                [homeBScopeId]: [createMachineFixture({ id: 'machine-b', activeAt: otherActiveAt, updatedAt: otherActiveAt })],
            },
            machineListStatusByServerId: { [homeAScopeId]: 'idle', [homeBScopeId]: 'idle' },
        });
        routeBoundary.params = { draftId: 'multiple-rendered-machines' };
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
        routeBoundary.params = { draftId: `pending-pool-${cachedPools === undefined ? 'cold' : 'cached'}` };
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
                expect(socketBoundary.fetches.mock.calls.some(([url]) =>
                    String(url) === `${homeB.serverUrl}/v1/push-tokens/ExponentPushToken%5Bmulti-home%5D`)).toBe(true);
            });
            expect(socketBoundary.fetches.mock.calls.some(([url]) => String(url).startsWith(`${homeA.serverUrl}/v1/push-tokens`)))
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
            expect(socketBoundary.fetches.mock.calls.every(([url]) => String(url) === `${homeA.serverUrl}/v1/features`)).toBe(true);
            expect(socketBoundary.emits).not.toHaveBeenCalled();
            expect(modalBoundary.alert).toHaveBeenCalledWith('common.error', 'newSession.failedToStart');
            expect(observabilityBoundary.capture).not.toHaveBeenCalled();
        } finally {
            await createHook.unmount().catch(() => undefined);
        }
    });
});
