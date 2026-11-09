import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64 } from '@happier-dev/protocol';

import { createLightSqliteHarness } from './lightSqliteHarness.ts';
import { createAuthenticatedTestApp } from '../app/api/testkit/sqliteFastify.ts';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from '../app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4.ts';
import { registerConnectedAccountAttemptTransactionRoutes } from '../app/api/routes/connect/connectedAccountAttemptTransactions/registerConnectedAccountAttemptTransactionRoutes.ts';
import { registerMachineAdmissionRoutes } from '../app/api/routes/machines/registerMachineAdmissionRoutes.ts';
import { featuresRoutes } from '../app/api/routes/features/featuresRoutes.ts';
import { accountRoutes } from '../app/api/routes/account/accountRoutes.ts';
import { startSocket } from '../app/api/socket.ts';
import { auth } from '../app/auth/auth.ts';
import { db } from '../storage/db.ts';
import { initiateShutdown } from '../utils/process/shutdown.ts';
import { createSignedAccountContentBinding } from './accountEncryption.ts';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { createMachineContentCodec } from '../../../cli/src/api/machine/machineStoredContent.ts';

// The executable fixture stays with the server so its @ alias resolves to
// server source. Its declaration lets composed CLI tests retain strict types
// without treating both apps as one TypeScript alias namespace.
export async function createConnectedAccountSocketHome({ encryptionMode = 'plain' } = {}) {
    const harness = await createLightSqliteHarness({
        tempDirPrefix: 'happier-connected-account-socket-home-', initAuth: true, initEncrypt: true,
        env: {
            HAPPIER_SERVER_IDENTITY_ID: `srv_${randomUUID().replaceAll('-', '')}`,
            AUTH_REQUIRED_LOGIN_PROVIDERS: '',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: 'none',
        },
    });
    const home = createAuthenticatedTestApp({ authentication: 'real' });
    const close = async () => {
        try {
            // startSocket registers its Socket.IO/tunnel teardown with the
            // real server shutdown owner, not Fastify onClose. This harness
            // owns the server process in its isolated Vitest worker.
            home.server.closeAllConnections();
            try { await initiateShutdown('connected-account-socket-fixture'); }
            finally { await home.close(); }
        } finally { await harness.close(); }
    };
    try {
        const contentKeys = encryptionMode === 'e2ee' ? nacl.box.keyPair() : null;
        const account = await db.account.create({ data: { encryptionMode,
            ...(contentKeys ? createSignedAccountContentBinding(contentKeys.publicKey) : {}) } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const keys = nacl.sign.keyPair();
        const installationId = randomUUID();
        const machineEncryptionKey = contentKeys ? nacl.randomBytes(32) : null;
        const machineCodec = createMachineContentCodec(machineEncryptionKey
            ? { encryptionMode: 'e2ee', encryptionKey: machineEncryptionKey, encryptionVariant: 'dataKey' }
            : { encryptionMode: 'plain' });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, active: true,
            installationId, installationPublicKey: new Uint8Array(keys.publicKey),
            metadata: machineCodec.encodeStored({ host: 'OAuth fixture', platform: 'linux', happyCliVersion: 'test',
                homeDir: harness.baseDir, happyHomeDir: harness.baseDir }),
            dataEncryptionKey: contentKeys && machineEncryptionKey
                ? sealEncryptedDataKeyEnvelopeV1({ dataKey: machineEncryptionKey, recipientPublicKey: contentKeys.publicKey,
                    randomBytes: nacl.randomBytes })
                : new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
        } });
        registerQualifiedConnectedAccountCredentialRoutesV4(home);
        registerConnectedAccountAttemptTransactionRoutes(home);
        registerMachineAdmissionRoutes(home);
        accountRoutes(home);
        featuresRoutes(home);
        startSocket(home);
        await home.listen({ host: '127.0.0.1', port: 0 });
        const address = home.server.address();
        if (!address || typeof address === 'string') throw new Error('Home listener unavailable');
        return {
            baseDir: harness.baseDir,
            baseUrl: `http://127.0.0.1:${address.port}`,
            accountId: account.id,
            machineId: machine.id,
            token, keys, installationId, encryptionMode,
            machineEncryptionKey,
            encryption: contentKeys ? { type: 'dataKey', machineKey: new Uint8Array(contentKeys.secretKey),
                publicKey: new Uint8Array(contentKeys.publicKey) } : null,
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
