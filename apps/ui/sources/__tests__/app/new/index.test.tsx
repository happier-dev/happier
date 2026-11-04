import React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { SESSION_DRAFT_V2_ROUTE_MUTATE, SESSION_DRAFT_V2_ROUTE_READ, SessionDraftMutateRequestV2Schema,
    SessionDraftMutateResponseV2Schema, SessionDraftReadResponseV2Schema,
    SessionDraftRecordV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { SESSION_DRAFT_ROUTE_MUTATE } from '@happier-dev/protocol/drafts/sessionDrafts';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
    tempData: null as Record<string, unknown> | null,
    serverId: 's1',
    resolvedTargetServerId: undefined as string | null | undefined,
    localSearchParams: {
        dataId: 'draft-data-id',
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
    } as {
        dataId?: string;
        spawnServerId?: string;
        draftId?: string;
        draftServerId?: string;
        draftAccountId?: string;
    },
    wizardRenders: 0,
    draftReadScopes: [] as Array<{ serverId: string; accountId: string }>,
    draftDeleteCalls: [] as Array<Readonly<{
        scope: { serverId: string; accountId: string };
        address: { kind: 'newSession'; draftId: string };
    }>>,
    routerPush: vi.fn(),
    routerReplace: vi.fn(),
    routerSetParams: vi.fn(),
}));

function setMockServerId(serverId: string): void {
    mockState.serverId = serverId;
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                        }
    );
});

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));

vi.mock('@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState', () => ({
    useNewSessionServerTargetState: ({ request }: { request: { spawnServerIdParam?: string | null } }) => ({
        targetServerId: typeof request?.spawnServerIdParam === 'string'
            ? request.spawnServerIdParam
            : mockState.resolvedTargetServerId === undefined
                ? mockState.serverId
                : mockState.resolvedTargetServerId,
    }),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        params: mockState.localSearchParams,
        router: {
            push: (...args: unknown[]) => mockState.routerPush(...args),
            replace: (...args: unknown[]) => mockState.routerReplace(...args),
            setParams: (...args: unknown[]) => mockState.routerSetParams(...args),
        },
    });
    return expoRouterMock.module;
});

vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: async () => true } }).module;
});

vi.mock('@/components/sessions/drafts/SessionDraftConflictResolution', () => ({
    SessionDraftConflictResolution: () => React.createElement('ConflictNotice', { testID: 'draft-conflict-notice' }),
    useSessionDraftConflictComposerBanner: () => ({ collapsed: false }),
}));

vi.mock('@/components/sessions/composerBanners/ComposerBannerCollapseProvider', () => ({
    ComposerBannerCollapseProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/sessions/drafts/NewSessionDraftComposerActions', () => ({
    NewSessionDraftComposerActions: (props: Readonly<{
        deleteDisabled: boolean;
        onStartAnother: () => void;
        onDelete: () => Promise<void>;
    }>) => React.createElement(
        'DraftComposerActions',
        props,
        React.createElement('Pressable', {
            testID: 'new-session-draft-start-another',
            onPress: props.onStartAnother,
        }),
        React.createElement('Pressable', {
            testID: 'new-session-draft-delete',
            disabled: props.deleteDisabled,
            onPress: props.onDelete,
        }),
    ),
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
    ICON_SIZE: { xs: 14, sm: 16, md: 18, lg: 20, xl: 24 },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => mockState.tempData,
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionScreenModel', () => ({
    useNewSessionScreenModel: (input: Readonly<{
        composerTopContent?: React.ReactNode;
        draftId: string;
        statusTrailingActions?: React.ReactNode;
    }>) => ({
        variant: 'wizard',
        popoverBoundaryRef: { current: null },
        wizardProps: {
            layout: null,
            sectionPresentation: { machines: 'list' },
            useColumnLayout: true,
            profiles: null,
            agent: null,
            machine: null,
            footer: {
                composerTopContent: input.composerTopContent,
                statusTrailingActions: input.statusTrailingActions,
            },
        },
    }),
}));

