import { describe, expect, it } from 'vitest';
import { readFile, writeFile, access } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { OwnServerDeploymentInputBasisV1Schema, DeploymentOwnServerContentV1Schema,
    createDeploymentReceiptArtifactHeaderV1, readDeploymentReceiptArtifactV1, environmentSecretBindingIdentityV1,
    type EnvironmentSecretBindingV1, type DeploymentBackupConfigurationV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { OwnServerDeploymentReceipt } from './ownServerDeploymentTarget';
import { RESTIC_RUNTIME_V1, buildResticRequestV1, type DeploymentRestoreResolvedCaptureV1 } from '@happier-dev/deployments';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import * as backupEnvironment from '@/deployments/secrets/deploymentExecEnvPort';
import { createOwnServerDatabaseUsernameReaderForHost } from './backupDestination';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { createNativeComposeImageIdentity } from '@/daemon/local/services/launch/nativeComposeImageIdentity';
import { nativeRestic0191 } from '@/daemon/local/services/launch/nativeResticRegistry.testkit';
import { withFiniteComposeFixture } from '@/daemon/local/services/launch/serviceExec.testkit';
import * as adapter from './nativeRestore';
import { publishOwnServerDeploymentReceiptContentForHost } from './ownServerDeploymentExecutor';
import { DeploymentRollbackActionInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';

import { archive, database, sourceManifest, installRestoreBoundary } from './nativeRestore.testkit';

describe('native restore adapter', () => {
    it('preserves ordinary receipt publication failures outside caller cancellation', async () => {
        const observed = createDeploymentReceiptDetailV1();
        const receipt: OwnServerDeploymentReceipt = { deployment: observed.deployment,
            content: DeploymentOwnServerContentV1Schema.parse(observed.content) };
        const failure = new Error('receipt storage unavailable');
        await expect(publishOwnServerDeploymentReceiptContentForHost(receipt, receipt.content,
            { signal: new AbortController().signal }, async () => { throw failure; })).rejects.toBe(failure);
    });

    it.each(['success', 'failure', 'cancel', 'missingTool', 'healthFailure', 'cancelPublication', 'safety', 'receiptCapture', 'publicRestore', 'dumpFailure', 'repositoryOnly'] as const)(
        'settles the real restore and releases its one backup preparation: %s', async mode => {
            await withFiniteComposeFixture(async ({ project, docker, source, root, exec, io }) => {
                await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
                const images = createNativeComposeImageIdentity({ directory: async () => root, async run(args) {
                    const tool = await exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose', cwd: source.rootPath });
                    const result = await exec.run({ executable: tool.executable, cwd: source.rootPath, args });
                    if (result.termination.observed.kind !== 'exit') throw new Error('Expected native image metadata');
                    return { exitCode: result.termination.observed.exitCode, stdout: Buffer.from(result.stdout).toString('utf8') };
                } });
                const [runtimeImage] = await images.resolveVariants({ service: 'restic', reference: RESTIC_RUNTIME_V1.image, platforms: ['linux/amd64'] });
                if (!runtimeImage) throw new Error('Expected the recorded restic image');
                const render = await project.render();
                const activation = await machineNativeEffectAdmission.run({ operation: { operationId: 'restore-seed', kind: 'deploy' },
                    keys: render.keys, settleNative: project.settleNative }, context => project.activate({ render, context }));
                await source.commit();
                const boundary = await installRestoreBoundary(root, mode === 'cancelPublication' ? 'healthFailure' : mode);
                const seed = new Uint8Array(32).fill(48);
                const roles = ['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const;
                const bindings = roles.map((role): Extract<EnvironmentSecretBindingV1, { purpose: 'backupDestination' }> => ({
                    purpose: 'backupDestination', configKey: 'destination', role,
                    source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(role), resourceRevision: 1 } }));
                const grants = roles.map(role => sealMachineSecretGrant({ subject: { v: 1, kind: 'secret',
                    environmentId: source.environmentId, machineId: source.machineId, installationId: source.installationId,
                    resourceId: role, resourceRevision: 1 }, installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey,
                    content: { kind: 'secret', value: role === 'repositoryPassword' ? 'repository-private' : role === 'accessKeyId' ? 'access-private' : 'secret-private' } }));
                const username = "database user\\' --literal";
                const usernameBinding: Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }> = {
                    purpose: 'variable', phase: 'runtime', name: 'LOGICAL_USER', source: mode === 'receiptCapture'
                        ? { kind: 'secret', ref: formatSharedSavedSecretRefV1('logical-user'), resourceRevision: 1 }
                        : { kind: 'value', value: username } };
                const usernameGrant = usernameBinding.source.kind === 'secret'
                    ? sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: source.environmentId,
                        machineId: source.machineId, installationId: source.installationId, resourceId: 'logical-user', resourceRevision: 1 },
                        installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey, content: { kind: 'secret', value: username } })
                    : sealMachineSecretGrant({ subject: { v: 1, kind: 'environmentValues',
                    environmentId: source.environmentId, machineId: source.machineId, installationId: source.installationId,
                    binding: { purpose: 'variable', phase: 'runtime', name: usernameBinding.name } },
                    installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey,
                    content: { kind: 'environmentValues', definition: usernameBinding.source } });
                const controller = new AbortController();
                let passwordPath: string | undefined;
                let pending = 0;
                const progressPhases: string[] = [];
                const stoppedServices: string[][] = [];
                const observed = createDeploymentReceiptDetailV1();
                let observedReceipt: OwnServerDeploymentReceipt = { deployment: observed.deployment,
                    content: DeploymentOwnServerContentV1Schema.parse(observed.content) };
                const destination = { environmentId: source.environmentId, revision: 1, adapter: 'postgres-v1' as const,
                    service: 'worker', database, stagingDatabase: 'restore-stage', recoveryDatabase: 'restore-old',
                    databaseExists: mode === 'safety', hasMeaningfulData: mode === 'safety',
                    writerServices: mode === 'healthFailure' || mode === 'cancelPublication' ? ['writer'] : [] };
                try {
                    await machineNativeEffectAdmission.run({ operation: { operationId: `restore-${mode}`, kind: 'restore', signal: controller.signal },
                        keys: render.keys, settleNative: project.settleNative }, async context => {
                        const environment = backupEnvironment.createDeploymentBackupEnvironmentForHost({ repository: 's3:https://fixture.invalid/backup',
                            signal: context.operation.signal!, isCurrent: () => true, preparation: {
                                environmentId: source.environmentId, machineId: source.machineId, installationId: source.installationId,
                                installationPrivateSeed: seed, bindings, backupDestinationUses: bindings, grants,
                                backupConfigBaseDir: root, assertCurrent: source.assertCurrent } });
                        let repositoryOverride: string | undefined;
                        const readAccess = () => {
                            const selected = environment.readAccess();
                            passwordPath = selected.credentialFiles[0]?.hostPath;
                            return repositoryOverride ? { ...selected, repository: repositoryOverride } : selected;
                        };
                        const input = { project, render, activation, context, io, ...environment, readAccess, runtimeImage,
                            readDatabaseUsername: createOwnServerDatabaseUsernameReaderForHost({
                                data: [{ engine: 'postgres', service: 'worker', logicalBackup: {
                                    adapter: 'postgres-v1', ...(mode === 'success' ? {} : { username: usernameBinding.name }) } }], preparation: {
                                    environmentId: source.environmentId, machineId: source.machineId, installationId: source.installationId,
                                    installationPrivateSeed: seed, bindings: [usernameBinding],
                                    grants: [usernameGrant], assertCurrent: source.assertCurrent } }),
                            operationProgress: { update(progress: Readonly<{ phase?: string }>) {
                                if (progress.phase) progressPhases.push(progress.phase);
                            } },
                            onStopPending: () => { pending++; },
                            async onIncumbentServicesChanged(services: readonly string[]) {
                                stoppedServices.push([...services]);
                                if (mode !== 'cancelPublication') return;
                                // Stop arrives after acknowledged native stop but before its private receipt write.
                                if (services.length && !controller.signal.aborted) controller.abort();
                                expect(context.operation.signal?.aborted).toBe(false);
                                observedReceipt = await publishOwnServerDeploymentReceiptContentForHost(observedReceipt,
                                    { ...observedReceipt.content, machineResults: [{ machineId: source.machineId,
                                        installationId: source.installationId, steps: [], activation: 'pending', health: 'unknown',
                                        incumbentStopped: services.length > 0 }] }, { signal: controller.signal }, async request => {
                                        // Persistence boundary mirrors the Artifact/HTTP writer's caller-signal cancellation.
                                        request.context.signal?.throwIfAborted();
                                        return { ok: true, environmentId: request.environmentId, deploymentId: request.deploymentId,
                                            revision: 1, deploymentRevision: request.expectedRevision + 1, state: request.state };
                                    });
                            } };
                        if (mode === 'repositoryOnly') {
                            const result = await adapter.withOwnServerNativeBackup(input, undefined, native =>
                                native.executeBackup(buildResticRequestV1({ access: native.access,
                                    environmentId: source.environmentId, command: { kind: 'config' } })));
                            expect(result).toMatchObject({ kind: 'completed', exitCode: 0 });
                            return;
                        }
                        if (mode === 'safety') await adapter.observeOwnServerNativeRestoreDestination(input, {
                            operationId: 'username-observation', environmentId: source.environmentId, revision: 1, target: destination });
                        const capture = { source: sourceManifest, destination, sourceFormat: 'postgresCustom' as const };
                        // Prepare/confirm are separate real lifecycle invocations; each owns
                        // one preparation, and prepare leaves no password file behind.
                        const configuration: DeploymentBackupConfigurationV1 = { configRevision: 1,
                            destinationRef: { pluginId: 'example.storage', localId: 's3' }, occurrenceId: 'storage', config: { bucket: 'backup' },
                            credentialBindings: roles.map(role => ({ purpose: 'backupDestination', configKey: 'destination', role })),
                            sources: [{ kind: 'dump', sourceId: 'safety', service: 'worker', consistency: 'logical' }],
                            ownership: { environmentId: source.environmentId, prefix: source.environmentId }, retention: { kind: 'keepEverything' } };
                        let recoveryReceipt: OwnServerDeploymentReceipt | undefined;
                        let restoreInput = input;
                        const forRecordedCapture = (resolved: DeploymentRestoreResolvedCaptureV1) => {
                            expect(resolved.configuration).toEqual(configuration);
                            const selectedIdentities = new Set(resolved.configuration.credentialBindings.map(environmentSecretBindingIdentityV1));
                            const environment = backupEnvironment.createDeploymentBackupEnvironmentForHost({ repository: resolved.repository.repository,
                                signal: context.operation.signal!, isCurrent: () => true, preparation: {
                                    environmentId: resolved.destination.environmentId, machineId: source.machineId, installationId: source.installationId,
                                    installationPrivateSeed: seed, bindings, grants,
                                    backupDestinationUses: bindings.filter(binding => selectedIdentities.has(environmentSecretBindingIdentityV1(binding))),
                                    backupConfigBaseDir: root, assertCurrent: source.assertCurrent } });
                            restoreInput = { ...input, ...environment, readAccess() {
                                const selected = environment.readAccess();
                                passwordPath = selected.credentialFiles[0]?.hostPath;
                                return { ...selected, repository: repositoryOverride ?? selected.repository };
                            } };
                            return restoreInput;
                        };
                        if (mode === 'receiptCapture' || mode === 'publicRestore' || mode === 'dumpFailure') {
                            const seedReceipt = createDeploymentReceiptDetailV1();
                            const approvedInputBasis = OwnServerDeploymentInputBasisV1Schema.parse({ v: 1,
                                environmentId: source.environmentId, environmentRevision: 1, targetLinkId: seedReceipt.deployment.targetLinkId,
                                targetLinkRevision: 1, sourceIntent: seedReceipt.content.sourceIntent, manifestFingerprint: 'manifest',
                                configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.39.4', services: ['worker'], profiles: [],
                                members: [{ machineId: 'machine-a', installationId: 'installation-a' }], bindings: [],
                                images: seedReceipt.content.images, health: [{ service: 'worker', participates: false }] });
                            const receipt: OwnServerDeploymentReceipt = { ...seedReceipt,
                                deployment: createDeploymentReceiptHeaderV1({ environmentId: source.environmentId }),
                                content: DeploymentOwnServerContentV1Schema.parse({ ...seedReceipt.content, ownServer: { approvedInputBasis } }),
                            };
                            const backup = adapter.runOwnServerNativePreMigrationBackup(input, {
                                receipt, destination, context: { signal: controller.signal },
                                backup: { environmentId: source.environmentId, configuration,
                                    data: { engine: 'postgres', service: 'worker', logicalBackup: { adapter: 'postgres-v1' } } },
                                async writeTransition(request) {
                                    expect(request.expectedRevision).toBe(receipt.deployment.revision);
                                    const header = { ...receipt.deployment, contentBodyVersion: receipt.deployment.contentBodyVersion + 1 };
                                    const opened = readDeploymentReceiptArtifactV1(header, { artifactId: header.contentArtifactId,
                                        revision: { headerVersion: header.contentHeaderVersion, bodyVersion: header.contentBodyVersion },
                                        header: createDeploymentReceiptArtifactHeaderV1('Recovery', request.content), body: JSON.stringify(request.content) });
                                    if (!opened.ok) throw new Error(opened.error);
                                    expect(opened.content.ownServer?.preMigrationBackup?.source.snapshot.snapshotId).toBe('d'.repeat(64));
                                    return { ok: true, deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision + 1,
                                        environmentId: source.environmentId, revision: 2, state: request.state };
                                },
                            });
                            if (mode === 'dumpFailure') {
                                await expect(backup).rejects.toMatchObject({ code: 'backup_failed',
                                    details: { nativeFailure: { exitCode: 7, stderr: '', stderrTruncated: false } } });
                                expect(JSON.parse(await readFile(boundary.stateFile, 'utf8')).safetySnapshot).toBeUndefined();
                                expect(await docker.readOperationContainerIds()).toEqual([]);
                                return;
                            }
                            const completed = await backup;
                            if (mode === 'receiptCapture') {
                                const observer = activation.authorizeServiceObserver();
                                try {
                                    expect(observer.secretRedactionLease?.redact(username)).not.toContain(username);
                                    expect(observer.secretRedactionLease?.redact(JSON.stringify(username)))
                                        .not.toContain(JSON.stringify(username).slice(1, -1));
                                } finally { await observer.release(); }
                            }
                            recoveryReceipt = completed.receipt;
                            expect(recoveryReceipt.content.ownServer?.preMigrationBackup?.target.database).toBe(database);
                            expect(recoveryReceipt.content.ownServer?.preMigrationBackup?.repository.repository).toBe('s3:https://fixture.invalid/backup');
                            repositoryOverride = 's3:https://fixture.invalid/changed-destination';
                            // ID selection refuses before a fresh P42 acquisition/native effect.
                            passwordPath = undefined;
                            await expect(adapter.prepareOwnServerNativeRestore(forRecordedCapture, { operationId: 'unknown-backup', destination,
                                receipt: recoveryReceipt, restoreBackupId: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'backup_required' });
                            expect(passwordPath).toBeUndefined();
                        }
                        if (mode === 'publicRestore') {
                            if (!recoveryReceipt) throw new Error('Expected the completed pre-migration receipt');
                            const action = DeploymentRollbackActionInputV1Schema.parse({ serverId: 'home',
                                environmentId: source.environmentId, deploymentId: 'retained-code', restoreBackupId: 'd'.repeat(64) });
                            for (const scenario of ['unknown', 'otherEnvironment', 'foreignSnapshot', 'noBackup'] as const) {
                                const receipt = structuredClone(recoveryReceipt);
                                if (scenario === 'otherEnvironment') receipt.deployment.environmentId = 'other-environment';
                                if (scenario === 'foreignSnapshot') receipt.content.ownServer!.preMigrationBackup!.source.snapshot.tags = ['happier', 'env:other'];
                                if (scenario === 'noBackup') delete receipt.content.ownServer!.preMigrationBackup;
                                let factories = 0;
                                await expect(adapter.executeOwnServerNativeRestore(capture => { factories++; return forRecordedCapture(capture); }, {
                                    receipt, operationId: 'public-restore', destination,
                                    restoreBackupId: scenario === 'unknown' ? 'f'.repeat(64) : action.restoreBackupId!,
                                })).rejects.toMatchObject({ code: scenario === 'otherEnvironment' ? 'stale_input' : 'backup_required' });
                                expect(factories).toBe(0);
                            }
                            const admitted: DeploymentRestoreResolvedCaptureV1[] = [];
                            const beforeRestore = (await docker.readInvocations()).length;
                            const restored = await adapter.executeOwnServerNativeRestore(capture => {
                                admitted.push(capture); return forRecordedCapture(capture);
                            }, {
                                receipt: recoveryReceipt, operationId: 'public-restore', destination, restoreBackupId: action.restoreBackupId!,
                            });
                            expect(restored).toMatchObject({ kind: 'restored', verified: true,
                                source: recoveryReceipt.content.ownServer!.preMigrationBackup!.source, destination });
                            const recorded = recoveryReceipt.content.ownServer!.preMigrationBackup!;
                            expect(admitted).toEqual([{ source: recorded.source, sourceFormat: recorded.sourceFormat,
                                destination, configuration: recorded.configuration, repository: recorded.repository }]);
                            // P42 creates a unique private directory per credential group.
                            // Observe its actual file mounts across both native phases.
                            const credentialGroups = (await docker.readInvocations()).slice(beforeRestore)
                                .flatMap(call => call.args.filter(arg => arg.includes('target=/run/happier/backup/repository-password')));
                            expect(credentialGroups.length).toBeGreaterThan(0);
                            expect(new Set(credentialGroups).size).toBe(1);
                            return;
                        }
                        const prepared = recoveryReceipt ? await adapter.prepareOwnServerNativeRestore(forRecordedCapture,
                            { receipt: recoveryReceipt, restoreBackupId: 'd'.repeat(64), destination, operationId: `restore-${mode}` })
                            : await adapter.prepareOwnServerNativeRestore(input, { ...capture, operationId: `restore-${mode}`,
                            ...(mode === 'safety' ? { safetyBackup: { environmentId: source.environmentId, configuration,
                                data: { engine: 'postgres' as const, service: 'worker', logicalBackup: { adapter: 'postgres-v1' as const } } } } : {}) });
                        if (mode === 'safety') expect(prepared.safetyBackup).toMatchObject({ kind: 'verified',
                            manifests: [{ snapshot: { snapshotId: 'd'.repeat(64) }, producerChecksumSha256: sourceManifest.producerChecksumSha256 }] });
                        const preparedPassword = passwordPath;
                        if (!preparedPassword) throw new Error('Expected actual P42 password material');
                        await expect(access(preparedPassword)).rejects.toMatchObject({ code: 'ENOENT' });
                        // The standalone prepare phase retired its attachment.
                        // A separately admitted confirmation owns fresh P42 material.
                        restoreInput = forRecordedCapture({ source: prepared.source, sourceFormat: prepared.sourceFormat,
                            destination: prepared.destination, configuration, repository: prepared.repository });
                        let watcher: ReturnType<typeof watch> | undefined;
                        const stopped = mode === 'cancel' ? new Promise<void>((resolve, reject) => {
                            let issued = false;
                            watcher = watch(join(root, 'tools'), (_event, file) => {
                                if (String(file) !== 'restore-events.jsonl' || issued) return;
                                void (async () => {
                                    const events = await readFile(boundary.eventsFile, 'utf8');
                                    if (!events.includes('"kind":"rename"') || issued) return;
                                    issued = true;
                                    watcher?.close();
                                    expect(context.operation.signal?.aborted).toBe(false);
                                    if (!passwordPath) throw new Error('Expected retained backup material');
                                    await access(passwordPath);
                                    controller.abort();
                                    expect(pending).toBe(1);
                                    expect(context.operation.signal?.aborted).toBe(false);
                                    await access(passwordPath);
                                    await writeFile(join(root, 'tools', 'release-rename'), 'release');
                                    resolve();
                                })().catch(reject);
                            });
                        }) : Promise.resolve();
                        try {
                            const [result] = await Promise.all([
                                adapter.confirmOwnServerNativeRestore(restoreInput, { source: prepared.source, sourceFormat: prepared.sourceFormat,
                                    destination: prepared.destination, prepare: prepared }), stopped,
                            ]);
                            expect(result).toMatchObject(mode === 'failure'
                                ? { kind: 'recoveryRequired', verified: false, code: 'restore_failed',
                                    nativeFailure: { exitCode: 1, stderr: '', stderrTruncated: false } }
                                : mode === 'healthFailure' || mode === 'cancelPublication' ? { kind: 'rolledBack', verified: false, code: 'restore_failed' }
                                    : { kind: 'restored', verified: true });
                            if (mode === 'success') {
                                expect(progressPhases).toContain('restore.restore.running');
                                expect(progressPhases).toContain('restore.health.completed');
                                expect(result.steps).toContainEqual({ id: 'restore', status: 'completed' });
                            }
                            expect(pending).toBe(mode === 'cancel' || mode === 'cancelPublication' ? 1 : 0);
                            if (mode === 'cancel' || mode === 'cancelPublication') expect(context.operation.signal?.aborted).toBe(true);
                        } finally { watcher?.close(); }
                    });
                } catch (error) {
                    if (mode !== 'missingTool') throw error;
                    expect(error).toMatchObject({ code: 'unsupported_action' });
                } finally { await activation.dispose(); }
                if (!passwordPath) throw new Error('Expected an acquired backup environment');
                if (mode === 'dumpFailure') {
                    // Natural dump exit plus the exact restic helper's proven
                    // removal settles custody despite an invalid backup stream.
                    await expect(access(passwordPath)).rejects.toMatchObject({ code: 'ENOENT' });
                    await machineNativeEffectAdmission.run({ operation: { operationId: 'backup-reconcile', kind: 'backup' },
                        keys: render.keys, settleNative: project.settleNative }, async () => {});
                }
                await expect(access(passwordPath)).rejects.toMatchObject({ code: 'ENOENT' });
                const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
                if (mode !== 'repositoryOnly') {
                    const commands = events.filter(row => row.kind === 'postgres');
                    for (const command of commands) {
                        if (command.argv.includes('--version') || mode === 'success') expect(command.argv).not.toContain(`--username=${username}`);
                        else expect(command.argv).toContain(`--username=${username}`);
                    }
                }
                if (mode === 'repositoryOnly') {
                    expect(events.filter(row => row.kind === 'restic')).toHaveLength(1);
                    expect(events.some(row => row.kind === 'postgres' || row.kind === 'nativeControl')).toBe(false);
                    expect(JSON.parse(await readFile(boundary.stateFile, 'utf8')).safetySnapshot).toBeUndefined();
                } else if (mode === 'missingTool') expect(events.some(row => row.argv?.[0] === 'createdb')).toBe(false);
                else if (mode !== 'failure' && mode !== 'dumpFailure') {
                    expect(events.find(row => row.kind === 'imported')).toMatchObject({ bytes: archive.length });
                    expect(JSON.parse(await readFile(boundary.stateFile, 'utf8')).names)
                        .toEqual(mode === 'safety' ? [destination.recoveryDatabase, destination.database]
                            : [mode === 'healthFailure' || mode === 'cancelPublication' ? destination.stagingDatabase : destination.database]);
                    expect(events.some(row => row.argv?.[0] === 'pg_amcheck' && row.argv.includes('--install-missing')
                        && row.argv.at(-1) === "dbname='live\\\\db\\''")).toBe(true);
                }
                if (mode === 'healthFailure' || mode === 'cancelPublication') {
                    expect(stoppedServices).toEqual([['writer'], [], ['writer'], []]);
                    if (mode === 'cancelPublication') {
                        expect(observedReceipt.content.machineResults).toEqual(observed.content.machineResults);
                    }
                    expect(events.filter(row => row.kind === 'nativeControl').map(row => [row.operation, row.services]))
                        .toEqual([['stop', ['writer']], ['start', ['writer']], ['stop', ['writer']], ['start', ['writer']]]);
                    expect(events.filter(row => row.kind === 'rename').map(row => [row.from, row.to]))
                        .toEqual([[destination.stagingDatabase, destination.database], [destination.database, destination.stagingDatabase]]);
                }
                if (mode === 'safety' || mode === 'receiptCapture') {
                    expect(events.find(row => row.argv?.[0] === 'pg_dump' && !row.argv.includes('--version'))?.argv)
                        .toEqual(['pg_dump', `--username=${username}`, '-Fc', '--no-owner', '--no-acl', "dbname='live\\\\db\\''"]);
                    expect(events.find(row => row.kind === 'safetyBytes')).toMatchObject({ bytes: archive.length });
                }
                if (mode === 'receiptCapture') {
                    expect(events.filter(row => row.kind === 'restic').map(row => row.argv[row.argv.indexOf('--repo') + 1]))
                        .toEqual(expect.arrayContaining(['s3:https://fixture.invalid/backup']));
                    expect(events.some(row => row.kind === 'restic' && row.argv.includes('s3:https://fixture.invalid/changed-destination'))).toBe(false);
                }
                expect(await docker.readOperationContainerIds()).toEqual([]);
            }, { nativeExecutableIo: true, ...(mode === 'healthFailure' || mode === 'cancelPublication' ? { writerService: true } : {}) });
        }, 60_000);
});
