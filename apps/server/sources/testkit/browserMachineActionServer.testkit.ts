import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Server } from 'socket.io';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    type MachineInstallationIdentityV1 } from '@happier-dev/protocol';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { validateMachineInstallationProof } from '@/app/machines/installationProof';
import { readMachineDaemonOwnershipMetadataFromSocketAuth } from '@happier-dev/protocol/machines/ownership/daemonOwnership';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerAccountProfileRoute } from '@/app/api/routes/account/registerAccountProfileRoute';
import { registerAccountSettingsRoutes } from '@/app/api/routes/account/registerAccountSettingsRoutes';
import { registerPairingAuthRoutes } from '@/app/api/routes/auth/registerPairingAuthRoutes';
import { registerAuthPingRoute } from '@/app/api/routes/auth/registerAuthPingRoute';
import { changesRoutes } from '@/app/api/routes/changes/changesRoutes';
import { registerPluginAvailabilityRoutes } from '@/app/plugins/availability/routes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { createHomeConnectionDescriptorContinuityStoreForServer } from '@/app/features/homeConnectionDescriptorContinuity';
import { startSocket } from '@/app/api/socket';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness } from './lightSqliteHarness';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { buildRpcMethodRoom } from '@/app/api/socket/rpc/rpcMethodRoom';
import { PLUGIN_MANIFEST as LIMA_MANIFEST } from '../../../../packages/plugins/machine-lima/src/manifest';
import { limaAcquisitionResource, LIMA_PROVISIONER_ID } from '../../../../packages/plugins/machine-lima/src/machine/provider';

