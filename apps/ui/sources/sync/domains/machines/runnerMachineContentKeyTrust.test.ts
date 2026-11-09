import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
    computeRunnerMachineContentKeyFingerprintV1,
    sealRunnerMachineContentKeyVerifierFactV1,
    signRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol/ephemeralRunner/machineContentKeyBinding';
import {
    resolvePublishedMachineDataEncryptionKeyV1} from '@happier-dev/protocol/machines/machineStoredContent';
import { encodeBase64 } from '@/encryption/base64';
import * as deviceLocalStorage from '@/auth/storage/deviceLocalStorage';
import {
    loadRunnerCreatorMachineContentKeyTrust,
    resetRunnerCreatorMachineContentKeyTrustProjectionForTests,
    retainRunnerCreatorMachineContentKeyTrust,
} from '@/sync/domains/ephemeralRunner/runnerCreatorMachineContentKeyTrust';
import { resolveRunnerMachineContentKeyTrustV1 } from './runnerMachineContentKeyTrust';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const TOKEN = 'e30.eyJzdWIiOiJhY2NvdW50LW9uZSJ9.signature';
const ACTIVATION_ID = '11111111-1111-4111-8111-111111111111';
const scope = { serverId: 'home-one', accountId: 'account-one' } as const;

const ACCOUNT_MACHINE_KEY = new Uint8Array(32).fill(6);
const OTHER_ACCOUNT_MACHINE_KEY = new Uint8Array(32).fill(16);
const accountMaterial = { type: 'dataKey', machineKey: ACCOUNT_MACHINE_KEY } as const;

/** A modern credential that carries no Account signing authority at all. */
const dataKeyCredentials = {
    token: TOKEN,
    encryption: {
        publicKey: encodeBase64(new Uint8Array(32).fill(5), 'base64'),
        machineKey: encodeBase64(ACCOUNT_MACHINE_KEY, 'base64'),
    },
} as const;

/** A second authorized device of the same Account: same material, no custody. */
const secondDeviceCredentials = dataKeyCredentials;

function sealVerifierFact(input: Readonly<{
    activationId?: string;
    machineId?: string;
    activationSigningPublicKey: string;
    machineKey?: Uint8Array;
}>): string {
    return sealRunnerMachineContentKeyVerifierFactV1({
        payload: {
            v: 1,
            activationId: input.activationId ?? ACTIVATION_ID,
            machineId: input.machineId ?? 'machine-one',
            activationSigningPublicKey: input.activationSigningPublicKey,
        },
        material: { type: 'dataKey', machineKey: input.machineKey ?? ACCOUNT_MACHINE_KEY },
        randomBytes: (length: number) => new Uint8Array(length).fill(3),
    });
}

function signRunnerBinding(input: Readonly<{
    secretKey: Uint8Array;
    dataKey: Uint8Array;
    machineId?: string;
    activationId?: string;
    creatorVerifierFactCiphertext?: string;
}>) {
    const binding = signRunnerMachineContentKeyBindingV1({
        payload: {
            v: 1,
            purpose: 'happier.ephemeral-runner.machine-content-key',
            homeServerIdentityId: 'home-one',
            activationId: input.activationId ?? ACTIVATION_ID,
            creatorAccountId: 'account-one',
            machineId: input.machineId ?? 'machine-one',
            installationId: 'installation-one',
            machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(input.dataKey),
        },
        activationSigningSecretKey: input.secretKey,
    });
    return input.creatorVerifierFactCiphertext
        ? { ...binding, creatorVerifierFactCiphertext: input.creatorVerifierFactCiphertext }
        : binding;
}

let values: Map<string, string>;

beforeEach(() => {
    values = new Map();
    resetRunnerCreatorMachineContentKeyTrustProjectionForTests();
    vi.stubGlobal('window', { localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    } });
});
afterEach(() => {
    vi.restoreAllMocks();
    resetRunnerCreatorMachineContentKeyTrustProjectionForTests();
    vi.unstubAllGlobals();
});

async function retainCreatorTrust(activationSigningPublicKey: string): Promise<void> {
    await retainRunnerCreatorMachineContentKeyTrust({
        scope: { homeServerIdentityId: scope.serverId, creatorAccountId: scope.accountId },
        machineId: 'machine-one',
        activationId: ACTIVATION_ID,
        activationSigningPublicKey,
    });
}

