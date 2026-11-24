import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readMachineRpcAdmissionCurrent } from './machineRpcAuthorization';

afterEach(() => { vi.restoreAllMocks(); });

it('verifies a Backup receiver Setup child at Home only on the Manage receiver its root review named', async () => {
  const homeId = 'srv_backup_home';
  const target = { kind: 'machine' as const, machineId: 'source' };
  const rootInput = { serverId: homeId, environmentId: 'environment', expectedRevision: 3, intent: 'test' as const,
    destinationSetup: { kind: 'anotherMachine' as const, machineId: 'receiver', expectedInstallationId: 'receiver-installation', receiverInputs: {} },
    configuration: { configRevision: 1, destinationRef: { pluginId: 'happier.backup.local', localId: 'open' }, occurrenceId: 'destination',
      config: { path: '/private/repository' }, credentialBindings: [],
      sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'postgres', consistency: 'logical' as const }],
      ownership: { environmentId: 'environment', prefix: 'owner-prefix' }, retention: { kind: 'keepEverything' as const } } };
  const envelope = { v: 1 as const, requestId: 'backup-configure', target, input: rootInput };
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-backup', binding: {
    accountId: 'person', custodianAccountId: 'person', authentication: { kind: 'account', tokenEpoch: 1 },
    accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId: 'source', installationId: 'source-installation',
    actionId: 'deployments.backups.configure', requestId: envelope.requestId, target, environmentId: 'environment',
    deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.configure', rootInput),
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  // Home's admission verifier is the network boundary; local packet matching stays real.
  const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true } });
  const keys = tweetnacl.sign.keyPair();
  const read = (machineId: string, role: 'manage' | 'use' = 'manage') => {
    const params = { homeId, machineId };
    const method = `${machineId}:${RPC_METHODS.MACHINE_SETUP_PLAN}`;
    return readMachineRpcAdmissionCurrent({
      context: { actorAccountId: 'person', custodianAccountId: 'bob', machineId, installationId: `${machineId}-installation`,
        role, encryptionMode: 'plain' },
      method, callerInputAuthorization: root,
      workspaceSyncSourceExecution: { method, requestId: 'receiver-plan', params, originalActionEnvelope: envelope,
        externalActionExecution: { v: 1, authorization: root, effectActionId: 'machines.setup.plan', target,
          installationId: 'source-installation', machineSignature: 'A'.repeat(86),
          reviewedChild: { actionId: 'machines.setup.plan', role: BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan.role,
            inputDigest: computeActionInputApprovalDigestV1('machines.setup.plan', params) } } },
      privateKey: keys.secretKey, daemonToken: 'receiver-daemon', serverHttpBaseUrl: 'https://home.invalid',
    }, failure => { failures.push(failure.stage); });
  };
  const failures: string[] = [];
  expect(await read('receiver'), failures.join(',')).toEqual({ v: 1, ok: true });
  expect(post).toHaveBeenCalledTimes(1);
  // A receiver shared only for Use, and a Machine the review did not name, never reach Home.
  expect(await read('receiver', 'use')).toBeNull();
  expect(await read('elsewhere')).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
});
