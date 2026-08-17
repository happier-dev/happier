import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
    ExternalSessionOperationProgressV1Schema,
    ExternalSessionOperationSharedPresentationV1Schema,
} from '@happier-dev/protocol';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    session: {} as Record<string, any>,
    itemProps: [] as Array<Record<string, any>>,
    friendDialog: null as Record<string, any> | null,
    shareDialog: null as Record<string, any> | null,
    publicDialog: null as Record<string, any> | null,
    encryptPublicDataKey: vi.fn(),
    modalAlert: vi.fn(),
    modalHide: vi.fn(),
    sessionListeners: new Set<() => void>(),
    machine: null as Machine | null,
    scopedMachine: null as Machine | null,
    machineListByServerId: {} as Record<string, Machine[] | null>,
    machineListStatusByServerId: {} as Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>,
    profileScope: null as Record<string, any> | null,
    profileScopeListeners: new Set<() => void>(),
    materializeStart: vi.fn(),
    operationStatus: vi.fn(),
    operationResume: vi.fn(),
    routeParams: { id: 'session-1' } as Record<string, string | undefined>,
    routeParamListeners: new Set<() => void>(),
}));

const api = vi.hoisted(() => ({
    getSessionShares: vi.fn(),
    getPublicShare: vi.fn(),
    getFriendsList: vi.fn(),
    createSessionShare: vi.fn(),
    updateSessionShare: vi.fn(),
    deleteSessionShare: vi.fn(),
    createPublicShare: vi.fn(),
    deletePublicShare: vi.fn(),
}));

function createSharingMachine(active: boolean = true): Machine {
    return createMachineFixture({
        active,
        activeAt: active ? Date.now() : 1,
    });
}

function hostedSession(encryptionMode: 'plain' | 'e2ee' = 'plain') {
    return {
        id: 'session-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        accessLevel: 'admin',
        canApprovePermissions: true,
        encryptionMode,
        currentStorageState: 'hosted',
        metadata: {},
        agentState: {},
    };
}

function loseSharingAuthority() {
    state.session = {
        ...state.session,
        currentStorageState: 'server_partial',
        acceptedThroughServerSeq: 8,
        publishedThroughServerSeq: null,
        materializedThroughSourceAt: null,
        metadata: {
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'native-session-1',
                source: { kind: 'codexHome', home: 'user' },
            },
        },
    };
    for (const listener of state.sessionListeners) listener();
}

installSessionRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            params: () => state.routeParams,
        }).module;
        return {
            ...routerMock,
            useLocalSearchParams: () => React.useSyncExternalStore(
                (listener) => {
                    state.routeParamListeners.add(listener);
                    return () => state.routeParamListeners.delete(listener);
                },
                () => state.routeParams,
            ),
        };
    },
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const { resolveServerScopedMachine } = await import(
            '@/sync/store/domains/machines/resolveServerScopedMachine'
        );
        const stub = createStorageModuleStub({
            useSession: () => React.useSyncExternalStore(
                (listener) => {
                    state.sessionListeners.add(listener);
                    return () => state.sessionListeners.delete(listener);
                },
                () => state.session,
            ),
            useMachine: () => state.machine,
            useServerScopedMachine: (serverId: string | null, machineId: string) =>
                resolveServerScopedMachine({
                    machines: state.machine ? { [state.machine.id]: state.machine } : {},
                    machineListByServerId: state.machineListByServerId,
                    machineListStatusByServerId: state.machineListStatusByServerId,
                }, serverId, machineId),
            useMachineListByServerId: () => state.machineListByServerId,
            useMachineListStatusByServerId: () => state.machineListStatusByServerId,
            useActiveServerAccountScope: () => React.useSyncExternalStore(
                (listener) => {
                    state.profileScopeListeners.add(listener);
                    return () => state.profileScopeListeners.delete(listener);
                },
                () => state.profileScope,
            ),
        });
        return {
            ...stub,
            getStorage: () => ({
                getState: () => ({ sessions: { 'session-1': state.session } }),
            }),
        };
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: state.modalAlert,
                hide: state.modalHide,
            },
        }).module;
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children }: { children?: React.ReactNode }) => React.createElement('Text', null, children),
}));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: (props: Record<string, unknown>) => React.createElement('ActivitySpinner', props),
}));
vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => ({ kind: 'available', sessionId }),
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: () => ({ token: 'test' }),
        getSessionDataKey: () => new Uint8Array([1, 2, 3]),
    },
}));
vi.mock('@/sync/api/social/apiSharing', () => ({
    getSessionShares: (...args: unknown[]) => api.getSessionShares(...args),
    createSessionShare: api.createSessionShare,
    updateSessionShare: api.updateSessionShare,
    deleteSessionShare: api.deleteSessionShare,
    getPublicShare: (...args: unknown[]) => api.getPublicShare(...args),
    createPublicShare: api.createPublicShare,
    deletePublicShare: api.deletePublicShare,
}));
vi.mock('@/sync/api/social/apiFriends', () => ({
    getFriendsList: (...args: unknown[]) => api.getFriendsList(...args),
}));
vi.mock('@/sync/encryption/publicShareEncryption', () => ({
    encryptDataKeyForPublicShare: (...args: unknown[]) => state.encryptPublicDataKey(...args),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => {
        state.itemProps.push(props);
        return React.createElement('Item', props);
    },
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, children),
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));
vi.mock('@/components/sessions/sharing/openFriendSelectorModal', () => ({
    openFriendSelectorModal: async (params: Record<string, unknown>) => {
        state.friendDialog = params;
        return 'friend-modal';
    },
}));
vi.mock('@/components/sessions/sharing/openSessionShareDialog', () => ({
    openSessionShareDialog: async (params: Record<string, unknown>) => {
        state.shareDialog = params;
        return 'share-modal';
    },
}));
vi.mock('@/components/sessions/sharing/openPublicLinkDialog', () => ({
    openPublicLinkDialog: async (params: Record<string, unknown>) => {
        state.publicDialog = params;
        return 'public-modal';
    },
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: (length: number) => new Uint8Array(length),
}));
vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionMaterializeStart: (...args: unknown[]) =>
        state.materializeStart(...args),
    machineExternalSessionOperationStatus: (...args: unknown[]) =>
        state.operationStatus(...args),
    machineExternalSessionOperationResume: (...args: unknown[]) =>
        state.operationResume(...args),
}));

