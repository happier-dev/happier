import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import {
    ACCOUNT_SECURITY_PATH_V1, ACCOUNT_PASSWORD_CHANGE_PATH_V1,
    AccountSecurityGetResponseV1Schema, AccountPasswordChangeRequestV1Schema,
    AccountPasswordMutationResponseV1Schema, AccountSecurityServerErrorV1Schema,
} from '@happier-dev/protocol/auth/accountSecurity';
import { nativePasswordTranslations } from '@/text/translations/nativePasswordTranslations';

installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('account-password-outcome', { preserveGenerations: true });
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { AccountEmailPasswordSection } = await import('./AccountEmailPasswordSection');
const { resetAccountSecurityProjectionStoreForTests } = await import('./accountSecurityProjectionStore');

let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
let restoreStorage: () => void;
let homeId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let restoreExecutor: (() => void) | undefined;
const copy = nativePasswordTranslations.en;

function projection(revision = 4) {
    return AccountSecurityGetResponseV1Schema.parse({
        v: 1, encryptionMode: 'plain', nativeEmail: 'person@example.test',
        password: { status: 'enrolled', revision },
    });
}

beforeEach(async () => {
    resetAccountSecurityProjectionStoreForTests();
    restoreStorage = installLocalStorageMock().restore;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    homeId = await homes.addHome({ name: 'Home A', serverUrl: 'https://home-a.example.test', accountId: 'account-a', currentAccount: true });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://home-a.example.test',
        credentials: (await TokenStorage.getCredentials())!, request: homes.request });
    restoreExecutor = await installRealActionExecutorModuleLoader();
    homes.answer(homeId, ACCOUNT_SECURITY_PATH_V1, { body: projection() });
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_CHANGE_PATH_V1}`, {
        body: AccountPasswordMutationResponseV1Schema.parse({ v: 1, status: 'updated' }),
    });
});

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    await connection?.dispose();
    connection = null;
    restoreExecutor?.();
    restoreExecutor = undefined;
    await homes.reset();
    restoreStorage();
    vi.unstubAllGlobals();
});

async function renderSection(props: React.ComponentProps<typeof AccountEmailPasswordSection> = {}) {
    screen = await renderScreen(<AuthProvider initialCredentials={await TokenStorage.getCredentials()}>
        <AccountEmailPasswordSection {...props} />
    </AuthProvider>);
    return screen;
}

async function openChangePasswordForm() {
    await renderSection();
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen!.pressByTestIdAsync('settings-account-password');
    await fillPasswords();
}

async function fillPasswords() {
    await act(async () => {
        screen?.changeTextByTestId('settings-account-current-password', 'current-password-value');
        screen?.changeTextByTestId('settings-account-new-password', 'a-long-enough-new-password');
        screen?.changeTextByTestId('settings-account-confirm-password', 'a-long-enough-new-password');
    });
}

function readFormError(): unknown {
    return screen?.findByTestId('settings-account-password-form-error')?.props.children ?? null;
}

it('reports an unconfirmed outcome instead of blaming the credential when the dispatched change loses its verdict', async () => {
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_CHANGE_PATH_V1}`, { dispatchThenFail: true });
    await openChangePasswordForm();
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');

    await vi.waitFor(() => expect(readFormError()).toBe(copy.outcomeUnconfirmed));
    expect(readFormError()).not.toBe(copy.signInFailed);
    expect(readFormError()).not.toBe(copy.offline);
    expect(AccountPasswordChangeRequestV1Schema.parse(homes.requestsFor(ACCOUNT_PASSWORD_CHANGE_PATH_V1)[0]?.input))
        .toMatchObject({ kind: 'plain', expectedCredentialRevision: 4 });
});

it('reconciles the authoritative projection after an unconfirmed change so the form is not left stale', async () => {
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_CHANGE_PATH_V1}`, { dispatchThenFail: true });
    await openChangePasswordForm();
    const readsBeforeSubmit = homes.requestsFor(ACCOUNT_SECURITY_PATH_V1).length;
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');

    await vi.waitFor(() => expect(homes.requestsFor(ACCOUNT_SECURITY_PATH_V1).length).toBeGreaterThan(readsBeforeSubmit));
    expect(readFormError()).toBe(copy.outcomeUnconfirmed);
});

it('re-reads the credential revision after a revision conflict so the next attempt can win', async () => {
    let revision = 4;
    homes.answer(homeId, ACCOUNT_SECURITY_PATH_V1, { select: () => ({ body: projection(revision) }) });
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_CHANGE_PATH_V1}`, { select: input => {
        const request = AccountPasswordChangeRequestV1Schema.parse(input);
        if (request.expectedCredentialRevision === 4) {
            revision = 9;
            return { status: 409, body: AccountSecurityServerErrorV1Schema.parse({ error: 'credential_revision_conflict' }) };
        }
        return { body: AccountPasswordMutationResponseV1Schema.parse({ v: 1, status: 'updated' }) };
    } });
    await openChangePasswordForm();
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');
    await vi.waitFor(() => expect(readFormError()).toBe(copy.revisionConflict));
    await vi.waitFor(() => expect(homes.requestsFor(ACCOUNT_SECURITY_PATH_V1).length).toBeGreaterThan(1));
    await fillPasswords();
    await screen!.pressByTestIdAsync('settings-account-change-password-submit');

    await vi.waitFor(() => expect(screen?.getTextContent()).toContain(copy.passwordChanged));
    expect(homes.requestsFor(ACCOUNT_PASSWORD_CHANGE_PATH_V1).map(row => AccountPasswordChangeRequestV1Schema.parse(row.input).expectedCredentialRevision))
        .toEqual([4, 9]);
});

it('publishes the canonical projection to its route owner instead of forcing a second read', async () => {
    const onProjection = vi.fn();
    await renderSection({ onProjection });
    await vi.waitFor(() => expect(onProjection).toHaveBeenCalledWith(projection()));
    expect(homes.requestsFor(ACCOUNT_SECURITY_PATH_V1)).toHaveLength(1);
});

it('publishes an unavailable projection so a dependent row cannot present stale Account facts', async () => {
    homes.answer(homeId, ACCOUNT_SECURITY_PATH_V1, { dispatchThenFail: true });
    const onProjection = vi.fn();
    await renderSection({ onProjection });

    await vi.waitFor(() => expect(onProjection).toHaveBeenCalledWith(null));
    expect(screen?.findByTestId('settings-account-security-unavailable')).not.toBeNull();
});
