import '../../../../ui/sources/dev/vitestSetup';
import { computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1, encodeBase64 } from '@happier-dev/protocol';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { expect, onTestFinished, vi } from 'vitest';
import { createDeploymentSocketHome } from '../../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { db } from '../../../../server/sources/storage/db';
import { auth } from '../../../../server/sources/app/auth/auth';
import { inTx } from '../../../../server/sources/storage/inTx';
import { setEligibleMachineAccessGrantInTx } from '../../../../server/sources/testkit/machineAccessGrant.testkit';
import { createSignedAccountContentBinding } from '../../../../server/sources/testkit/accountEncryption';
import { commitMachineRecipientKeyEnvelopesInTx, readMachineRecipientCensusInTx } from '../../../../server/sources/app/machines/machineAccess';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { reloadConfiguration } from '@/configuration';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import * as installationStore from '@/daemon/identity/store';
import { createS0DeploymentDaemonIngress, installationBoundary, readS0Installation } from '@/deployments/deploymentDaemonIngress.testkit';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { decodeStoredCredentials, encodeStoredCredentials } from '@/persistence';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { randomUUID } from 'node:crypto';
import { createMemberInstallJourney } from './memberInstallJourney.testkit';
import { logger } from '@/ui/logger';
import { acquireEnrollmentJourneyGuest, createEnrollmentJourneyIsolationReadinessSystem } from './enrollmentJourney.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { readMachineRolesV1, machineRolesMetadataFieldV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';

import { installApprovalCommonModuleMocks } from '../../../../ui/sources/components/approvals/approvalsTestHelpers';
import { TokenStorage } from '../../../../ui/sources/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '../../../../ui/sources/sync/domains/server/serverProfiles';
import { createDefaultActionExecutor } from '../../../../ui/sources/sync/ops/actions/defaultActionExecutor';

installApprovalCommonModuleMocks();
const readiness = createEnrollmentJourneyIsolationReadinessSystem(999);

