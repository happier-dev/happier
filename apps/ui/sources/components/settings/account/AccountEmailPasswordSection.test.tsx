import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    buildApprovalRequestArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import {
    createPasswordCredentialMutationDigestV1} from '@happier-dev/protocol/auth/passwordMutationChallenge';
import {
    encodePasswordCredentialFieldV1} from '@happier-dev/protocol/auth/accountPasswordCredential';
import {
    type ApprovalRequestV2,
} from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { HappyError } from '@/utils/errors/errors';
import { Modal } from '@/modal';
import { nativePasswordTranslations } from '@/text/translations/nativePasswordTranslations';
import { AccountEmailPasswordSection } from './AccountEmailPasswordSection';
import {
    AccountSecurityActionApprovalPendingError,
} from './accountSecurityActionClient';
import { resetAccountSecurityProjectionStoreForTests } from './accountSecurityProjectionStore';

const auth = vi.hoisted(() => ({
    credentials: {
        token: 'token',
        secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
}));
const scope = vi.hoisted(() => ({
    profile: { id: 'account-a' },
    server: { serverId: 'home-a', serverUrl: 'https://home-a.example.test', generation: 1 },
}));
const cryptoBoundary = vi.hoisted(() => ({
    prepareEnroll: vi.fn(),
}));
const externalAuth = vi.hoisted(() => ({
    readProof: vi.fn(),
    start: vi.fn(),
    openSession: vi.fn(),
    clear: vi.fn(async () => true),
}));
const network = vi.hoisted(() => ({
    serverFetch: vi.fn(),
}));
const approvalHost = vi.hoisted(() => ({
    requestApproval: vi.fn(),
}));

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/sync/domains/state/storage', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/state/storage')>()),
    useProfile: () => scope.profile,
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => scope.server,
}));
vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>()),
    captureActiveServerAccountScopeCurrentness: () => ({
        isCurrent: () => true,
        onRetire: () => ({ dispose: () => undefined }),
    }),
}));
vi.mock('@/sync/api/auth/accountSecurity', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/api/auth/accountSecurity')>()),
    prepareE2eeAccountPasswordEnroll: cryptoBoundary.prepareEnroll,
}));
vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/http/client')>()),
    serverFetch: network.serverFetch,
}));
vi.mock('@/sync/ops/account/accountEncryptionFirstKeyExternalAuth', () => ({
    clearAccountPasswordEnrollmentExternalAuthCustody: externalAuth.clear,
    readAccountPasswordEnrollmentExternalAuthProof: externalAuth.readProof,
    startAccountPasswordEnrollmentExternalAuth: externalAuth.start,
    openAccountPasswordEnrollmentExternalAuthSession: externalAuth.openSession,
}));
vi.mock('@/components/approvals/useActionApprovalContinuation', () => ({
    useActionApprovalContinuation: () => ({
        artifact: null,
        approvalId: null,
        approvalStatus: null,
        approvalPending: false,
        isLoading: false,
        error: null,
        invalidArtifact: false,
        requestApproval: approvalHost.requestApproval,
    }),
}));

let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
const originalPlatformOS = Platform.OS;

beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
    network.serverFetch.mockReset();
    // The projection store is module state: a projection read by one test must
    // not seed the next test's first paint.
    resetAccountSecurityProjectionStoreForTests();
});

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    scope.profile = { id: 'account-a' };
    scope.server = { serverId: 'home-a', serverUrl: 'https://home-a.example.test', generation: 1 };
    cryptoBoundary.prepareEnroll.mockReset();
    cryptoBoundary.prepareEnroll.mockResolvedValue({ v: 1, kind: 'e2ee', action: 'connect' });
    externalAuth.readProof.mockReset().mockResolvedValue(null);
    externalAuth.start.mockReset();
    externalAuth.openSession.mockReset();
    externalAuth.clear.mockClear();
    approvalHost.requestApproval.mockReset();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
    vi.unstubAllGlobals();
});

function projection(nativeEmail: string) {
    return {
        v: 1 as const,
        encryptionMode: 'plain' as const,
        nativeEmail,
        password: { status: 'enrolled' as const, revision: 4 },
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => { resolve = next; });
    return { promise, resolve };
}

it('loads the canonical projection and opens the enrolled Plain password form', async () => {
    const client = {
        read: vi.fn(async () => projection('person@example.test')),
        enrollPlainPassword: vi.fn(),
        enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(),
        changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(),
        removeE2eePassword: vi.fn(),
        requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');

    expect(screen.findByTestId('settings-account-change-password-form')).not.toBeNull();
    expect(screen.findByTestId('settings-account-current-password')).not.toBeNull();
});

it('retires old Account work and never renders or republishes its projection after a Home switch', async () => {
    const oldMutation = deferred<{ v: 1; status: 'verification_sent' }>();
    const client = {
        read: vi.fn(async () => scope.profile.id === 'account-a'
            ? projection('alice@example.test')
            : projection('bob@example.test')),
        enrollPlainPassword: vi.fn(), enrollE2eePassword: vi.fn(), changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(),
        requestEmailChange: vi.fn(() => oldMutation.promise),
    };
    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain('alice@example.test'));
    await screen.pressByTestIdAsync('settings-account-sign-in-email');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-change-email-input', 'next@example.test');
    });
    screen.pressByTestId('settings-account-change-email-submit');
    await vi.waitFor(() => expect(client.requestEmailChange).toHaveBeenCalledOnce());

    scope.profile = { id: 'account-b' };
    scope.server = { serverId: 'home-b', serverUrl: 'https://home-b.example.test', generation: 2 };
    // The production hooks publish this scope change. The focused test mocks
    // those hooks with mutable values, so change the injected client identity
    // to make React.memo observe the same render boundary.
    await screen.update(<AccountEmailPasswordSection client={{ ...client }} />);
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain('bob@example.test'));
    expect(screen.findByTestId('settings-account-change-email-form')).toBeNull();

    await act(async () => {
        oldMutation.resolve({ v: 1, status: 'verification_sent' });
        await oldMutation.promise;
    });
    expect(screen.getTextContent()).toContain('bob@example.test');
    expect(screen.getTextContent()).not.toContain('alice@example.test');
    expect(screen.findByTestId('settings-account-pending-email-actions')).toBeNull();
});