/** Real Home HTTP, SQLite, installation verification and Socket.IO forwarding. */
export async function startBrowserMachineActionServer(input: Readonly<{
    machineId: string; installation: MachineInstallationIdentityV1; happyHomeDir: string; publicEndpoint?: string;
}>) {
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'browser-machine-action-', initAuth: true,
        initEncrypt: true, env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
            HAPPIER_SERVER_IDENTITY_ID: `srv_${randomUUID().replaceAll('-', '')}`,
            ...(input.publicEndpoint ? { HAPPIER_CANONICAL_SERVER_URL: input.publicEndpoint, HAPPIER_PUBLIC_SERVER_URL: input.publicEndpoint,
                HAPPIER_FEATURE_AUTH_PAIRING__DESKTOP_QR_MOBILE_SCAN_ENABLED: 'true' } : {}),
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    const close = async () => {
        try { if (app.machineDaemonPresence instanceof Server) await app.machineDaemonPresence.close(); }
        finally { try { await app.close(); } finally { await harness.close(); } }
    };
    try {
        enableSchemaValidation(app); enableErrorHandlers(app); enableAuthentication(app);
        registerAccountEncryptionRoutes(app); registerAccountProfileRoute(app); registerAccountSettingsRoutes(app);
        registerPairingAuthRoutes(app); registerAuthPingRoute(app);
        changesRoutes(app); registerPluginAvailabilityRoutes(app);
        machinesRoutes(app); artifactsRoutes(app);
        featuresRoutes(app, { homeConnectionDescriptorContinuityStore: createHomeConnectionDescriptorContinuityStoreForServer(process.env) });
        startSocket(app);
        // Use startSocket's production dispatcher and its real forwardRpcCall.
        registerExternalActionRoutes(app);
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.machine.create({ data: { id: input.machineId, accountId: owner.id, active: true, lastActiveAt: new Date(),
            installationId: input.installation.installationId,
            installationPublicKey: Uint8Array.from(decodeBase64(input.installation.publicKey, 'base64url')),
            metadata: encodePlainMachineStoredContent({ host: 'installed-browser-fixture', platform: 'linux', happyCliVersion: 'test',
                homeDir: input.happyHomeDir, happyHomeDir: input.happyHomeDir }),
            dataEncryptionKey: Uint8Array.from(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: {
                requesterExecutionIsolation: { protocolVersions: [1] }, externalActionExecutionAuthorization: { protocolVersions: [1] },
            } } });
        await makeShareEligibleForTest(owner.id, member.id);
        const grant = await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: owner.id, machineId: input.machineId,
            principal: { kind: 'account', accountId: member.id }, level: 'view' }));
        if (grant.kind !== 'saved') throw new Error('Browser Machine member grant unavailable');
        const token = (accountId: string, authority: 'present_user' | 'account_automation') => auth.createToken(accountId,
            undefined, { kind: authority === 'present_user' ? 'account' : 'terminal', authority });
        const ownerToken = await token(owner.id, 'present_user');
        const installedToken = await token(owner.id, 'account_automation');
        const memberToken = await token(member.id, 'present_user');
        const homeId = await getOrCreateServerIdentityId();
        const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        // Canonical and public transports address this same Home authority.
        // Enrollment's network boundary forwards a simulated public ingress.
        process.env.HAPPIER_CANONICAL_SERVER_URL = baseUrl;
        process.env.HAPPIER_PUBLIC_SERVER_URL = input.publicEndpoint ?? baseUrl;
        return { baseUrl, homeId, ownerAccountId: owner.id, memberAccountId: member.id, ownerToken, installedToken, memberToken,
            // Persistence is the fixture boundary. Public reads/cancellation
            // still traverse the real authorization, projection and HTTP owners.
            createOutputManagedMachine: async (fixture: Readonly<{ id: string; setupGuestId?: string; boundResource?: boolean }>) => {
                const provisioner = LIMA_MANIFEST.contributes.machineProvisioners?.find(row => row.id === LIMA_PROVISIONER_ID);
                if (!provisioner) throw new Error('Retained native output fixture requires the Lima declaration');
                const provider = { pluginId: LIMA_MANIFEST.id, localId: provisioner.id };
                const choices = { store: input.happyHomeDir, image: 'https://example.test/ubuntu.img', arch: 'x86_64' as const,
                    vmType: 'qemu' as const, cpus: 2, memoryGiB: 4, diskGiB: 20, mounts: [] };
                const launch = { provider, schemaVersion: 1, name: 'Retained output contract Machine', choices };
                const existing = await db.managedMachine.findUnique({ where: { id: fixture.id } });
                const machine = existing ?? await db.managedMachine.create({ data: {
                    id: fixture.id, homeId, custodianAccountId: owner.id,
                    controllerMachineId: input.machineId, controllerInstallationId: input.installation.installationId,
                    admittedActionRequestId: randomUUID(), admittedInput: { enrollmentAccountId: owner.id },
                    allocation: fixture.setupGuestId || fixture.boundResource ? 'bound' : 'unsubmitted', creationState: 'active', desired: 'start',
                    launch,
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
                    ...(fixture.setupGuestId || fixture.boundResource ? {
                        resource: { contributionRef: provider, schemaVersion: 1,
                            value: limaAcquisitionResource(choices, fixture.id) },
                        reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [],
                            billing: provisioner.billing, retentionCapabilities: provisioner.retention,
                            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
                        } : {}),
                    ...(fixture.setupGuestId ? { enrolledMachineId: fixture.setupGuestId,
                        presetId: `${fixture.id}-preset`, presetRevision: 0,
                        machineSetup: { setup: { scripts: [] }, state: 'failed', errorCode: 'setup_failed' } } : {}),
                } });
                return { managedId: machine.id, intentRevision: machine.intentRevision };
            },
            createOutputMachine: async (fixture: Readonly<{ id: string; active?: boolean; accountId?: string }>) => {
                const existing = await db.machine.findUnique({ where: { id: fixture.id }, select: { id: true } });
                if (existing) return existing.id;
                const machine = await db.machine.create({ data: { id: fixture.id, accountId: fixture.accountId ?? owner.id,
                    active: fixture.active ?? false, lastActiveAt: new Date(), installationId: randomUUID(),
                    installationPublicKey: Uint8Array.from(decodeBase64(input.installation.publicKey, 'base64url')),
                    metadata: encodePlainMachineStoredContent({ host: fixture.id, platform: 'linux', happyCliVersion: 'test',
                        homeDir: input.happyHomeDir, happyHomeDir: input.happyHomeDir }),
                    dataEncryptionKey: Uint8Array.from(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
                return machine.id;
            },
            readOwnerMintPrerequisites: async () => {
                const credential = await auth.verifyTokenForRoute(ownerToken);
                const currentMachine = await db.machine.findUnique({ where: { id: input.machineId },
                    select: { accountId: true, installationId: true } });
                return { credentialVerified: credential !== null,
                    credentialKind: credential?.authTokenKind, credentialAuthority: credential?.authority,
                    signedEpochCurrent: credential !== null && await auth.isSignedCredentialCurrent(db, owner.id, credential.tokenEpoch),
                    physicalMachineCurrent: currentMachine?.accountId === owner.id
                        && currentMachine.installationId === input.installation.installationId };
            },
            readReceiverAdmission: () => {
                const io = app.machineDaemonPresence;
                if (!(io instanceof Server)) return { connected: false, installationVerified: false, externalRegistered: false };
                const socket = [...io.sockets.sockets.values()].find(candidate => candidate.data.machineId === input.machineId);
                const room = buildRpcMethodRoom({ userId: owner.id, method: `${input.machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}` });
                const claimed = readMachineDaemonOwnershipMetadataFromSocketAuth(socket?.handshake.auth);
                const proof = validateMachineInstallationProof({ accountId: owner.id, machineId: input.machineId,
                    installationId: claimed.installationId, installationPublicKey: claimed.installationPublicKey,
                    installationProof: claimed.installationProof, replacesMachineId: null, replacementReason: null, contentPublicKeyFingerprint: null });
                return { connected: socket !== undefined,
                    installationVerified: socket?.data.verifiedMachineInstallationId === input.installation.installationId,
                    claimedInstallationMatches: claimed.installationId === input.installation.installationId,
                    claimedPublicKeyMatches: claimed.installationPublicKey === input.installation.publicKey,
                    proofStatus: !proof.ok ? proof.reason : proof.identity ? 'verified' : 'missing',
                    externalRegistered: socket !== undefined && io.sockets.adapter.rooms.get(room)?.has(socket.id) === true };
            },
            close, setProtectedSupport: async (supported: boolean) => {
                await db.machine.update({ where: { id: input.machineId }, data: { operationProtocolCapabilitiesRevision: { increment: 1 },
                    operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                        ...(supported ? { requesterExecutionIsolation: { protocolVersions: [1] } } : {}) } } });
            } };
    } catch (error) { await close(); throw error; }
}
