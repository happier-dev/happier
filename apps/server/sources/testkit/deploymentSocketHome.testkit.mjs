import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { createLightSqliteHarness } from './lightSqliteHarness.ts';
import { createDatabaseIntegrationHarness } from './databaseIntegrationHarness.ts';
import { createAuthenticatedTestApp } from '../app/api/testkit/sqliteFastify.ts';
import { registerDeploymentRoutes } from '../app/api/routes/deployments/deploymentRoutes.ts';
import { projectSourceRoutes } from '../app/api/routes/projects/projectSourceRoutes.ts';
import { artifactsRoutes } from '../app/api/routes/artifacts/artifactsRoutes.ts';
import { machinesRoutes } from '../app/api/routes/machines/machinesRoutes.ts';
import { authRoutes } from '../app/api/routes/auth/authRoutes.ts';
import { accountRoutes } from '../app/api/routes/account/accountRoutes.ts';
import { changesRoutes } from '../app/api/routes/changes/changesRoutes.ts';
import { featuresRoutes } from '../app/api/routes/features/featuresRoutes.ts';
import { registerExternalActionRoutes } from '../app/api/routes/actions/registerExternalActionRoutes.ts';
import { registerPluginAvailabilityRoutes } from '../app/plugins/availability/routes.ts';
import { createSignedAccountContentBinding } from './accountEncryption.ts';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { startSocket } from '../app/api/socket.ts';
import { auth } from '../app/auth/auth.ts';
import { readCachedServerIdentityIdForHotPath } from '../app/serverIdentity/serverIdentity.ts';
import { createArtifact } from '../app/artifacts/artifactWriteService.ts';
import { db } from '../storage/db.ts';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import { createReleaseLessDeclarationV1 } from '../app/plugins/availability/currentDeclaration.ts';
import { createHomeConnectionDescriptorContinuityStoreForServer } from '../app/features/homeConnectionDescriptorContinuity.ts';
import { readHomeConnectionDescriptor } from '../app/features/homeConnectionDescriptorPublication.ts';
import { createEphemeralTlsServerFixture } from '../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';