it('remains alive through React StrictMode effect replay and publishes the current projection', async () => {
    const client = {
        read: vi.fn(async () => projection('strict@example.test')),
        enrollPlainPassword: vi.fn(), enrollE2eePassword: vi.fn(), changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(), requestEmailChange: vi.fn(),
    };
    screen = await renderScreen(
        <React.StrictMode><AccountEmailPasswordSection client={client} /></React.StrictMode>,
    );
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain('strict@example.test'));
});

function e2eeNotEnrolledProjection() {
    return {
        v: 1 as const,
        encryptionMode: 'e2ee' as const,
        nativeEmail: null,
        password: { status: 'not_enrolled' as const, revision: null },
    };
}

function e2eeEnrolledProjection() {
    return {
        v: 1 as const,
        encryptionMode: 'e2ee' as const,
        nativeEmail: 'person@example.test',
        password: { status: 'enrolled' as const, revision: 4 },
    };
}

function plainNotEnrolledProjection() {
    return {
        v: 1 as const,
        encryptionMode: 'plain' as const,
        nativeEmail: null,
        password: { status: 'not_enrolled' as const, revision: null },
    };
}

async function useSavedE2eeHome() {
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const home = await profiles.upsertServerProfile({
        serverUrl: 'https://home-a.example.test',
        name: 'Home A',
        source: 'manual',
    });
    await profiles.setServerProfileIdentityForUrl(
        home.serverUrl,
        'srv_home_a',
    );
    scope.server = {
        serverId: home.id,
        serverUrl: home.serverUrl,
        generation: 2,
    };
}

function plainTargetCredential() {
    return {
        v: 1 as const,
        kind: 'plain_password_hash' as const,
        hash: {
            v: 1 as const,
            algorithm: 'scrypt' as const,
            parameters: { n: 2 ** 14, r: 8 as const, p: 5, keyLength: 32 as const },
            salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)),
            digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)),
        },
    };
}

function accountPasswordEnrollmentArtifact(input: Readonly<{
    actionInput: unknown;
    artifactId?: string;
    accountId?: string;
    status?: 'executed' | 'failed' | 'rejected';
}>): DecryptedArtifact {
    const status = input.status ?? 'executed';
    const common = {
        v: 2 as const,
        status,
        createdAtMs: 1,
        updatedAtMs: 2,
        createdBy: { surface: 'system' as const },
        requestedSurface: 'ui',
        executionOriginV1: {
            v: 1 as const,
            authority: 'present_user' as const,
            surface: 'ui' as const,
            caller: { kind: 'host' as const },
            serverId: 'home-a',
            accountId: input.accountId ?? 'account-a',
            actionId: 'account.password.enroll' as const,
            requestId: 'request-1',
        },
        actionId: 'account.password.enroll' as const,
        actionArgs: input.actionInput,
        summary: 'Set up a password',
    };
    const request: ApprovalRequestV2 = status === 'executed'
        ? {
            ...common,
            status,
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: { executedAtMs: 2, ok: true, result: { v: 1, status: 'updated' } },
        }
        : status === 'failed'
            ? {
                ...common,
                status,
                decision: { kind: 'approve', decidedAtMs: 2 },
                execution: { executedAtMs: 2, ok: false, errorCode: 'method_not_available' },
            }
            : {
                ...common,
                status,
                decision: { kind: 'reject', decidedAtMs: 2 },
            };
    return {
        id: input.artifactId ?? 'approval-enroll-1',
        title: null,
        header: buildApprovalRequestArtifactHeaderV1(request),
        body: JSON.stringify(request),
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        isDecrypted: true,
    };
}

it('submits first Plain enrollment only with the exact purpose-bound proof in custody', async () => {
    const targetCredential = plainTargetCredential();
    const reauthentication = {
        normalizedNativeEmail: 'person@example.test',
        targetCredential,
        externalAuthProof: { provider: 'github', pending: 'server-pending', proof: 'local-proof' },
    };
    externalAuth.readProof.mockResolvedValueOnce(reauthentication);
    scope.profile = {
        id: 'account-a',
        linkedProviders: [{ id: 'github' }],
    } as never;
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(async () => ({ v: 1 as const, status: 'updated' as const })),
        enrollE2eePassword: vi.fn(), requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken="mailbox-proof" />,
    );
    await vi.waitFor(() => expect(client.enrollPlainPassword).toHaveBeenCalledTimes(1));

    expect(client.enrollPlainPassword).toHaveBeenCalledWith({
        v: 1,
        kind: 'plain',
        email: 'person@example.test',
        targetCredential,
        verificationToken: 'mailbox-proof',
        reauthentication: reauthentication.externalAuthProof,
    }, expect.any(AbortSignal));
    expect(client.changePlainPassword).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(externalAuth.clear).toHaveBeenCalledWith({
        accountId: 'account-a',
        target: {
            serverId: 'home-a',
            serverUrl: 'https://home-a.example.test',
        },
    }));
});