export async function runMemberInstallJourney(installRolesReceiver: boolean): Promise<void> {
    const directory = await createTempDir('composed-member-install-');
    onTestFinished(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); reloadConfiguration(); await removeTempDir(directory); });
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    reloadConfiguration();
    const plugin = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory,
        controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.agent.claude'] } });
    onTestFinished(() => plugin.dispose());
    const home = await createDeploymentSocketHome({ encryptionMode: 'e2ee',
        prepareMachineContent: (key, metadata) => createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: key,
            encryptionVariant: 'dataKey' }).encodeStored(metadata) });
    onTestFinished(() => home.close());
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(
        () => installationBoundary.getStore() ?? readS0Installation(home));
    const keys = nacl.box.keyPair();
    const member = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
    const token = await auth.createToken(member.id, undefined, { kind: 'account', authority: 'present_user',
        authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
    const warnings = vi.spyOn(logger, 'warn');
    let controller: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>> | undefined;
    let receiver: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>> | undefined;
    let memberJourney: Awaited<ReturnType<typeof createMemberInstallJourney>> | undefined;
    const guest = await acquireEnrollmentJourneyGuest(home, {
        confirmWholeOperation: true,
        startController: async managedMachineAction => {
            controller = await createS0DeploymentDaemonIngress({ home, managedMachineAction });
            onTestFinished(() => controller!.close());
            return controller;
        },
        startGuest: async (guest, nativeBoundary) => {
            const workspace = join(directory, 'workspace');
            await mkdir(workspace);
            memberJourney = await createMemberInstallJourney({ home: guest, memberAccountId: member.id });
            onTestFinished(() => memberJourney!.close());
            receiver = await createS0DeploymentDaemonIngress({ home: guest, nativeBoundary, installRolesReceiver,
                operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
                isolationWorkspace: { rootId: 'member-journey', path: workspace }, isolationReadinessSystem: readiness, configureRpc: memberJourney.register });
            onTestFinished(() => receiver!.close());
        },
    });
    const records = await db.managedMachine.findMany({ where: { controllerMachineId: home.machineId } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ enrolledMachineId: guest.machineId, allocation: 'bound' });
    const operations = controller!.actionOperations.store.list({ accountId: home.accountId, machineId: home.machineId }).items
        .filter(operation => operation.actionId === 'machines.managed.acquire');
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ state: 'succeeded' });
    expect(receiver!.readIsolation()).toMatchObject({ enabled: true, memberProvisioning: 'linuxUsersV1', status: { kind: 'effective' } });
    if (!guest.machineEncryptionKey) throw new Error('Missing enrolled guest content key');
    const storedGuest = await db.machine.findUniqueOrThrow({ where: { id: guest.machineId } });
    const guestMetadata = createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: guest.machineEncryptionKey,
        encryptionVariant: 'dataKey' }).decodeStored(storedGuest.metadata);
    expect(readMachineRolesV1(guestMetadata)).toMatchObject({ status: 'ready',
        source: installRolesReceiver ? 'stored' : 'default', policy: installRolesReceiver
            ? { active: ['deployments', 'sessions'] } : machineRolesMetadataFieldV1.defaultValue() });
    const roleWarnings = warnings.mock.calls.filter(([message]) => message === '[MANAGED MACHINE] Enrollment roles seed failed');
    if (installRolesReceiver) {
        expect(roleWarnings).toEqual([]);
    } else {
        expect(roleWarnings).toHaveLength(1);
        expect(roleWarnings[0]![1]).toMatchObject({ machineId: guest.machineId, code: 'RPC_METHOD_NOT_FOUND' });
    }
    // Sharing uses the owning grant and envelope writers, never a fabricated
    // machineAdmission or signed authorization supplied by the fixture.
    expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: home.accountId,
        machineId: guest.machineId, principal: { kind: 'account', accountId: member.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
    const census = await inTx(tx => readMachineRecipientCensusInTx(tx, { actorAccountId: home.accountId, machineId: guest.machineId }));
    if ('kind' in census || !guest.machineEncryptionKey) throw new Error('Missing enrolled guest share census');
    expect(await inTx(tx => commitMachineRecipientKeyEnvelopesInTx(tx, {
        actorAccountId: home.accountId, machineId: guest.machineId,
        expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!, expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!,
        expectedMetadataVersion: census.content.metadataVersion, expectedDaemonStateVersion: census.content.daemonStateVersion,
        recipientKeyEnvelopes: [{ recipientAccountId: member.id,
            encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: guest.machineEncryptionKey,
                recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys.publicKey) }],
    }))).toMatchObject({ appliedRecipientAccountIds: [member.id] });
    const credentials = decodeStoredCredentials(encodeStoredCredentials({ token,
        encryption: { type: 'dataKey', machineKey: keys.secretKey, publicKey: keys.publicKey } }));
    if (!credentials) throw new Error('Missing member credential');
    const profile = await upsertServerProfile({ serverUrl: home.baseUrl });
    await setServerProfileIdentityForUrl(home.baseUrl, home.serverId);
    // Device credential storage is the boundary; UI capture, codec, HTTP, Home
    // admission, daemon dispatch and job ownership all stay real.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token,
        encryption: { machineKey: encodeBase64(keys.secretKey), publicKey: encodeBase64(keys.publicKey) } });
    const executor = createDefaultActionExecutor();
    await memberJourney!.run(async (rawActionId, input) => {
        const actionId = ActionIdSchema.parse(rawActionId);
        const requestId = randomUUID();
        const target = { kind: 'machine' as const, machineId: guest.machineId };
        if (actionId === 'machines.agents.install.cancel' || actionId === 'machines.agents.install.status') {
            // Match the mounted browser entry: no manufactured confirmation,
            // invocation stamp, receipt or admission. The UI owner must emit it.
            return executor.execute(actionId, input, { serverId: profile.id,
                expectedAccountId: member.id, surface: 'ui', authority: 'present_user', actionRequestId: requestId });
        }
        return dispatchOriginalAccountAction({ actionId, input, requestId, target, credentials,
            serverHttpBaseUrl: home.baseUrl, serverIdentityId: home.serverId,
            onRequesterSessionCredentialDisclosure: async () => true,
            invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' },
                presentUserConfirmation: { actionId, requestId, accountId: member.id, serverId: home.serverId, target,
                    inputDigest: computeActionInputApprovalDigestV1(actionId, input) } } });
    });
}
