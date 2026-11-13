import { describe, expect, it, onTestFailed } from 'vitest';
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
import { RESTIC_RUNTIME_V1, buildResticRequestV1, runDeploymentBackupV1, type DeploymentBackupRunInputV1,
    type ResticAccessV1, type DeploymentRestoreResolvedCaptureV1 } from '@happier-dev/deployments';
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

import { archive, volumeTarFixture, database, sourceManifest, installRestoreBoundary } from './nativeRestore.testkit';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createOwnServerExpectedDownPublisher } from './expectedDown';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';
import { createDeploymentBackupActionForHost } from '@/deployments/actions/backups';
import { readOrCreateInstallationIdentitySync } from '@/daemon/identity/store';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';

describe('native restore adapter', () => {
    it('preserves ordinary receipt publication failures outside caller cancellation', async () => {
        const observed = createDeploymentReceiptDetailV1();
        const receipt: OwnServerDeploymentReceipt = { deployment: observed.deployment,
            content: DeploymentOwnServerContentV1Schema.parse(observed.content) };
        const failure = new Error('receipt storage unavailable');
        await expect(publishOwnServerDeploymentReceiptContentForHost(receipt, receipt.content,
            { signal: new AbortController().signal }, async () => { throw failure; })).rejects.toBe(failure);
    });

    it.each(['success', 'failure', 'cancel', 'missingTool', 'healthFailure', 'cancelPublication', 'safety', 'copySafety', 'copySafetyFailure', 'receiptCapture', 'publicRestore', 'publicRestoreUnknown', 'publicRestoreFailure', 'dumpFailure', 'repositoryOnly', 'volumeBackup', 'volumeBackupFailure', 'volumeRestore', 'volumeRestoreStopped', 'volumeRestoreFailure', 'volumeUpload', 'volumeRender', 'sqlUploadUnsafe', 'sqlUploadBinary', 'sqlUploadCustom', 'sqlUploadCustomChunks', 'sqliteBackup'] as const)(
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
                const copying = mode === 'copySafety' || mode === 'copySafetyFailure';
                const boundary = await installRestoreBoundary(root, mode === 'cancelPublication' ? 'healthFailure'
                    : mode === 'publicRestoreFailure' ? 'failure' : copying ? 'safety' : mode);
                if (mode === 'volumeRestoreFailure') onTestFailed(async () => {
                    const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').filter(Boolean)
                        .map(line => JSON.parse(line)).map(row => ({ kind: row.kind, operation: row.operation,
                            errorClass: row.errorClass, fixtureCode: row.fixtureCode }));
                    const invocations = (await docker.readInvocations()).map(row => ({
                        command: row.args.includes('compose') ? 'compose' : row.args[0],
                        operation: row.args.includes('compose') ? ['up', 'stop', 'start', 'ps', 'config'].find(value => row.args.includes(value)) : undefined,
                    }));
                    console.error('volume-recovery-boundary', JSON.stringify({ events, invocations: invocations.slice(-20) }));
                });
                if (mode === 'copySafetyFailure') {
                    const state = JSON.parse(await readFile(boundary.stateFile, 'utf8'));
                    await writeFile(boundary.stateFile, JSON.stringify({ ...state, mode: 'dumpFailure' }));
                }
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
                    purpose: 'variable', phase: 'runtime', name: 'LOGICAL_USER', source: mode === 'receiptCapture' || mode === 'dumpFailure'
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
                let destinationPasswordPath: string | undefined;
                let pending = 0;
                const progressPhases: string[] = [];
                const stoppedServices: string[][] = [];
                const expectedDownServices: string[][] = [];
                const observed = createDeploymentReceiptDetailV1();
                let observedReceipt: OwnServerDeploymentReceipt = { deployment: observed.deployment,
                    content: DeploymentOwnServerContentV1Schema.parse(observed.content) };
                const destination = { environmentId: copying ? 'copy-destination' : source.environmentId, revision: 1, adapter: 'postgres-v1' as const,
                    service: 'worker', database, stagingDatabase: 'restore-stage', recoveryDatabase: 'restore-old',
                    databaseExists: mode === 'safety' || copying, hasMeaningfulData: mode === 'safety' || copying,
                    writerServices: mode === 'healthFailure' || mode === 'cancelPublication' ? ['writer'] : [] };
                const operationStore = createActionOperationStore();
                const operationScope = { accountId: 'account', machineId: source.machineId };
                let publishExpectedDown: ((services: readonly string[]) => Promise<void>) | undefined;
                try {
                    const executeNative = async () => {
                    await machineNativeEffectAdmission.run({ operation: { operationId: `restore-${mode}`, kind: 'restore', signal: controller.signal },
                        keys: render.keys, settleNative: project.settleNative }, async context => {
                        const prepareEnvironment = () => backupEnvironment.createDeploymentBackupEnvironmentForHost({ repository: 's3:https://fixture.invalid/backup',
                            signal: context.operation.signal!, isCurrent: () => true, preparation: {
                                environmentId: source.environmentId, machineId: source.machineId, installationId: source.installationId,
                                installationPrivateSeed: seed, bindings, backupDestinationUses: bindings, grants,
                                backupConfigBaseDir: root, assertCurrent: source.assertCurrent } });
                        const environment = prepareEnvironment();
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
                            async onExpectedDownServicesChanged(services: readonly string[]) {
                                expectedDownServices.push([...services]);
                                await publishExpectedDown?.(services);
                                if (publishExpectedDown) {
                                    const snapshot = ActionOperationSnapshotV1Schema.parse(operationStore.get(operationScope, 'native-backup'));
                                    expect(snapshot.domainRef).toMatchObject(services.length
                                        ? { kind: 'deployment', expectedDown: { operation: 'backup',
                                            serviceIds: services.map(service => `instance/${service}`), domains: [] } }
                                        : { kind: 'deployment', environmentId: source.environmentId });
                                    if (!services.length) expect(snapshot.domainRef).not.toHaveProperty('expectedDown');
                                }
                                if ((mode === 'volumeBackup' || mode === 'volumeBackupFailure') && services.length) {
                                    const dockerState = JSON.parse(await readFile(`${root}/tools/docker-state.json`, 'utf8'));
                                    expect(dockerState.containers.find((row: { Config: { Labels: Record<string, string> } }) =>
                                        row.Config.Labels['com.docker.compose.service'] === 'worker').State.Status).toBe('running');
                                }
                            },
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
                        if (mode === 'volumeRender') {
                            const candidate = project.createVolumeRestoreCandidate([{ volume: 'data', physicalName: 'happier-volume-restore-stage' }]);
                            try { expect((await candidate.render()).namedVolumes).toEqual([{ volume: 'data', physicalName: 'happier-volume-restore-stage' }]); }
                            finally { await candidate.dispose(); }
                            return;
                        }
                        if (mode === 'sqliteBackup') {
                            const configuration: DeploymentBackupConfigurationV1 = { configRevision: 1,
                                destinationRef: { pluginId: 'example.storage', localId: 's3' }, occurrenceId: 'storage', config: { bucket: 'backup' },
                                credentialBindings: roles.map(role => ({ purpose: 'backupDestination', configKey: 'destination', role })),
                                sources: [{ kind: 'dump', sourceId: 'database', service: 'worker', consistency: 'logical' }],
                                ownership: { environmentId: source.environmentId, prefix: source.environmentId }, retention: { kind: 'keepEverything' } };
                            const backup = await Reflect.apply(adapter.withOwnServerNativeBackup, undefined, [input,
                                [{ environmentId: source.environmentId, service: 'worker', adapter: 'sqlite-v1', path: '/data/database.sqlite' }],
                                (native: Readonly<{ access: ResticAccessV1; signal: AbortSignal; executeBackup: DeploymentBackupRunInputV1['execute'] }>) =>
                                    Reflect.apply(runDeploymentBackupV1, undefined, [{ environmentId: source.environmentId, configuration,
                                        data: [{ engine: 'sqlite', service: 'worker', logicalBackup: { adapter: 'sqlite-v1', path: '/data/database.sqlite' } }],
                                        access: native.access, signal: native.signal, execute: native.executeBackup }])]);
                            expect(backup).toMatchObject({ kind: 'verified', manifests: [{ kind: 'dump',
                                snapshot: { paths: ['/worker.sqlite'] }, producerChecksumSha256: expect.any(String) }] });
                            const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
                            expect(events.some(row => row.kind === 'sqlite' && row.operation === 'vacuum')).toBe(true);
                            expect(events.some(row => row.kind === 'nativeControl' && row.operation === 'stop')).toBe(false);
                            return;
                        }
                        if (mode === 'sqlUploadUnsafe' || mode === 'sqlUploadBinary' || mode === 'sqlUploadCustom' || mode === 'sqlUploadCustomChunks') {
                            const custom = mode === 'sqlUploadCustom' || mode === 'sqlUploadCustomChunks';
                            const bytes = custom ? archive : mode === 'sqlUploadBinary' ? Buffer.from('SQLite format 3\0\0\0\0\0')
                                : Buffer.from('SELECT 1;\n\\! touch /tmp/happier-import-must-not-execute\n');
                            const { execEnv: _execEnv, readAccess: _readAccess, ...common } = input;
                            const upload = { kind: 'upload' as const, transferId: 'completed-sql-upload', filePath: join(root, 'private-upload.sql'),
                                sizeBytes: bytes.length, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'),
                                readChunk: async ({ offset, length }: { offset: number; length: number }) =>
                                    bytes.subarray(offset, offset + (mode === 'sqlUploadCustomChunks' ? Math.min(length, 2) : length)) };
                            const preparation = adapter.prepareOwnServerNativeRestore({ ...common, upload }, {
                                operationId: 'unsafe-sql-prepare', source: { kind: 'upload', transferId: upload.transferId,
                                    sizeBytes: upload.sizeBytes, sha256: upload.sha256 }, sourceFormat: 'postgresSql', destination,
                            });
                            if (custom) await expect(preparation).resolves.toMatchObject({ kind: 'prepared', sourceFormat: 'postgresCustom' });
                            else await expect(preparation).rejects.toMatchObject({ code: 'unsupported_action' });
                            const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
                            expect(events.some(row => row.kind === 'nativeControl' || row.kind === 'imported'
                                || row.argv?.[0] === 'createdb' && !row.argv.includes('--version')),
                                JSON.stringify(events.map(row => ({ kind: row.kind, operation: row.operation,
                                    services: row.services, command: row.argv?.[0] })))).toBe(false);
                            if (custom) expect(events.some(row => row.argv?.[0] === 'pg_restore' && row.argv.includes('--list'))).toBe(true);
                            return;
                        }
                        if (mode === 'volumeRestore' || mode === 'volumeRestoreStopped' || mode === 'volumeRestoreFailure' || mode === 'volumeUpload') {
                            const volumeSnapshot = { ...sourceManifest, sourceId: 'data', kind: 'volume' as const, producerChecksumSha256: undefined,
                                snapshot: { ...sourceManifest.snapshot, paths: ['/happier/source'],
                                    tags: ['happier', `env:${source.environmentId}`, 'kind:volume', 'src:data'] } };
                            const state = JSON.parse(await readFile(boundary.stateFile, 'utf8'));
                            await writeFile(boundary.stateFile, JSON.stringify({ ...state,
                                snapshot: { ...state.snapshot, paths: volumeSnapshot.snapshot.paths, tags: volumeSnapshot.snapshot.tags } }));
                            if (mode === 'volumeRestoreStopped') {
                                const dockerState = JSON.parse(await readFile(`${root}/tools/docker-state.json`, 'utf8'));
                                dockerState.containers.find((row: { Config: { Labels: Record<string, string> } }) =>
                                    row.Config.Labels['com.docker.compose.service'] === 'writer').State.Status = 'exited';
                                await writeFile(`${root}/tools/docker-state.json`, JSON.stringify(dockerState));
                            }
                            const capture = { operationId: 'volume-restore-prepare', source: volumeSnapshot, sourceFormat: 'volume',
                                destination: { environmentId: source.environmentId, revision: 1, adapter: 'volume-v1',
                                    service: 'worker', volume: 'data', currentVolume: 'fixture-physical-data',
                                    stagingVolume: 'happier-volume-restore-stage', hasMeaningfulData: false,
                                    writerServices: ['worker'], runningServices: ['worker'] } };
                            let nativeInput: adapter.OwnServerNativeRestoreInput | adapter.OwnServerNativeUploadRestoreInput = input;
                            let admittedCapture: unknown = capture;
                            if (mode === 'volumeUpload') {
                                const bytes = volumeTarFixture;
                                const filePath = join(root, 'uploaded.tar');
                                await writeFile(filePath, bytes);
                                const upload = { kind: 'upload' as const, transferId: 'completed-volume-upload', filePath,
                                    sizeBytes: bytes.length, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'),
                                    readChunk: async ({ offset, length }: { offset: number; length: number }) => bytes.subarray(offset, offset + length) };
                                const { execEnv: _execEnv, readAccess: _readAccess, ...common } = input;
                                nativeInput = { ...common, upload };
                                admittedCapture = { ...capture, sourceFormat: 'volumeTar',
                                    source: { kind: 'upload', transferId: upload.transferId, sizeBytes: upload.sizeBytes, sha256: upload.sha256 } };
                            }
                            const prepared = await Reflect.apply(adapter.prepareOwnServerNativeRestore, undefined, [nativeInput, admittedCapture]);
                            // Confirmation is a fresh host admission. The first phase's
                            // retained P42 attachment has already been disposed.
                            if (!('upload' in nativeInput)) {
                                const confirmationEnvironment = prepareEnvironment();
                                nativeInput = { ...nativeInput, ...confirmationEnvironment, readAccess() {
                                    const access = confirmationEnvironment.readAccess();
                                    passwordPath = access.credentialFiles[0]?.hostPath;
                                    return access;
                                } };
                            }
                            const restored = await Reflect.apply(adapter.confirmOwnServerNativeRestore, undefined, [nativeInput,
                                { ...prepared, prepare: prepared }]);
                            const nativeOperations = (await docker.readInvocations()).slice(-8).map(row => row.args.slice(0, 3));
                            expect(restored, JSON.stringify({ restored, nativeOperations, nativeFailures: await docker.readFailures() }))
                                .toMatchObject(mode === 'volumeRestoreFailure'
                                    ? { kind: 'rolledBack', verified: false, nextAction: 'checkServiceHealth' }
                                    : { kind: 'restored', verified: true });
                            const stateAfter = JSON.parse(await readFile(`${root}/tools/docker-state.json`, 'utf8'));
                            expect(stateAfter.containers.filter((row: { State: { Status: string }; Config: { Labels: Record<string, string> } }) =>
                                row.State.Status === 'running' && row.Config.Labels['com.docker.compose.service'] === 'worker'))
                                .toEqual([expect.objectContaining({ Mounts: [expect.objectContaining({ Name: mode === 'volumeRestoreFailure'
                                    ? capture.destination.currentVolume : capture.destination.stagingVolume })] })]);
                            if (mode === 'volumeRestoreStopped') expect(stateAfter.containers.filter((row: { Config: { Labels: Record<string, string> } }) =>
                                row.Config.Labels['com.docker.compose.service'] === 'writer')).toEqual([
                                expect.objectContaining({ State: expect.objectContaining({ Status: 'created' }) })]);
                            const requests = (await docker.readInvocations()).filter(row => row.args[0] === 'create' && row.args.includes('restore'));
                            if (mode === 'volumeUpload') {
                                expect(await readFile(join(root, 'tools', 'volume-happier-volume-restore-stage', 'restored.txt'), 'utf8')).toBe('restored\n');
                                const tarRequests = (await docker.readInvocations()).filter(row => row.args[0] === 'create' && row.args.includes('/bin/tar'));
                                expect(tarRequests).toHaveLength(2);
                                const extraction = tarRequests.find(row => row.args.includes('-xf'));
                                expect(extraction?.args).toContain('type=volume,source=happier-volume-restore-stage,target=/happier/staging,volume-nocopy');
                                expect(extraction?.args).toContain('--read-only');
                                expect(extraction?.args).toContain('none');
                                expect(tarRequests.some(row => row.args.includes('--repo') || row.args.includes('RESTIC_PASSWORD_FILE'))).toBe(false);
                            } else {
                                expect(requests).toHaveLength(1);
                                expect(requests[0]?.args).toContain('--verify');
                                expect(requests[0]?.args).toContain('type=volume,source=happier-volume-restore-stage,target=/happier/staging,volume-nocopy');
                            }
                            return;
                        }
                        if (mode === 'volumeBackup' || mode === 'volumeBackupFailure') {
                            const result = await adapter.withOwnServerNativeBackup(input, undefined, native =>
                                native.executeBackup(buildResticRequestV1({ access: native.access,
                                    environmentId: source.environmentId, command: { kind: 'backupPaths', sourceId: 'uploads', paths: ['/happier/source'] } }),
                                { kind: 'volume', sourceId: 'uploads', service: 'worker', volume: 'data', consistency: 'stopDuringCopy' }));
                            expect(result).toMatchObject({ kind: 'completed', exitCode: mode === 'volumeBackupFailure' ? 7 : 0 });
                            expect(expectedDownServices).toEqual([['worker'], []]);
                            const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
                            expect(events.filter(row => row.kind === 'nativeControl').map(row => [row.operation, row.services]))
                                .toEqual([['stop', ['worker']], ['start', ['worker']]]);
                            expect(events.some(row => row.kind === 'postgres')).toBe(false);
                            const create = (await docker.readInvocations()).find(row => row.args[0] === 'create' && row.args.includes('backup'));
                            expect(create?.args).toContain('type=volume,source=fixture-physical-data,target=/happier/source,readonly,volume-nocopy');
                            return;
                        }
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
                        if (copying) {
                            const observed = await adapter.observeOwnServerNativeRestoreDestination(input, {
                                operationId: `restore-${mode}`, environmentId: destination.environmentId, revision: 1, target: destination });
                            expect(observed).toMatchObject({ databaseExists: true, hasMeaningfulData: true });
                            const destinationBindings = bindings.map(binding => ({ ...binding,
                                source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(`destination-${binding.role}`), resourceRevision: 1 } }));
                            const destinationGrants = roles.map(role => sealMachineSecretGrant({ subject: { v: 1, kind: 'secret',
                                environmentId: destination.environmentId, machineId: source.machineId, installationId: source.installationId,
                                resourceId: `destination-${role}`, resourceRevision: 1 }, installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey,
                                content: { kind: 'secret', value: `destination-private-${role}` } }));
                            const destinationEnvironment = backupEnvironment.createDeploymentBackupEnvironmentForHost({
                                repository: 's3:https://fixture.invalid/destination-backup', signal: context.operation.signal!, isCurrent: () => true,
                                preparation: { environmentId: destination.environmentId, machineId: source.machineId, installationId: source.installationId,
                                    installationPrivateSeed: seed, bindings: destinationBindings, backupDestinationUses: destinationBindings,
                                    grants: destinationGrants, backupConfigBaseDir: root, assertCurrent: source.assertCurrent } });
                            const destinationUsernameBinding = { purpose: 'variable' as const, phase: 'runtime' as const,
                                name: 'LOGICAL_USER', source: { kind: 'value' as const, value: 'destination-database-user' } };
                            const destinationUsernameGrant = sealMachineSecretGrant({ subject: { v: 1, kind: 'environmentValues',
                                environmentId: destination.environmentId, machineId: source.machineId, installationId: source.installationId,
                                binding: { purpose: 'variable', phase: 'runtime', name: destinationUsernameBinding.name } },
                                installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey,
                                content: { kind: 'environmentValues', definition: destinationUsernameBinding.source } });
                            const destinationInput = { ...input, ...destinationEnvironment,
                                readAccess() {
                                    const selected = destinationEnvironment.readAccess();
                                    destinationPasswordPath = selected.credentialFiles[0]?.hostPath;
                                    return selected;
                                },
                                readDatabaseUsername: createOwnServerDatabaseUsernameReaderForHost({
                                    data: [{ engine: 'postgres', service: 'worker', logicalBackup: {
                                        adapter: 'postgres-v1', username: destinationUsernameBinding.name } }],
                                    preparation: { environmentId: destination.environmentId, machineId: source.machineId,
                                        installationId: source.installationId, installationPrivateSeed: seed,
                                        bindings: [destinationUsernameBinding], grants: [destinationUsernameGrant], assertCurrent: source.assertCurrent } }) };
                            const prepare = adapter.prepareOwnServerNativeRestore(input, { ...capture, operationId: `restore-${mode}`,
                                safetyBackup: { environmentId: destination.environmentId,
                                    configuration: { ...configuration, ownership: { environmentId: destination.environmentId, prefix: destination.environmentId } },
                                    data: [{ engine: 'postgres', service: 'worker', logicalBackup: { adapter: 'postgres-v1' } }] } }, destinationInput);
                            if (mode === 'copySafetyFailure') await expect(prepare).rejects.toMatchObject({ code: 'backup_failed' });
                            else {
                                const prepared = await prepare;
                                expect(prepared.repository?.repository).toBe('s3:https://fixture.invalid/backup');
                                expect(prepared.safetyBackup).toMatchObject({ kind: 'verified', manifests: [{ environmentId: destination.environmentId }] });
                            }
                            const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
                            const sourceCommands = events.filter(row => row.kind === 'restic' && row.argv[row.argv.indexOf('--repo') + 1] === 's3:https://fixture.invalid/backup');
                            expect(sourceCommands.length).toBeGreaterThan(0);
                            expect(sourceCommands.every(row => !row.argv.includes('backup') && !row.argv.includes('init')
                                && !row.argv.includes('forget') && !row.argv.includes('prune'))).toBe(true);
                            expect(events.find(row => row.kind === 'restic' && row.argv.includes('backup'))?.argv)
                                .toContain('s3:https://fixture.invalid/destination-backup');
                            expect(events.find(row => row.kind === 'postgres' && row.argv[0] === 'pg_dump' && !row.argv.includes('--version'))?.argv)
                                .toContain('--username=destination-database-user');
                            expect(events.some(row => row.kind === 'imported' || row.kind === 'rename'
                                || row.kind === 'postgres' && row.argv[0] === 'createdb' && !row.argv.includes('--version'))).toBe(false);
                            expect(JSON.parse(await readFile(boundary.stateFile, 'utf8')).names).toEqual([database]);
                            return;
                        }
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
                        if (mode === 'receiptCapture' || mode === 'publicRestore' || mode === 'publicRestoreUnknown' || mode === 'publicRestoreFailure' || mode === 'dumpFailure') {
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
                                    data: [{ engine: 'postgres', service: 'worker', logicalBackup: { adapter: 'postgres-v1' } }] },
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
                                const identity = readOrCreateInstallationIdentitySync();
                                const executor = createActionExecutor({
                                    deploymentBackupAction: createDeploymentBackupActionForHost({ serverId: 'home', machineId: source.machineId,
                                        async assertCurrent(context) { context.signal?.throwIfAborted(); },
                                        // The genuine native backup rejection crosses the host port unchanged.
                                        async backup() { await backup; throw new Error('Expected the native dump to fail'); },
                                    }),
                                    resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(
                                        async () => { throw new Error('Unexpected full Environment read'); },
                                        async ({ environmentId }) => ({ ok: true, environment: {
                                            id: environmentId, projectSourceId: 'source', purpose: 'standard',
                                        } })),
                                });
                                const result = await executor.execute('deployments.backups.run', { serverId: 'home',
                                    environmentId: source.environmentId, machineId: source.machineId,
                                    installationId: identity.installationId, targetLinkId: receipt.deployment.targetLinkId,
                                    deploymentId: receipt.deployment.id, expectedRevision: receipt.deployment.revision, configRevision: 1,
                                }, { surface: 'cli', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account',
                                    bypassApprovals: true, actionRequestId: 'native-dump-failure',
                                    operationAcceptance: { actionId: 'deployments.backups.run', operationId: 'native-dump-failure', accept() {} } });
                                expect(result).toMatchObject({ ok: false, errorCode: 'backup_failed',
                                    details: { nativeFailure: { exitCode: 7, stderr: expect.stringContaining('pg_dump: connection for user'),
                                        stderrTruncated: false } } });
                                expect(JSON.stringify(result)).not.toContain(username);
                                expect(JSON.stringify(result)).not.toContain(JSON.stringify(username).slice(1, -1));
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
                        if (mode === 'publicRestore' || mode === 'publicRestoreUnknown' || mode === 'publicRestoreFailure') {
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
                            if (mode === 'publicRestoreUnknown') {
                                // The destination changed after admission. Preserve the restore owner's
                                // uncertainty rather than reclassifying it as terminal failure.
                                await boundary.setDatabaseNameObservations([[database, destination.stagingDatabase]]);
                                await expect(adapter.executeOwnServerNativeRestore(forRecordedCapture, {
                                    receipt: recoveryReceipt, operationId: 'public-restore-unknown', destination,
                                    restoreBackupId: action.restoreBackupId!,
                                })).rejects.toMatchObject({ code: 'outcome_unknown', details: { kind: 'outcome_unknown' } });
                                return;
                            }
                            if (mode === 'publicRestoreFailure') {
                                const failure = await adapter.executeOwnServerNativeRestore(forRecordedCapture, {
                                    receipt: recoveryReceipt, operationId: 'public-restore-failure', destination,
                                    restoreBackupId: action.restoreBackupId!,
                                }).then(() => { throw new Error('Expected native integrity failure'); }, error => {
                                    expect(error).toMatchObject({ code: 'restore_failed', details: {
                                        kind: 'recoveryRequired', nativeFailure: { exitCode: 1, stderr: '', stderrTruncated: false },
                                    } });
                                    return projectDeploymentFailure('restore_failed', error);
                                });
                                expect(failure).toMatchObject({ ok: false, errorCode: 'restore_failed', details: {
                                    nativeFailure: { exitCode: 1, stderr: '', stderrTruncated: false },
                                } });
                                return;
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
                                data: [{ engine: 'postgres' as const, service: 'worker', logicalBackup: { adapter: 'postgres-v1' as const } }] } } : {}) });
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
                    };
                    if (mode === 'volumeBackup' || mode === 'volumeBackupFailure') {
                        const spec = getActionSpec('deployments.backups.run');
                        const runner = createActionOperationRunner({ store: operationStore, generateOperationId: () => 'native-backup',
                            resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
                        const observed = await runner.observe({ actionId: spec.id, scope: operationScope, input: {},
                            execute: async ({ publishOwnerUpdate }) => {
                                publishExpectedDown = createOwnServerExpectedDownPublisher({ serverId: 'home',
                                    environmentId: source.environmentId, targetLinkId: 'link', deploymentId: 'deployment',
                                    machineId: source.machineId, installationId: source.installationId,
                                    environmentInstanceId: 'instance', operation: 'backup',
                                    context: { operationOwnerUpdate: { update: publishOwnerUpdate } }, readDomains: async () => [] });
                                await executeNative();
                                return { ok: true, result: {} };
                            } });
                        expect(observed).toMatchObject({ ok: true });
                    } else await executeNative();
                } catch (error) {
                    if (mode !== 'missingTool') throw error;
                    expect(error).toMatchObject({ code: 'unsupported_action' });
                } finally { await activation.dispose(); }
                if (mode === 'volumeUpload' || mode === 'volumeRender' || mode === 'sqlUploadUnsafe' || mode === 'sqlUploadBinary' || mode === 'sqlUploadCustom' || mode === 'sqlUploadCustomChunks') { expect(passwordPath).toBeUndefined(); return; }
                if (!passwordPath) throw new Error('Expected an acquired backup environment');
                if (mode === 'dumpFailure') {
                    // Natural dump exit plus the exact restic helper's proven
                    // removal settles custody despite an invalid backup stream.
                    await expect(access(passwordPath)).rejects.toMatchObject({ code: 'ENOENT' });
                    await machineNativeEffectAdmission.run({ operation: { operationId: 'backup-reconcile', kind: 'backup' },
                        keys: render.keys, settleNative: project.settleNative }, async () => {});
                }
                await expect(access(passwordPath)).rejects.toMatchObject({ code: 'ENOENT' });
                if (copying) {
                    if (!destinationPasswordPath) throw new Error('Expected destination-owned backup credentials');
                    await expect(access(destinationPasswordPath)).rejects.toMatchObject({ code: 'ENOENT' });
                    expect(await docker.readOperationContainerIds()).toEqual([]);
                    return;
                }
                const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
                if (mode !== 'repositoryOnly') {
                    const commands = events.filter(row => row.kind === 'postgres');
                    for (const command of commands) {
                        if (command.argv.includes('--version') || command.argv.includes('--username=restore-stage') || mode === 'success') expect(command.argv).not.toContain(`--username=${username}`);
                        else expect(command.argv).toContain(`--username=${username}`);
                    }
                }
                if (mode === 'sqliteBackup' || mode === 'volumeBackup' || mode === 'volumeBackupFailure' || mode === 'volumeRestore' || mode === 'volumeRestoreStopped' || mode === 'volumeRestoreFailure') {
                    expect(await docker.readOperationContainerIds()).toEqual([]);
                    expect(events.some(row => row.kind === 'imported')).toBe(false);
                    return;
                }
                if (mode === 'repositoryOnly') {
                    expect(events.filter(row => row.kind === 'restic')).toHaveLength(1);
                    expect(events.some(row => row.kind === 'postgres' || row.kind === 'nativeControl')).toBe(false);
                    expect(JSON.parse(await readFile(boundary.stateFile, 'utf8')).safetySnapshot).toBeUndefined();
                } else if (mode === 'missingTool') expect(events.some(row => row.argv?.[0] === 'createdb')).toBe(false);
                else if (mode === 'publicRestoreUnknown') expect(events.some(row => row.kind === 'imported')).toBe(false);
                else if (mode !== 'failure' && mode !== 'publicRestoreFailure' && mode !== 'dumpFailure') {
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
            }, { nativeExecutableIo: true, ...(mode === 'volumeBackup' || mode === 'volumeBackupFailure' || mode === 'volumeRestore' || mode === 'volumeRestoreStopped' || mode === 'volumeRestoreFailure' || mode === 'volumeUpload' || mode === 'volumeRender' || mode === 'sqliteBackup' ? { namedVolume: true } : {}),
                ...(mode === 'sqliteBackup' ? { sqliteRuntime: true } : {}),
                ...(mode === 'healthFailure' || mode === 'cancelPublication' || mode === 'volumeRestoreStopped' ? { writerService: true } : {}) });
        }, 60_000);
});
