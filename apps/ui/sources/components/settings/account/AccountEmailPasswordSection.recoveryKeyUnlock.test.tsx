import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { encodeBase64 } from '@/encryption/base64';

import { renderScreen } from '@/dev/testkit';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installPasswordKdfWorkerBoundary } from '@/dev/testkit/mocks/passwordKdfWorker';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import {
    ACCOUNT_SECURITY_PATH_V1, ACCOUNT_PASSWORD_CHANGE_PATH_V1, ACCOUNT_PASSWORD_REMOVE_PATH_V1,
    ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1, AccountSecurityGetResponseV1Schema,
    AccountPasswordChangeRequestV1Schema, AccountPasswordRemoveRequestV1Schema,
    AccountPasswordMutationResponseV1Schema, PasswordMutationPreparationRequestV1Schema,
    PasswordMutationPreparationResponseV1Schema,
} from '@happier-dev/protocol/auth/accountSecurity';
import { E2eeAccountPasswordCredentialV1Schema, encodePasswordCredentialFieldV1, decodePasswordCredentialFieldV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import { createPasswordCredentialMutationDigestV1, createPasswordCredentialTargetDigestV1, createPasswordMutationChallengeSigningInputV1, PasswordMutationChallengeV1Schema } from '@happier-dev/protocol/auth/passwordMutationChallenge';
import { nativePasswordTranslations } from '@/text/translations/nativePasswordTranslations';

installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('account-password-recovery-key', { preserveGenerations: true });
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true, renderCustomModals: true }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { Modal, ModalProvider } = await import('@/modal');
const { AccountEmailPasswordSection } = await import('./AccountEmailPasswordSection');
const { resetAccountSecurityProjectionStoreForTests } = await import('./accountSecurityProjectionStore');

const RECOVERY_SECRET = new Uint8Array(32).fill(7);
const machineKey = deriveAccountMachineKeyFromRecoverySecret(RECOVERY_SECRET);
const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
const recoveryKeyText = encodePasswordCredentialFieldV1(RECOVERY_SECRET);
const challenges = new Map<string, ReturnType<typeof PasswordMutationChallengeV1Schema.parse>>();
let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
let restoreStorage: () => void;
let homeId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let restoreExecutor: (() => void) | undefined;
let revision: number | null;

