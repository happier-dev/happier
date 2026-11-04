import React from 'react';
import { vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type {
    AuthCredentials,
    PendingAccountDirectoryAuth,
    PendingExternalAuth,
    PendingExternalConnect,
} from '@/auth/storage/tokenStorage';
import type { TeamInvitationPostAuthContinuationV1 } from '@happier-dev/protocol';
import type {
    AuthCredentialLifecycleResult,
} from '@/auth/context/AuthContext';
import { setAccountServiceEndpoint } from '@/sync/domains/server/serverProfiles';

export const replaceSpy = vi.fn();
export const localSearchParamsMock = vi.fn();

export const loginSpy = vi.fn<
    (...args: unknown[]) => Promise<AuthCredentialLifecycleResult>
>(async () => ({ kind: 'completed' }));
export const loginWithCredentialsSpy = vi.fn<
    (...args: unknown[]) => Promise<AuthCredentialLifecycleResult>
>(async () => ({ kind: 'completed' }));
export const refreshFromActiveServerSpy = vi.fn(async () => {});
export const getRandomBytesSpy = vi.fn((length = 32) => new Uint8Array(length).fill(9));
export const upsertAndActivateServerSpy = vi.fn();
export const trackAccountCreatedSpy = vi.fn();
export const trackAccountRestoredSpy = vi.fn();
export const resumeAccountEncryptionFirstKeyExternalAuthSpy =
    vi.fn(async () => ({ returnTo: '/settings/account' }));
export const resumeAccountPasswordEnrollmentExternalAuthSpy =
    vi.fn(async () => ({ returnTo: '/settings/account/security?verificationToken=mailbox-proof' }));
export const cancelAccountPasswordEnrollmentExternalAuthSpy =
    vi.fn(async () => ({ returnTo: '/settings/account/security?verificationToken=mailbox-proof' }));
export const clearAccountPasswordEnrollmentExternalAuthCustodySpy = vi.fn();
export const readAccountPasswordEnrollmentExternalAuthCallbackContextSpy =
    vi.fn<() => Readonly<{
        target: Readonly<{ serverId: string; serverUrl: string }>;
    }> | null>(() => null);
export const accountDirectoryCredentialSetSpy = vi.fn(async () => true);
export const accountDirectoryCredentialGetSpy = vi.fn(async () => null as AuthCredentials | null);
export const pendingAccountDirectoryAuthGetSpy = vi.fn(async () => null as PendingAccountDirectoryAuth | null);
export const pendingAccountDirectoryAuthCustodyResolveSpy = vi.fn<
    () => Promise<import('@/auth/storage/tokenStorage').PendingAccountDirectoryAuthCustodyResolution>
>(async () => ({ kind: 'absent' }));
export const pendingAccountDirectoryAuthClearSpy = vi.fn(async () => true);
export const accountDirectoryExchangeOAuthSpy = vi.fn();
const hoistedModal = vi.hoisted(() => ({
    show: vi.fn((config: { onRequestClose?: () => void }) => {
        config.onRequestClose?.();
        return 'modal-id';
    }),
    alert: vi.fn(async () => {}),
    alertAsync: vi.fn(async () => {}),
    prompt: vi.fn<(title: string, message: string, opts: Record<string, unknown>) => Promise<string | null>>(async () => null),
    confirm: vi.fn(async () => true),
}));
export const modal = hoistedModal;
const hoistedWebBrowser = vi.hoisted(() => ({
    maybeCompleteAuthSession: vi.fn<() => {
        type: 'success' | 'failed';
        message: string;
    }>(() => ({
        type: 'failed' as const,
        message: 'No auth session is currently in progress',
    })),
}));
export const maybeCompleteAuthSessionSpy =
    hoistedWebBrowser.maybeCompleteAuthSession;

vi.mock('expo-web-browser', () => ({
    maybeCompleteAuthSession:
        hoistedWebBrowser.maybeCompleteAuthSession,
}));

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
let pendingExternalAuthServerMismatch = false;
let pendingExternalConnectState: PendingExternalConnect | null = null;
let pendingAccountDirectoryAuthState: PendingAccountDirectoryAuth | null = null;
let storedCredentialsState: AuthCredentials | null = null;
let authState: {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
} = {
    isAuthenticated: false,
    credentials: null,
};

function isCurrentPendingExternalAuth(expected: PendingExternalAuth): boolean {
    return pendingExternalAuthState !== null
        && JSON.stringify(pendingExternalAuthState) === JSON.stringify(expected);
}

async function clearPendingExternalAuthForHarness(
    options?: Readonly<{
        removeFirstKeyMigrationAttempted?:
            PendingExternalAuth;
    }>,
): Promise<boolean> {
    const marked =
        pendingExternalAuthState
            ?.accountEncryptionFirstKey
            ?.migrationSubmissionAttempted === true;
    if (
        marked
        && !options?.removeFirstKeyMigrationAttempted
    ) {
        return false;
    }
    pendingExternalAuthState = null;
    return true;
}

export const clearPendingExternalAuthMock =
    vi.fn(clearPendingExternalAuthForHarness);
export const recordTeamInvitationPostAuthContinuationMock = vi.fn(
    async (
        expected: PendingExternalAuth,
        continuation: TeamInvitationPostAuthContinuationV1,
    ): Promise<PendingExternalAuth | null> => {
        if (!isCurrentPendingExternalAuth(expected)) return null;
        const updated = { ...expected, postAuthInvitation: continuation };
        pendingExternalAuthState = updated;
        return updated;
    },
);
export const isPendingExternalAuthContinuationCurrentMock = vi.fn(
    async (expected: PendingExternalAuth): Promise<boolean> =>
        isCurrentPendingExternalAuth(expected),
);
export const clearPendingExternalConnectMock = vi.fn(async () => true);
export const readPendingExternalAuthStateMock = vi.fn(async () => ({
    value: pendingExternalAuthState,
    serverMismatch: pendingExternalAuthServerMismatch,
}));

export function setPendingExternalAuthState(next: PendingExternalAuth | null) {
    pendingExternalAuthState = next;
}

export function setPendingExternalAuthServerMismatch(next: boolean) {
    pendingExternalAuthServerMismatch = next;
}

export function setPendingExternalConnectState(next: PendingExternalConnect | null) {
    pendingExternalConnectState = next;
}

export function setPendingAccountDirectoryAuthState(
    next: (Omit<PendingAccountDirectoryAuth, 'canonicalServerUrl' | 'entryIntent'> & Partial<Pick<PendingAccountDirectoryAuth, 'canonicalServerUrl' | 'entryIntent'>>) | null,
) {
    pendingAccountDirectoryAuthState = next
        ? {
            ...next,
            canonicalServerUrl: next.canonicalServerUrl ?? next.endpoint,
            entryIntent: next.entryIntent ?? { kind: 'enter', target: { kind: 'automatic' } },
        }
        : null;
    if (next?.endpoint && next.serverIdentityId) {
        localSearchParamsMock.mockReturnValue({
            ...localSearchParamsMock(),
            canonicalServerUrl: next.canonicalServerUrl ?? next.endpoint,
        });
        setAccountServiceEndpoint({
            url: next.endpoint,
            serverIdentityId: next.serverIdentityId,
            source: 'user',
        });
    }
}

export function setStoredCredentialsState(next: AuthCredentials | null) {
    storedCredentialsState = next;
}

export function setAuthState(next: { isAuthenticated: boolean; credentials: AuthCredentials | null }) {
    authState = next;
}

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { replace: replaceSpy },
        params: () => localSearchParamsMock(),
    });
    return expoRouterMock.module;
});