vi.mock('@/components/sessions/new/components/NewSessionSimplePanel', () => ({
    NewSessionSimplePanel: 'NewSessionSimplePanel',
}));
// The embedded (Home) presentation's composer card; the /new route never renders it.
vi.mock('@/components/sessions/new/components/NewSessionComposerCard', () => ({
    NewSessionComposerCard: 'NewSessionComposerCard',
}));

vi.mock('@/components/sessions/new/components/NewSessionWizard', () => ({
    NewSessionWizard: (props: Record<string, unknown>) => {
        mockState.wizardRenders += 1;
        const footer = props.footer as Readonly<{
            composerTopContent?: React.ReactNode;
            statusTrailingActions?: React.ReactNode;
        }> | null;
        return React.createElement(
            'NewSessionWizard',
            props,
            footer?.composerTopContent,
            footer?.statusTrailingActions,
        );
    },
}));

vi.mock('@/components/sessions/new/navigation/newSessionContainedModalScreen', () => ({
    NewSessionScreenPortalScope: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/popover', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/popover')>();
    return {
        ...actual,
        PopoverBoundaryProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
        PopoverPortalTargetProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
        PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
    };
});

await loadSyncSingletonForTests();
const disposeActionModuleLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionModuleLoader);
const homes = createHomeGovernanceHarness();
const repository = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { prepareSessionDraftPersistenceStorage, discardSessionDraftPersistenceWrites } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const readDraftSnapshot = repository.getSessionDraftSnapshot;
const deleteDraftWithScopedRuntime = repository.deleteSessionDraftWithScopedRuntime;
vi.spyOn(repository, 'getSessionDraftSnapshot').mockImplementation((scope, address) => {
    mockState.draftReadScopes.push(scope);
    return readDraftSnapshot(scope, address);
});
vi.spyOn(repository, 'deleteSessionDraftWithScopedRuntime').mockImplementation(async input => {
    if (input.address.kind === 'newSession') {
        mockState.draftDeleteCalls.push({ scope: input.scope, address: input.address });
    }
    return deleteDraftWithScopedRuntime(input);
});
const Screen = (await import('@/app/(app)/new')).default;
const { storage } = await import('@/sync/domains/state/storage');
const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');

beforeEach(async () => {
    await prepareSessionDraftPersistenceStorage();
    repository.configureSessionDraftRepository({ syncEnabled: false });
    repository.resetSessionDraftRepositoryForTests();
    actionOperationStore.reset();
    await seedPersistedHomeProfilesForTests({ activeServerId: 's1', profiles: [
        { id: 's1', name: 'Home 1', serverUrl: 'https://api.happier.dev' },
        { id: 's2', name: 'Home 2', serverUrl: 'https://s2.test' },
    ].map(profile => ({ ...profile, createdAt: 1, updatedAt: 1, lastUsedAt: 1, source: 'manual' })) });
    await homes.reset();
    await homes.addHome({ name: 'Home 1', serverUrl: 'https://api.happier.dev',
        accountId: 'account-1', currentAccount: true, active: false });
    await homes.addHome({ name: 'Home 2', serverUrl: 'https://s2.test',
        accountId: 'account-1', currentAccount: true, active: false });
    setMockServerId('s1');
    storage.getState().activateProfileScope({ serverId: 's1', accountId: 'account-1' });
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ isSessionDraftsReady: true });
});

afterEach(async () => {
    await standardCleanup();
    await homes.reset();
    await discardSessionDraftPersistenceWrites();
    const { clearBrowserRecords } = await import('@/sync/domains/state/browserRecordStorage');
    await clearBrowserRecords();
    repository.resetSessionDraftRepositoryForTests();
    actionOperationStore.reset();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.getState().clearProfileScope();
    mockState.tempData = null;
    mockState.serverId = 's1';
    mockState.resolvedTargetServerId = undefined;
    for (const key of Object.keys(mockState.localSearchParams)) {
        delete mockState.localSearchParams[key as keyof typeof mockState.localSearchParams];
    }
    Object.assign(mockState.localSearchParams, {
        dataId: 'draft-data-id',
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
    });
    mockState.wizardRenders = 0;
    mockState.draftReadScopes = [];
    mockState.draftDeleteCalls = [];
    mockState.routerPush.mockReset();
    mockState.routerReplace.mockReset();
    mockState.routerSetParams.mockReset();
});

