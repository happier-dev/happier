import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import type { DeploymentImageV1, DeploymentBackupConfigurationV1 } from '@happier-dev/deployments/contracts/v1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { runDeploymentBackupV1 } from '@happier-dev/deployments';
import { createDeploymentSourceMaterializationPort } from './exactCommitRelease';
import { createDeploymentExecEnvPortForHost, prepareDeploymentBackupEnvironmentForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { createStablePluginExecService, readPluginExecProcessCustodyForHost } from '@/plugins/runtime/invocation/services/exec';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createNativeComposeLifecycle } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import * as adapter from './nativeRestore';

const artifactDirectory = process.env.HAPPIER_SQLITE_TEST_ARTIFACT_DIR;
// Vitest deliberately isolates HOME. The real Docker boundary needs its OS
// user's installed plugins/context, while all Happier state stays test-owned.
const nativeEnvironment = { ...Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)), HOME: userInfo().homedir };

// This is the builder's private artifact envelope, not a product input. Image
// descriptors and archive bytes still cross the canonical native verifier.
type Artifact = Readonly<{ indexDigest: string; sqliteVersion: string; ociArchive: string;
    ociArchiveSha256: string; ociArchiveSizeBytes: number; variants: readonly DeploymentImageV1[] }>;

function docker(args: readonly string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        execFile('docker', [...args], { encoding: 'buffer', env: nativeEnvironment }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
}

describe.skipIf(!artifactDirectory)('native SQLite on the retained original OCI', () => {
    it('preserves committed WAL and sibling data through backup, staged import and recovery', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-native-sqlite-'));
        const controller = new AbortController();
        const incumbent = tryAcquireAuthoritativePluginRuntimeRegistryLease();
        let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        let cleanupNative: (() => Promise<void>) | undefined;
        let writer: ReturnType<typeof spawn> | undefined;
        let physicalProjectName: string | undefined;
        let resticReference: string | undefined;
        const volume = `happier-sqlite-test-${randomUUID()}`;
        const repositoryOperation = randomUUID(), uploadOperation = randomUUID(), recoveryOperation = randomUUID();
        const operationIds = new Set([repositoryOperation, uploadOperation, recoveryOperation]);
        try {
            if (!incumbent) admitted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: root,
                controller: pluginReloadController, runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
            const metadata = JSON.parse(await readFile(join(artifactDirectory!, 'native-acquisition-identity.json'), 'utf8')) as Artifact;
            const variant = metadata.variants.find(image => image.platform === 'linux/amd64');
            if (!variant) throw new Error('The retained original OCI has no amd64 descriptor');
            const image = { ...variant, service: 'worker' };
            const helperImage = { ...variant, service: 'sqlite' };
            const document = JSON.stringify({ services: { worker: { image: metadata.indexDigest,
                stdin_open: true, tty: true, command: ['/data/database.sqlite'],
                volumes: [{ type: 'volume', source: 'data', target: '/data' }] } }, volumes: { data: { name: volume } } });
            const source = await createDeploymentSourceMaterializationPort({ async admit() {
                return { environmentId: 'native-sqlite-environment', environmentInstanceId: `sqlite-${randomUUID()}`,
                    deploymentId: 'native-sqlite-generation', machineId: 'native-sqlite-machine', installationId: 'native-sqlite-installation',
                    deploymentRoot: join(root, 'deployments'), artifactDirectory: join(root, 'source-artifacts'),
                    definition: { kind: 'stored' as const, contentRevision: 1, document, profiles: [], services: ['worker'],
                        composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}` }, async assertCurrent() {} };
            } }).materialize({ environmentId: 'native-sqlite-environment', deploymentId: 'native-sqlite-generation' });
            // Native Docker plugins/context belong to the admitted host profile.
            // Test artifact/source custody is isolated independently below.
            const environment = nativeEnvironment;
            const exec = createStablePluginExecService({ environment, signal: controller.signal, isOccurrenceCurrent: () => true,
                systemTools: createPluginExecSystemToolResolver({ baseEnv: environment,
                    definitions: [{ toolId: 'docker', displayName: 'Docker', lookupNames: ['docker'] }], registerGrant() {} }),
                async resolveExecutable() { throw new Error('The native tool owner resolves Docker'); }, resolvePath: async path => String(path) });
            const seed = new Uint8Array(32).fill(67);
            const environmentPort = (phase: 'build' | 'runtime') => createDeploymentExecEnvPortForHost({ source, phase, signal: controller.signal,
                isCurrent: () => true, prepare: ({ phase }: { phase: 'build' | 'runtime' }) => prepareEnvironmentSecretBindingsForLaunch({
                    environmentId: source.environmentId, machineId: source.machineId, installationId: source.installationId,
                    installationPrivateSeed: seed, phase, bindings: [], grants: [], assertCurrent: source.assertCurrent }) });
            const envPort = environmentPort('runtime');
            let failNextResume = false;
            const io: ProjectNativeToolchainIo = { async resolveTool() { return null; }, run(request) {
                return new Promise((resolve, reject) => {
                    const child = execFile(request.command, [...request.args], { cwd: request.cwd, env: request.env,
                        encoding: 'utf8', ...(request.signal ? { signal: request.signal } : {}) }, async (error, stdout, stderr) => {
                        if (error && typeof error.code !== 'number') { reject(error); return; }
                        // A real external service crash after resume exercises the
                        // existing recovery owner; no domain lifecycle is mocked.
                        if (failNextResume && request.args.includes('compose') && request.args.includes('start')) {
                            failNextResume = false;
                            try { await docker(['compose', '--project-directory', source.rootPath, '-f', join(source.rootPath, 'compose.yaml'),
                                '--project-name', physicalProjectName!, 'stop', 'worker']); }
                            catch (failure) { reject(failure); return; }
                        }
                        resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
                    });
                    child.stdin?.end(request.stdin);
                });
            } };
            const archive = (selected: DeploymentImageV1) => ({ image: selected, sizeBytes: metadata.ociArchiveSizeBytes,
                sha256: metadata.ociArchiveSha256, async acquire() {
                    const path = join(root, `${randomUUID()}.oci.tar`);
                    await copyFile(metadata.ociArchive, path);
                    return { path, sizeBytes: metadata.ociArchiveSizeBytes, sha256: metadata.ociArchiveSha256 };
                } });
            const project = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source, sourceKind: 'stored',
                files: ['compose.yaml'], services: ['worker'], images: [image],
                imageAcquisition: { operation: 'rollback', publicRegistryEnvPort: environmentPort('build'), archives: [archive(image), archive(helperImage)] },
                ...{ sqliteRuntime: { image: helperImage, version: metadata.sqliteVersion } }, io,
                settleNative: readPluginExecProcessCustodyForHost(exec).waitForSettlement });
            cleanupNative = async () => {
                try {
                    if (physicalProjectName) await docker(['compose', '--project-directory', source.rootPath,
                        '-f', join(source.rootPath, 'compose.yaml'), '--project-name', physicalProjectName, 'down']);
                } finally { await project.dispose(); await readPluginExecProcessCustodyForHost(exec).requestStop(); }
            };
            const render = await project.render();
            physicalProjectName = render.projectName;
            const activation = await machineNativeEffectAdmission.run({ operation: { operationId: 'sqlite-seed', kind: 'deploy' },
                keys: render.keys, settleNative: project.settleNative }, context => project.activate({ render, context }));
            await source.commit();
            const mount = `type=volume,source=${volume},target=/data`;
            const sqlite = async (path: string, sql: string) => (await docker(['run', '--rm', '--mount', mount,
                metadata.indexDigest, '-batch', '-bail', path, sql])).toString('utf8').trim();
            await sqlite('/data/database.sqlite', "PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT); INSERT INTO records VALUES('baseline');");
            await sqlite('/data/sibling.sqlite', "CREATE TABLE records(value TEXT); INSERT INTO records VALUES('sibling');");
            writer = spawn('docker', ['run', '--rm', '-i', '--mount', mount, metadata.indexDigest,
                '-batch', '-bail', '/data/database.sqlite'], { stdio: ['pipe', 'ignore', 'pipe'], env: nativeEnvironment });
            const ready = new Promise<void>((resolve, reject) => {
                let stderr = '';
                writer!.stderr!.on('data', (bytes: Buffer) => { stderr += bytes.toString('utf8'); if (stderr.includes('SQLITE_WAL_READY')) resolve(); });
                writer!.once('error', reject);
                writer!.once('exit', code => reject(new Error(`The WAL fixture exited before readiness (${code})`)));
            });
            writer.stdin!.write("PRAGMA wal_autocheckpoint=0; INSERT INTO records VALUES('committed-wal');\n.output /dev/stderr\n.print SQLITE_WAL_READY\n.output stdout\n");
            await ready;
            const repository = join(root, 'repository');
            await mkdir(repository);
            const binding = { purpose: 'backupDestination' as const, configKey: 'destination', role: 'repositoryPassword',
                source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('native-sqlite-repository'), resourceRevision: 1 } };
            const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: source.environmentId,
                machineId: source.machineId, installationId: source.installationId, resourceId: 'native-sqlite-repository', resourceRevision: 1 },
                installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey, content: { kind: 'secret', value: randomUUID() } });
            const configuration: DeploymentBackupConfigurationV1 = { configRevision: 1,
                destinationRef: { pluginId: 'fixture.storage', localId: 'local' }, occurrenceId: 'sqlite-storage', config: {},
                credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
                sources: [{ kind: 'dump', sourceId: 'sqlite-source', service: 'worker', consistency: 'logical' }],
                ownership: { environmentId: source.environmentId, prefix: source.environmentId }, retention: { kind: 'keepEverything' } };
            const target = { service: 'worker', adapter: 'sqlite-v1' as const, path: '/data/database.sqlite' };
            const data = [{ engine: 'postgres' as const, service: 'unused' }, { engine: 'sqlite' as const, service: 'worker',
                logicalBackup: { adapter: 'sqlite-v1' as const, path: target.path } }];
            const withInput = <T>(phase: string, effect: (input: adapter.OwnServerNativeRestoreInput) => Promise<T>) => {
                const operationId = `${phase}-${randomUUID()}`; operationIds.add(operationId);
                return machineNativeEffectAdmission.run({ operation: { operationId, kind: 'backup', signal: controller.signal },
                    keys: render.keys, settleNative: project.settleNative }, async context => {
                const backup = await prepareDeploymentBackupEnvironmentForHost({ repository, local: { path: repository }, databaseBindings: [],
                    signal: context.operation.signal!, isCurrent: () => true, preparation: { environmentId: source.environmentId,
                        machineId: source.machineId, installationId: source.installationId, installationPrivateSeed: seed,
                        bindings: [binding], backupDestinationUses: [binding], grants: [grant], backupConfigBaseDir: root, assertCurrent: source.assertCurrent } });
                try {
                    const runtimeImage = await project.prepareResticRuntime({ render, context });
                    resticReference = runtimeImage.registryReference;
                    const input = { project, render, activation, context, io, ...backup, runtimeImage,
                        retainSource: () => source.commit(),
                        async readDatabaseUsername() { return undefined; }, onStopPending() {} };
                    return await effect(input);
                } finally { await backup.dispose(); }
            }); };
            const result = await withInput('sqlite-native-backup', input => adapter.withOwnServerNativeBackup(input, [target],
                native => runDeploymentBackupV1({ environmentId: source.environmentId, configuration, data, restoreTargets: [target],
                    access: native.access, signal: native.signal, execute: native.executeBackup })));
                    expect(result).toMatchObject({ kind: 'verified', restoreCaptures: [{ sourceFormat: 'sqlite', target }] });
                    expect(writer!.exitCode).toBeNull();
                    expect((await docker(['inspect', '--format', '{{.State.Running}}', ...activation.nativeIdsForService('worker')]))
                        .toString('utf8').trim()).toBe('true');
                    const nextCommit = new Promise<void>((resolve, reject) => {
                        let stderr = '';
                        const onData = (bytes: Buffer) => {
                            stderr += bytes.toString('utf8');
                            if (stderr.includes('SQLITE_AFTER_BACKUP_READY')) { writer!.stderr!.off('data', onData); resolve(); }
                        };
                        writer!.stderr!.on('data', onData);
                        writer!.once('error', reject);
                    });
                    writer!.stdin!.write("INSERT INTO records VALUES('after-vacuum');\n.output /dev/stderr\n.print SQLITE_AFTER_BACKUP_READY\n.output stdout\n");
                    await nextCommit;
                    writer!.stdin!.end();
                    await once(writer!, 'exit');
                    writer = undefined;
                    expect(await sqlite('/data/database.sqlite', 'SELECT group_concat(value) FROM records;')).toBe('baseline,committed-wal,after-vacuum');
                    expect(await sqlite('/data/sibling.sqlite', 'SELECT value FROM records;')).toBe('sibling');
                    // These are existing native entry points. The SQLite adapter
                    // must supply their same staged destination and recovery facts.
                    const observe = (input: adapter.OwnServerNativeRestoreInput, operationId: string) =>
                        adapter.observeOwnServerNativeRestoreDestination(input, { operationId, environmentId: source.environmentId, revision: 1, target });
                    const destination = await withInput('sqlite-observe', input => observe(input, repositoryOperation));
                    expect(destination.hasMeaningfulData).toBe(true);
                    const absent = await withInput('sqlite-absent-observe', input => adapter.observeOwnServerNativeRestoreDestination(input,
                        { operationId: repositoryOperation, environmentId: source.environmentId, revision: 1,
                            target: { ...target, path: '/data/absent.sqlite' } }));
                    expect(absent.hasMeaningfulData).toBe(false);
                    await sqlite('/data/database.sqlite', "INSERT INTO records VALUES('after-backup');");
                    const capture = result.restoreCaptures?.[0];
                    if (!capture || capture.sourceFormat !== 'sqlite') throw new Error('The verified SQLite source has no restore capture');
                    const safetyBackup = { environmentId: source.environmentId, configuration, data };
                    const prepared = await withInput<adapter.OwnServerNativeRestorePrepareReceipt>('sqlite-prepare', input => adapter.prepareOwnServerNativeRestore(input,
                        { operationId: repositoryOperation, ...capture, destination, safetyBackup }));
                    const restored = await withInput('sqlite-confirm', input => adapter.confirmOwnServerNativeRestore(input,
                        { prepare: prepared, ...capture, destination }));
                    expect(restored, JSON.stringify({ kind: restored.kind, code: restored.code, nextAction: restored.nextAction, steps: restored.steps })).toMatchObject({ kind: 'restored' });
                    expect(await sqlite('/data/database.sqlite', 'PRAGMA integrity_check; SELECT group_concat(value) FROM records;'))
                        .toBe('ok\nbaseline,committed-wal');
                    expect(await sqlite('/data/sibling.sqlite', 'SELECT value FROM records;')).toBe('sibling');
                    await sqlite('/data/upload.sqlite', "PRAGMA page_size=8192; CREATE TABLE records(value TEXT); INSERT INTO records VALUES('uploaded');");
                    const activePageSize = await sqlite('/data/database.sqlite', 'PRAGMA page_size;');
                    expect(activePageSize).not.toBe(await sqlite('/data/upload.sqlite', 'PRAGMA page_size;'));
                    const exportContainer = (await docker(['create', '--mount', mount, metadata.indexDigest])).toString('utf8').trim();
                    const filePath = join(root, 'upload.sqlite');
                    try { await docker(['cp', `${exportContainer}:/data/upload.sqlite`, filePath]); }
                    finally { await docker(['container', 'rm', exportContainer]); }
                    const bytes = await readFile(filePath);
                    const upload = { kind: 'upload' as const, transferId: 'sqlite-upload', filePath, sizeBytes: bytes.length,
                        sha256: createHash('sha256').update(bytes).digest('hex'),
                        readChunk: async ({ offset, length }: { offset: number; length: number }) => bytes.subarray(offset, offset + length) };
                    const uploadSource = { kind: upload.kind, transferId: upload.transferId, sizeBytes: upload.sizeBytes, sha256: upload.sha256 };
                    const uploadDestination = await withInput('sqlite-upload-observe', input => observe(input, uploadOperation));
                    const uploadPrepared = await withInput<adapter.OwnServerNativeRestorePrepareReceipt>('sqlite-upload-prepare', input => {
                        const { execEnv: _execEnv, readAccess: _readAccess, ...common } = input;
                        return adapter.prepareOwnServerNativeRestore({ ...common, upload },
                            { operationId: uploadOperation, source: uploadSource, destination: uploadDestination, safetyBackup }, input);
                    });
                    expect(uploadPrepared).toMatchObject({ source: uploadSource, sourceFormat: 'sqlite' });
                    const uploaded = await withInput('sqlite-upload-confirm', input => {
                        const { execEnv: _execEnv, readAccess: _readAccess, ...common } = input;
                        return adapter.confirmOwnServerNativeRestore({ ...common, upload },
                            { prepare: uploadPrepared, source: uploadSource, sourceFormat: uploadPrepared.sourceFormat, destination: uploadDestination });
                    });
                    expect(uploaded, JSON.stringify({ kind: uploaded.kind, code: uploaded.code, nextAction: uploaded.nextAction, steps: uploaded.steps })).toMatchObject({ kind: 'restored' });
                    expect(await sqlite('/data/database.sqlite', 'PRAGMA integrity_check; PRAGMA journal_mode; SELECT value FROM records;'))
                        .toBe('ok\nwal\nuploaded');
                    expect(await sqlite('/data/database.sqlite', 'PRAGMA page_size;')).toBe(activePageSize);
                    expect(await sqlite('/data/sibling.sqlite', 'SELECT value FROM records;')).toBe('sibling');
                    failNextResume = true;
                    const recoveryDestination = await withInput('sqlite-recovery-observe', input => observe(input, recoveryOperation));
                    const recoveryPrepared = await withInput<adapter.OwnServerNativeRestorePrepareReceipt>('sqlite-recovery-prepare', input => adapter.prepareOwnServerNativeRestore(input,
                        { operationId: recoveryOperation, ...capture, destination: recoveryDestination, safetyBackup }));
                    const recovered = await withInput('sqlite-recovery-confirm', input => adapter.confirmOwnServerNativeRestore(input,
                        { prepare: recoveryPrepared, ...capture, destination: recoveryDestination }));
                    expect(recovered).toMatchObject({ kind: 'rolledBack', verified: false, nextAction: 'none' });
                    expect(await sqlite('/data/database.sqlite', 'PRAGMA integrity_check; SELECT group_concat(value) FROM records;'))
                        .toBe('ok\nuploaded');
                    expect(await sqlite('/data/sibling.sqlite', 'SELECT value FROM records;')).toBe('sibling');
        } finally {
            writer?.stdin?.end();
            if (writer && writer.exitCode === null) await once(writer, 'exit');
            try { await cleanupNative?.(); }
            finally {
                controller.abort();
                for (const operationId of operationIds) {
                    const owned = (await docker(['volume', 'ls', '--filter', `label=happier.operation=${operationId}`, '--format', '{{.Name}}']))
                        .toString('utf8').trim().split('\n').filter(Boolean);
                    for (const name of owned) await docker(['volume', 'rm', name]);
                }
                const volumes = (await docker(['volume', 'ls', '--filter', `name=${volume}`, '--format', '{{.Name}}']))
                    .toString('utf8').trim().split('\n');
                if (volumes.includes(volume)) await docker(['volume', 'rm', volume]);
                await incumbent?.release(); await admitted?.dispose();
                // Restic creates root-owned repository directories inside the
                // test-owned bind mount. Restore host cleanup access there only.
                if (resticReference) await docker(['run', '--rm', '--entrypoint', '/bin/chmod', '--mount',
                    `type=bind,source=${join(root, 'repository')},target=/repository`, resticReference, '-R', 'a+rwX', '/repository']);
                await rm(root, { recursive: true, force: true });
            }
        }
    }, 300_000);
});