const existingShare = {
    id: 'share-1',
    sessionId: 'session-1',
    sharedWithUser: {
        id: 'friend-1',
        username: 'friend',
        firstName: null,
        lastName: null,
        avatar: null,
    },
    accessLevel: 'view',
    canApprovePermissions: false,
    createdAt: 1,
    updatedAt: 1,
};

const existingFriend = {
    id: 'friend-1',
    username: 'friend',
    firstName: null,
    lastName: null,
    avatar: null,
    status: 'friend',
};

function createInitialPartialProgress() {
    return ExternalSessionOperationProgressV1Schema.parse({
        v: 1,
        operationId: 'operation-partial',
        revision: 7,
        request: {
            plan: 'materialize',
            targetStorageMode: 'external-linked',
            targetRuntimeMode: null,
        },
        status: 'awaiting_user_resume',
        phase: 'importing',
        timeline: EXTERNAL_SESSION_OPERATION_TIMELINES_V1.materialize,
        updatedAtMs: 1_700_000_000_000,
        priorStableStorage: { state: 'machine_only' },
        currentStorageState: 'server_partial',
        checkpoint: {
            sourcePagesRead: 1,
            stagedItemCount: 8,
            importedItemCount: 5,
            acceptedThroughServerSeq: 5,
            requiredItemFailures: {
                total: 0,
                record: 0,
                media: 0,
                conversion: 0,
                diagnosticsTruncated: false,
            },
        },
        fence: {
            kind: 'initial_server_partial',
            acceptedThroughServerSeq: 5,
        },
        retryTargetPhase: 'importing',
    });
}

async function renderAndCaptureDialogs() {
    const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
    const screen = await renderScreen(<Screen />);
    await act(async () => {});

    const findItem = (title: string) => [...state.itemProps]
        .reverse()
        .find((props: Record<string, any>) => props.title === title);
    await act(async () => {
        findItem('session.sharing.addShare')?.onPress?.();
        findItem('friend')?.onPress?.();
        findItem('session.sharing.createPublicLink')?.onPress?.();
    });
    expect(state.friendDialog).not.toBeNull();
    expect(state.shareDialog).not.toBeNull();
    expect(state.publicDialog).not.toBeNull();
    return { Screen, screen };
}