it('settles deferred Plain enrollment from the exact approval Artifact without replaying the Action', async () => {
    const targetCredential = plainTargetCredential();
    const verificationToken = 'A'.repeat(43);
    const prepared = {
        normalizedNativeEmail: 'person@example.test',
        targetCredential,
        externalAuthProof: { provider: 'github', pending: 'server-pending', proof: 'local-proof' },
    };
    externalAuth.readProof.mockResolvedValueOnce(prepared);
    let actionInput: unknown = null;
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(async (input: unknown) => {
            actionInput = input;
            throw new AccountSecurityActionApprovalPendingError(
                'approval-enroll-1',
                'account.password.enroll',
            );
        }),
        enrollE2eePassword: vi.fn(), requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken={verificationToken} />,
    );
    await vi.waitFor(() => expect(approvalHost.requestApproval).toHaveBeenCalledTimes(1));

    expect(client.enrollPlainPassword).toHaveBeenCalledTimes(1);
    expect(screen.getTextContent()).toContain(nativePasswordTranslations.en.approvalPending);
    expect(externalAuth.clear).toHaveBeenCalledWith({
        accountId: 'account-a',
        includingClaimed: true,
        target: { serverId: 'home-a', serverUrl: 'https://home-a.example.test' },
    });

    const continuation = approvalHost.requestApproval.mock.calls[0]?.[0];
    await act(async () => {
        await continuation.onExecuted(accountPasswordEnrollmentArtifact({ actionInput }));
    });

    await vi.waitFor(() => expect(screen?.getTextContent()).toContain(
        nativePasswordTranslations.en.passwordSetUp,
    ));
    expect(client.enrollPlainPassword).toHaveBeenCalledTimes(1);
    expect(client.read.mock.calls.length).toBeGreaterThan(1);

    await act(async () => {
        await continuation.onExecuted(accountPasswordEnrollmentArtifact({ actionInput }));
    });
    expect(client.enrollPlainPassword).toHaveBeenCalledTimes(1);
});

it.each([
    ['rejected', 'rejected', nativePasswordTranslations.en.cancelled],
    ['failed', 'failed', nativePasswordTranslations.en.unavailable],
] as const)('releases deferred Plain enrollment after an approval is %s', async (_label, status, message) => {
    const verificationToken = 'A'.repeat(43);
    const prepared = {
        normalizedNativeEmail: 'person@example.test',
        targetCredential: plainTargetCredential(),
        externalAuthProof: { provider: 'github', pending: 'server-pending', proof: 'local-proof' },
    };
    externalAuth.readProof.mockResolvedValueOnce(prepared);
    let actionInput: unknown = null;
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(async (input: unknown) => {
            actionInput = input;
            throw new AccountSecurityActionApprovalPendingError(
                'approval-enroll-1',
                'account.password.enroll',
            );
        }),
        enrollE2eePassword: vi.fn(), requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken={verificationToken} />,
    );
    await vi.waitFor(() => expect(approvalHost.requestApproval).toHaveBeenCalledTimes(1));
    const continuation = approvalHost.requestApproval.mock.calls[0]?.[0];

    await act(async () => {
        continuation.onTerminal?.(
            status,
            accountPasswordEnrollmentArtifact({ actionInput, status }),
        );
    });

    await vi.waitFor(() => expect(screen?.getTextContent()).toContain(message));
    expect(client.enrollPlainPassword).toHaveBeenCalledTimes(1);
    expect(screen.findByTestId('settings-account-change-password-form')).not.toBeNull();
});

it('expires a deferred Plain enrollment without replaying it or retaining proof custody', async () => {
    const prepared = {
        normalizedNativeEmail: 'person@example.test',
        targetCredential: plainTargetCredential(),
        externalAuthProof: { provider: 'github', pending: 'server-pending', proof: 'local-proof' },
    };
    externalAuth.readProof.mockResolvedValueOnce(prepared);
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(async () => {
            throw new AccountSecurityActionApprovalPendingError(
                'approval-enroll-1',
                'account.password.enroll',
            );
        }),
        enrollE2eePassword: vi.fn(), requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken={'A'.repeat(43)} />,
    );
    await vi.waitFor(() => expect(approvalHost.requestApproval).toHaveBeenCalledTimes(1));
    const continuation = approvalHost.requestApproval.mock.calls[0]?.[0];

    await act(async () => {
        continuation.onTerminal?.('invalid', null);
    });

    await vi.waitFor(() => expect(
        screen?.findByTestId('settings-account-password-form-error'),
    ).not.toBeNull());
    expect(client.enrollPlainPassword).toHaveBeenCalledTimes(1);
    expect(externalAuth.clear).toHaveBeenCalledWith({
        accountId: 'account-a',
        includingClaimed: true,
        target: { serverId: 'home-a', serverUrl: 'https://home-a.example.test' },
    });
});

it('rejects a same-Artifact approval from another Account without completing enrollment', async () => {
    const prepared = {
        normalizedNativeEmail: 'person@example.test',
        targetCredential: plainTargetCredential(),
        externalAuthProof: { provider: 'github', pending: 'server-pending', proof: 'local-proof' },
    };
    externalAuth.readProof.mockResolvedValueOnce(prepared);
    let actionInput: unknown = null;
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(async (input: unknown) => {
            actionInput = input;
            throw new AccountSecurityActionApprovalPendingError(
                'approval-enroll-1',
                'account.password.enroll',
            );
        }),
        enrollE2eePassword: vi.fn(), requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken={'A'.repeat(43)} />,
    );
    await vi.waitFor(() => expect(approvalHost.requestApproval).toHaveBeenCalledTimes(1));
    const continuation = approvalHost.requestApproval.mock.calls[0]?.[0];

    await act(async () => {
        await continuation.onExecuted(accountPasswordEnrollmentArtifact({
            actionInput,
            accountId: 'account-other',
        }));
    });

    await vi.waitFor(() => expect(screen?.getTextContent()).toContain(
        nativePasswordTranslations.en.linkExpired,
    ));
    expect(client.enrollPlainPassword).toHaveBeenCalledTimes(1);
    expect(screen.getTextContent()).not.toContain(nativePasswordTranslations.en.passwordSetUp);
});

