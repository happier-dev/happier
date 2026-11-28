import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';

import type { ActionExecuteResult, DeploymentEnvironmentGetResultV1 } from '@happier-dev/protocol';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import {
    DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1,
    DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, DEPLOYMENT_BACKUP_HISTORY_ACTION_ID_V1,
    DEPLOYMENT_BACKUP_INVENTORY_ACTION_ID_V1, DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1,
    DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_BACKUP_PRUNE_ACTION_ID_V1,
} from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import {
    DeploymentBackupTestResultV1Schema, DeploymentBackupRunResultV1Schema,
    DeploymentBackupHistoryResultV1Schema, DeploymentBackupInventoryResultV1Schema,
    DeploymentBackupVerifyResultV1Schema, DeploymentBackupPruneResultV1Schema,
} from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DeploymentBackupConfigureResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { DeploymentBackupRestoreResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import { SFTP_BACKUP_DESTINATION_REF_V1 } from '@happier-dev/protocol/plugins/contributions/backupDestinations';
import { createDeploymentDumpBackupSourceV1, RESTIC_RUNTIME_V1 } from '@happier-dev/deployments';

import type { DeploymentSocketHomeFixture } from '../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { nativeRestic0191 } from '@/daemon/local/services/launch/nativeResticRegistry.testkit';
import { archive, installRestoreBoundary } from './targets/ownServer/nativeRestore.testkit';
import type { createOwnServerDockerBoundary } from './targets/ownServer/ownServerDeployment.testkit';

/** One continuation of the composed Home/daemon journey. Only PostgreSQL,
 * restic and Docker are substituted, at their existing executable boundary. */
export async function runDeploymentRootBackupCoverage(input: Readonly<{
    home: DeploymentSocketHomeFixture;
    invoke(actionId: string, input: unknown): Promise<ActionExecuteResult>;
    docker: Awaited<ReturnType<typeof createOwnServerDockerBoundary>>;
    environmentId: string;
    targetLinkId: string;
    deploymentId: string;
    secretRef: string;
    readEnvironment(): Promise<Extract<DeploymentEnvironmentGetResultV1, { ok: true }>>;
}>): Promise<void> {
    const { home, docker, environmentId, targetLinkId, deploymentId } = input;
    const tools = dirname(docker.executablePath);
    const repository = join(tools, 'root-coverage-backup');
    await mkdir(join(repository, environmentId), { recursive: true });
    await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
    const native = await installRestoreBoundary(tools, 'success', { toolDirectory: tools, environmentId });

    const invoke = async (actionId: string, authored: unknown): Promise<unknown> => {
        const result = await input.invoke(actionId, authored);
        expect(result.ok, `${actionId}: ${result.ok ? '' : result.errorCode}`).toBe(true);
        if (!result.ok) throw new Error(`${actionId}: ${result.errorCode}`);
        return result.result;
    };
    const initial = await input.readEnvironment();
    const secret = parseSavedSecretRefV1(input.secretRef);
    if (secret.kind !== 'shared_resource') throw new Error('Backup coverage requires the journey shared Saved Secret');
    const resourceRevision = initial.savedSecretRevisions?.find(capture => capture.resourceId === secret.resourceId)?.revision;
    if (!resourceRevision) throw new Error('Backup coverage requires the bound Saved Secret revision');
    const configured = DeploymentBackupConfigureResultV1Schema.parse(await invoke(DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, {
        serverId: home.serverId, environmentId, expectedRevision: initial.environment.revision, intent: 'save',
        configuration: {
            configRevision: 1,
            destinationRef: { pluginId: SFTP_BACKUP_DESTINATION_REF_V1.pluginId, localId: 'local' },
            // Configure replaces this authored operand with its admitted registry occurrence.
            occurrenceId: 'resolved-by-configure', config: { path: repository },
            credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
            sources: [createDeploymentDumpBackupSourceV1('database')],
            ownership: { environmentId, prefix: environmentId }, retention: { kind: 'keepEverything' },
        },
        backupBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword',
            source: { kind: 'secret', ref: input.secretRef, resourceRevision } }],
    }));
    expect(configured.kind).toBe('configured');
    if (configured.kind !== 'configured') throw new Error(`Backup configuration did not persist: ${configured.kind}`);
    const target = async () => {
        const current = await input.readEnvironment();
        expect(current.targetLinks.find(link => link.id === targetLinkId)?.activeDeploymentId).toBe(deploymentId);
        return { serverId: home.serverId, environmentId, targetLinkId, deploymentId,
            machineId: home.machineId, installationId: home.installationId,
            expectedRevision: current.environment.revision, configRevision: configured.configuration.configRevision };
    };

    expect(DeploymentBackupTestResultV1Schema.parse(await invoke(DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1, await target())))
        .toMatchObject({ kind: 'reachable' });
    const captured = DeploymentBackupRunResultV1Schema.parse(await invoke(DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, await target()));
    const manifest = captured.manifests[0];
    if (!manifest) throw new Error('The successful backup must retain its actual snapshot manifest');
    expect(manifest).toMatchObject({ environmentId, kind: 'dump', totalBytesProcessed: archive.length });
    const history = DeploymentBackupHistoryResultV1Schema.parse(await invoke(DEPLOYMENT_BACKUP_HISTORY_ACTION_ID_V1, await target()));
    expect(history.history.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ operationId: captured.operationId, state: 'succeeded', action: 'backup' }),
    ]));
    const inventory = DeploymentBackupInventoryResultV1Schema.parse(await invoke(DEPLOYMENT_BACKUP_INVENTORY_ACTION_ID_V1, await target()));
    expect(inventory.snapshots).toEqual(expect.arrayContaining([expect.objectContaining({
        snapshot: expect.objectContaining({ snapshotId: manifest.snapshot.snapshotId }),
        verification: expect.objectContaining({ kind: 'verified', backupOperationId: captured.operationId }),
    })]));
    expect(DeploymentBackupVerifyResultV1Schema.parse(await invoke(DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1, {
        ...await target(), backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId,
        level: 'repositoryCheck',
    }))).toMatchObject({ kind: 'verified', verified: true, backupOperationId: captured.operationId });

    const { configRevision: _configRevision, ...restoreTarget } = await target();
    const restoreInput = { ...restoreTarget,
        source: { kind: 'repository', backupOperationId: captured.operationId, snapshotId: manifest.snapshot.snapshotId },
        destination: { kind: 'database', service: 'database', database: 'root_coverage_restored' },
    };
    const prepared = DeploymentBackupRestoreResultV1Schema.parse(await invoke(DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1,
        { ...restoreInput, mode: 'prepare' }));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error(`Restore preparation failed: ${prepared.kind}`);
    expect(DeploymentBackupRestoreResultV1Schema.parse(await invoke(DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, {
        ...restoreInput, mode: 'confirm', prepareOperationId: prepared.operationId,
    }))).toMatchObject({ kind: 'restored', verified: true });
    const restored = JSON.parse(await readFile(native.stateFile, 'utf8')) as { names: string[]; importedBytes?: number };
    expect(restored.names).toContain(restoreInput.destination.database);
    expect(restored.importedBytes).toBe(archive.length);

    // Keep-everything is an authored successful prune outcome, with no deletions.
    expect(DeploymentBackupPruneResultV1Schema.parse(await invoke(DEPLOYMENT_BACKUP_PRUNE_ACTION_ID_V1, {
        ...await target(), retention: { kind: 'keepEverything' },
    }))).toMatchObject({ kind: 'noop', forgottenSnapshotIds: [] });
}
