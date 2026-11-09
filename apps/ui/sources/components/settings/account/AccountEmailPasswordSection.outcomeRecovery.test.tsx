import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { HappyError } from '@/utils/errors/errors';
import { nativePasswordTranslations } from '@/text/translations/nativePasswordTranslations';

import { AccountEmailPasswordSection } from './AccountEmailPasswordSection';

const copy = nativePasswordTranslations.en;

const auth = vi.hoisted(() => ({
    credentials: { token: 'token' },
}));
const scope = vi.hoisted(() => ({
    profile: { id: 'account-a' },
    server: { serverId: 'home-a', serverUrl: 'https://home-a.example.test', generation: 1 },
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
vi.mock('@/sync/ops/account/accountEncryptionFirstKeyExternalAuth', () => ({
    clearAccountPasswordEnrollmentExternalAuthCustody: vi.fn(async () => true),
    readAccountPasswordEnrollmentExternalAuthProof: vi.fn(async () => null),
    startAccountPasswordEnrollmentExternalAuth: vi.fn(),
    openAccountPasswordEnrollmentExternalAuthSession: vi.fn(),
}));

let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;

beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
});

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    vi.unstubAllGlobals();
});

function enrolledPlainProjection(revision: number) {
    return {
        v: 1 as const,
        encryptionMode: 'plain' as const,
        nativeEmail: 'person@example.test',
        password: { status: 'enrolled' as const, revision },
    };
}

function createClient(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        read: vi.fn(async () => enrolledPlainProjection(4)),
        enrollPlainPassword: vi.fn(),
        enrollE2eePassword: vi.fn(),
        requestPasswordEnrollmentEmail: vi.fn(),
        changePlainPassword: vi.fn(),
        changeE2eePassword: vi.fn(),
        removePlainPassword: vi.fn(),
        removeE2eePassword: vi.fn(),
        requestEmailChange: vi.fn(),
        ...overrides,
    };
}

async function openChangePasswordForm(client: ReturnType<typeof createClient>) {
    screen = await renderScreen(<AccountEmailPasswordSection client={client} />);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');
    await act(async () => {
        screen?.changeTextByTestId('settings-account-current-password', 'current-password-value');
        screen?.changeTextByTestId('settings-account-new-password', 'a-long-enough-new-password');
        screen?.changeTextByTestId('settings-account-confirm-password', 'a-long-enough-new-password');
    });
    return screen;
}

function readFormError(): unknown {
    return screen?.findByTestId('settings-account-password-form-error')?.props.children ?? null;
}

it('reports an unconfirmed outcome instead of blaming the credential when a change loses its verdict', async () => {
    const client = createClient({
        changePlainPassword: vi.fn(async () => { throw new HappyError('unknown', false, { code: 'outcome_unknown' }); }),
    });
    await openChangePasswordForm(client);

    await screen!.pressByTestIdAsync('settings-account-change-password-submit');

    await vi.waitFor(() => expect(readFormError()).toBe(copy.outcomeUnconfirmed));
    expect(readFormError()).not.toBe(copy.signInFailed);
    expect(readFormError()).not.toBe(copy.offline);
});

it('reconciles the authoritative projection after an unconfirmed change so the form is not left stale', async () => {
    const client = createClient({
        changePlainPassword: vi.fn(async () => { throw new HappyError('unknown', false, { code: 'outcome_unknown' }); }),
    });
    await openChangePasswordForm(client);
    const readsBeforeSubmit = client.read.mock.calls.length;

    await screen!.pressByTestIdAsync('settings-account-change-password-submit');

    await vi.waitFor(() => expect(client.read.mock.calls.length).toBeGreaterThan(readsBeforeSubmit));
});

it('re-reads the credential revision after a revision conflict so the next attempt can win', async () => {
    let revision = 4;
    const changePlainPassword = vi.fn(async (input: { expectedCredentialRevision: number }) => {
        if (input.expectedCredentialRevision === 4) {
            // The conflict means Home already owns a newer revision by the time
            // this mutation returns; expose it to the reconciliation read.
            revision = 9;
            throw new HappyError('conflict', false, { kind: 'auth', code: 'credential_revision_conflict' });
        }
        return { v: 1 as const, status: 'updated' as const };
    });
    const client = createClient({
        read: vi.fn(async () => enrolledPlainProjection(revision)),
        changePlainPassword,
    });
    await openChangePasswordForm(client);

    await screen!.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(readFormError()).toBe(copy.revisionConflict));

    await vi.waitFor(() => expect(client.read.mock.calls.length).toBeGreaterThan(1));

    await act(async () => {
        screen?.changeTextByTestId('settings-account-current-password', 'current-password-value');
        screen?.changeTextByTestId('settings-account-new-password', 'a-long-enough-new-password');
        screen?.changeTextByTestId('settings-account-confirm-password', 'a-long-enough-new-password');
    });
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');

    await vi.waitFor(() => expect(changePlainPassword).toHaveBeenCalledWith(
        expect.objectContaining({ expectedCredentialRevision: 9 }),
        expect.anything(),
    ));
});

it('publishes the canonical projection to its route owner instead of forcing a second read', async () => {
    const client = createClient();
    const onProjection = vi.fn();

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} onProjection={onProjection} />,
    );

    await vi.waitFor(() => expect(onProjection).toHaveBeenCalledWith(enrolledPlainProjection(4)));
});

it('publishes an unavailable projection so a dependent row cannot present stale Account facts', async () => {
    const client = createClient({
        read: vi.fn(async () => { throw new TypeError('Network request failed'); }),
    });
    const onProjection = vi.fn();

    screen = await renderScreen(
        <AccountEmailPasswordSection client={client} onProjection={onProjection} />,
    );

    await vi.waitFor(() => expect(onProjection).toHaveBeenCalledWith(null));
});
