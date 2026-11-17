import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { SharedSavedSecretMutationOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { sealSavedSecretResourceRecipientEnvelopeV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentBackupRunResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DeploymentBackupConfigureResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { DeploymentBackupRestoreResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import { deploymentBackupTargetOperands, RESTIC_RUNTIME_V1, selectDeploymentRuntimeTargetLinkV1 } from '@happier-dev/deployments';
import { PLUGIN_MANIFEST as BACKUP_DESTINATIONS } from '../../../plugins/backup-destinations/src/manifest';
import { nativeRestic0191 } from '../../../../apps/cli/src/daemon/local/services/launch/nativeResticRegistry.testkit';
import { installRestoreBoundary } from '../../../../apps/cli/src/deployments/targets/ownServer/nativeRestore.testkit';
import { createOwnServerDockerBoundary } from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeployment.testkit';
import type { TeamSetupFFixture } from './teamSetupF';
import { fetchAccountId } from './socialFriends';

/** Existing native Docker/restic boundary, real secret custody and backup/restore Actions. */
export async function runDeploymentOwnServerBackup(input: Readonly<{
  fixture: TeamSetupFFixture;
  account: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>;
  machine: Awaited<ReturnType<TeamSetupFFixture['enrollDaemon']>>;
  docker: Awaited<ReturnType<typeof createOwnServerDockerBoundary>>;
  tools: string; environmentId: string; targetLinkId: string; deploymentId: string;
}>) {
  const { fixture, account, machine, docker, tools, environmentId, targetLinkId, deploymentId } = input;
  const ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
    addressAnchorUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
  // Native backup Actions enter through the person's UI and its real review presenter.
  async function invoke(actionId: ActionId, value: unknown) {
    const result = await ui.executeConfirmed(actionId, value, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: ui.serverId, serverIdentityId: fixture.serverId, actionRequestId: randomUUID(),
      externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
    });
    if (!result.ok) throw new Error(`${actionId}: ${JSON.stringify(result)}`);
    return result.result;
  }
  try {
    const address = { serverId: fixture.serverId, environmentId };
    const detail = DeploymentEnvironmentGetResultV1Schema.parse(await invoke('deployments.environments.get', address));
    if (!detail.ok) throw new Error('Backup Environment unavailable');
    await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
    const boundary = await installRestoreBoundary(tools, 'repositoryOwnership', { toolDirectory: tools, environmentId });
    await boundary.setRepositoryMissing('/run/happier/backup/repository');
    const resourceId = randomUUID();
    const resourceDataKey = Uint8Array.from(randomBytes(32));
    const accountId = await fetchAccountId(fixture.server.baseUrl, account.credentials.token);
    const secret = SharedSavedSecretMutationOutputV1Schema.parse(await invoke('secrets.shared.create', {
      resourceId, displayName: 'Journey backup password', kind: 'password', encryptionMode: 'e2ee', teamGrants: [], groupGrants: [],
      storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey,
        content: { v: 1, name: 'Journey backup password', kind: 'password', value: 'fixture-repository-password' }, randomBytes }),
      keyEnvelopes: [{ recipientAccountId: accountId, ...sealSavedSecretResourceRecipientEnvelopeV1({
        resourceDataKey, recipientContentPublicKey: account.credentials.encryption.publicKey, randomBytes }) }],
    }));
    const destination = BACKUP_DESTINATIONS.contributes.backupDestinations?.find(row => row.id === 'local');
    if (!destination) throw new Error('Local backup destination unavailable');
    const repository = join(tools, 'repository');
    await mkdir(repository);
    const configuration = { configRevision: 1, destinationRef: { pluginId: BACKUP_DESTINATIONS.id, localId: destination.id },
      occurrenceId: destination.id, config: { path: repository },
      credentialBindings: destination.credentialRoles.map(({ role }) => ({ purpose: 'backupDestination', configKey: 'destination', role })),
      sources: [{ kind: 'volume', sourceId: 'data', service: 'app', volume: 'data', consistency: 'stopDuringCopy' }],
      ownership: { environmentId, prefix: environmentId }, retention: { kind: 'keepEverything' } };
    const configured = DeploymentBackupConfigureResultV1Schema.parse(await invoke('deployments.backups.configure', {
      ...address, expectedRevision: detail.environment.revision, intent: 'initializeAndSave', configuration,
      backupBindings: configuration.credentialBindings.map(binding => ({ ...binding,
        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(secret.resourceId), resourceRevision: secret.revision } })),
    }));
    expect(configured.kind).toBe('configured');
    if (configured.kind !== 'configured') throw new Error(`Backup configuration refused: ${configured.kind}`);
    const current = DeploymentEnvironmentGetResultV1Schema.parse(await invoke('deployments.environments.get', address));
    if (!current.ok) throw new Error('Backup Environment unavailable');
    const backupTarget = deploymentBackupTargetOperands({ environment: current.environment,
      runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1({ environment: current.environment,
        targetLinks: current.targetLinks.map(targetLink => ({ targetLink })) }) }, configured.configuration);
    if (!backupTarget) throw new Error('Backup Environment has no active native target');
    const captured = DeploymentBackupRunResultV1Schema.parse(await invoke('deployments.backups.run', {
      serverId: fixture.serverId, ...backupTarget,
    }));
    const manifest = captured.manifests[0];
    if (!manifest) throw new Error('Backup omitted its manifest');
    expect(manifest.kind).toBe('volume');
    const identity = MachineInstallationIdentityV1Schema.parse(JSON.parse(await readFile(join(machine.homeDir, 'installation-identity.json'), 'utf8')));
    const target = { ...address, targetLinkId, deploymentId, machineId: machine.target.machineId,
      installationId: identity.installationId, expectedRevision: current.environment.revision,
      source: { kind: 'repository', backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId } };
    const prepared = DeploymentBackupRestoreResultV1Schema.parse(await invoke('deployments.backups.restore', { ...target, mode: 'prepare' }));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error(`Restore preparation refused: ${prepared.kind}`);
    const restored = DeploymentBackupRestoreResultV1Schema.parse(await invoke('deployments.backups.restore', {
      ...target, mode: 'confirm', prepareOperationId: prepared.operationId,
    }));
    expect(restored).toMatchObject({ kind: 'restored', verified: true });
  } finally {
    await ui.close();
  }
}