function harnessAuth() {
    return {
        isAuthenticated: authState.isAuthenticated,
        credentials: authState.credentials,
        login: loginSpy,
        loginWithCredentials: loginWithCredentialsSpy,
        refreshFromActiveServer: refreshFromActiveServerSpy,
        logout: vi.fn(async () => {}),
    };
}

// The route's step frame reads the optional projection to choose the welcome pane or the card.
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: harnessAuth,
    useOptionalAuth: harnessAuth,
}));

vi.mock(
    '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth',
    async (importOriginal) => {
        const actual = await importOriginal<
            typeof import('@/sync/ops/account/accountEncryptionFirstKeyExternalAuth')
        >();
        return {
            ...actual,
            resumeAccountEncryptionFirstKeyExternalAuth:
                resumeAccountEncryptionFirstKeyExternalAuthSpy,
            resumeAccountPasswordEnrollmentExternalAuth:
                resumeAccountPasswordEnrollmentExternalAuthSpy,
            cancelAccountPasswordEnrollmentExternalAuth:
                cancelAccountPasswordEnrollmentExternalAuthSpy,
            clearAccountPasswordEnrollmentExternalAuthCustody:
                clearAccountPasswordEnrollmentExternalAuthCustodySpy,
            readAccountPasswordEnrollmentExternalAuthCallbackContext:
                readAccountPasswordEnrollmentExternalAuthCallbackContextSpy,
        };
    },
);

