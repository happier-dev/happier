import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';
import 'fake-indexeddb/auto';

import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createDeferred, renderHook } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import type { SessionSpawnNewResultV1, SessionAuthoringCheckoutCreationDraftV1 } from '@happier-dev/protocol';
import type { HomeViewStateV1, ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

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
    controls: new Map<string, Readonly<{ disconnect: () => void; reconnect: () => void }>>(),
}));
const modalBoundary = vi.hoisted(() => ({
    alert: vi.fn((..._args: unknown[]) => { modalBoundary.alertStacks.push(new Error('Alert boundary').stack); }),
    alertStacks: [] as Array<string | undefined>,
    confirm: vi.fn(async () => false),
    show: vi.fn((_params: unknown) => 'composed-modal'),
}));
const observabilityBoundary = vi.hoisted(() => ({ capture: vi.fn() }));
const routeBoundary = vi.hoisted(() => ({
    params: {} as Record<string, string | undefined>,
    push: vi.fn(),
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
let sessionHttpBoundary: ((url: string, init?: RequestInit) => Response | null) | null = null;
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
        setRuntimeFetch(async (input, init) => {
            const authoringResponse = await authoringMemoryHttp.handle(input, init);
            if (authoringResponse) return authoringResponse;
            const url = String(input);
            socketBoundary.fetches(url, init?.method ?? 'GET');
            const artifactResponse = artifactHttpBoundary?.(url, init);
            if (artifactResponse) return await artifactResponse;
            const sessionResponse = sessionHttpBoundary?.(url, init);
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
            if (url.endsWith('/v1/machines/machine-b')) {
                return Response.json({
                    machine: { id: 'machine-b', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER },
                });
            }
            if (url.endsWith('/v1/machines/pools/list')) return Response.json({ pools: [] });
            if (url.endsWith('/v1/machines')) return Response.json((machineHttpSnapshots.get(new URL(url).origin) ?? []).map((machine) => ({
                ...machine, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                metadata: encodePlainMachineStoredContent(machine.metadata),
                daemonState: machine.daemonState ? encodePlainMachineStoredContent(machine.daemonState) : null,
            })));
            if (url.endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.endsWith('/v1/account/encryption/currentness')) return Response.json({ mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (url.endsWith('/v1/account/entity-rows/prompt-library')) return Response.json({ rows: [] });
            if (url.endsWith('/v2/account/settings') && (!init?.method || init.method === 'GET')) return Response.json({
                content: accountHttpSettings ? { t: 'plain', v: accountHttpSettings } : null, version: 1 });
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
        await selectHomeView({
            version: 1,
            activeTargetKind: 'server',
            activeTargetId: homeAScopeId,
            groups: [{ id: `home-a-group${urlSuffix}`, name: 'Home A', serverIds: [homeAScopeId] }],
        });
        await sync!.switchServer({ token: homeAToken });
        // The app connection owner publishes the applied runtime after Sync
        // finishes. This harness drives that same producer, not the scope reader.
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        publishAppliedActiveServerSnapshot(profiles.getActiveServerSnapshot());
        return { profiles, homeA, homeAScopeId, homeAToken };
    }

    let draftSequence = 0;
    async function renderProductionCreateCaller(params: Readonly<{
        activeServerId: string;
        accountId?: string;
        targetServerId?: string;
        draftId?: string;
        mountTemporaryController?: boolean;
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
        const draftId = params.draftId ?? `multi-home-composed-draft-${++draftSequence}`;
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

    it('exposes a leaf-local Bot name editor that persists edits and reopens an automatic empty title', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = {};
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = `bot-name-composed-${++draftSequence}`;
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

    it('keeps Instructions editing local and reopens the authored draft without creating an Artifact', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = {};
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = `instructions-local-composed-${++draftSequence}`;
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

    it.each([false, true])('keeps a late Instructions Save in its captured draft and preserves newer authoring (replaceDraft=%s)', async replaceDraft => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        routeBoundary.params = {};
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const firstId = `instructions-save-first-${++draftSequence}`;
        const secondId = `instructions-save-second-${++draftSequence}`;
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
        const draftId = `instructions-account-retired-${++draftSequence}`;
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
        const draftId = `instructions-send-account-retired-${++draftSequence}`;
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
        const draftId = `routed-source-admission-${sourceState}-${++draftSequence}`;
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
        const draftId = `instructions-clear-handoff-${++draftSequence}`;
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

    it('captures the initiating target Account before temporary artifact acquisition can outlive its credential', async () => {
        // The first genuine Home baseline owns this preference. Re-publishing
        // changed bytes at the same Settings revision would correctly be ignored.
        accountHttpSettings = { useEnhancedSessionWizard: true };
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA('temporary-account-capture'));
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
        const { TeamsPageV1Schema, TeamCredentialResourceEntitledPageV1Schema,
            NO_TEAM_CAPABILITIES_V1, resolveTeamAdmissionProjectionV1 } = await import('@happier-dev/protocol/teams');
        const { RunnerArtifactAvailabilityProjectionV1Schema } = await import('@happier-dev/protocol/ephemeralRunner/runnerArtifact');
        const { EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1, EPHEMERAL_RUNNER_ACTIVATIONS_PATH_V1 } = await import('@happier-dev/protocol/ephemeralRunner/routes');
        const { writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const scope = { serverId: homeBScopeId, accountId: 'account-a' };
        const draftId = `temporary-account-capture-${++draftSequence}`;
        routeBoundary.params = { spawnServerId: homeBScopeId, draftServerId: homeBScopeId, draftAccountId: scope.accountId,
            backendTargetKey: 'agent:happier.agent.codex/codex' };
        writeNewSessionDraft({ scope, draftId, materializationIntent: 'userEdit', patch: {
            text: 'Prepare on the original target Account', authoring: { agentTarget: { kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, profileId: null,
                executionTarget: { kind: 'temporary_computer', serverId: homeBScopeId,
                    artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' } } },
        } });
        const features = buildServerFeaturesResponse();
        for (const id of ['sessions.ephemeralRunner', 'teams', 'teams.credentialResources'] as const) {
            expect(tryWriteServerEnabledBitInPlace(features, id, true)).toBe(true);
        }
        const teams = TeamsPageV1Schema.parse({ items: [{ id: 'runner-team', name: 'Runner team', description: null,
            logo: null, archivedAt: null, recovery: null, viewerRole: 'member', counts: null,
            capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true }, admission: resolveTeamAdmissionProjectionV1(),
            policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
                defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null } }], nextCursor: null });
        const entitled = TeamCredentialResourceEntitledPageV1Schema.parse({ resources: [{ id: 'runner-resource', teamId: 'runner-team',
            displayName: 'Runner model', resourceRevision: 7, readiness: { kind: 'available' }, recoveryAction: null,
            mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
            providerModels: [{ selection: { kind: 'team_credential_provider_model', resourceId: 'runner-resource', teamId: 'runner-team',
                expectedResourceRevision: 7, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5', deliveryMode: 'brokered' },
                descriptor: { id: 'gpt-5', name: 'GPT-5' }, application: { agentTargetKey: 'agent:happier.agent.codex/codex',
                    implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai_responses' },
                sourceRevision: 'runner-source-7', availability: 'available' }], sourcePresentation: { kind: 'provider',
                provider: { identity: { pluginId: 'happier.provider.openai', localId: 'openai' }, definitionRevision: 1 } } }] });
        const publication = RunnerArtifactAvailabilityProjectionV1Schema.parse({ status: 'available', artifacts: [{
            identity: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) }, channel: 'stable',
            url: 'https://runner-publication.test/happier-runner-v0.3.0-linux-x64.zip',
            checksumsUrl: 'https://runner-publication.test/checksums.txt', checksumsSignatureUrl: 'https://runner-publication.test/checksums.txt.minisig',
            sizeBytes: 1, entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 1, mode: 0o755 }] }] });
        const teamPath = bindHomeDomainActionHttpRequestV1('teams.list', { v: 1, scope: 'member', archived: 'active', cursor: null }).path;
        const resourcesPath = bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId: 'runner-team' }).path;
        const initiatingAccountReads: string[] = [];
        const activationEffects: string[] = [];
        sessionHttpBoundary = (url, init) => {
            const parsed = new URL(url);
            if (parsed.pathname === '/v1/features' || parsed.pathname === '/v1/features/authenticated') return Response.json({ ...features,
                capabilities: { ...features.capabilities, accountStoredContentCompatibility: { v: 1,
                    minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    declarationTransport: 'http-header-and-socket-auth-v1' } } });
            if (`${parsed.pathname}${parsed.search}` === teamPath) return Response.json(teams);
            if (`${parsed.pathname}${parsed.search}` === resourcesPath) return Response.json(entitled);
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
            draftId, mountTemporaryController: true });
        let sending: Promise<void> | undefined;
        try {
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                expect(model.variant).toBe('wizard');
                if (model.variant === 'wizard') expect(model.wizardProps.agent.teamCredentialResources).toHaveLength(1);
            });
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                if (model.variant !== 'wizard') throw new Error('Expected the production Agent selector');
                expect(model.wizardProps.agent.agentPickerSelectedOptionId).toBe(entitled.resources[0]!.providerModels[0]!.selection.agentTargetKey);
            });
            await act(async () => {
                const model = hook.getCurrent();
                if (model.variant !== 'wizard') throw new Error('Expected the production model selector');
                await model.wizardProps.agent.onSelectTeamCredentialModel(entitled.resources[0]!.providerModels[0]!.selection);
            });
            // Finish public selection and its background projections before
            // observing the distinct Send → preparation HTTP phase.
            await hook.rerender();
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                expect(model.variant === 'wizard' ? model.wizardProps.footer.canCreate : model.simpleProps.canCreate).toBe(true);
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
            checksums.resolve(new Response('Unavailable publication', { status: 503 }));
            await sending?.catch(() => undefined);
            await hook.unmount();
            publicationFetch.mockRestore();
        }
    });

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
                .filter(([url]) => new URL(String(url)).pathname.startsWith('/v1/machines/machine-b'))
                .every(([url]) => new URL(String(url)).origin === new URL(homeB.serverUrl).origin)).toBe(true);
            expect(socketBoundary.emits).toHaveBeenCalledTimes(1);
            expect(socketBoundary.emits.mock.calls[0]?.[0]).toMatchObject({
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

    it('explicit Send retains the reopened original Project destination on the created owner tuple after editing the launch Home and folder', async () => {
        ({ homeA, homeAScopeId, homeAToken } = await arrangeFocusedHomeA());
        await arrangeHomeB();
        await selectHomeView({ version: 1, activeTargetKind: 'server', activeTargetId: homeBScopeId, groups: [] });
        const { writeNewSessionDraftToRepository, readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { createSessionAccessFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { SessionCurrentProjectionRecordV1Schema, SessionSpawnNewInputV2Schema } = await import('@happier-dev/protocol');
        const { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1,
            SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1');
        const scope = { serverId: homeAScopeId, accountId: 'account-a' };
        const draftId = `origin-send-composed-${++draftSequence}`;
        const origin = { kind: 'project', accountId: scope.accountId, page: 'changes', comparisonId: 'original-comparison',
            workspace: { serverId: homeAScopeId, workspaceId: 'original-workspace', machineId: 'original-machine', rootPath: '/original/project' } } as const;
        const draft = { input: 'Review the original changes', selectedMachineId: 'original-machine', selectedPath: '/original/project',
            targetServerId: homeAScopeId, selectedProfileId: null, selectedSecretId: null, agentType: 'codex',
            permissionMode: 'default', acpSessionModeId: null, updatedAt: 1, authoringOrigin: origin,
            executionTarget: { kind: 'machine', target: { serverId: homeAScopeId, machineId: 'original-machine' } } } as const;
        writeNewSessionDraftToRepository({ scope, draftId, draft });
        resetSessionDraftRepositoryForTests();
        const reopened = readNewSessionDraftFromRepository({ scope, draftId });
        if (!reopened) throw new Error('Expected the persisted authoring draft');
        writeNewSessionDraftToRepository({ scope, draftId, draft: { ...reopened, targetServerId: homeBScopeId,
            selectedMachineId: 'machine-b', selectedPath: '/edited/project',
            executionTarget: { kind: 'machine', target: { serverId: homeBScopeId, machineId: 'machine-b' } } } });
        resetSessionDraftRepositoryForTests();
        routeBoundary.params = {};
        const metadata = { path: '/edited/project', host: 'home-b-machine', machineId: 'machine-b', flavor: 'codex',
            work: { memoryEnabled: false, viewPreferences: { showToolCalls: true } } };
        const admitted = createSessionOwnerMetadataV1({ metadata });
        if (!admitted.ok) throw new Error('Expected admitted created Session metadata');
        let record = SessionCurrentProjectionRecordV1Schema.parse({
            id: 'created-origin-send', createdAt: 1, updatedAt: 1, seq: 0, active: false, activeAt: 0,
            encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 1,
            metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(admitted.ownerMetadata),
            agentStateVersion: 0, agentState: null, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
            responsibleAccountId: null, responsibleAccount: null,
        });
        const writes: Array<{ url: string; patch: ReturnType<typeof SessionMetadataTuplePatchV1Schema.parse> }> = [];
        sessionHttpBoundary = (url, init) => {
            if (new URL(url).pathname !== '/v2/sessions/created-origin-send') return null;
            expect(new URL(url).origin).toBe(new URL(homeB.serverUrl).origin);
            expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${homeBToken}`);
            if (init?.method === 'PATCH') {
                const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
                if (patch.mode !== 'owner') throw new Error('Expected the owner-private tuple writer');
                writes.push({ url, patch });
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
        const createHook = await renderProductionCreateCaller({ activeServerId: homeAScopeId, targetServerId: homeBScopeId, draftId });
        try {
            expect(readNewSessionDraftFromRepository({ scope, draftId })?.authoringOrigin).toEqual(origin);
            expect(writes).toHaveLength(0);
            expect(socketBoundary.emits.mock.calls.filter(([request]) =>
                request.payload?.method?.endsWith(':session.spawnNew'))).toHaveLength(0);
            socketBoundary.result = { type: 'success', disposition: 'created', sessionId: record.id,
                executionTarget: { serverId: homeBScopeId, machineId: 'machine-b' },
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'accepted', localId: 'origin-first-turn' } };
            socketBoundary.emits.mockClear();
            await act(async () => { await readProductionCreateAction(createHook.getCurrent())(); });
            const spawn = socketBoundary.emits.mock.calls.find(([request]) => request.payload?.method === 'machine-b:session.spawnNew');
            expect(spawn, JSON.stringify({ alerts: modalBoundary.alert.mock.calls,
                alertStacks: modalBoundary.alertStacks,
                errors: observabilityBoundary.capture.mock.calls.map(([error]) => error instanceof Error ? error.stack : error),
                requests: socketBoundary.fetches.mock.calls })).toBeDefined();
            expect(SessionSpawnNewInputV2Schema.parse(spawn?.[0]?.payload?.params)).toMatchObject({
                executionTarget: { serverId: homeBScopeId, machineId: 'machine-b' },
                directory: { kind: 'path', path: '/edited/project' },
                initialInput: { text: draft.input },
            });
            expect(record.ownerMetadata).toMatchObject({ t: 'plain', v: { work: {
                memoryEnabled: false, viewPreferences: { showToolCalls: true }, authoringOriginV1: origin,
            } } });
            expect(writes.some(({ patch }) => patch.mode === 'owner' && patch.ownerMetadata.t === 'plain'
                && patch.ownerMetadata.v.work?.authoringOriginV1?.comparisonId === origin.comparisonId)).toBe(true);
            expect(record.metadata).not.toContain('original-comparison');
            expect(record.metadata).not.toContain('/original/project');
            expect(routeBoundary.replace).toHaveBeenCalled();
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
        const draftId = `origin-cold-materialized-${++draftSequence}`;
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
                environmentVariables: null, mcpSelection: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] },
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
            expect(socketBoundary.emits).toHaveBeenCalledOnce();
            await vi.waitFor(() => expect(storage.getState().authoringMemory.recentMachinePaths[0]).toEqual({ machineId: 'machine-b', path: '/same-home/project' }));
        } finally {
            await createHook.unmount();
        }
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
