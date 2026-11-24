import React, { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { AuthEntryProjectionV1Schema } from '@happier-dev/protocol/auth/entry';

import { createDeferred, createRootLayoutFeaturesResponse, renderHook, renderScreen } from '@/dev/testkit';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

const { AccountSignInSecuritySection } = await import('./AccountSignInSecuritySection');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { useAuthEntryOptions } = await import('@/components/account/auth/useAuthEntryOptions');
const { storage } = await import('@/sync/domains/state/storage');

const endpoint = 'https://account-entry.example.test';
const entryPath = '/v1/auth/entry';
const recoveryKey = 'settings-account-signin-recovery-key';
const githubConnect = 'settings-account-identity-github-connect';
const passwordRow = 'settings-account-email-password';
const connect = (methodId: string, mode: 'keyed' | 'keyless') => ({
    kind: 'authenticate', methodId, action: 'connect', mode, origin: 'home',
    presentation: { displayName: methodId },
});
const homeEntry = (signedIn: boolean) => AuthEntryProjectionV1Schema.parse({
    v: 1, state: 'ready', scope: { kind: 'home' }, autoRedirect: null,
    actions: [
        {
            kind: 'authenticate', methodId: 'key_challenge', action: 'login', mode: 'keyed', origin: 'home',
            presentation: { displayName: 'Recovery key' },
        },
        ...(signedIn ? [connect('github', 'keyed'), connect('email_password', 'keyless')] : []),
    ],
});

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
});

it('asks as the signed Account, replacing only the reserved connection row before Recovery key', async () => {
    const accountId = 'account-a';
    const credentials = {
        token: createAccountTokenForTests(accountId, { currentAccount: true }),
        secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    const serverId = await homes.addHome({
        name: 'Studio', serverUrl: endpoint, serverIdentityId: 'srv_account_entry',
        accountId, credentials, currentAccount: true, accountEncryptionMode: 'e2ee',
    });
    const features = createRootLayoutFeaturesResponse({
        capabilities: { auth: { methods: [
            { id: 'github', actions: [{ id: 'connect', enabled: true, mode: 'keyed' }] },
            { id: 'email_password', actions: [{ id: 'connect', enabled: true, mode: 'keyless' }] },
        ] } },
    });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    homes.answer(serverId, '/v1/account/profile', { body: AccountProfileSchema.parse({ id: accountId }) });
    homes.answer(serverId, '/v1/account/encryption/currentness', {
        body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials),
    });
    const pending = createDeferred<void>();
    const publicEntry = homeEntry(false);
    const signedEntry = homeEntry(true);
    let holdEntry = false;
    homes.answer(serverId, `POST ${entryPath}`, {
        select: (_input, { init }) => ({
            body: new Headers(init?.headers).get('authorization') === `Bearer ${credentials.token}` ? signedEntry : publicEntry,
            ...(holdEntry ? { respondAfter: pending.promise } : {}),
        }),
    });

    connection = await restoreServerAccountForTest({
        serverUrl: endpoint, serverIdentityId: 'srv_account_entry', credentials,
        request: async (input, init) => {
            const response = await homes.request(input, init);
            const url = new URL(String(input));
            return response.status === 404 ? createEmptyAccountBootstrapHttpResponse(url.pathname + url.search, init) ?? response : response;
        },
    });
    await vi.waitFor(() => expect(storage.getState().profile.id).toBe(accountId));

    const welcome = await renderHook(() => useAuthEntryOptions(), {
        wrapper: ({ children }) => <InjectedAuthProvider credentials={null}>{children}</InjectedAuthProvider>,
    });
    await vi.waitFor(() => expect(homes.requestsFor(entryPath).map(({ token }) => token)).toEqual([null]));
    await welcome.unmount();

    const security = AccountSecurityGetResponseV1Schema.parse({
        v: 1, encryptionMode: 'e2ee', nativeEmail: null,
        password: { status: 'not_enrolled', revision: null },
    });
    const renderCommit = vi.fn();
    const renderAccount = (accountCredentials: typeof credentials | null) => renderScreen(
        <InjectedAuthProvider credentials={accountCredentials}>
            <React.Profiler id="account-sign-in" onRender={renderCommit}>
                <AccountSignInSecuritySection
                    homeName="Studio" security={{ kind: 'ready', projection: security }}
                    profile={storage.getState().profile} credentials={accountCredentials}
                    applyProfile={storage.getState().applyProfile}
                />
            </React.Profiler>
        </InjectedAuthProvider>,
    );
    // The signed-in shell has already discovered the Home's published methods before opening Settings.
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features } });
    holdEntry = true;
    const account = await renderAccount(credentials);
    const isPlaceholder = (id: string) => /^settings-account-identity-reserve-skeleton:\d+$/.test(id);
    const signInRows = () => collectRenderedTestIds(account.tree.toJSON()).filter((id) =>
        id === recoveryKey || id === passwordRow || id === githubConnect || isPlaceholder(id),
    );
    const initialRows = signInRows();
    await vi.waitFor(() => expect(homes.requestsFor(entryPath).map(({ token }) => token)).toEqual([null, credentials.token]));
    expect(initialRows).toEqual([passwordRow, expect.stringMatching(/^settings-account-identity-reserve-/), recoveryKey]);
    await act(async () => { pending.resolve(); });
    await vi.waitFor(() => expect(signInRows()).toEqual([passwordRow, githubConnect, recoveryKey]));
    const arrivedRows = signInRows();
    expect(initialRows.filter(isPlaceholder)).toHaveLength(arrivedRows.filter((id) => id === githubConnect).length);
    expect(arrivedRows.indexOf(recoveryKey)).toBe(initialRows.indexOf(recoveryKey));
    expect(renderCommit).toHaveBeenCalled();
    renderCommit.mockClear();
    await act(async () => { storage.setState(({ isDataReady }) => ({ isDataReady: !isDataReady })); });
    expect(renderCommit).not.toHaveBeenCalled();
    expect(homes.requestsFor(entryPath)).toHaveLength(2);
    await account.unmount();

    holdEntry = false;
    const signedOut = await renderAccount(null);
    expect(signedOut.findByTestId(githubConnect)).toBeNull();
    await vi.waitFor(() => expect(homes.requestsFor(entryPath).map(({ token }) => token))
        .toEqual([null, credentials.token, null]));
    expect(signedOut.findByTestId(githubConnect)).toBeNull();
    await signedOut.unmount();
});