async function seedConflictingDraft(draftId: string) {
    const scope = { serverId: 's1', accountId: 'account-1' };
    const address = { kind: 'newSession' as const, draftId };
    const values = new Map<string, string>();
    const { createSessionDraftCipher } = await import('@/sync/encryption/sessionDraftEncryption');
    const { getRandomBytes } = await import('@/platform/cryptoRandom');
    const cipher = createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
        getSessionContext: () => null, randomBytes: getRandomBytes });
    const otherDevice = repository.createSessionDraftRepository({ syncEnabled: false, cipher,
        storage: { getString: key => values.get(key), set: (key, value) => { values.set(key, value); },
            delete: key => { values.delete(key); } } });
    otherDevice.writeNewSessionDraft({ scope, draftId, patch: { text: 'Original draft' }, materializationIntent: 'seeded' });
    const base = otherDevice.getSessionDraftSnapshot(scope, address)?.document;
    if (!base) throw new Error('Expected the producer to materialize the base draft');
    let remote = SessionDraftRecordV2Schema.parse({ address, revision: 1,
        content: await cipher.seal(address, base), createdAt: 1, updatedAt: 1 });
    // This is the external draft transport. Both devices still use the real
    // repository serializer, cipher, mutation tokens and conflict reducer.
    repository.configureSessionDraftRepository({ scope, syncEnabled: true, cipher, transport: {
        read: async () => ({ status: 'present', record: remote }),
        list: async () => ({ items: [], nextAfter: undefined }),
        mutate: async () => SessionDraftMutateResponseV2Schema.parse({ status: 'conflict', current: remote }),
    } });
    await repository.materializeExactSessionDraft(scope, address);
    otherDevice.writeNewSessionDraft({ scope, draftId, patch: { text: 'Another device edit' }, materializationIntent: 'userEdit' });
    const newer = otherDevice.getSessionDraftSnapshot(scope, address)?.document;
    if (!newer) throw new Error('Expected the producer to retain the concurrent draft');
    remote = SessionDraftRecordV2Schema.parse({ address, revision: 2,
        content: await cipher.seal(address, newer), createdAt: 1, updatedAt: 2 });
    repository.writeNewSessionDraft({ scope, draftId, patch: { text: 'Resume the migration\nwith tests' }, materializationIntent: 'userEdit' });
    await repository.flushSessionDraft({ scope, address });
    expect(readDraftSnapshot(scope, address)).toMatchObject({ status: 'conflict',
        conflict: { fields: [{ fieldId: 'composer.text', mine: 'Resume the migration\nwith tests', synced: 'Another device edit' }] } });
    repository.configureSessionDraftRepository({ syncEnabled: false });
}

