import { describe, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { OwnServerDeploymentInputBasisV1Schema, DeploymentOwnServerContentV1Schema, type EnvironmentSecretBindingV1, type DeploymentBackupConfigurationV1 } from '@happier-dev/deployments/contracts/v1';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { RESTIC_RUNTIME_V1 } from '@happier-dev/deployments';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { createDeploymentBackupEnvironmentForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { createNativeComposeImageIdentity } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { nativeRestic0191 } from '@/daemon/local/services/launch/nativeResticRegistry.testkit';
import { withFiniteComposeFixture } from '@/daemon/local/services/launch/serviceExec.testkit';
import { createNativeComposeLifecycle } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { executeOwnServerMigration, MIGRATION_PENDING_CHECK_STEP, MIGRATION_STEP } from './migration';
import type { OwnServerDeploymentReceipt } from './ownServerDeploymentTarget';
import { archive, database, installRestoreBoundary } from './nativeRestore.testkit';
import { createOwnServerDatabaseUsernameReaderForHost } from './backupDestination';

describe('own-server migration native backup consumer', () => {
    it.each(['backup', 'zero', 'pending', 'pendingWithoutBackup', 'unknown', 'cancel', 'dumpFailure', 'unconfigured'] as const)(
        'settles migration with native recovery custody: %s', async mode => {
            await withFiniteComposeFixture(async ({ project, docker, source, root, exec, io, envPort }) => {
                await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
                const images = createNativeComposeImageIdentity({ directory: async () => root, async run(args) {
                    const tool = await exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose', cwd: source.rootPath });
                    const result = await exec.run({ executable: tool.executable, cwd: source.rootPath, args });
                    if (result.termination.observed.kind !== 'exit') throw new Error('Expected native image metadata');
                    return { exitCode: result.termination.observed.exitCode, stdout: Buffer.from(result.stdout).toString('utf8') };
                } });
                const [runtimeImage] = await images.resolveVariants({ service: 'restic', reference: RESTIC_RUNTIME_V1.image, platforms: ['linux/amd64'] });
                if (!runtimeImage) throw new Error('Expected recorded restic runtime');
                const compose: { services: { worker: { image: string } } } = JSON.parse(await readFile(join(source.rootPath, 'compose.yaml'), 'utf8'));
                const candidateImages = await images.resolveVariants({ service: 'worker', reference: compose.services.worker.image, platforms: ['linux/amd64'] });
                const render = await project.render();
                const activation = await machineNativeEffectAdmission.run({ operation: { operationId: 'migration-seed', kind: 'deploy' },
                    keys: render.keys, settleNative: project.settleNative }, context => project.activate({ render, context }));
                // The live database generation supplies backup while the unactivated
                // candidate owns its finite pre-activation migration command.
                const candidate = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source, sourceKind: 'stored',
                    files: ['compose.yaml'], services: ['worker'], images: candidateImages, io, settleNative: project.settleNative });
                const candidateRender = await candidate.render({ purpose: 'serviceCommand', service: 'worker' });
                await source.commit();
                const boundary = await installRestoreBoundary(root, mode === 'dumpFailure' ? 'dumpFailure' : 'success');
                const seed = new Uint8Array(32).fill(48);
                const roles = ['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const;
                const bindings = roles.map((role): Extract<EnvironmentSecretBindingV1, { purpose: 'backupDestination' }> => ({
                    purpose: 'backupDestination', configKey: 'destination', role,
                    source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(role), resourceRevision: 1 } }));
                const grants = roles.map(role => sealMachineSecretGrant({ subject: { v: 1, kind: 'secret',
                    environmentId: source.environmentId, machineId: source.machineId, installationId: source.installationId,
                    resourceId: role, resourceRevision: 1 }, installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey,
                    content: { kind: 'secret', value: `private-${role}` } }));
                const data = [{ engine: 'postgres' as const, service: 'worker', logicalBackup: { adapter: 'postgres-v1' as const } }];
                const configuration: DeploymentBackupConfigurationV1 = { configRevision: 1,
                    destinationRef: { pluginId: 'example.storage', localId: 's3' }, occurrenceId: 'storage', config: { bucket: 'backup' },
                    credentialBindings: roles.map(role => ({ purpose: 'backupDestination', configKey: 'destination', role })),
                    sources: [{ kind: 'dump', sourceId: 'safety', service: 'worker', consistency: 'logical' }],
                    ownership: { environmentId: source.environmentId, prefix: source.environmentId }, retention: { kind: 'keepEverything' } };
                const seedReceipt = createDeploymentReceiptDetailV1();
                const approvedInputBasis = OwnServerDeploymentInputBasisV1Schema.parse({ v: 1,
                    environmentId: source.environmentId, environmentRevision: 1, targetLinkId: seedReceipt.deployment.targetLinkId,
                    targetLinkRevision: 1, sourceIntent: seedReceipt.content.sourceIntent, manifestFingerprint: 'manifest',
                    configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.39.4', services: ['worker'], profiles: [],
                    members: [{ machineId: source.machineId, installationId: source.installationId }], bindings: [],
                    images: seedReceipt.content.images, health: [{ service: 'worker', participates: false }] });
                let receipt: OwnServerDeploymentReceipt = { ...seedReceipt,
                    deployment: createDeploymentReceiptHeaderV1({ environmentId: source.environmentId }),
                    content: DeploymentOwnServerContentV1Schema.parse({ ...seedReceipt.content, ownServer: { approvedInputBasis } }) };
                const controller = new AbortController();
                let passwordPath: string | undefined;
                let preparationDisposed = false;
                const pendingCheck = ['zero', 'pending', 'pendingWithoutBackup', 'unknown'].includes(mode);
                if (mode === 'pending' || mode === 'pendingWithoutBackup') await docker.setCommandOutcome({ exitCode: 7 });
                if (mode === 'unknown') await docker.setCommandOutcome({ loseExitAcknowledgement: true });
                try {
                    await machineNativeEffectAdmission.run({ operation: { operationId: `migration-${mode}`, kind: 'deploy', signal: controller.signal },
                        keys: render.keys, settleNative: project.settleNative }, async context => {
                        const execute = executeOwnServerMigration({ configuration: { rollout: 'recreate', autoRestorePreviousRelease: true,
                            migration: { service: 'worker', argv: ['migrate'],
                            ...(pendingCheck ? { pendingCheck: { argv: ['pending'] } } : {}) }, migrationFailurePolicy: 'ask',
                            ...(mode === 'pendingWithoutBackup' ? { backupBeforeMigration: false } : {}) },
                            project: candidate, render: candidateRender, context, signal: controller.signal, directUrlBound: false,
                            async writeStep(step) {
                                receipt = { ...receipt, content: { ...receipt.content,
                                    steps: [...receipt.content.steps.filter(previous => previous.id !== step.id), step] } };
                                if (step.id === MIGRATION_PENDING_CHECK_STEP && step.state !== 'running') await docker.setCommandOutcome({});
                                if (step.id === MIGRATION_STEP && step.state === 'running' && mode !== 'pendingWithoutBackup') {
                                    // A command must never become reachable before its verified recovery capture is persisted.
                                    expect(receipt.content.ownServer?.preMigrationBackup?.source.snapshot.snapshotId).toBe('d'.repeat(64));
                                    const events = await readFile(boundary.eventsFile, 'utf8');
                                    expect(events).toContain('"kind":"safetyBytes"');
                                    expect(events).toContain('"snapshots"');
                                }
                            },
                            ...(mode === 'unconfigured' ? {} : { async prepareBackup() {
                                const preparation = { environmentId: source.environmentId, machineId: source.machineId,
                                    installationId: source.installationId, installationPrivateSeed: seed, bindings,
                                    backupDestinationUses: bindings, grants, backupConfigBaseDir: root, assertCurrent: source.assertCurrent };
                                const environment = createDeploymentBackupEnvironmentForHost({ repository: 's3:https://fixture.invalid/backup',
                                    signal: context.operation.signal!, isCurrent: () => true, preparation });
                                if (mode === 'cancel') controller.abort();
                                return { input: { project, render, activation, context, io, ...environment, runtimeImage,
                                    retainSource: () => source.commit(),
                                    readDatabaseUsername: createOwnServerDatabaseUsernameReaderForHost({ data, preparation }),
                                    readAccess() { const selected = environment.readAccess(); passwordPath = selected.credentialFiles[0]?.hostPath; return selected; },
                                    onStopPending() {} },
                                    capture: { receipt, destination: { environmentId: source.environmentId, revision: 1, adapter: 'postgres-v1' as const,
                                        service: 'worker', database, stagingDatabase: 'restore-stage', recoveryDatabase: 'restore-old',
                                        databaseExists: true, hasMeaningfulData: true, writerServices: [] }, context: { signal: controller.signal },
                                        backup: { environmentId: source.environmentId, configuration, data },
                                        async writeTransition(request: Parameters<Parameters<typeof import('./nativeRestore').runOwnServerNativePreMigrationBackup>[1]['writeTransition']>[0]) {
                                            receipt = { ...receipt, content: request.content,
                                                deployment: { ...receipt.deployment, revision: receipt.deployment.revision + 1 } };
                                            return { ok: true as const, deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision,
                                                environmentId: source.environmentId, revision: 2, state: request.state };
                                        } }, async dispose() { preparationDisposed = true; } };
                            } }) });
                        if (mode === 'unknown') await expect(execute).rejects.toMatchObject({ code: 'outcome_unknown' });
                        else if (mode === 'dumpFailure') await expect(execute).rejects.toMatchObject({ code: 'backup_failed' });
                        else if (mode === 'unconfigured') await expect(execute).rejects.toMatchObject({ code: 'backup_required' });
                        else if (mode === 'cancel') await expect(execute).rejects.toBeDefined();
                        else await execute;
                    });
                    const migrated = ['backup', 'pending', 'pendingWithoutBackup'].includes(mode);
                    expect(await docker.readCompletedCommand(['migrate'])).toBe(migrated ? 0 : null);
                    const captured = mode === 'backup' || mode === 'pending';
                    expect(receipt.content.ownServer?.preMigrationBackup?.source.snapshot.snapshotId).toBe(captured ? 'd'.repeat(64) : undefined);
                    const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
                    expect(events.filter(row => row.kind === 'safetyBytes')).toEqual(captured ? [{ kind: 'safetyBytes', bytes: archive.length }] : []);
                    if (captured) {
                        expect(receipt.content.ownServer?.preMigrationBackup?.target.database).toBe(database);
                        expect(receipt.content.ownServer?.preMigrationBackup?.repository.repository).toBe('s3:https://fixture.invalid/backup');
                    }
                    expect(preparationDisposed).toBe(captured || mode === 'cancel' || mode === 'dumpFailure');
                    if (mode === 'zero') expect(receipt.content.steps).toEqual(expect.arrayContaining([
                        expect.objectContaining({ id: MIGRATION_PENDING_CHECK_STEP, state: 'succeeded' }),
                        expect.objectContaining({ id: MIGRATION_STEP, state: 'skipped' })]));
                    if (['zero', 'unknown', 'pendingWithoutBackup', 'unconfigured'].includes(mode)) expect(passwordPath).toBeUndefined();
                    if (mode === 'dumpFailure' && passwordPath) {
                        await expect(access(passwordPath)).rejects.toMatchObject({ code: 'ENOENT' });
                        await machineNativeEffectAdmission.run({ operation: { operationId: 'migration-backup-reconcile', kind: 'backup' },
                            keys: render.keys, settleNative: project.settleNative }, async () => {});
                    }
                    if (passwordPath) await expect(access(passwordPath)).rejects.toMatchObject({ code: 'ENOENT' });
                    expect(await docker.readOperationContainerIds()).toEqual([]);
                } finally { await candidate.dispose(); await activation.dispose(); }
            }, { nativeExecutableIo: true });
        }, 60_000);
});
