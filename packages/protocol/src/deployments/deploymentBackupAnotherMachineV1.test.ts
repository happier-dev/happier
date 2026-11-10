import { describe, expect, it } from 'vitest';
import { DeploymentBackupAnotherMachineSetupV1Schema } from './deploymentBackupAnotherMachineV1.js';
import { DeploymentBackupConfigureResultV1Schema } from './deploymentBackupConfigureV1.js';

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
