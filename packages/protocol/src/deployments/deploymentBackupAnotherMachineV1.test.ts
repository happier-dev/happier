import { describe, expect, it } from 'vitest';
import { DeploymentBackupAnotherMachineSetupV1Schema } from './deploymentBackupAnotherMachineV1.js';
import { DeploymentBackupConfigureResultV1Schema } from './deploymentBackupConfigureV1.js';
import { DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1 } from './deploymentActionIdsV1.js';
import { projectDeploymentNativeAdmissionV1 } from './deploymentCandidatePublicationV1.js';

describe('Another Machine backup configure operand', () => {
  it('retains independently saved sender refs while recipe input remains with the setup owner', () => {
    const setup = { kind: 'anotherMachine', machineId: 'receiver', expectedInstallationId: 'receiver-installation',
      receiverInputs: { username: 'archive', endpoint: { host: '100.100.1.2', port: 22 } },
      senderIdentity: { publicKey: 'ssh-ed25519 cHVibGlj',
        sshPrivateKey: { kind: 'secret', ref: 'happier:shared-secret:v1:sender-key', resourceRevision: 1 } } };
    expect(DeploymentBackupAnotherMachineSetupV1Schema.parse(setup)).toEqual(setup);
    expect(DeploymentBackupAnotherMachineSetupV1Schema.safeParse({ ...setup,
      senderIdentity: { ...setup.senderIdentity, privateKey: 'private-bytes' } }).success).toBe(false);
  });

  it('binds the reviewed installation along with the receiver and Environment before sealing the input', () => {
    const environmentId = 'environment';
    const receiverMachineId = 'receiver';
    const receiverInstallationId = 'receiver-installation';
    expect(projectDeploymentNativeAdmissionV1(DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, {
      serverId: 'home', environmentId, expectedRevision: 1, intent: 'test',
      destinationSetup: { kind: 'anotherMachine', machineId: receiverMachineId,
        expectedInstallationId: receiverInstallationId, receiverInputs: {} },
      configuration: { configRevision: 1, destinationRef: { pluginId: 'example.backup', localId: 'open' },
        occurrenceId: 'destination', config: {}, credentialBindings: [],
        sources: [{ kind: 'dump', sourceId: 'database', service: 'postgres', consistency: 'logical' }],
        ownership: { environmentId, prefix: 'owner-prefix' }, retention: { kind: 'keepEverything' } },
    })).toMatchObject({ environmentId, receiverMachineId, receiverInstallationId });
  });

  it('returns settled sender references after Test so Save can reuse the same identity', () => {
    const result = { kind: 'tested', test: { kind: 'reachable', repositoryId: 'a'.repeat(64) },
      destinationSetup: { kind: 'anotherMachine', machineId: 'receiver', expectedInstallationId: 'receiver-installation',
        receiverInputs: { username: 'archive' }, senderIdentity: { publicKey: 'ssh-ed25519 cHVibGlj',
          sshPrivateKey: { kind: 'secret', ref: 'happier:shared-secret:v1:sender-key', resourceRevision: 1 },
          repositoryPassword: { kind: 'secret', ref: 'happier:shared-secret:v1:repository-password', resourceRevision: 2 } } },
      setupOperation: { operationId: 'receiver-setup' } };
    expect(DeploymentBackupConfigureResultV1Schema.parse(result)).toEqual(result);
  });
});