it('consumes a mounted proof once and clears failed reauthentication without looping', async () => {
    const prepared = {
        normalizedNativeEmail: 'person@example.test',
        targetCredential: plainTargetCredential(),
        externalAuthProof: {
            provider: 'github',
            pending: 'server-pending',
            proof: 'local-proof',
        },
    };
    externalAuth.readProof.mockResolvedValue(prepared);
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(async () => {
            throw new HappyError('Reauthentication required', false, {
                kind: 'auth', code: 'reauthentication_required',
            });
        }),
        enrollE2eePassword: vi.fn(), requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken="mailbox-proof" />,
    );
    await vi.waitFor(() => expect(client.enrollPlainPassword).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(externalAuth.clear).toHaveBeenCalledWith({
        accountId: 'account-a',
        target: {
            serverId: 'home-a',
            serverUrl: 'https://home-a.example.test',
        },
    }));
    await act(async () => undefined);
    expect(client.enrollPlainPassword).toHaveBeenCalledTimes(1);
});

it('does not auto-submit after reload when process-local enrollment custody is absent', async () => {
    externalAuth.readProof.mockResolvedValue(null);
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(),
        enrollE2eePassword: vi.fn(), requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken="mailbox-proof" />,
    );
    await vi.waitFor(() => expect(externalAuth.readProof).toHaveBeenCalledTimes(1));
    expect(client.enrollPlainPassword).not.toHaveBeenCalled();
    expect(externalAuth.start).not.toHaveBeenCalled();
});

it('retires exact callback-claimed custody when the user cancels enrollment', async () => {
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(),
        enrollE2eePassword: vi.fn(), requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };
    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken="mailbox-proof" />,
    );
    await vi.waitFor(() => expect(
        screen?.findByTestId('settings-account-password-form-cancel'),
    ).not.toBeNull());

    await screen.pressByTestIdAsync('settings-account-password-form-cancel');

    expect(externalAuth.clear).toHaveBeenCalledWith({
        accountId: 'account-a',
        includingClaimed: true,
        target: {
            serverId: 'home-a',
            serverUrl: 'https://home-a.example.test',
        },
    });
    expect(client.enrollPlainPassword).not.toHaveBeenCalled();
});

it('stops an in-flight preparation when the person cancels, instead of dispatching after it', async () => {
    let releaseProof!: (value: unknown) => void;
    externalAuth.readProof.mockReturnValueOnce(new Promise((resolve) => { releaseProof = resolve; }));
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(async () => ({ v: 1 as const, status: 'updated' as const })),
        enrollE2eePassword: vi.fn(), requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken="mailbox-proof" />,
    );
    await vi.waitFor(() => expect(externalAuth.readProof).toHaveBeenCalledTimes(1));

    await screen.pressByTestIdAsync('settings-account-password-form-cancel');
    await act(async () => {
        releaseProof({
            normalizedNativeEmail: 'person@example.test',
            targetCredential: plainTargetCredential(),
            externalAuthProof: { provider: 'github', pending: 'server-pending', proof: 'local-proof' },
        });
        await Promise.resolve();
    });

    // Cancel is an escape the person may press while the section is busy. The
    // preparation it belonged to must not still reach the Home afterwards.
    expect(client.enrollPlainPassword).not.toHaveBeenCalled();

    // Cancelling retired that operation, so the section is usable again in the
    // same mounted Account: reopening the form offers editable fields rather
    // than a section latched busy by the operation nobody is waiting for.
    await screen.pressByTestIdAsync('settings-account-password');
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-change-password-form')).not.toBeNull());
    expect(screen.findByTestId('settings-account-new-password')?.props.editable).toBe(true);
});

it('aborts mounted proof submission and retires process-local custody on unmount', async () => {
    externalAuth.readProof.mockResolvedValue({
        normalizedNativeEmail: 'person@example.test',
        targetCredential: plainTargetCredential(),
        externalAuthProof: {
            provider: 'github',
            pending: 'server-pending',
            proof: 'local-proof',
        },
    });
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(async (_request: unknown, signal: AbortSignal) => await new Promise<never>(
            (_resolve, reject) => signal.addEventListener(
                'abort',
                () => reject(new Error('Aborted')),
                { once: true },
            ),
        )),
        enrollE2eePassword: vi.fn(), requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken="mailbox-proof" />,
    );
    await vi.waitFor(() => expect(client.enrollPlainPassword).toHaveBeenCalledTimes(1));
    const signal = client.enrollPlainPassword.mock.calls[0]?.[1];
    await screen.unmount();
    screen = null;
    await act(async () => { await Promise.resolve(); });
    expect(signal?.aborted).toBe(true);
    expect(externalAuth.clear).toHaveBeenCalledWith({
        accountId: 'account-a',
        target: {
            serverId: 'home-a',
            serverUrl: 'https://home-a.example.test',
        },
    });
});