vi.mock('@/track', () => ({
    trackAccountCreated: trackAccountCreatedSpy,
    trackAccountRestored: trackAccountRestoredSpy,
}));

vi.mock('@/auth/accountDirectory/accountDirectoryAuthClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/accountDirectory/accountDirectoryAuthClient')>();
    return {
        ...actual,
        accountDirectoryAuthClient: {
            ...actual.accountDirectoryAuthClient,
            exchangeOAuth: accountDirectoryExchangeOAuthSpy,
        },
    };
});

vi.mock('@/modal', () => ({ Modal: modal }));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    subscribeActiveServer: () => () => {},
    getActiveServerSnapshot: () => activeServerSnapshotState,
    getActiveServerHomeCarrier: () => null,
    upsertAndActivateServer: upsertAndActivateServerSpy,
}));

vi.mock('@/sync/api/capabilities/sessionSharingSupport', () => ({
    isSessionSharingSupported: async () => false,
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: (length: number) => getRandomBytesSpy(length),
    getRandomBytesAsync: async (length: number) => new Uint8Array(length).fill(9),
}));

vi.mock('@/auth/storage/tokenStorage', async () => {
    const actual = await vi.importActual<typeof import('@/auth/storage/tokenStorage')>('@/auth/storage/tokenStorage');
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getPendingExternalAuth: async () => (pendingExternalAuthServerMismatch ? null : pendingExternalAuthState),
            readPendingExternalAuthState: readPendingExternalAuthStateMock,
            readPendingExternalAuthContinuationState:
                readPendingExternalAuthStateMock,
            readPendingExternalAuthStateForServerUrl:
                readPendingExternalAuthStateMock,
            clearPendingExternalAuth: clearPendingExternalAuthMock,
            isPendingExternalAuthContinuationCurrent:
                isPendingExternalAuthContinuationCurrentMock,
            recordTeamInvitationPostAuthContinuation:
                recordTeamInvitationPostAuthContinuationMock,
            getPendingExternalConnect: async () => pendingExternalConnectState,
            clearPendingExternalConnect: clearPendingExternalConnectMock,
            getCredentials: async () => storedCredentialsState,
            getCredentialsForServerUrl: async () => storedCredentialsState,
            getPendingAccountDirectoryAuth: pendingAccountDirectoryAuthGetSpy,
            resolvePendingAccountDirectoryAuthCustody: pendingAccountDirectoryAuthCustodyResolveSpy,
            clearPendingAccountDirectoryAuth: pendingAccountDirectoryAuthClearSpy,
            accountDirectoryAuthCredentials: {
                ...actual.TokenStorage.accountDirectoryAuthCredentials,
                get: accountDirectoryCredentialGetSpy,
                set: accountDirectoryCredentialSetSpy,
            },
        },
    };
});