describe('session sharing mutation authority', () => {
    beforeEach(() => {
        state.session = hostedSession();
        state.itemProps = [];
        state.friendDialog = null;
        state.shareDialog = null;
        state.publicDialog = null;
        state.modalAlert.mockReset();
        state.modalHide.mockReset();
        state.encryptPublicDataKey.mockReset();
        state.encryptPublicDataKey.mockResolvedValue('encrypted-key');
        state.machine = null;
        state.scopedMachine = null;
        state.machineListByServerId = {};
        state.machineListStatusByServerId = {};
        state.profileScope = null;
        state.routeParams = { id: 'session-1' };
        state.materializeStart.mockReset();
        state.materializeStart.mockResolvedValue({
            ok: false,
            error: { code: 'internal_error', message: 'fixture' },
        });
        state.operationStatus.mockReset();
        state.operationResume.mockReset();
        api.getSessionShares.mockReset();
        api.getSessionShares.mockResolvedValue([existingShare]);
        api.getPublicShare.mockReset();
        api.getPublicShare.mockResolvedValue(null);
        api.getFriendsList.mockReset();
        api.getFriendsList.mockResolvedValue([existingFriend]);
        for (const spy of Object.values(api)) {
            if (
                spy !== api.getSessionShares
                && spy !== api.getPublicShare
                && spy !== api.getFriendsList
            ) {
                spy.mockReset();
            }
        }
    });

    it('starts a linked-session import with intent only', async () => {
        state.routeParams = { id: 'session-1', serverId: 'server-owned' };
        state.machine = createSharingMachine();
        state.machineListByServerId = { 'server-owned': [state.machine] };
        state.machineListStatusByServerId = { 'server-owned': 'idle' };
        state.session = {
            ...hostedSession(),
            currentStorageState: 'machine_only',
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'codexHome', home: 'user' },
                    linkedAtMs: 42,
                },
            },
        };
        state.materializeStart.mockResolvedValue({
            ok: true,
            progress: {
                operationId: 'operation-1',
            },
        });

        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});
        const importItem = [...state.itemProps]
            .reverse()
            .find((props) => props.title === 'externalSessions.operationTitleMaterialize');

        await act(async () => {
            importItem?.onPress?.();
        });

        expect(importItem?.disabled).toBe(false);
        expect(state.materializeStart).toHaveBeenCalledWith({
            machineId: 'machine-1',
            request: {
                v: 1,
                idempotencyKey: '00000000000000000000000000000000',
                sessionId: 'session-1',
                plan: 'materialize',
                targetStorageMode: 'external-linked',
                targetRuntimeMode: null,
            },
        }, { serverId: 'server-owned' });
        expect(state.materializeStart.mock.calls[0]?.[0]?.request)
            .not.toHaveProperty('source');
    });

    it.each([
        {
            availability: 'missing',
            machine: null,
            reason: 'externalSessions.sharingSourceMachineMissing',
        },
        {
            availability: 'offline',
            machine: createSharingMachine(false),
            reason: 'externalSessions.sharingSourceMachineOffline',
        },
    ])('explains why Import into Happier is disabled when the source machine is $availability', async ({ machine, reason }) => {
        state.routeParams = { id: 'session-1', serverId: 'server-owned' };
        state.machineListByServerId = { 'server-owned': machine ? [machine] : [] };
        state.machineListStatusByServerId = { 'server-owned': 'idle' };
        state.machine = machine ?? createSharingMachine();
        state.session = {
            ...hostedSession(),
            currentStorageState: 'machine_only',
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'codexHome', home: 'user' },
                    linkedAtMs: 42,
                },
            },
        };

        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});
        const importItem = [...state.itemProps]
            .reverse()
            .find((props) => props.title === 'externalSessions.operationTitleMaterialize');

        expect(importItem).toMatchObject({
            disabled: true,
            subtitle: reason,
            accessibilityLabel: `externalSessions.operationTitleMaterialize. ${reason}`,
        });
        expect(state.materializeStart).not.toHaveBeenCalled();
    });

    it('keeps Import into Happier enabled when the route-scoped source machine is online outside the active projection', async () => {
        state.routeParams = { id: 'session-1', serverId: 'server-owned' };
        state.machine = null;
        state.scopedMachine = createSharingMachine();
        state.machineListByServerId = { 'server-owned': [state.scopedMachine] };
        state.machineListStatusByServerId = { 'server-owned': 'idle' };
        state.session = {
            ...hostedSession(),
            currentStorageState: 'machine_only',
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'codexHome', home: 'user' },
                    linkedAtMs: 42,
                },
            },
        };

        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});
        const importItem = [...state.itemProps]
            .reverse()
            .find((props) => props.title === 'externalSessions.operationTitleMaterialize');

        expect(importItem).toMatchObject({
            disabled: false,
            subtitle: 'externalSessions.sharingTranscriptOnMachine',
        });
    });

    it.each([
        {
            status: 'loading' as const,
        },
        {
            status: 'idle' as const,
        },
        {
            status: 'signedOut' as const,
        },
        {
            status: 'error' as const,
        },
    ])('does not misreport an unresolved source-machine list as a missing machine when its status is $status', async ({ status }) => {
        state.routeParams = { id: 'session-1', serverId: 'server-owned' };
        state.machine = createSharingMachine();
        state.machineListByServerId = {};
        state.machineListStatusByServerId = { 'server-owned': status };
        state.session = {
            ...hostedSession(),
            currentStorageState: 'machine_only',
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'codexHome', home: 'user' },
                    linkedAtMs: 42,
                },
            },
        };

        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});
        const importItem = [...state.itemProps]
            .reverse()
            .find((props) => props.title === 'externalSessions.operationTitleMaterialize');

        expect(importItem).toMatchObject({
            disabled: true,
            subtitle: 'externalSessions.sharingActionAwaitingAvailability',
            accessibilityLabel: 'externalSessions.operationTitleMaterialize. externalSessions.sharingActionAwaitingAvailability',
        });
    });

    it('presents typed materialization failures without exposing daemon error copy', async () => {
        state.machine = createSharingMachine();
        state.session = {
            ...hostedSession(),
            currentStorageState: 'machine_only',
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'codexHome', home: 'user' },
                    linkedAtMs: 42,
                },
            },
        };
        state.materializeStart.mockResolvedValue({
            ok: false,
            error: {
                code: 'operation_conflict',
                message: 'daemon-private-operation-detail',
            },
        });

        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});
        const importItem = [...state.itemProps]
            .reverse()
            .find((props) => props.title === 'externalSessions.operationTitleMaterialize');

        await act(async () => {
            importItem?.onPress?.();
            await Promise.resolve();
        });

        expect(state.modalAlert).toHaveBeenCalledWith(
            'common.error',
            'externalSessions.operationActionErrorConflict',
            [{ text: 'common.ok', style: 'cancel' }],
        );
        expect(state.modalAlert).not.toHaveBeenCalledWith(
            expect.anything(),
            'daemon-private-operation-detail',
            expect.anything(),
        );
    });

    it('runs snapshot catch-up through the canonical materialization action when eligible', async () => {
        state.routeParams = { id: 'session-1', serverId: 'server-owned' };
        state.machine = null;
        state.scopedMachine = createSharingMachine();
        state.machineListByServerId = { 'server-owned': [state.scopedMachine] };
        state.machineListStatusByServerId = { 'server-owned': 'idle' };
        state.session = {
            ...hostedSession(),
            currentStorageState: 'snapshot_complete',
            publishedThroughServerSeq: 5,
            materializedThroughSourceAt: 1_700_000_000_000,
            transcriptShareable: true,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'codexHome', home: 'user' },
                    linkedAtMs: 42,
                },
            },
        };
        state.materializeStart.mockResolvedValue({ ok: true, progress: { operationId: 'operation-update' } });

        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});
        const updateItem = [...state.itemProps]
            .reverse()
            .find((props) => props.title === 'externalSessions.sharingUpdateSharedCopy');

        expect(updateItem).toMatchObject({
            disabled: false,
            subtitle: 'externalSessions.sharingUpdateSharedCopyDescription',
            accessibilityLabel: 'externalSessions.sharingUpdateSharedCopy. externalSessions.sharingUpdateSharedCopyDescription',
        });
        await act(async () => {
            await updateItem?.onPress?.();
        });

        expect(state.materializeStart).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            request: expect.objectContaining({
                sessionId: 'session-1',
                plan: 'materialize',
            }),
        }), { serverId: 'server-owned' });
    });

    it.each([
        {
            availability: 'missing',
            machine: null,
            reason: 'externalSessions.sharingSourceMachineMissing',
        },
        {
            availability: 'offline',
            machine: createSharingMachine(false),
            reason: 'externalSessions.sharingSourceMachineOffline',
        },
    ])('explains why Update shared copy is disabled when the source machine is $availability', async ({ machine, reason }) => {
        state.routeParams = { id: 'session-1', serverId: 'server-owned' };
        state.machineListByServerId = { 'server-owned': machine ? [machine] : [] };
        state.machineListStatusByServerId = { 'server-owned': 'idle' };
        state.machine = machine ?? createSharingMachine();
        state.session = {
            ...hostedSession(),
            currentStorageState: 'snapshot_complete',
            publishedThroughServerSeq: 5,
            materializedThroughSourceAt: 1_700_000_000_000,
            transcriptShareable: true,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'codexHome', home: 'user' },
                    linkedAtMs: 42,
                },
            },
        };

        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});
        const updateItem = [...state.itemProps]
            .reverse()
            .find((props) => props.title === 'externalSessions.sharingUpdateSharedCopy');

        expect(updateItem).toMatchObject({
            disabled: true,
            subtitle: reason,
            accessibilityLabel: `externalSessions.sharingUpdateSharedCopy. ${reason}`,
        });
        expect(state.materializeStart).not.toHaveBeenCalled();
    });

    it('renders sharing unavailable when the server rejects an otherwise complete snapshot projection', async () => {
        state.session = {
            ...hostedSession(),
            currentStorageState: 'snapshot_complete',
            publishedThroughServerSeq: 5,
            materializedThroughSourceAt: 1_700_000_000_000,
            transcriptShareable: false,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'codexHome', home: 'user' },
                    linkedAtMs: 42,
                },
            },
        };

        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});

        const addShare = [...state.itemProps]
            .reverse()
            .find((props) => props.title === 'session.sharing.addShare');
        const publicLink = [...state.itemProps]
            .reverse()
            .find((props) => props.title === 'session.sharing.createPublicLink');
        expect(addShare).toMatchObject({
            disabled: true,
            subtitle: 'externalSessions.sharingTranscriptUnavailable',
        });
        expect(publicLink).toMatchObject({
            disabled: true,
            subtitle: 'externalSessions.sharingTranscriptUnavailable',
        });
    });

    it('rejects stale global machine presence for owner hydration', async () => {
        const progress = createInitialPartialProgress();
        state.routeParams = { id: 'session-1', serverId: 'server-owned' };
        state.profileScope = { serverId: 'server-owned', accountId: 'owner-1' };
        state.machine = createSharingMachine();
        state.machineListByServerId = { 'server-owned': [] };
        state.machineListStatusByServerId = { 'server-owned': 'idle' };
        state.session = {
            ...hostedSession(),
            owner: 'owner-1',
            currentStorageState: 'server_partial',
            acceptedThroughServerSeq: 5,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'codexHome', home: 'user' },
                    linkedAtMs: 42,
                },
                externalSessionOperationPresentationV1:
                    ExternalSessionOperationSharedPresentationV1Schema.parse({
                        v: 1,
                        operationId: progress.operationId,
                        revision: progress.revision,
                        kind: 'materialize',
                        status: 'awaiting_user_resume',
                        phase: 'importing',
                    }),
            },
        };
        state.operationStatus.mockResolvedValue({ ok: true, progress });

        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});

        expect(state.operationStatus).not.toHaveBeenCalled();
        expect([...state.itemProps].some(
            (props) => props.title === 'externalSessions.operationActionResume',
        )).toBe(false);
    });

    it('resumes a partial import only from exact hydrated operation authority', async () => {
        const progress = createInitialPartialProgress();
        state.machine = createSharingMachine();
        state.profileScope = { serverId: 'server-primary', accountId: 'owner-1' };
        state.machineListByServerId = { 'server-primary': [state.machine] };
        state.machineListStatusByServerId = { 'server-primary': 'idle' };
        state.session = {
            ...hostedSession(),
            owner: 'owner-1',
            currentStorageState: 'server_partial',
            acceptedThroughServerSeq: 5,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'codexHome', home: 'user' },
                    linkedAtMs: 42,
                },
                externalSessionOperationPresentationV1:
                    ExternalSessionOperationSharedPresentationV1Schema.parse({
                        v: 1,
                        operationId: progress.operationId,
                        revision: progress.revision,
                        kind: 'materialize',
                        status: 'awaiting_user_resume',
                        phase: 'importing',
                    }),
            },
        };
        state.operationStatus.mockResolvedValue({ ok: true, progress });
        state.operationResume.mockResolvedValue({ ok: true, progress: { ...progress, revision: 8, status: 'running' } });

        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});
        let resumeItem: Record<string, any> | undefined;
        await vi.waitFor(() => {
            resumeItem = [...state.itemProps]
                .reverse()
                .find((props) => props.title === 'externalSessions.operationActionResume');
            expect(resumeItem?.disabled).not.toBe(true);
            expect(resumeItem?.onPress).toEqual(expect.any(Function));
        });
        await act(async () => {
            await resumeItem?.onPress?.();
        });
        expect(state.operationResume).toHaveBeenCalledWith({
            machineId: 'machine-1',
            sessionId: 'session-1',
            operationId: 'operation-partial',
            revision: 7,
        }, undefined);
    });

    it('shows honest partial-import information without a Resume action when exact progress is unavailable', async () => {
        const progress = createInitialPartialProgress();
        state.machine = createSharingMachine();
        state.profileScope = { serverId: 'server-primary', accountId: 'owner-1' };
        state.machineListByServerId = { 'server-primary': [state.machine] };
        state.machineListStatusByServerId = { 'server-primary': 'idle' };
        state.session = {
            ...hostedSession(),
            owner: 'owner-1',
            currentStorageState: 'server_partial',
            acceptedThroughServerSeq: 5,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'codexHome', home: 'user' },
                    linkedAtMs: 42,
                },
                externalSessionOperationPresentationV1:
                    ExternalSessionOperationSharedPresentationV1Schema.parse({
                        v: 1,
                        operationId: progress.operationId,
                        revision: progress.revision,
                        kind: 'materialize',
                        status: 'awaiting_user_resume',
                        phase: 'importing',
                    }),
            },
        };
        state.operationStatus.mockResolvedValue({
            ok: false,
            error: { code: 'stale_revision', message: 'stale' },
        });

        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});

        expect([...state.itemProps].some(
            (props) => props.title === 'externalSessions.operationActionResume',
        )).toBe(false);
        expect([...state.itemProps].some(
            (props) => props.title === 'externalSessions.sharingImportIncomplete'
                && props.onPress === undefined,
        )).toBe(true);
        expect(state.operationResume).not.toHaveBeenCalled();
    });

    it('drops owner-private operation progress and rehydrates on an authenticated server scope change', async () => {
        const progress = createInitialPartialProgress();
        const nextAccountRead = createDeferred<{
            ok: true;
            progress: ReturnType<typeof createInitialPartialProgress>;
        }>();
        const presentation = ExternalSessionOperationSharedPresentationV1Schema.parse({
            v: 1,
            operationId: progress.operationId,
            revision: progress.revision,
            kind: 'materialize',
            status: 'awaiting_user_resume',
            phase: 'importing',
        });
        state.routeParams = { id: 'session-1', serverId: 'server-primary' };
        state.machine = createSharingMachine();
        state.machineListByServerId = { 'server-primary': [state.machine] };
        state.machineListStatusByServerId = { 'server-primary': 'idle' };
        state.profileScope = { serverId: 'account-server-1', accountId: 'owner-1' };
        state.session = {
            ...hostedSession(),
            owner: 'owner-1',
            currentStorageState: 'server_partial',
            acceptedThroughServerSeq: 5,
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'native-session-1',
                    source: { kind: 'codexHome', home: 'user' },
                    linkedAtMs: 42,
                },
                externalSessionOperationPresentationV1: presentation,
            },
        };
        state.operationStatus
            .mockResolvedValueOnce({ ok: true, progress })
            .mockReturnValueOnce(nextAccountRead.promise);

        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await vi.waitFor(() => expect(state.operationStatus).toHaveBeenCalledTimes(1));
        state.itemProps = [];

        await act(async () => {
            state.profileScope = { serverId: 'account-server-2', accountId: 'owner-1' };
            for (const listener of state.profileScopeListeners) listener();
        });

        expect(state.operationStatus).toHaveBeenCalledTimes(2);
        expect([...state.itemProps].some(
            (props) => props.title === 'externalSessions.operationActionResume',
        )).toBe(false);

        nextAccountRead.resolve({
            ok: true,
            progress: { ...progress, updatedAtMs: progress.updatedAtMs + 1 },
        });
        await act(async () => {
            await nextAccountRead.promise;
        });
        await vi.waitFor(() => expect([...state.itemProps].some(
            (props) => props.title === 'externalSessions.operationActionResume',
        )).toBe(true));
    });

    it('never renders empty sharing authority after an initial request failure and retries', async () => {
        const initialShares = createDeferred<any[]>();
        api.getSessionShares.mockImplementationOnce(() => initialShares.promise);
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        expect([...state.itemProps].some((props) => props.title === 'session.sharing.noShares')).toBe(false);
        expect([...state.itemProps].some((props) => props.title === 'session.sharing.createPublicLink')).toBe(false);
        expect(screen.findByTestId('session-sharing-load-state')).not.toBeNull();
        expect(screen.findByTestId('session-sharing-load-state-action')).toBeNull();

        await act(async () => {
            initialShares.reject(new Error('offline'));
            await Promise.resolve();
        });
        expect(screen.findByTestId('session-sharing-load-state-action')).not.toBeNull();

        api.getSessionShares.mockResolvedValue([existingShare]);
        await screen.pressByTestIdAsync('session-sharing-load-state-action');
        expect([...state.itemProps].some((props) => props.title === 'friend')).toBe(true);
    });

    it('retains the last successful sharing results when refresh fails', async () => {
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});
        const shareItem = [...state.itemProps].reverse().find((props) => props.title === 'friend');
        await act(async () => {
            shareItem?.onPress?.();
        });
        api.updateSessionShare.mockResolvedValue(undefined);
        api.getSessionShares.mockRejectedValueOnce(new Error('refresh failed'));

        await act(async () => {
            await state.shareDialog?.onUpdateShare('share-1', { accessLevel: 'edit' });
        });

        expect([...state.itemProps].some((props) => props.title === 'friend')).toBe(true);
        expect([...state.itemProps].some(
            (props) => props.testID === 'session-sharing-refresh-retry'
                && props.onPress !== undefined,
        )).toBe(true);
    });

    it('fences a stale sharing response after the route scope changes', async () => {
        const staleShares = createDeferred<any[]>();
        api.getSessionShares.mockImplementationOnce(() => staleShares.promise);
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});

        state.routeParams = { id: 'session-2' };
        state.session = { ...hostedSession(), id: 'session-2' };
        api.getSessionShares.mockResolvedValueOnce([{ ...existingShare, id: 'share-2', sessionId: 'session-2', sharedWithUser: { ...existingShare.sharedWithUser, username: 'scope-two' } }]);
        await act(async () => {
            for (const listener of state.routeParamListeners) listener();
        });
        await act(async () => {
            staleShares.resolve([{ ...existingShare, sharedWithUser: { ...existingShare.sharedWithUser, username: 'stale-scope-one' } }]);
            await staleShares.promise;
        });

        expect([...state.itemProps].some((props) => props.title === 'scope-two')).toBe(true);
        expect([...state.itemProps].slice(-12).some((props) => props.title === 'stale-scope-one')).toBe(false);
    });

    it('fences a stale sharing response after the account scope changes', async () => {
        const staleShares = createDeferred<any[]>();
        state.profileScope = { serverId: 'server-primary', accountId: 'owner-1' };
        api.getSessionShares.mockImplementationOnce(() => staleShares.promise);
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});

        state.profileScope = { serverId: 'server-primary', accountId: 'owner-2' };
        api.getSessionShares.mockResolvedValueOnce([{
            ...existingShare,
            sharedWithUser: { ...existingShare.sharedWithUser, username: 'account-two' },
        }]);
        await act(async () => {
            for (const listener of state.profileScopeListeners) listener();
        });
        await vi.waitFor(() => expect([...state.itemProps].some(
            (props) => props.title === 'account-two',
        )).toBe(true));

        await act(async () => {
            staleShares.resolve([{
                ...existingShare,
                sharedWithUser: { ...existingShare.sharedWithUser, username: 'stale-account-one' },
            }]);
            await staleShares.promise;
        });
        expect([...state.itemProps].slice(-12).some(
            (props) => props.title === 'stale-account-one',
        )).toBe(false);
    });

    it('clears a private public token, closes its modal, and blocks its callbacks after an account scope change', async () => {
        const publicShare = {
            id: 'public-share-1',
            sessionId: 'session-1',
            token: 'owner-one-token',
            expiresAt: null,
            maxUses: null,
            useCount: 0,
            isConsentRequired: true,
            createdAt: 1,
            updatedAt: 1,
        };
        state.profileScope = { serverId: 'server-primary', accountId: 'owner-1' };
        api.getPublicShare.mockResolvedValueOnce(publicShare);
        const Screen = (await import('@/app/(app)/session/[id]/sharing')).default;
        await renderScreen(<Screen />);
        await act(async () => {});
        const ownerOnePublicLink = [...state.itemProps].reverse().find(
            (props) => props.title === 'session.sharing.publicLinkActive',
        );
        await act(async () => {
            ownerOnePublicLink?.onPress?.();
        });
        const ownerOneDialog = state.publicDialog;
        expect(ownerOneDialog?.publicShare?.token).toBe('owner-one-token');

        state.profileScope = { serverId: 'server-primary', accountId: 'owner-2' };
        api.getPublicShare.mockResolvedValueOnce({ ...publicShare, token: null });
        await act(async () => {
            for (const listener of state.profileScopeListeners) listener();
        });
        await vi.waitFor(() => expect(state.modalHide).toHaveBeenCalledWith('public-modal'));

        await expect(ownerOneDialog!.onDelete()).rejects.toThrow('errors.operationFailed');
        expect(api.deletePublicShare).not.toHaveBeenCalled();

        const ownerTwoPublicLink = [...state.itemProps].reverse().find(
            (props) => props.title === 'session.sharing.publicLinkActive',
        );
        await act(async () => {
            ownerTwoPublicLink?.onPress?.();
        });
        expect(state.publicDialog?.publicShare?.token).toBeNull();
    });

    afterEach(() => {
        standardCleanup();
        state.sessionListeners.clear();
        state.profileScopeListeners.clear();
        state.routeParamListeners.clear();
    });

    it('blocks callbacks captured by hosted dialogs after the transcript becomes partial', async () => {
        await renderAndCaptureDialogs();
        await act(async () => {
            loseSharingAuthority();
        });

        expect(state.modalHide.mock.calls.map(([modalId]) => modalId)).toEqual(expect.arrayContaining([
            'friend-modal',
            'share-modal',
            'public-modal',
        ]));

        const attempts = [
            () => state.friendDialog!.onSelect('friend-1', 'view'),
            () => state.shareDialog!.onUpdateShare('share-1', { accessLevel: 'edit' }),
            () => state.shareDialog!.onRemoveShare('share-1'),
            () => state.publicDialog!.onCreate({ isConsentRequired: true }),
            () => state.publicDialog!.onDelete(),
        ];

        for (const attempt of attempts) {
            await expect(attempt()).rejects.toThrow('externalSessions.sharingImportIncomplete');
        }
        expect(api.createSessionShare).not.toHaveBeenCalled();
        expect(api.updateSessionShare).not.toHaveBeenCalled();
        expect(api.deleteSessionShare).not.toHaveBeenCalled();
        expect(api.createPublicShare).not.toHaveBeenCalled();
        expect(api.deletePublicShare).not.toHaveBeenCalled();
    });

    it('blocks callbacks captured before the server shareability projection turns false', async () => {
        await renderAndCaptureDialogs();
        await act(async () => {
            state.session = {
                ...state.session,
                currentStorageState: 'snapshot_complete',
                publishedThroughServerSeq: 5,
                materializedThroughSourceAt: 1_700_000_000_000,
                transcriptShareable: false,
                metadata: {
                    externalSessionV1: {
                        v: 1,
                        agentId: 'codex',
                        machineId: 'machine-1',
                        remoteSessionId: 'native-session-1',
                        source: { kind: 'codexHome', home: 'user' },
                        linkedAtMs: 42,
                    },
                },
            };
            for (const listener of state.sessionListeners) listener();
        });

        await expect(state.friendDialog!.onSelect('friend-1', 'view'))
            .rejects.toThrow('externalSessions.sharingTranscriptUnavailable');
        expect(api.createSessionShare).not.toHaveBeenCalled();
    });

    it('rechecks authority after asynchronous public-share encryption preflight', async () => {
        state.session = hostedSession('e2ee');
        let resolveEncryption!: (value: string) => void;
        state.encryptPublicDataKey.mockImplementation(() => new Promise<string>((resolve) => {
            resolveEncryption = resolve;
        }));
        await renderAndCaptureDialogs();

        const createAttempt = state.publicDialog!.onCreate({ isConsentRequired: true });
        const createRejection = expect(createAttempt).rejects.toThrow('externalSessions.sharingImportIncomplete');
        await vi.waitFor(() => expect(state.encryptPublicDataKey).toHaveBeenCalledOnce());
        await act(async () => {
            loseSharingAuthority();
            resolveEncryption('encrypted-key');
        });

        await createRejection;
        expect(api.createPublicShare).not.toHaveBeenCalled();
    });
});