it('opens web OAuth from a direct continuation gesture and submits in the live custody owner', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const targetCredential = plainTargetCredential();
    const resumedProof = {
        normalizedNativeEmail: 'person@example.test',
        targetCredential,
        externalAuthProof: {
            provider: 'github',
            pending: 'server-pending',
            proof: 'local-proof',
        },
    };
    scope.profile = {
        id: 'account-a',
        linkedProviders: [{ id: 'github' }],
    } as never;
    externalAuth.readProof
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(resumedProof);
    externalAuth.start.mockResolvedValueOnce({
        kind: 'oauth',
        provider: 'github',
        url: 'https://github.example.test/authorize',
    });
    externalAuth.openSession.mockResolvedValueOnce({ kind: 'completed' });
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(async () => ({ v: 1 as const, status: 'updated' as const })),
        enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };
    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken="mailbox-proof" />,
    );
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-change-password-form')).not.toBeNull());
    await act(async () => {
        screen?.changeTextByTestId('settings-account-password-enroll-email', 'Person@Example.test');
        screen?.changeTextByTestId('settings-account-new-password', 'correct horse battery staple');
        screen?.changeTextByTestId('settings-account-confirm-password', 'correct horse battery staple');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');

    expect(externalAuth.start).toHaveBeenCalledWith({
        accountId: 'account-a',
        currentCredentials: auth.credentials,
        linkedProviderIds: ['github'],
        normalizedNativeEmail: 'person@example.test',
        newPassword: 'correct horse battery staple',
        signal: expect.any(AbortSignal),
        returnTo: '/settings/account/security?verificationToken=mailbox-proof&serverId=home-a',
        target: {
            serverId: 'home-a',
            serverUrl: 'https://home-a.example.test',
        },
    });
    expect(externalAuth.openSession).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(
        screen?.findByTestId('settings-account-password-enrollment-continue'),
    ).not.toBeNull());
    expect(screen?.findByTestId('settings-account-new-password')?.props.editable).toBe(false);
    expect(screen?.findByTestId('settings-account-password-enroll-email')?.props.editable).toBe(false);

    await screen.pressByTestIdAsync('settings-account-password-enrollment-continue');

    expect(externalAuth.openSession).toHaveBeenCalledWith({
        kind: 'oauth',
        provider: 'github',
        url: 'https://github.example.test/authorize',
        currentCredentials: auth.credentials,
        target: {
            serverId: 'home-a',
            serverUrl: 'https://home-a.example.test',
        },
    });
    expect(externalAuth.readProof).toHaveBeenCalledTimes(3);
    expect(client.enrollPlainPassword).toHaveBeenCalledWith({
        v: 1,
        kind: 'plain',
        email: 'person@example.test',
        targetCredential,
        verificationToken: 'mailbox-proof',
        reauthentication: resumedProof.externalAuthProof,
    }, expect.any(AbortSignal));
});

it('unlocks the web enrollment form for a fresh preparation after the auth popup closes', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    scope.profile = {
        id: 'account-a',
        linkedProviders: [{ id: 'github' }],
    } as never;
    externalAuth.start.mockResolvedValueOnce({
        kind: 'oauth',
        provider: 'github',
        url: 'https://github.example.test/authorize',
    });
    externalAuth.openSession.mockResolvedValueOnce({ kind: 'cancelled' });
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(), enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };
    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken="mailbox-proof" />,
    );
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-change-password-form')).not.toBeNull());
    await act(async () => {
        screen?.changeTextByTestId('settings-account-password-enroll-email', 'person@example.test');
        screen?.changeTextByTestId('settings-account-new-password', 'correct horse battery staple');
        screen?.changeTextByTestId('settings-account-confirm-password', 'correct horse battery staple');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(
        screen?.findByTestId('settings-account-password-enrollment-continue'),
    ).not.toBeNull());

    await screen.pressByTestIdAsync('settings-account-password-enrollment-continue');

    await vi.waitFor(() => expect(
        screen?.findByTestId('settings-account-change-password-submit'),
    ).not.toBeNull());
    expect(screen?.findByTestId('settings-account-new-password')?.props.editable).toBe(true);
    expect(client.enrollPlainPassword).not.toHaveBeenCalled();
});

it('requests mailbox verification before acquiring a Plain enrollment proof', async () => {
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(), enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(async () => undefined),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };
    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');
    // The password typed here would be discarded and asked for again on the
    // verified continuation, so this step must not collect one.
    expect(screen.findByTestId('settings-account-new-password')).toBeNull();
    expect(screen.findByTestId('settings-account-confirm-password')).toBeNull();
    await act(async () => {
        screen?.changeTextByTestId('settings-account-password-enroll-email', 'Person@Example.test');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');

    expect(client.requestPasswordEnrollmentEmail).toHaveBeenCalledWith(
        { email: 'person@example.test' }, expect.any(AbortSignal),
    );
    expect(externalAuth.start).not.toHaveBeenCalled();
    expect(client.enrollPlainPassword).not.toHaveBeenCalled();
    // The mailbox is the proof channel; the screen only ever echoes it masked.
    const rendered = screen.getTextContent();
    expect(rendered).toContain('p•••••@example.test');
    expect(rendered).not.toContain('person@example.test');
});

it('opens the existing first-password enrollment form for an explicit Connect continuation', async () => {
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(), enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} connectIntent />,
    );

    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-change-password-form')).not.toBeNull());
    expect(screen.findByTestId('settings-account-password-enroll-email')).not.toBeNull();
    expect(client.requestPasswordEnrollmentEmail).not.toHaveBeenCalled();
});

