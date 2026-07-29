import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
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
    machine: null as Record<string, any> | null,
    materializeStart: vi.fn(),
    routeParams: { id: 'session-1' } as Record<string, string | undefined>,
}));

const api = vi.hoisted(() => ({
    createSessionShare: vi.fn(),
    updateSessionShare: vi.fn(),
    deleteSessionShare: vi.fn(),
    createPublicShare: vi.fn(),
    deletePublicShare: vi.fn(),
}));

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
        return createExpoRouterMock({
            params: () => state.routeParams,
        }).module;
    },
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const stub = createStorageModuleStub({
            useSession: () => React.useSyncExternalStore(
                (listener) => {
                    state.sessionListeners.add(listener);
                    return () => state.sessionListeners.delete(listener);
                },
                () => state.session,
            ),
            useMachine: () => state.machine,
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
    getSessionShares: async () => [{
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
    }],
    createSessionShare: api.createSessionShare,
    updateSessionShare: api.updateSessionShare,
    deleteSessionShare: api.deleteSessionShare,
    getPublicShare: async () => null,
    createPublicShare: api.createPublicShare,
    deletePublicShare: api.deletePublicShare,
}));
vi.mock('@/sync/api/social/apiFriends', () => ({
    getFriendsList: async () => [{
        id: 'friend-1',
        username: 'friend',
        firstName: null,
        lastName: null,
        avatar: null,
        status: 'friend',
    }],
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
}));

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
        state.routeParams = { id: 'session-1' };
        state.materializeStart.mockReset();
        state.materializeStart.mockResolvedValue({
            ok: false,
            error: { code: 'internal_error', message: 'fixture' },
        });
        for (const spy of Object.values(api)) {
            spy.mockReset();
        }
    });

    it('starts a linked-session import with intent only', async () => {
        state.routeParams = { id: 'session-1', serverId: 'server-owned' };
        state.machine = { id: 'machine-1', active: true };
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

    it('presents typed materialization failures without exposing daemon error copy', async () => {
        state.machine = { id: 'machine-1', active: true };
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

    afterEach(() => {
        standardCleanup();
        state.sessionListeners.clear();
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
