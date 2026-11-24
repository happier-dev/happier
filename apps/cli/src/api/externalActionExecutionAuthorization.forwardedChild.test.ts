import { expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { projectExternalActionRequesterHttpAuthorization } from './externalActionExecutionAuthorization';

// The receiver opens forwarded custody after the seal owner admitted the recipient;
// its HTTP projection must not re-decide (and narrow) that family list.
it.each(['deployments.backups.configure', 'projects.setup.set'] as const)(
  'projects receiver HTTP custody for a forwarded %s child the seal owner admitted', async rootActionId => {
    const homeId = 'srv_home';
    const target = { kind: 'machine' as const, machineId: 'source' };
    const rootInput = { serverId: homeId, environmentId: 'environment', expectedRevision: 3, intent: 'test' as const,
      destinationSetup: { kind: 'anotherMachine' as const, machineId: 'receiver', expectedInstallationId: 'receiver-installation', receiverInputs: {} },
      configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.local', localId: 'open' }, occurrenceId: 'destination',
        config: { path: '/private/repository' }, credentialBindings: [],
        sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'postgres', consistency: 'logical' as const }],
        ownership: { environmentId: 'environment', prefix: 'owner-prefix' }, retention: { kind: 'keepEverything' as const } } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
      accountId: 'person', custodianAccountId: 'person', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: 'source', installationId: 'source-installation',
      actionId: rootActionId, requestId: 'root-request', requestEnvelopeDigest: 'A'.repeat(43), target,
      ...(rootActionId === 'deployments.backups.configure' ? { environmentId: 'environment',
        deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(rootActionId, rootInput) } : {}),
    } });
    const params = { homeId, machineId: 'receiver' };
    const projected = await projectExternalActionRequesterHttpAuthorization({ authorization, serverId: homeId,
      serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.invalid', target, installationId: 'receiver-installation',
      privateKey: tweetnacl.sign.keyPair().secretKey, isCurrent: async () => true,
      forwardedMove: { credentials: { token: 'person-private', encryption: null }, isCurrent: async () => true,
        method: RPC_METHODS.MACHINE_SETUP_PLAN, reviewedChild: { actionId: 'machines.setup.plan',
          role: BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan.role, inputDigest: computeActionInputApprovalDigestV1('machines.setup.plan', params) } } });
    expect(projected?.binding).toEqual(authorization.binding);
    // Without a forwarded child the receiver still has no custody for another installation's root.
    expect(await projectExternalActionRequesterHttpAuthorization({ authorization, serverId: homeId,
      serverIdentityId: homeId, serverHttpBaseUrl: 'https://home.invalid', target, installationId: 'receiver-installation',
      privateKey: tweetnacl.sign.keyPair().secretKey, isCurrent: async () => true })).toBeNull();
  });
