import { createManagedBootstrapSshCredential, createManagedBootstrapSshKeyPair,
    readManagedBootstrapCredential, readManagedBootstrapSshPublicKey,
    ManagedMachineControllerError, type ManagedReconciliationHome } from '@happier-dev/cli-common/machines/managed';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { randomUUID } from '@/platform/randomUUID';
import { admitProfileAccount } from '@/sync/api/account/apiProfileCatalog';
import { readSavedSecretReferenceInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { prepareSavedSecretResourceCreateInContext } from '@/sync/ops/settings/savedSecretResourceOperations';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/** The captured Account's incumbent SavedSecret owner holds both private SSH identities. */
export function createUiManagedAccountCredential(input: Readonly<{
    account: LazyActionAccountContext;
    home: ManagedReconciliationHome;
    signal?: AbortSignal;
}>) {
    const assertAccount = (machine: ManagedMachineV1) => {
        if (machine.custodianAccountId !== input.account.accountId) throw new ManagedMachineControllerError('credential_unavailable');
    };
    const read = async (machine: ManagedMachineV1, expectedRevision?: number) => {
        assertAccount(machine);
        if (!machine.bootstrapCredentialRef) throw new ManagedMachineControllerError('credential_unavailable');
        const material = await readSavedSecretReferenceInContext(input.account,
            formatSharedSavedSecretRefV1(machine.bootstrapCredentialRef.resourceId), input.signal,
            expectedRevision === undefined ? undefined : { expectedRevision, requireManage: true });
        if (!material.ok) throw new ManagedMachineControllerError('credential_unavailable');
        const credential = readManagedBootstrapCredential(material.value);
        // Retained scalar RSA credentials predate guest pinning. Bootstrap retry
        // does not need their authorization public key and never invents a host key.
        const publicKey = credential.bootstrapPrivateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')
            ? readManagedBootstrapSshPublicKey(credential.bootstrapPrivateKey) : undefined;
        return { value: credential.bootstrapPrivateKey, ...credential, publicKey, revision: material.revision };
    };
    return {
        read,
        async prepare(machine: ManagedMachineV1, kind: 'ssh' | 'native-token') {
            assertAccount(machine);
            if (kind !== 'ssh') throw new ManagedMachineControllerError('credential_unavailable');
            if (!machine.bootstrapCredentialRef) {
                machine = await admitProfileAccount(input.account, async (account, mode) => {
                    const login = createManagedBootstrapSshKeyPair({ randomBytes: getRandomBytes });
                    const value = createManagedBootstrapSshCredential({ bootstrapPrivateKey: login.privateKey, randomBytes: getRandomBytes });
                    const prepared = await prepareSavedSecretResourceCreateInContext(account, mode, {
                        resourceId: randomUUID(), displayName: 'Managed machine bootstrap', kind: 'other', value,
                        accountGrants: [], teamGrants: [], groupGrants: [],
                    });
                    try {
                        // Home atomically stores the ordinary resource and its row
                        // reference; an idempotent retry may return the incumbent.
                        return await input.home.row('create-bootstrap-credential', {
                            ...input.home.correlation(machine), credential: prepared.input,
                        });
                    } finally { prepared.dispose(); }
                });
            }
            const credential = await read(machine);
            return { machine, publicKey: credential.publicKey, guestHostPublicKey: credential.guestHostPublicKey,
                credentialRevision: credential.revision };
        },
    };
}