/** Real storage/auth/Socket boundary. No CLI source is imported into the server. */
export async function createDeploymentSocketHome({ encryptionMode = 'plain', credentialVariant = 'dataKey', dbProvider = 'sqlite', prepareMachineContent, configureApp,
    serverId = readCachedServerIdentityIdForHotPath() ?? `srv_${randomUUID().replaceAll('-', '')}` } = {}) {
    if (dbProvider === 'postgres' && (process.env.HAPPIER_DB_PROVIDER !== 'postgres' || !process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID)) {
        throw new Error('The PostgreSQL deployment journey requires the disposable DB-contract runner');
    }
    const harness = await (dbProvider === 'postgres' ? createDatabaseIntegrationHarness : createLightSqliteHarness)({
        tempDirPrefix: 'happier-deployment-socket-home-', initAuth: true, initEncrypt: true,
        env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: 'none' },
    });
    let home;
    let closeSocket;
    let tls;
    const previousCaCertificates = getCACertificates('default');
    const close = async () => {
        try {
            if (home) {
                home.server.closeAllConnections();
                try { await closeSocket?.(); }
                finally { await home.close(); }
            }
        } finally {
            try { await harness.close(); }
            finally {
                setDefaultCACertificates(previousCaCertificates);
                await tls?.cleanup();
            }
        }
    };
    try {
        // Qualification happens before guest effects. Give the source guest a
        // real remote-capable HTTPS route instead of exempting this fixture's
        // controller-only loopback address from the production guard.
        const host = Object.values(networkInterfaces()).flat()
            .find(address => address?.family === 'IPv4' && !address.internal)?.address;
        if (!host) throw new Error('The deployment journey requires a non-loopback IPv4 interface');
        tls = await createEphemeralTlsServerFixture({ additionalIpAddresses: [host] });
        const [cert, key, ca] = await Promise.all([
            readFile(tls.leafCertificatePath), readFile(tls.privateKeyPath), readFile(tls.caCertificatePath, 'utf8'),
        ]);
        setDefaultCACertificates([...previousCaCertificates, ca]);
        // Node reads this at process startup, including the fresh source guest.
        // The harness restores the original environment when it closes.
        process.env.NODE_EXTRA_CA_CERTS = tls.caCertificatePath;
        home = createAuthenticatedTestApp({ authentication: 'real', https: { cert, key } });
        const legacySecret = encryptionMode === 'e2ee' && credentialVariant === 'legacy' ? nacl.randomBytes(32) : null;
        const contentKeys = encryptionMode === 'e2ee' ? legacySecret
            ? nacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(legacySecret))
            : nacl.box.keyPair() : null;
        const account = await db.account.create({ data: { encryptionMode,
            ...(contentKeys ? createSignedAccountContentBinding(contentKeys.publicKey) : {}) } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user',
            authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
        const keys = nacl.sign.keyPair();
        const installationId = randomUUID();
        const machineEncryptionKey = contentKeys ? nacl.randomBytes(32) : null;
        // This fixture creates only the already paired acquisition controller.
        // The journey obtains its deployment target through public enrollment.
        const metadata = { host: 'S0 acquisition controller', platform: 'linux', happyCliVersion: 'test', homeDir: harness.baseDir, happyHomeDir: harness.baseDir };
        let controllerProvisionerManifest;
        if (machineEncryptionKey && !prepareMachineContent) throw new Error('E2EE fixture requires the owning client Machine codec');
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: account.id, active: true, installationId,
            installationPublicKey: new Uint8Array(keys.publicKey),
            metadata: machineEncryptionKey ? await prepareMachineContent(machineEncryptionKey, metadata) : encodePlainMachineStoredContent(metadata),
            dataEncryptionKey: contentKeys && machineEncryptionKey ? sealEncryptedDataKeyEnvelopeV1({
                dataKey: machineEncryptionKey, recipientPublicKey: contentKeys.publicKey, randomBytes: nacl.randomBytes,
            }) : privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } });
        // Routes capture the presence port during registration, as in startApi.
        closeSocket = startSocket(home);
        registerDeploymentRoutes(home);
        projectSourceRoutes(home);
        artifactsRoutes(home);
        machinesRoutes(home);
        authRoutes(home);
        accountRoutes(home);
        changesRoutes(home);
        const homeConnectionDescriptorContinuityStore = createHomeConnectionDescriptorContinuityStoreForServer(process.env);
        if (!homeConnectionDescriptorContinuityStore) throw new Error('Home descriptor continuity unavailable');
        featuresRoutes(home, { homeConnectionDescriptorContinuityStore });
        registerExternalActionRoutes(home);
        registerPluginAvailabilityRoutes(home);
        await configureApp?.(home);
        await home.listen({ host, port: 0 });
        const address = home.server.address();
        if (!address || typeof address === 'string') throw new Error('Home listener unavailable');
        const baseUrl = `https://${host}:${address.port}`;
        process.env.HAPPIER_CANONICAL_SERVER_URL = baseUrl;
        process.env.HAPPIER_PUBLIC_SERVER_URL = baseUrl;
        // The real server startup publishes this durable fact before accepting
        // first-contact enrollment; public discovery itself cannot create it.
        const descriptor = await readHomeConnectionDescriptor({ continuityStore: homeConnectionDescriptorContinuityStore,
            visibility: 'authenticated' });
        if (!descriptor) throw new Error('Home descriptor publication unavailable');
        return {
            baseDir: harness.baseDir, baseUrl,
            accountId: account.id, serverId, machineId: machine.id, token, keys, installationId, encryptionMode,
            machineEncryptionKey, encryption: contentKeys ? legacySecret
                ? { type: 'legacy', secret: legacySecret, publicKey: new Uint8Array(contentKeys.publicKey) }
                : { type: 'dataKey', machineKey: new Uint8Array(contentKeys.secretKey),
                    publicKey: new Uint8Array(contentKeys.publicKey) } : null,
            async prepareControllerProvisioner(rawManifest) {
                // The already installed controller is the fixture precondition;
                // managed admission, allocation and guest registration remain live.
                const manifest = PluginManifestV2Schema.parse(rawManifest);
                controllerProvisionerManifest = manifest;
                const declaration = createReleaseLessDeclarationV1(manifest);
                await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id, enabled: true,
                    writableCollections: [], releaseLessDeclaration: declaration } });
                await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: serverId,
                    machineId: machine.id, materializationId: installationId, pluginId: manifest.id, version: manifest.version,
                    sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
                    uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
                await db.machine.update({ where: { id: machine.id }, data: { pluginMaterializationRevision: BigInt(1) } });
            },
            async setControllerProvisionerFiniteOnly(finiteOnly) {
                if (!controllerProvisionerManifest) throw new Error('The controller provisioner must be installed first');
                // The installed declaration is the real provider-support boundary;
                // capability admission, Action execution and storage stay live.
                const manifest = PluginManifestV2Schema.parse({ ...controllerProvisionerManifest,
                    contributes: { ...controllerProvisionerManifest.contributes,
                        machineProvisioners: controllerProvisionerManifest.contributes.machineProvisioners.map(provisioner => ({
                            ...provisioner, retention: { ...provisioner.retention, finiteOnly },
                        })),
                    },
                });
                const declaration = createReleaseLessDeclarationV1(manifest);
                await db.$transaction([
                    db.accountPluginIntent.updateMany({ where: { accountId: account.id, pluginId: manifest.id },
                        data: { releaseLessDeclaration: declaration } }),
                    db.pluginMachineMaterialization.updateMany({ where: { accountId: account.id, serverIdentityId: serverId,
                        machineId: machine.id, materializationId: installationId, pluginId: manifest.id },
                        data: { archiveDigestSha256: declaration.manifestDigestSha256 } }),
                    db.machine.update({ where: { id: machine.id }, data: { pluginMaterializationRevision: { increment: BigInt(1) } } }),
                ]);
                controllerProvisionerManifest = manifest;
            },
            async readManagedEnrollment(machineId) {
                const row = await db.managedMachine.findFirst({ where: { enrolledMachineId: machineId, custodianAccountId: account.id } });
                return row ? { managedId: row.id, enrolledMachineId: row.enrolledMachineId,
                    controllerMachineId: row.controllerMachineId, allocation: row.allocation } : null;
            },
            async createContentArtifact(content, kind) {
                if (encryptionMode !== 'plain') throw new Error('E2EE Artifacts must be prepared by the owning client codec');
                const result = await createArtifact({ actorUserId: account.id, artifactId: randomUUID(),
                    header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Deployment content' })),
                    body: privacyKit.decodeBase64(encodePlainArtifactStoredContent(content)),
                    dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
                if (!result.ok) throw new Error(`Deployment Artifact preparation failed: ${result.error}`);
                return { contentArtifactId: result.artifact.id, contentHeaderVersion: result.artifact.headerVersion, contentBodyVersion: result.artifact.bodyVersion };
            },
            close,
        };
    } catch (error) { await close(); throw error; }
}
