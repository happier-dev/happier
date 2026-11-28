import { expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '../../actions/externalActionApi.js';
import { computeActionInputApprovalDigestV1 } from '../../actions/decisionAuthority.js';
import { projectDeploymentNativeAdmissionV1 } from '../../deployments/deploymentCandidatePublicationV1.js';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1 } from '../../machines/managed/actionIdsV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { openExternalActionRequesterAccountContextV1, sealExternalActionRequesterAccountContextV1 } from './sessionRequesterBootstrapV1.js';

it('seals and opens requester custody only for the receiver a Backup configure review named', () => {
  const homeId = 'srv_backup_home';
  const target = { kind: 'machine' as const, machineId: 'source' };
  const rootInput = { serverId: homeId, environmentId: 'environment', expectedRevision: 3, intent: 'test' as const,
    destinationSetup: { kind: 'anotherMachine' as const, machineId: 'receiver', expectedInstallationId: 'receiver-installation', receiverInputs: {} },
    configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.local', localId: 'open' }, occurrenceId: 'destination',
      config: { path: '/private/repository' }, credentialBindings: [],
      sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'postgres', consistency: 'logical' as const }],
      ownership: { environmentId: 'environment', prefix: 'owner-prefix' }, retention: { kind: 'keepEverything' as const } } };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
    serverIdentityId: homeId, accountId: 'person', custodianAccountId: 'person', authentication: { kind: 'account', tokenEpoch: 1 },
    accountEncryptionMode: 'plain', machineId: 'source', installationId: 'source-installation',
    actionId: 'deployments.backups.configure', requestId: 'backup-request', requestEnvelopeDigest: 'A'.repeat(43), target,
    environmentId: 'environment', deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.configure', rootInput),
  } });
  const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
  const credentials = { token: 'person-private', encryption: null };
  const purpose = (machineId: string) => {
    const params = { homeId, machineId };
    return { kind: 'machine_rpc' as const, method: RPC_METHODS.MACHINE_SETUP_PLAN, params,
      reviewedChild: { actionId: 'machines.setup.plan' as const, role: BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan.role,
        inputDigest: computeActionInputApprovalDigestV1('machines.setup.plan', params) },
      recipient: { machineId, installationId: `${machineId}-installation` } };
  };
  const seal = (value: ReturnType<typeof purpose> | Omit<ReturnType<typeof purpose>, 'reviewedChild'>) =>
    sealExternalActionRequesterAccountContextV1({ authorization, credentials, purpose: value,
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
  const sealed = seal(purpose('receiver'));
  expect(openExternalActionRequesterAccountContextV1({ authorization: sealed, purpose: purpose('receiver'),
    machineId: 'receiver', installationId: 'receiver-installation', serverIdentityId: homeId,
    installationPrivateKey: installation.secretKey })).toEqual(credentials);
  // A Machine the review did not name, or a purpose without the reviewed child, gets no custody.
  expect(() => seal(purpose('elsewhere'))).toThrow('requester_account_move_root_mismatch');
  const { reviewedChild: _withheld, ...unreviewed } = purpose('receiver');
  expect(() => seal(unreviewed)).toThrow('requester_account_move_root_mismatch');
});