beforeEach(async () => {
    resetAccountSecurityProjectionStoreForTests();
    restoreStorage = installLocalStorageMock().restore;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    installPasswordKdfWorkerBoundary();
    challenges.clear();
    vi.mocked(Modal.show).mockClear();
    revision = 5;
    homeId = await homes.addHome({ name: 'Home A', serverUrl: 'https://home-a.example.test',
        serverIdentityId: 'srv_home_a', accountId: 'account-a', currentAccount: true, accountEncryptionMode: 'e2ee',
        // This device has data keys, but deliberately no recovery secret.
        credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }),
            encryption: { publicKey: encodeBase64(publicKey), machineKey: encodeBase64(machineKey) } },
    });
    const credentials = (await TokenStorage.getCredentials())!;
    homes.answer(homeId, '/v1/account/encryption/currentness', { body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://home-a.example.test',
        serverIdentityId: 'srv_home_a', credentials, request: async (input, init) => {
            const response = await homes.request(input, init);
            const url = new URL(input instanceof Request ? input.url : String(input));
            return response.status === 404 ? createEmptyAccountBootstrapHttpResponse(url.pathname + url.search, init) ?? response : response;
        } });
    restoreExecutor = await installRealActionExecutorModuleLoader();
    homes.answer(homeId, ACCOUNT_SECURITY_PATH_V1, { select: () => ({ body: AccountSecurityGetResponseV1Schema.parse({
        v: 1, encryptionMode: 'e2ee', nativeEmail: revision === null ? null : 'person@example.test',
        password: revision === null ? { status: 'not_enrolled', revision: null } : { status: 'enrolled', revision },
    }) }) });
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1}`, { select: input => {
        const request = PasswordMutationPreparationRequestV1Schema.parse(input);
        const targetCredential = 'newE2eePassword' in request ? E2eeAccountPasswordCredentialV1Schema.parse({
            v: 1, kind: 'e2ee_password_envelope', envelope: request.newE2eePassword.envelope,
            authVerifier: { v: 1, hash: { v: 1, algorithm: 'scrypt', parameters: { n: 16384, r: 8, p: 5, keyLength: 32 },
                salt: encodePasswordCredentialFieldV1(new Uint8Array(16).fill(3)), digest: encodePasswordCredentialFieldV1(new Uint8Array(32).fill(5)) } },
        }) : null;
        const challengeId = `challenge-${challenges.size}`;
        const challenge = PasswordMutationChallengeV1Schema.parse({
            v: 1, challengeId, nonce: 'nonce', issuedAt: '2026-11-17T10:00:00.000Z', expiresAt: '2026-11-17T10:05:00.000Z',
            audience: { origin: 'https://home-a.example.test', serverIdentityId: 'srv_home_a' }, expectedAccountId: 'account-a',
            operationKind: 'password_credential_mutation_v1', operationDigest: createPasswordCredentialMutationDigestV1({
                v: 1, action: request.action, accountId: 'account-a', expectedCredentialRevision: request.expectedCredentialRevision,
                normalizedNativeEmail: request.normalizedNativeEmail, newCredentialDigest: targetCredential ? createPasswordCredentialTargetDigestV1(targetCredential) : null,
            }),
        });
        challenges.set(challengeId, challenge);
        return { body: PasswordMutationPreparationResponseV1Schema.parse({ ...(targetCredential ? { targetCredential } : {}), challenge }) };
    } });
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_CHANGE_PATH_V1}`, { select: input => {
        const request = AccountPasswordChangeRequestV1Schema.parse(input);
        if (request.kind !== 'e2ee') throw new Error('Expected E2EE mutation');
        verifyProof(request.proof);
        revision = 6;
        return { body: AccountPasswordMutationResponseV1Schema.parse({ v: 1, status: 'updated' }) };
    } });
    homes.answer(homeId, `POST ${ACCOUNT_PASSWORD_REMOVE_PATH_V1}`, { select: input => {
        const request = AccountPasswordRemoveRequestV1Schema.parse(input);
        if (request.kind !== 'e2ee') throw new Error('Expected E2EE mutation');
        verifyProof(request.proof);
        revision = null;
        return { body: AccountPasswordMutationResponseV1Schema.parse({ v: 1, status: 'removed' }) };
    } });
});

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    Modal.hideAll();
    await connection?.dispose();
    connection = null;
    restoreExecutor?.();
    restoreExecutor = undefined;
    await homes.reset();
    restoreStorage();
    vi.unstubAllGlobals();
});

function verifyProof(proof: { challengeId: string; signature: string; publicKey: string }) {
    const challenge = challenges.get(proof.challengeId);
    if (!challenge) throw new Error('No issued challenge');
    expect(tweetnacl.sign.detached.verify(createPasswordMutationChallengeSigningInputV1(challenge),
        decodePasswordCredentialFieldV1(proof.signature), decodePasswordCredentialFieldV1(proof.publicKey))).toBe(true);
    expect(proof.publicKey).toBe(encodePasswordCredentialFieldV1(tweetnacl.sign.keyPair.fromSeed(RECOVERY_SECRET).publicKey));
}

async function openChangeForm() {
    screen = await renderScreen(<AuthProvider initialCredentials={await TokenStorage.getCredentials()}>
        <ModalProvider><AccountEmailPasswordSection /></ModalProvider>
    </AuthProvider>);
    await vi.waitFor(() => expect(screen?.findByTestId('settings-account-password')).not.toBeNull());
    await screen.pressByTestIdAsync('settings-account-password');
}