it('requests exact-Account mailbox verification before first E2EE password enrollment', async () => {
    await useSavedE2eeHome();
    const client = {
        read: vi.fn(async () => e2eeNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(),
        enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(async () => undefined),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');
    // Exactly as for Plain: this step only proves the mailbox, so a password
    // typed here would be discarded and asked for again on the continuation.
    expect(screen.findByTestId('settings-account-new-password')).toBeNull();
    expect(screen.findByTestId('settings-account-confirm-password')).toBeNull();
    await act(async () => {
        screen?.changeTextByTestId('settings-account-password-enroll-email', 'Person@Example.test');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');

    expect(client.requestPasswordEnrollmentEmail).toHaveBeenCalledWith(
        { email: 'person@example.test' },
        expect.any(AbortSignal),
    );
    expect(cryptoBoundary.prepareEnroll).not.toHaveBeenCalled();
    expect(client.enrollE2eePassword).not.toHaveBeenCalled();
    expect(screen.findByTestId('settings-account-pending-email-actions')).not.toBeNull();
});

it('carries the exact mailbox verification bearer into the existing E2EE enrollment Action', async () => {
    await useSavedE2eeHome();
    const preparedRequest = { v: 1 as const, kind: 'e2ee' as const, action: 'connect' as const };
    cryptoBoundary.prepareEnroll.mockResolvedValueOnce(preparedRequest);
    const client = {
        read: vi.fn(async () => e2eeNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(),
        enrollE2eePassword: vi.fn(async () => ({ v: 1 as const, status: 'updated' as const })),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken="enrollment-proof" />,
    );
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-change-password-form')).not.toBeNull());
    await act(async () => {
        screen?.changeTextByTestId('settings-account-password-enroll-email', 'Person@Example.test');
        screen?.changeTextByTestId('settings-account-new-password', 'correct horse battery staple');
        screen?.changeTextByTestId('settings-account-confirm-password', 'correct horse battery staple');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');

    expect(cryptoBoundary.prepareEnroll).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
            accountId: 'account-a',
            normalizedNativeEmail: 'person@example.test',
            verificationToken: 'enrollment-proof',
            expectedAudience: {
                origin: 'https://home-a.example.test',
                serverIdentityId: 'srv_home_a',
            },
        }),
    );
    expect(client.requestPasswordEnrollmentEmail).not.toHaveBeenCalled();
    expect(client.enrollE2eePassword).toHaveBeenCalledWith(preparedRequest, expect.any(AbortSignal));
});

it('validates E2EE mutation proof against the stable Home identity and canonical URL, not its profile alias', async () => {
    const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
    const home = await adoptHomeProfile({
        source: 'manual',
        descriptorAuthority: 'current_connection_observation',
        descriptor: {
            v: 1,
            homeServerIdentityId: 'srv_home_a',
            canonicalServerUrl: 'https://canonical-home-a.example.test',
            revision: 1,
            endpoints: [{ kind: 'https', url: 'https://edge-home-a.example.test' }],
        },
    });
    expect(home.id).not.toBe('srv_home_a');
    scope.server = {
        serverId: home.id,
        serverUrl: home.serverUrl,
        generation: 2,
    };
    const expectedAudience = {
        origin: 'https://canonical-home-a.example.test',
        serverIdentityId: 'srv_home_a',
    } as const;
    const operationDigest = createPasswordCredentialMutationDigestV1({
        v: 1,
        action: 'remove',
        accountId: 'account-a',
        expectedCredentialRevision: 4,
        normalizedNativeEmail: 'person@example.test',
        newCredentialDigest: null,
    });
    network.serverFetch.mockResolvedValueOnce(Response.json({
        challenge: {
            v: 1,
            challengeId: 'challenge-remove',
            nonce: 'nonce',
            issuedAt: '2026-09-08T10:00:00.000Z',
            expiresAt: '2026-09-08T10:05:00.000Z',
            audience: expectedAudience,
            expectedAccountId: 'account-a',
            operationKind: 'password_credential_mutation_v1',
            operationDigest,
        },
    }));
    const client = {
        read: vi.fn(async () => e2eeEnrolledProjection()),
        enrollPlainPassword: vi.fn(), enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(),
        removeE2eePassword: vi.fn(async () => ({ v: 1 as const, status: 'updated' as const })),
        requestEmailChange: vi.fn(),
    };
    const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValueOnce(true);
    try {
        screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
        await vi.waitFor(() => expect(
            screen?.findByTestId('settings-account-password-remove'),
        ).not.toBeNull());
        await screen.pressByTestIdAsync('settings-account-password-remove');
        await vi.waitFor(() => expect(
            screen?.findByTestId('settings-account-remove-password-submit'),
        ).not.toBeNull());
        await screen.pressByTestIdAsync('settings-account-remove-password-submit');

        await vi.waitFor(() => expect(client.removeE2eePassword).toHaveBeenCalledTimes(1));
        expect(network.serverFetch).toHaveBeenCalledWith(
            '/v1/auth/password/mutation/challenge',
            expect.objectContaining({ method: 'POST' }),
            { retry: 'none', onIssued: expect.any(Function) },
        );
        expect(client.removeE2eePassword).toHaveBeenCalledWith(
            expect.objectContaining({
                v: 1,
                kind: 'e2ee',
                expectedCredentialRevision: 4,
                proof: expect.objectContaining({ challengeId: 'challenge-remove' }),
            }),
            expect.any(AbortSignal),
        );
    } finally {
        confirm.mockRestore();
    }
});

it('echoes a requested sign-in email change only as a masked address', async () => {
    const client = {
        read: vi.fn(async () => projection('person@example.test')),
        enrollPlainPassword: vi.fn(), enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(),
        requestEmailChange: vi.fn(async () => ({
            v: 1 as const,
            status: 'verification_sent' as const,
        })),
    };

    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-sign-in-email')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-sign-in-email');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-change-email-input', 'Next.Person@Example.test');
    });
    await screen.pressByTestIdAsync('settings-account-change-email-submit');

    await vi.waitFor(() => expect(
        screen?.findByTestId('settings-account-pending-email-actions'),
    ).not.toBeNull());
    expect(client.requestEmailChange).toHaveBeenCalledWith(
        { email: 'Next.Person@example.test' },
        expect.any(AbortSignal),
    );
    const rendered = screen.getTextContent();
    expect(rendered).toContain('n••••••••••@example.test');
    expect(rendered).not.toContain('Next.Person@example.test');
    expect(rendered).not.toContain('next.person@example.test');
});

it('confirms a completed Plain password change on the surface that requested it', async () => {
    const client = {
        read: vi.fn(async () => projection('person@example.test')),
        enrollPlainPassword: vi.fn(), enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(async () => ({ v: 1 as const, status: 'updated' as const })),
        changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-current-password', 'previous horse battery staple');
        screen?.changeTextByTestId('settings-account-new-password', 'correct horse battery staple');
        screen?.changeTextByTestId('settings-account-confirm-password', 'correct horse battery staple');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');

    await vi.waitFor(() => expect(client.changePlainPassword).toHaveBeenCalledTimes(1));
    // Enrolled -> enrolled changes nothing on the Password row, so the completed
    // mutation would otherwise be invisible.
    await vi.waitFor(() => expect(
        screen?.findByTestId('settings-account-password-outcome'),
    ).not.toBeNull());
    expect(screen.getTextContent()).toContain(
        nativePasswordTranslations.en.passwordChanged,
    );
    expect(screen.findByTestId('settings-account-change-password-form')).toBeNull();
});

it('clears a completed-change confirmation when the person reopens the password form', async () => {
    const client = {
        read: vi.fn(async () => projection('person@example.test')),
        enrollPlainPassword: vi.fn(), enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(async () => ({ v: 1 as const, status: 'updated' as const })),
        changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-current-password', 'previous horse battery staple');
        screen?.changeTextByTestId('settings-account-new-password', 'correct horse battery staple');
        screen?.changeTextByTestId('settings-account-confirm-password', 'correct horse battery staple');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(
        screen?.findByTestId('settings-account-password-outcome'),
    ).not.toBeNull());

    await screen.pressByTestIdAsync('settings-account-password');

    expect(screen.findByTestId('settings-account-password-outcome')).toBeNull();
});

it('settles the surface after native OAuth enrollment completes without a second gesture', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const targetCredential = plainTargetCredential();
    const resumedProof = {
        normalizedNativeEmail: 'person@example.test',
        targetCredential,
        externalAuthProof: { provider: 'github', pending: 'server-pending', proof: 'local-proof' },
    };
    scope.profile = { id: 'account-a', linkedProviders: [{ id: 'github' }] } as never;
    externalAuth.readProof
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(resumedProof);
    externalAuth.start.mockResolvedValueOnce({
        kind: 'oauth',
        provider: 'github',
        url: 'https://github.example.test/authorize',
    });
    externalAuth.openSession.mockResolvedValueOnce({ kind: 'completed' });
    const client = {
        read: vi.fn(async () => plainNotEnrolledProjection()),
        enrollPlainPassword: vi.fn(async () => ({ v: 1 as const, status: 'updated' as const })),
        enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
    };

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken="mailbox-proof" />,
    );
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-change-password-form')).not.toBeNull());
    await act(async () => {
        screen?.changeTextByTestId('settings-account-password-enroll-email', 'Person@Example.test');
        screen?.changeTextByTestId('settings-account-new-password', 'correct horse battery staple');
        screen?.changeTextByTestId('settings-account-confirm-password', 'correct horse battery staple');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');

    // Native opens the provider session inline, so the enrollment completes in
    // this one gesture and the surface must show its own result.
    await vi.waitFor(() => expect(client.enrollPlainPassword).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(
        screen?.findByTestId('settings-account-password-outcome'),
    ).not.toBeNull());
    expect(screen.getTextContent()).toContain(nativePasswordTranslations.en.passwordSetUp);
    expect(screen.findByTestId('settings-account-change-password-form')).toBeNull();
    // The Home owns enrolment truth; the surface re-reads it rather than
    // assuming the projection it loaded before the mutation is still current.
    expect(client.read).toHaveBeenCalledTimes(2);
});

function clientFor(read: () => Promise<unknown>, overrides: Record<string, unknown> = {}) {
    return {
        read: vi.fn(read),
        enrollPlainPassword: vi.fn(), enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(), changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(), removeE2eePassword: vi.fn(), requestEmailChange: vi.fn(),
        ...overrides,
    } as never;
}

it('keeps the section and its rows in place while the projection loads', async () => {
    const pending = deferred<ReturnType<typeof projection>>();
    screen = await renderScreen(<AccountEmailPasswordSection client={clientFor(() => pending.promise)} />);

    // The rows exist before their values do, so nothing below them moves when
    // the projection arrives: two quiet placeholder rows, announced as busy,
    // never a "Loading…" text value.
    const placeholder = screen.findHostByTestId('settings-account-security-loading');
    expect(placeholder?.props.accessibilityState).toEqual({ busy: true });
    expect(screen.findHostByTestId('settings-account-security-loading-skeleton:1')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain('common.loading');

    await act(async () => {
        pending.resolve(projection('person@example.test'));
        await pending.promise;
    });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-sign-in-email')).not.toBeNull());
    expect(screen.findByTestId('settings-account-security-loading')).toBeNull();
    expect(screen.getTextContent()).toContain('person@example.test');
});

it('keeps the unavailable row on screen while a retry is in flight', async () => {
    const retry = deferred<ReturnType<typeof projection>>();
    const read = vi.fn<() => Promise<ReturnType<typeof projection>>>()
        .mockRejectedValueOnce(new Error('offline'))
        .mockReturnValueOnce(retry.promise);
    screen = await renderScreen(<AccountEmailPasswordSection client={clientFor(read)} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-security-unavailable')).not.toBeNull());

    // One failure row for the read, saying what failed, with its Retry.
    await act(async () => {
        screen?.pressByTestId('settings-account-security-unavailable-retry');
    });
    expect(read).toHaveBeenCalledTimes(2);
    // Retrying never blanks the section: the row stays until the answer lands.
    expect(screen.findByTestId('settings-account-security-unavailable')).not.toBeNull();

    await act(async () => {
        retry.resolve(projection('person@example.test'));
        await retry.promise;
    });
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-sign-in-email')).not.toBeNull());
    expect(screen.findByTestId('settings-account-security-unavailable')).toBeNull();
});

it('shows a failure of the mailbox-first step even though that step has no password field', async () => {
    const client = clientFor(async () => plainNotEnrolledProjection(), {
        requestPasswordEnrollmentEmail: vi.fn(async () => {
            throw new HappyError('refused', false, { kind: 'auth', code: 'unrecognised_refusal' });
        }),
    });
    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-password-enroll-email', 'person@example.test');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');

    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password-form-error')).not.toBeNull());
});

it('submits the password form from the keyboard on the last field', async () => {
    const client = clientFor(async () => projection('person@example.test'), {
        changePlainPassword: vi.fn(async () => ({ v: 1 as const, status: 'updated' as const })),
    });
    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-current-password', 'previous horse battery staple');
        screen?.changeTextByTestId('settings-account-new-password', 'correct horse battery staple');
        screen?.changeTextByTestId('settings-account-confirm-password', 'correct horse battery staple');
    });
    await act(async () => {
        screen?.findHostByTestId('settings-account-confirm-password')?.props.onSubmitEditing?.();
    });

    await vi.waitFor(() => expect((client as { changePlainPassword: ReturnType<typeof vi.fn> }).changePlainPassword).toHaveBeenCalledTimes(1));
});

it('submits the sign-in email form from the keyboard', async () => {
    const client = clientFor(async () => projection('person@example.test'), {
        requestEmailChange: vi.fn(async () => ({ v: 1 as const, status: 'verification_sent' as const })),
    });
    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-sign-in-email')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-sign-in-email');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-change-email-input', 'next@example.test');
    });
    await act(async () => {
        screen?.findHostByTestId('settings-account-change-email-input')?.props.onSubmitEditing?.();
    });

    await vi.waitFor(() => expect((client as { requestEmailChange: ReturnType<typeof vi.fn> }).requestEmailChange).toHaveBeenCalledWith(
        { email: 'next@example.test' }, expect.any(AbortSignal),
    ));
});