describe('resolveRunnerMachineContentKeyTrustV1', () => {
    it('awaits retained creator custody on the first resolution after a remount', async () => {
        const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const publicKey = encodeBase64(signing.publicKey, 'base64url');
        await retainCreatorTrust(publicKey);
        resetRunnerCreatorMachineContentKeyTrustProjectionForTests();

        const trust = await resolveRunnerMachineContentKeyTrustV1({
            credentials: dataKeyCredentials, homeServerIdentityId: scope.serverId, machineId: 'machine-one',
        });
        expect(trust?.trustedMachineKind).toBe('ephemeral_session_runner');
        expect(trust?.expectedRunnerBinding.accountSigningPublicKeyBase64Url).toBe(publicKey);
        expect(resolvePublishedMachineDataEncryptionKeyV1({
            machine: { id: 'machine-one', kind: 'persistent', dataEncryptionKey: 'home-chosen-envelope' },
            openedDataEncryptionKey: new Uint8Array(32).fill(22),
            ...trust,
        })).toEqual({ status: 'unavailable' });
    });

    it('shares a delayed durable read without accepting weaker trust while it is pending', async () => {
        const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        await retainCreatorTrust(encodeBase64(signing.publicKey, 'base64url'));
        resetRunnerCreatorMachineContentKeyTrustProjectionForTests();
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const read = deviceLocalStorage.readDeviceLocalStorageString;
        const readSpy = vi.spyOn(deviceLocalStorage, 'readDeviceLocalStorageString').mockImplementation(async (key) => {
            await pending;
            return await read(key);
        });
        const input = { credentials: dataKeyCredentials, homeServerIdentityId: scope.serverId, machineId: 'machine-one' };
        let settled = false;
        const first = resolveRunnerMachineContentKeyTrustV1(input).then((trust) => { settled = true; return trust; });
        const second = resolveRunnerMachineContentKeyTrustV1(input);
        await vi.waitFor(() => expect(readSpy).toHaveBeenCalledTimes(1));
        expect(settled).toBe(false);
        release();
        for (const trust of await Promise.all([first, second])) {
            expect(trust?.trustedMachineKind).toBe('ephemeral_session_runner');
        }
    });

    it('does not treat corrupt retained custody as confirmed absence', async () => {
        const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        await retainCreatorTrust(encodeBase64(signing.publicKey, 'base64url'));
        resetRunnerCreatorMachineContentKeyTrustProjectionForTests();
        for (const key of values.keys()) values.set(key, '{broken');
        expect(await resolveRunnerMachineContentKeyTrustV1({
            credentials: dataKeyCredentials, homeServerIdentityId: scope.serverId, machineId: 'machine-one',
        })).toBeNull();
    });

    it('does not turn failed creator storage into confirmed absence and retries after recovery', async () => {
        const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        await retainCreatorTrust(encodeBase64(signing.publicKey, 'base64url'));
        resetRunnerCreatorMachineContentKeyTrustProjectionForTests();
        const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('storage unavailable'); });
        const input = { credentials: dataKeyCredentials, homeServerIdentityId: scope.serverId, machineId: 'machine-one' };
        expect(await resolveRunnerMachineContentKeyTrustV1(input)).toBeNull();
        getItem.mockRestore();
        expect((await resolveRunnerMachineContentKeyTrustV1(input))?.trustedMachineKind).toBe('ephemeral_session_runner');
    });

    it('trusts the creator activation identity for a data-key credential with no Account signing key', async () => {
        const activationSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const activationSigningPublicKey = encodeBase64(activationSigning.publicKey, 'base64url');
        await retainCreatorTrust(activationSigningPublicKey);

        const expected = await resolveRunnerMachineContentKeyTrustV1({
            credentials: dataKeyCredentials,
            homeServerIdentityId: 'home-one',
            machineId: 'machine-one',
        });
        expect(expected).toEqual({
            expectedRunnerBinding: {
                homeServerIdentityId: 'home-one',
                creatorAccountId: 'account-one',
                machineId: 'machine-one',
                accountSigningPublicKeyBase64Url: activationSigningPublicKey,
            },
            // Creator custody for this exact Machine is the one classification
            // the Home cannot rewrite, so the resolver may trust it.
            trustedMachineKind: 'ephemeral_session_runner',
        });

        const dataKey = new Uint8Array(32).fill(11);
        const binding = signRunnerMachineContentKeyBindingV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-runner.machine-content-key',
                homeServerIdentityId: 'home-one',
                activationId: ACTIVATION_ID,
                creatorAccountId: 'account-one',
                machineId: 'machine-one',
                installationId: 'installation-one',
                machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(dataKey),
            },
            activationSigningSecretKey: activationSigning.secretKey,
        });
        expect(resolvePublishedMachineDataEncryptionKeyV1({
            machine: {
                id: 'machine-one',
                kind: 'ephemeral_session_runner',
                installationId: 'installation-one',
                dataEncryptionKey: 'wrapped-runner-key',
                runnerContentKeyBinding: binding,
            },
            openedDataEncryptionKey: dataKey,
            expectedAccountMode: 'e2ee',
            expectedRunnerBinding: expected!.expectedRunnerBinding,
        })).toEqual({ status: 'e2ee', dataKey });
    });

    it('rejects joint substitution of verifier identity, binding and an Account-openable envelope', async () => {
        const activationSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        await retainCreatorTrust(encodeBase64(activationSigning.publicKey, 'base64url'));

        // Home and Runner together choose a key the Home can also open, re-sign a
        // fully consistent binding for it and publish their own verifier identity.
        const colluding = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
        const substitutedKey = new Uint8Array(32).fill(12);
        const substitutedBinding = signRunnerMachineContentKeyBindingV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-runner.machine-content-key',
                homeServerIdentityId: 'home-one',
                activationId: ACTIVATION_ID,
                creatorAccountId: 'account-one',
                machineId: 'machine-one',
                installationId: 'installation-one',
                machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(substitutedKey),
            },
            activationSigningSecretKey: colluding.secretKey,
        });

        const expected = await resolveRunnerMachineContentKeyTrustV1({
            credentials: dataKeyCredentials,
            homeServerIdentityId: 'home-one',
            machineId: 'machine-one',
        });
        // The verifier identity comes from creator-local custody, so the published
        // one is never consulted and the substituted triple fails closed.
        expect(expected?.expectedRunnerBinding.accountSigningPublicKeyBase64Url)
            .not.toBe(encodeBase64(colluding.publicKey, 'base64url'));
        expect(resolvePublishedMachineDataEncryptionKeyV1({
            machine: {
                id: 'machine-one',
                kind: 'ephemeral_session_runner',
                installationId: 'installation-one',
                dataEncryptionKey: 'wrapped-runner-key',
                runnerContentKeyBinding: substitutedBinding,
            },
            openedDataEncryptionKey: substitutedKey,
            expectedAccountMode: 'e2ee',
            expectedRunnerBinding: expected!.expectedRunnerBinding,
        })).toEqual({ status: 'unavailable' });
    });

    it('resolves the Account-material route on a device without creator activation custody', async () => {
        await expect(loadRunnerCreatorMachineContentKeyTrust(scope, 'machine-one')).resolves.toBeNull();
        expect(await resolveRunnerMachineContentKeyTrustV1({
            credentials: secondDeviceCredentials,
            homeServerIdentityId: 'home-one',
            machineId: 'machine-one',
        })).toEqual({
            // No creator custody here: the Account-material route authenticates
            // the binding but classifies nothing, so no trusted kind is claimed.
            expectedRunnerBinding: {
                homeServerIdentityId: 'home-one',
                creatorAccountId: 'account-one',
                machineId: 'machine-one',
                accountScopedMaterial: accountMaterial,
            },
        });
    });

    it('locks the Runner Machine for a token-only device, which holds neither custody nor Account material', async () => {
        expect(await resolveRunnerMachineContentKeyTrustV1({
            credentials: { token: TOKEN } as never,
            homeServerIdentityId: 'home-one',
            machineId: 'machine-one',
        })).toBeNull();
    });

    it('opens the Runner Machine on a second device from the creator-sealed verifier fact alone', async () => {
        const activationSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const dataKey = new Uint8Array(32).fill(11);
        const binding = signRunnerBinding({
            secretKey: activationSigning.secretKey,
            dataKey,
            creatorVerifierFactCiphertext: sealVerifierFact({
                activationSigningPublicKey: encodeBase64(activationSigning.publicKey, 'base64url'),
            }),
        });
        const expected = await resolveRunnerMachineContentKeyTrustV1({
            credentials: secondDeviceCredentials,
            homeServerIdentityId: 'home-one',
            machineId: 'machine-one',
        });

        expect(resolvePublishedMachineDataEncryptionKeyV1({
            machine: {
                id: 'machine-one',
                kind: 'ephemeral_session_runner',
                installationId: 'installation-one',
                dataEncryptionKey: 'wrapped-runner-key',
                runnerContentKeyBinding: binding,
            },
            openedDataEncryptionKey: dataKey,
            expectedAccountMode: 'e2ee',
            expectedRunnerBinding: expected!.expectedRunnerBinding,
        })).toEqual({ status: 'e2ee', dataKey });
    });

    it('rejects a substituted verifier fact, binding and envelope on a second device', async () => {
        // The Home holds no Account material, so the best it can do is publish a
        // consistent triple whose verifier fact it cannot seal under the Account.
        const colluding = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
        const substitutedKey = new Uint8Array(32).fill(12);
        const expected = await resolveRunnerMachineContentKeyTrustV1({
            credentials: secondDeviceCredentials,
            homeServerIdentityId: 'home-one',
            machineId: 'machine-one',
        });

        for (const substitutedFact of [
            undefined,
            // Sealed under material the Home could hold; never the Account's.
            sealVerifierFact({
                activationSigningPublicKey: encodeBase64(colluding.publicKey, 'base64url'),
                machineKey: OTHER_ACCOUNT_MACHINE_KEY,
            }),
        ]) {
            expect(resolvePublishedMachineDataEncryptionKeyV1({
                machine: {
                    id: 'machine-one',
                    kind: 'ephemeral_session_runner',
                    installationId: 'installation-one',
                    dataEncryptionKey: 'wrapped-runner-key',
                    runnerContentKeyBinding: signRunnerBinding({
                        secretKey: colluding.secretKey,
                        dataKey: substitutedKey,
                        ...(substitutedFact ? { creatorVerifierFactCiphertext: substitutedFact } : {}),
                    }),
                },
                openedDataEncryptionKey: substitutedKey,
                expectedAccountMode: 'e2ee',
                expectedRunnerBinding: expected!.expectedRunnerBinding,
            })).toEqual({ status: 'unavailable' });
        }
    });

    it('rejects an authentic verifier fact replayed from another Runner', async () => {
        // A colluding Runner host signs for its own Machine, then the Home moves
        // the creator-sealed fact of a different Runner onto this Machine row.
        const otherRunnerSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
        const dataKey = new Uint8Array(32).fill(13);
        const expected = await resolveRunnerMachineContentKeyTrustV1({
            credentials: secondDeviceCredentials,
            homeServerIdentityId: 'home-one',
            machineId: 'machine-one',
        });

        expect(resolvePublishedMachineDataEncryptionKeyV1({
            machine: {
                id: 'machine-one',
                kind: 'ephemeral_session_runner',
                installationId: 'installation-one',
                dataEncryptionKey: 'wrapped-runner-key',
                runnerContentKeyBinding: signRunnerBinding({
                    secretKey: otherRunnerSigning.secretKey,
                    dataKey,
                    creatorVerifierFactCiphertext: sealVerifierFact({
                        machineId: 'machine-two',
                        activationId: '22222222-2222-4222-8222-222222222222',
                        activationSigningPublicKey: encodeBase64(otherRunnerSigning.publicKey, 'base64url'),
                    }),
                }),
            },
            openedDataEncryptionKey: dataKey,
            expectedAccountMode: 'e2ee',
            expectedRunnerBinding: expected!.expectedRunnerBinding,
        })).toEqual({ status: 'unavailable' });
    });

    it('serves the retained identity after a remount once the record is loaded', async () => {
        const activationSigning = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        await retainCreatorTrust(encodeBase64(activationSigning.publicKey, 'base64url'));
        resetRunnerCreatorMachineContentKeyTrustProjectionForTests();

        await expect(loadRunnerCreatorMachineContentKeyTrust(scope, 'machine-one'))
            .resolves.toEqual({
                activationId: ACTIVATION_ID,
                activationSigningPublicKey: encodeBase64(activationSigning.publicKey, 'base64url'),
            });
        expect((await resolveRunnerMachineContentKeyTrustV1({
            credentials: dataKeyCredentials,
            homeServerIdentityId: 'home-one',
            machineId: 'machine-one',
        }))?.expectedRunnerBinding.accountSigningPublicKeyBase64Url)
            .toBe(encodeBase64(activationSigning.publicKey, 'base64url'));
    });
});