describe('/new', () => {
    // 58d AF1: with no machine yet, New Session is the same composer as first-run Home; its
    // "Run on…" picker offers creating one or using one you have. No setup page replaces it.
    it('opens the composer, not machine setup, once the Home is known to have no machines', async () => {
        const previous = storage.getState();
        try {
            storage.setState({ isDataReady: true, machines: {},
                machineListByServerId: { s1: [], s2: [] }, machineListStatusByServerId: {} });

            const screen = await renderScreen(React.createElement(Screen));

            expect(() => screen.findByType('NewSessionWizard')).not.toThrow();
            expect(() => screen.findByType('SessionGettingStartedGuidance')).toThrow();
        } finally {
            storage.setState({ machines: previous.machines, machineListByServerId: previous.machineListByServerId,
                machineListStatusByServerId: previous.machineListStatusByServerId });
        }
    });

    it.each([
        { intent: 'worktree draft', tempData: { workspaceId: 'workspace-1', workspaceLocationId: 'location-1',
            checkoutCreationDraft: { kind: 'git_worktree', displayName: 'feature-x', baseRef: 'main' } } },
        { intent: 'machine', tempData: { machineId: 'machine-1' } },
    ])('keeps the wizard path when temp data seeds a $intent intent', async ({ tempData }) => {
        setMockServerId('s1');
        mockState.tempData = tempData;

        const screen = await renderScreen(React.createElement(Screen));

        expect(() => screen.findByType('NewSessionWizard')).not.toThrow();
        expect(() => screen.findByType('SessionGettingStartedGuidance')).toThrow();
    });

    it('opens a materialized draft without duplicate context copy and places conflict plus actions beside the composer', async () => {
        await seedConflictingDraft(mockState.localSearchParams.draftId!);

        const screen = await renderScreen(React.createElement(Screen));

        expect(() => screen.findByProps({ testID: 'session-draft-context' })).toThrow();
        expect(screen.findByProps({ testID: 'draft-conflict-notice' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'new-session-draft-start-another' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'new-session-draft-delete' }).props.disabled).toBe(false);

        await pressTestInstanceAsync(screen.findByProps({ testID: 'new-session-draft-start-another' }));
        expect(mockState.routerReplace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
                draftOrigin: 'ordinary',
            },
        });
        expect(mockState.routerPush).not.toHaveBeenCalled();
    });

    it('ignores unrelated Action operation updates while retaining exact launch custody', async () => {
        const draftId = mockState.localSearchParams.draftId!;
        repository.writeNewSessionDraft({ scope: { serverId: 's1', accountId: 'account-1' },
            draftId, patch: {}, materializationIntent: 'seeded' });
        repository.writeSessionDraftLocalSupplement({ scope: { serverId: 's1', accountId: 'account-1' },
            address: { kind: 'newSession', draftId }, patch: { launchUserAttemptId: 'draft-launch' } });

        const screen = await renderScreen(React.createElement(Screen));
        const rendersBeforeActionUpdates = mockState.wizardRenders;
        expect(screen.findByProps({ testID: 'new-session-draft-delete' }).props.disabled).toBe(false);

        React.act(() => actionOperationStore.mergeSnapshots({
            serverId: 's1',
            snapshots: [{
                version: 1,
                operationId: 'unrelated-operation',
                revision: 1,
                requestId: 'unrelated-request',
                actionId: 'projects.list',
                state: 'succeeded',
                scope: { accountId: 'account-1', machineId: 'machine-1' },
                title: 'List projects',
                createdAt: 10,
                settledAt: 11,
                cancellation: 'unsupported',
            }],
        }));

        expect(mockState.wizardRenders).toBe(rendersBeforeActionUpdates);

        React.act(() => actionOperationStore.mergeSnapshots({
            serverId: 's1',
            snapshots: [{
                version: 1,
                operationId: 'matching-launch',
                revision: 1,
                requestId: 'draft-launch',
                actionId: 'session.spawn_new',
                state: 'accepted',
                scope: { accountId: 'account-1', machineId: 'machine-1' },
                title: 'Create session',
                createdAt: 20,
                cancellation: 'unsupported',
            }],
        }));

        expect(mockState.wizardRenders).toBeGreaterThan(rendersBeforeActionUpdates);
        expect(screen.findByProps({ testID: 'new-session-draft-delete' }).props.disabled).toBe(true);
    });

    it('reopens and deletes a waiting draft through its route-qualified inactive Home Account', async () => {
        const draftId = '8e0a5dd1-b1df-43dd-b51e-b7787b30362e';
        await homes.reset();
        await seedPersistedHomeProfilesForTests({
            activeServerId: 'home-a',
            profiles: ['home-a', 'home-b'].map(id => ({ id, name: id, serverUrl: `https://${id}.test`,
                createdAt: 1, updatedAt: 1, lastUsedAt: 1, source: 'manual' })),
        });
        await homes.addHome({ name: 'Home A', serverUrl: 'https://home-a.test',
            accountId: 'account-1', currentAccount: true, active: false });
        await homes.addHome({ name: 'Home B', serverUrl: 'https://home-b.test',
            accountId: 'account-b', currentAccount: true, active: false });
        const features = createRootLayoutFeaturesResponse();
        if (!tryWriteServerEnabledBitInPlace(features, 'sessions.drafts', true)) {
            throw new Error('Expected the canonical drafts feature fixture');
        }
        homes.answer('home-b', '/v1/features', { body: features });
        homes.answer('home-b', '/v1/features/authenticated', { body: features });
        homes.answer('home-b', `POST ${SESSION_DRAFT_V2_ROUTE_READ}`, {
            body: SessionDraftReadResponseV2Schema.parse({ status: 'absent' }),
        });
        for (const path of [SESSION_DRAFT_ROUTE_MUTATE, SESSION_DRAFT_V2_ROUTE_MUTATE]) {
            homes.answer('home-b', `POST ${path}`, { select: input => {
                const request = SessionDraftMutateRequestV2Schema.parse(input);
                expect(request.address).toEqual({ kind: 'newSession', draftId });
                expect(request.content).toBeNull();
                return { body: SessionDraftMutateResponseV2Schema.parse({ status: 'updated', record: {
                    address: request.address, revision: 1, content: null, createdAt: 1, updatedAt: 2,
                } }) };
            } });
        }
        setMockServerId('home-a');
        storage.getState().activateProfileScope({ serverId: 'home-a', accountId: 'account-1' });
        storage.setState({ isSessionDraftsReady: false });
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        for (const key of Object.keys(mockState.localSearchParams)) {
            delete mockState.localSearchParams[key as keyof typeof mockState.localSearchParams];
        }
        Object.assign(mockState.localSearchParams, {
            draftId,
            spawnServerId: 'home-b',
            draftServerId: 'home-b',
            draftAccountId: 'account-b',
        });
        repository.writeNewSessionDraft({ scope: { serverId: 'home-b', accountId: 'account-b' },
            draftId, patch: { text: 'Waiting for computer' }, materializationIntent: 'seeded' });
        repository.writeNewSessionDraft({ scope: { serverId: 'home-a', accountId: 'account-1' },
            draftId, patch: { text: 'Other Home draft' }, materializationIntent: 'seeded' });

        const Screen = (await import('@/app/(app)/new')).default;
        const screen = await renderScreen(React.createElement(Screen));

        await vi.waitFor(async () => {
            await act(async () => {});
            expect(screen.findByProps({ testID: 'new-session-draft-delete' }).props.disabled).toBe(false);
        });
        expect(mockState.draftReadScopes).toContainEqual({ serverId: 'home-b', accountId: 'account-b' });
        expect(mockState.draftReadScopes).not.toContainEqual({ serverId: 'home-a', accountId: 'account-1' });

        await pressTestInstanceAsync(screen.findByProps({ testID: 'new-session-draft-delete' }));

        expect(mockState.draftDeleteCalls).toEqual([{
            scope: { serverId: 'home-b', accountId: 'account-b' },
            address: { kind: 'newSession', draftId },
        }]);
        expect(readDraftSnapshot({ serverId: 'home-b', accountId: 'account-b' }, { kind: 'newSession', draftId })).toBeNull();
        expect(readDraftSnapshot({ serverId: 'home-a', accountId: 'account-1' }, { kind: 'newSession', draftId }))
            .toMatchObject({ document: { composer: { text: { value: 'Other Home draft' } } } });
        expect(homes.requests.some(request => request.serverId === 'home-b'
            && (request.path === SESSION_DRAFT_ROUTE_MUTATE || request.path === SESSION_DRAFT_V2_ROUTE_MUTATE)))
            .toBe(true);
    });
});