it('shows one problem once, on the surface that produced it, while an address is pending', async () => {
    const client = clientFor(async () => projection('person@example.test'), {
        requestEmailChange: vi.fn(async () => ({ v: 1 as const, status: 'verification_sent' as const })),
        changePlainPassword: vi.fn(async () => {
            throw new HappyError('wrong', false, { kind: 'auth', code: 'authentication_failed' });
        }),
    });
    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-sign-in-email')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-sign-in-email');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-change-email-input', 'next@example.test');
    });
    await screen.pressByTestIdAsync('settings-account-change-email-submit');
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-pending-email-actions')).not.toBeNull());

    await screen.pressByTestIdAsync('settings-account-password');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-current-password', 'not my password at all');
        screen?.changeTextByTestId('settings-account-new-password', 'correct horse battery staple');
        screen?.changeTextByTestId('settings-account-confirm-password', 'correct horse battery staple');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');

    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-current-password-error')).not.toBeNull());
    const message = nativePasswordTranslations.en.signInFailed;
    expect(screen.getTextContent().split(message).length - 1).toBe(1);
    // The pending address is still announced in its own row.
    expect(screen.findByTestId('settings-account-pending-email-actions')).not.toBeNull();
});

/** The ids rendered inside one row's subtree. */
function rowContains(row: { findAll: (predicate: (node: { props?: { testID?: unknown } }) => boolean) => unknown[] } | null, testID: string): boolean {
    return (row?.findAll((node) => node.props?.testID === testID).length ?? 0) > 0;
}