async function requestChange() {
    await act(async () => {
        screen?.changeTextByTestId('settings-account-new-password', 'a-long-enough-new-password');
        screen?.changeTextByTestId('settings-account-confirm-password', 'a-long-enough-new-password');
    });
    // Submission waits for a person to finish the real recovery-key entry modal.
    await act(async () => { screen!.pressByTestId('settings-account-change-password-submit'); });
    await vi.waitFor(() => expect(screen?.findByTestId('restore-manual-secret-input')).not.toBeNull());
}

async function enterRecoveryKey() {
    await act(async () => { screen?.changeTextByTestId('restore-manual-secret-input', recoveryKeyText); });
    await screen!.pressByTestIdAsync('restore-manual-submit');
    await vi.waitFor(() => expect(screen?.getTextContent()).toContain(nativePasswordTranslations.en.passwordChanged));
}

it('opens the password form without dead-ending when this device holds no recovery secret', async () => {
    await openChangeForm();
    expect(screen?.findByTestId('settings-account-change-password-form')).not.toBeNull();
    expect(screen?.findByTestId('settings-account-current-password')).toBeNull();
});

it('changes the E2EE password with a locally entered recovery key and sends only the purpose-bound proof and envelope', async () => {
    await openChangeForm();
    await requestChange();
    await enterRecoveryKey();

    const mutation = AccountPasswordChangeRequestV1Schema.parse(homes.requestsFor(ACCOUNT_PASSWORD_CHANGE_PATH_V1)[0]?.input);
    expect(mutation).toMatchObject({ kind: 'e2ee', expectedCredentialRevision: 5 });
    const wire = JSON.stringify(homes.requests);
    expect(wire).not.toContain(recoveryKeyText);
    expect(wire).not.toContain('a-long-enough-new-password');
    expect(await TokenStorage.getCredentials()).not.toHaveProperty('secret');
});

it('mutates nothing when the recovery-key ceremony is dismissed', async () => {
    await openChangeForm();
    await requestChange();
    const config = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
    await act(async () => { config?.onHostUnmount?.(); });

    expect(homes.requestsFor(ACCOUNT_PASSWORD_MUTATION_CHALLENGE_PATH_V1)).toHaveLength(0);
    expect(homes.requestsFor(ACCOUNT_PASSWORD_CHANGE_PATH_V1)).toHaveLength(0);
    expect(screen?.findByTestId('settings-account-change-password-form')).not.toBeNull();
});

it('asks for the recovery key only once for consecutive mutations in the same mounted ceremony', async () => {
    await openChangeForm();
    await requestChange();
    await enterRecoveryKey();
    const promptsAfterChange = vi.mocked(Modal.show).mock.calls.filter(([config]) => 'onEntered' in (config.props ?? {})).length;
    expect(promptsAfterChange).toBe(1);
    await screen!.pressByTestIdAsync('settings-account-password-remove');
    await screen!.pressByTestIdAsync('settings-account-remove-password-submit');
    await vi.waitFor(() => expect(screen?.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
    await screen!.pressByTestIdAsync('actions.confirmation-review.decision-approve');

    await vi.waitFor(() => expect(screen?.getTextContent()).toContain(nativePasswordTranslations.en.passwordRemoved));
    expect(homes.requestsFor(ACCOUNT_PASSWORD_REMOVE_PATH_V1)).toHaveLength(1);
    expect(vi.mocked(Modal.show).mock.calls.filter(([config]) => 'onEntered' in (config.props ?? {}))).toHaveLength(promptsAfterChange);
    expect(AccountPasswordRemoveRequestV1Schema.parse(homes.requestsFor(ACCOUNT_PASSWORD_REMOVE_PATH_V1)[0]?.input))
        .toMatchObject({ kind: 'e2ee', expectedCredentialRevision: 6 });
});