vi.mock('@/encryption/libsodium.lib', async () => {
    const { deriveBoxPublicKeyFromSeed } = await vi.importActual<typeof import('@happier-dev/protocol')>('@happier-dev/protocol');
    const tweetnacl = (
        await vi.importActual<{ default: typeof import('tweetnacl') }>('tweetnacl')
    ).default;
    const boxSecretKey = new Uint8Array(32).fill(5);
    const boxKeyPair = tweetnacl.box.keyPair.fromSecretKey(boxSecretKey);
    return {
        default: {
            ready: Promise.resolve(),
            crypto_sign_seed_keypair: (_seed: Uint8Array) => ({
                publicKey: new Uint8Array(32).fill(1),
                privateKey: new Uint8Array(64).fill(2),
            }),
            crypto_sign_detached: (_message: Uint8Array, _privateKey: Uint8Array) => new Uint8Array(64).fill(3),
            crypto_box_seed_keypair: (_seed: Uint8Array) => ({
                publicKey: deriveBoxPublicKeyFromSeed(boxSecretKey),
                privateKey: boxSecretKey,
            }),
            crypto_box_keypair: () => ({
                publicKey: boxKeyPair.publicKey,
                privateKey: boxKeyPair.secretKey,
            }),
        },
    };
});

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
    loginSpy.mockResolvedValue({ kind: 'completed' });
    loginWithCredentialsSpy.mockReset();
    loginWithCredentialsSpy.mockResolvedValue({ kind: 'completed' });
    refreshFromActiveServerSpy.mockReset();
    refreshFromActiveServerSpy.mockResolvedValue(undefined);
    getRandomBytesSpy.mockReset();
    getRandomBytesSpy.mockImplementation((length = 32) => new Uint8Array(length).fill(9));
    upsertAndActivateServerSpy.mockReset();
    trackAccountCreatedSpy.mockReset();
    trackAccountRestoredSpy.mockReset();
    resumeAccountEncryptionFirstKeyExternalAuthSpy.mockReset();
    resumeAccountEncryptionFirstKeyExternalAuthSpy.mockResolvedValue({
        returnTo: '/settings/account',
    });
    resumeAccountPasswordEnrollmentExternalAuthSpy.mockReset();
    resumeAccountPasswordEnrollmentExternalAuthSpy.mockResolvedValue({
        returnTo: '/settings/account/security?verificationToken=mailbox-proof',
    });
    cancelAccountPasswordEnrollmentExternalAuthSpy.mockReset();
    cancelAccountPasswordEnrollmentExternalAuthSpy.mockResolvedValue({
        returnTo: '/settings/account/security?verificationToken=mailbox-proof',
    });
    clearAccountPasswordEnrollmentExternalAuthCustodySpy.mockReset();
    readAccountPasswordEnrollmentExternalAuthCallbackContextSpy.mockReset();
    readAccountPasswordEnrollmentExternalAuthCallbackContextSpy.mockReturnValue(null);
    maybeCompleteAuthSessionSpy.mockReset();
    maybeCompleteAuthSessionSpy.mockReturnValue({
        type: 'failed',
        message: 'No auth session is currently in progress',
    });
    accountDirectoryCredentialSetSpy.mockReset();
    accountDirectoryCredentialSetSpy.mockResolvedValue(true);
    accountDirectoryCredentialGetSpy.mockReset();
    accountDirectoryCredentialGetSpy.mockResolvedValue(null);
    pendingAccountDirectoryAuthGetSpy.mockReset();
    pendingAccountDirectoryAuthGetSpy.mockImplementation(async () => pendingAccountDirectoryAuthState);
    pendingAccountDirectoryAuthCustodyResolveSpy.mockReset();
    pendingAccountDirectoryAuthCustodyResolveSpy.mockImplementation(async () => pendingAccountDirectoryAuthState
        ? { kind: 'matched' as const, pending: pendingAccountDirectoryAuthState }
        : { kind: 'absent' as const });
    pendingAccountDirectoryAuthClearSpy.mockReset();
    pendingAccountDirectoryAuthClearSpy.mockResolvedValue(true);
    accountDirectoryExchangeOAuthSpy.mockReset();
    if (typeof modal.alert.mockReset === 'function') {
        modal.alert.mockReset();
    } else {
        modal.alert = vi.fn(async () => {});
    }
    modal.show.mockClear();
    modal.alertAsync.mockClear();
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
    clearPendingExternalAuthMock.mockImplementation(
        clearPendingExternalAuthForHarness,
    );
    recordTeamInvitationPostAuthContinuationMock.mockReset();
    recordTeamInvitationPostAuthContinuationMock.mockImplementation(
        async (expected, continuation) => {
            if (!isCurrentPendingExternalAuth(expected)) return null;
            const updated = { ...expected, postAuthInvitation: continuation };
            pendingExternalAuthState = updated;
            return updated;
        },
    );
    isPendingExternalAuthContinuationCurrentMock.mockReset();
    isPendingExternalAuthContinuationCurrentMock.mockImplementation(
        async (expected) => isCurrentPendingExternalAuth(expected),
    );
    clearPendingExternalConnectMock.mockReset();
    clearPendingExternalConnectMock.mockResolvedValue(true);
    readPendingExternalAuthStateMock.mockClear();
    setPendingExternalAuthState({
        provider: 'github',
        secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    setPendingExternalAuthServerMismatch(false);
    setPendingExternalConnectState(null);
    setPendingAccountDirectoryAuthState(null);
    setStoredCredentialsState(null);
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