function setupStep(): number | undefined {
    return screen?.findByTestId('settings-account-email-password-steps')?.props.accessibilityValue?.now;
}

it('says a sign-in email comes first and runs the one mailbox-first setup from the email row', async () => {
    const client = clientFor(async () => plainNotEnrolledProjection(), {
        requestPasswordEnrollmentEmail: vi.fn(async () => undefined),
    });
    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    expect(screen.getTextContent()).toContain(nativePasswordTranslations.en.passwordNeedsEmail);

    // Password leads into the email row instead of opening an email form of its own.
    await screen.pressByTestIdAsync('settings-account-password');
    const emailRow = screen.findByTestId('settings-account-sign-in-email-row');
    expect(rowContains(emailRow, 'settings-account-password-enroll-email')).toBe(true);
    expect(screen.findAllHostsByTestId('settings-account-password-enroll-email')).toHaveLength(1);
    expect(setupStep()).toBe(1);

    await act(async () => {
        screen?.changeTextByTestId('settings-account-password-enroll-email', 'person@example.test');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');
    expect((client as unknown as { requestPasswordEnrollmentEmail: ReturnType<typeof vi.fn> }).requestPasswordEnrollmentEmail)
        .toHaveBeenCalledWith({ email: 'person@example.test' }, expect.any(AbortSignal));
    // Step 2: the confirmation is awaited in the same row.
    await vi.waitFor(() => expect(rowContains(screen!.findByTestId('settings-account-sign-in-email-row'), 'settings-account-pending-email-actions')).toBe(true));
    expect(setupStep()).toBe(2);
});

it('does not offer a sign-in email change when there is no sign-in email to change', async () => {
    // The Home refuses an email change without a current sign-in email (`identity_changed`);
    // the first address is added by the mailbox-first setup.
    const client = clientFor(async () => e2eeNotEnrolledProjection(), {
        requestPasswordEnrollmentEmail: vi.fn(async () => undefined),
    });
    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-sign-in-email')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-sign-in-email');

    expect(screen.findByTestId('settings-account-change-email-form')).toBeNull();
    expect(screen.findByTestId('settings-account-password-enroll-email')).not.toBeNull();
    await act(async () => {
        screen?.changeTextByTestId('settings-account-password-enroll-email', 'person@example.test');
    });
    await screen.pressByTestIdAsync('settings-account-change-password-submit');

    const calls = client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(calls.requestEmailChange).not.toHaveBeenCalled();
    expect(calls.requestPasswordEnrollmentEmail).toHaveBeenCalledWith({ email: 'person@example.test' }, expect.any(AbortSignal));
});

it('continues the setup at the password step in the email row after the confirmation link', async () => {
    await useSavedE2eeHome();
    const client = clientFor(async () => e2eeNotEnrolledProjection());
    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} verificationToken="enrollment-proof" />,
    );
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-change-password-form')).not.toBeNull());

    const emailRow = screen.findByTestId('settings-account-sign-in-email-row');
    expect(rowContains(emailRow, 'settings-account-new-password')).toBe(true);
    expect(setupStep()).toBe(3);
});
