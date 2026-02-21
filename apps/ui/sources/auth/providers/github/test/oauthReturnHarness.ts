import React from 'react';
import { vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { PendingExternalAuth, PendingExternalConnect } from '@/auth/storage/tokenStorage';

export const replaceSpy = vi.fn();
export const localSearchParamsMock = vi.fn();

export const loginSpy = vi.fn(async () => {});
export const upsertAndActivateServerSpy = vi.fn();
const hoistedModal = vi.hoisted(() => ({
    alert: vi.fn(async () => {}),
    prompt: vi.fn<(title: string, message: string, opts: Record<string, unknown>) => Promise<string | null>>(async () => null),
    confirm: vi.fn(async () => true),
}));
export const modal = hoistedModal;

let activeServerSnapshotState: {
    serverId: string;
    serverUrl: string;
    kind: string;
    generation: number;
} = {
    serverId: 'server-a',
    serverUrl: 'http://default.example.test',
    kind: 'custom',
    generation: 1,
};

export function setActiveServerSnapshot(next: Partial<typeof activeServerSnapshotState>) {
    activeServerSnapshotState = { ...activeServerSnapshotState, ...next };
}

let pendingExternalAuthState: PendingExternalAuth | null = {
    provider: 'github',
    secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};
let pendingExternalConnectState: PendingExternalConnect | null = null;
let authState: {
    isAuthenticated: boolean;
    credentials: { token: string; secret: string } | null;
} = {
    isAuthenticated: false,
    credentials: null,
};

export const clearPendingExternalAuthMock = vi.fn(async () => true);
export const clearPendingExternalConnectMock = vi.fn(async () => true);

export function setPendingExternalAuthState(next: PendingExternalAuth | null) {
    pendingExternalAuthState = next;
}

export function setPendingExternalConnectState(next: PendingExternalConnect | null) {
    pendingExternalConnectState = next;
}

export function setAuthState(next: { isAuthenticated: boolean; credentials: { token: string; secret: string } | null }) {
    authState = next;
}

vi.mock('react-native-reanimated', () => ({}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ replace: replaceSpy }),
    useLocalSearchParams: localSearchParamsMock,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: authState.isAuthenticated,
        credentials: authState.credentials,
        login: loginSpy,
        logout: vi.fn(async () => {}),
    }),
}));

vi.mock('@/modal', () => ({ Modal: modal }));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshotState,
    upsertAndActivateServer: upsertAndActivateServerSpy,
}));

vi.mock('@/sync/api/capabilities/sessionSharingSupport', () => ({
    isSessionSharingSupported: async () => false,
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: () => new Uint8Array(32).fill(9),
}));

vi.mock('@/auth/storage/tokenStorage', async () => {
    const actual = await vi.importActual<typeof import('@/auth/storage/tokenStorage')>('@/auth/storage/tokenStorage');
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getPendingExternalAuth: async () => pendingExternalAuthState,
            clearPendingExternalAuth: clearPendingExternalAuthMock,
            getPendingExternalConnect: async () => pendingExternalConnectState,
            clearPendingExternalConnect: clearPendingExternalConnectMock,
        },
    };
});

vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        crypto_sign_seed_keypair: (_seed: Uint8Array) => ({
            publicKey: new Uint8Array(32).fill(1),
            privateKey: new Uint8Array(64).fill(2),
        }),
        crypto_sign_detached: (_message: Uint8Array, _privateKey: Uint8Array) => new Uint8Array(64).fill(3),
    },
}));

export async function flushOAuthEffects(turns = 8): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) {
        await act(async () => {});
    }
}

export async function runWithOAuthScreen(
    runAssertions: (tree: ReturnType<typeof renderer.create>) => Promise<void>,
): Promise<void> {
    const tree = await renderOAuthReturnScreen();
    try {
        await runAssertions(tree);
    } finally {
        act(() => {
            tree.unmount();
        });
    }
}

export async function renderOAuthReturnScreen() {
    const { default: Screen } = await import('@/app/(app)/oauth/[provider]');
    let tree: ReturnType<typeof renderer.create> | undefined;
    await act(async () => {
        tree = renderer.create(React.createElement(Screen));
    });
    await flushOAuthEffects();
    if (!tree) {
        throw new Error('Expected OAuth screen to render');
    }
    return tree;
}

export function resetOAuthHarness() {
    replaceSpy.mockReset();
    loginSpy.mockReset();
    upsertAndActivateServerSpy.mockReset();
    if (typeof modal.alert.mockReset === 'function') {
        modal.alert.mockReset();
    } else {
        modal.alert = vi.fn(async () => {});
    }
    if (typeof modal.prompt.mockReset === 'function') {
        modal.prompt.mockReset();
    } else {
        modal.prompt = vi.fn<(title: string, message: string, opts: Record<string, unknown>) => Promise<string | null>>(
            async () => null,
        );
    }
    if (typeof modal.confirm.mockReset === 'function') {
        modal.confirm.mockReset();
    } else {
        modal.confirm = vi.fn(async () => true);
    }
    clearPendingExternalAuthMock.mockReset();
    clearPendingExternalAuthMock.mockResolvedValue(true);
    clearPendingExternalConnectMock.mockReset();
    clearPendingExternalConnectMock.mockResolvedValue(true);
    setPendingExternalAuthState({
        provider: 'github',
        secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    setPendingExternalConnectState(null);
    setAuthState({
        isAuthenticated: false,
        credentials: null,
    });
    setActiveServerSnapshot({
        serverId: 'server-a',
        serverUrl: 'http://default.example.test',
        kind: 'custom',
        generation: 1,
    });
}
