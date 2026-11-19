import { expect, it } from 'vitest';
import { access, chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployments/contracts/v1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { RESTIC_RUNTIME_V1, buildResticRequestV1, testDeploymentBackupDestinationV1 } from '@happier-dev/deployments';
import { withFiniteComposeFixture } from '@/daemon/local/services/launch/serviceExec.testkit';
import { nativeRestic0191 } from '@/daemon/local/services/launch/nativeResticRegistry.testkit';
import { createDeploymentBackupEnvironmentForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { installRestoreBoundary } from './nativeRestore.testkit';
import { withNativeBackupRepositoryForHost } from '@/daemon/local/services/launch/nativeResticCommand';
import { executeFilesystemMutationAction } from '@/rpc/handlers/fileSystem/pathMutationHandlers';

it('runs a repository operation with native custody before any Compose render or deployment exists', async () => {
    await withFiniteComposeFixture(async ({ docker, source, root, exec, io, project }) => {
        await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
        const boundary = await installRestoreBoundary(root, 'repositoryOnly');
        const seed = new Uint8Array(32).fill(48);
        const binding: Extract<EnvironmentSecretBindingV1, { purpose: 'backupDestination' }> = {
            purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword',
            source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('password'), resourceRevision: 1 },
        };
        const grants = [sealMachineSecretGrant({ subject: { v: 1, kind: 'secret',
            environmentId: source.environmentId, machineId: source.machineId, installationId: source.installationId,
            resourceId: 'password', resourceRevision: 1 }, installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey,
            content: { kind: 'secret', value: 'private-repository-password' } })];
        const signal = new AbortController().signal;
        const destination = createDeploymentBackupEnvironmentForHost({ repository: 's3:https://fixture.invalid/backup',
            signal, isCurrent: () => true, preparation: { environmentId: source.environmentId,
                machineId: source.machineId, installationId: source.installationId, installationPrivateSeed: seed,
                bindings: [binding], backupDestinationUses: [binding], grants, backupConfigBaseDir: root,
                async assertCurrent() {} } });
        let passwordPath = '';
        const result = await withNativeBackupRepositoryForHost({ cwd: source.rootPath, directory: root,
            environmentInstanceId: source.environmentInstanceId, projectName: 'configuration-only',
            operation: { operationId: 'configure-test', kind: 'deployments.backups.configure', signal },
            runtime: { exec, nativeIo: io, settleNative: project.settleNative },
            async prepareDestination() { return destination; } },
        async native => {
            passwordPath = native.access.credentialFiles[0]!.hostPath;
            return native.execute(buildResticRequestV1({ access: native.access,
                environmentId: source.environmentId, command: { kind: 'config' } }));
        });
        expect(result).toMatchObject({ kind: 'completed', exitCode: 0 });
        if (result.kind !== 'completed') throw new Error('Expected the native repository command to complete');
        expect(JSON.parse(result.stdout)).toMatchObject({ version: 2, id: 'c'.repeat(64) });
        await expect(access(passwordPath)).rejects.toThrow();
        const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(events.filter(event => event.kind === 'restic')).toHaveLength(1);
        expect(events.some(event => event.kind === 'service')).toBe(false);
    });
});

it.each([
    { initializeIfMissing: false, missingBase: false, scoped: true },
    { initializeIfMissing: true, missingBase: false, scoped: true },
    { initializeIfMissing: false, missingBase: true, scoped: false },
    { initializeIfMissing: true, missingBase: true, scoped: false },
    { initializeIfMissing: false, missingBase: true, scoped: true },
    { initializeIfMissing: true, missingBase: true, scoped: true },
])('tests a missing local repository and initializes only when requested ($initializeIfMissing, missing base $missingBase, scoped $scoped)', async ({ initializeIfMissing, missingBase, scoped }) => {
    await withFiniteComposeFixture(async ({ docker, source, root, exec, io, project }) => {
        await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
        const checkOwnership = initializeIfMissing && !missingBase && scoped && process.platform !== 'win32' && process.getuid?.() !== 0;
        const boundary = await installRestoreBoundary(root, checkOwnership ? 'repositoryOwnership' : 'repositoryOnly');
        const prefix = scoped ? '/previews/environment-staging' : '';
        const repository = `/run/happier/backup/repository${prefix}`;
        const nativeRepository = `/run/happier/backup/repository${missingBase ? '/missing-base/recovery' : ''}${prefix}`;
        await boundary.setRepositoryMissing(nativeRepository);
        const mountPath = missingBase ? join(root, 'missing-base', 'recovery') : join(root, 'recovery');
        if (!missingBase) await mkdir(mountPath);
        const local = scoped ? { path: join(mountPath, 'previews', 'environment-staging'), mountPath } : { path: mountPath };
        const seed = new Uint8Array(32).fill(48);
        const binding: Extract<EnvironmentSecretBindingV1, { purpose: 'backupDestination' }> = {
            purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword',
            source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('password'), resourceRevision: 1 },
        };
        const grants = [sealMachineSecretGrant({ subject: { v: 1, kind: 'secret',
            environmentId: source.environmentId, machineId: source.machineId, installationId: source.installationId,
            resourceId: 'password', resourceRevision: 1 }, installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey,
            content: { kind: 'secret', value: 'private-repository-password' } })];
        const signal = new AbortController().signal;
        const prepareDestination = async (selectedLocal = local) => createDeploymentBackupEnvironmentForHost({ repository, local: selectedLocal,
            signal, isCurrent: () => true, preparation: { environmentId: source.environmentId,
                machineId: source.machineId, installationId: source.installationId, installationPrivateSeed: seed,
                bindings: [binding], backupDestinationUses: [binding], grants, backupConfigBaseDir: root,
                async assertCurrent() {} } });
        try {
            const result = await withNativeBackupRepositoryForHost({ cwd: source.rootPath, directory: root,
                environmentInstanceId: source.environmentInstanceId, projectName: 'configuration-only',
                operation: { operationId: 'configure-local', kind: 'deployments.backups.configure', signal },
                runtime: { exec, nativeIo: io, settleNative: project.settleNative },
                async prepareDestination() { return prepareDestination(); } },
            native => testDeploymentBackupDestinationV1({ environmentId: source.environmentId,
                operationId: 'configure-local', access: native.access, signal, execute: native.execute, initializeIfMissing }));
            expect(result).toMatchObject(initializeIfMissing ? { kind: 'reachable', repositoryId: 'c'.repeat(64) }
                : { kind: 'failed', reason: 'repository_missing', nativeExitCode: 10 });
            const events = (await readFile(boundary.eventsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
            const restic = events.filter(event => event.kind === 'restic');
            for (const event of restic) expect(event.argv[1]).toBe(
                event.argv.includes('config') ? nativeRepository : repository);
            expect(restic.some(event => event.argv.includes('init'))).toBe(initializeIfMissing);
            const commands = (await docker.readInvocations()).filter(invocation => invocation.args.includes('--repo'));
            expect(commands.length).toBeGreaterThan(0);
            expect(commands, 'ownership repair must stay in the same helper invocation').toHaveLength(restic.length);
            for (const command of commands) {
                const initial = command.args.includes('config');
                const mountSource = await realpath(missingBase && initial ? root : mountPath);
                expect(command.args).toContain(`type=bind,source=${mountSource},target=/run/happier/backup/repository`);
            }
            if (initializeIfMissing) await expect(access(local.path, constants.R_OK | constants.W_OK | constants.X_OK)).resolves.toBeUndefined();
            else {
                await expect(access(local.path)).rejects.toThrow();
                if (missingBase) await expect(access(mountPath)).rejects.toThrow();
            }
            if (checkOwnership) {
                const deleteRepository = () => executeFilesystemMutationAction({ actionId: 'daemon.filesystem.delete',
                    input: { rootPath: mountPath, path: local.path, recursive: true },
                    workingDirectory: root, accessPolicy: { kind: 'osUser' },
                    getAdditionalAllowedReadDirs: () => [], getAdditionalAllowedWriteDirs: () => [] });
                expect.soft(await deleteRepository(), 'a freshly initialized backup must be daemon-deletable')
                    .toEqual({ success: true });
                await mkdir(join(local.path, 'index'), { recursive: true, mode: 0o700 });
                await chmod(join(local.path, 'index'), 0o700);
                await writeFile(join(local.path, 'index', 'historical-index'), 'retained index', { mode: 0o400 });
                // The Docker boundary models an existing root-owned0700 index
                // with000; the daemon can neither enumerate nor delete it.
                await chmod(join(local.path, 'index'), 0o000);
                await chmod(local.path, 0o000);
                const backup = await withNativeBackupRepositoryForHost({ cwd: source.rootPath, directory: root,
                    environmentInstanceId: source.environmentInstanceId, projectName: 'configuration-only',
                    operation: { operationId: 'repair-existing-repository', kind: 'deployments.backups.configure', signal },
                    runtime: { exec, nativeIo: io, settleNative: project.settleNative },
                    async prepareDestination() { return prepareDestination({ path: local.path }); } },
                native => native.execute(buildResticRequestV1({ access: native.access,
                    environmentId: source.environmentId, command: { kind: 'probe',
                        operationId: 'repair-existing-repository', payload: new Uint8Array([0, 255, 128]) } })));
                expect(backup).toMatchObject({ kind: 'completed', exitCode: 0 });
                expect(await deleteRepository(), 'one backup must repair an existing root-owned repository')
                    .toEqual({ success: true });
                await expect(access(local.path)).rejects.toMatchObject({ code: 'ENOENT' });
            }
        } finally {
            if (checkOwnership) {
                try { await chmod(local.path, 0o700); }
                catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
                try { await chmod(join(local.path, 'index'), 0o700); }
                catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
            }
            const firstCreated = missingBase ? join(root, 'missing-base') : join(mountPath, 'previews');
            try { await chmod(firstCreated, 0o700); }
            catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
        }
    });
});


it('retains both password captures for an explicit repository re-key and retires their files after native settlement', async () => {
    await withFiniteComposeFixture(async ({ docker, source, root, exec, io, project }) => {
        await docker.registerRecordedImage('restic', RESTIC_RUNTIME_V1.image, nativeRestic0191);
        await installRestoreBoundary(root, 'repositoryOnly');
        const seed = new Uint8Array(32).fill(48);
        const signal = new AbortController().signal;
        const destination = (resourceId: string) => {
            const binding: Extract<EnvironmentSecretBindingV1, { purpose: 'backupDestination' }> = {
                purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword',
                source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 },
            };
            const grants = [sealMachineSecretGrant({ subject: { v: 1, kind: 'secret',
                environmentId: source.environmentId, machineId: source.machineId, installationId: source.installationId,
                resourceId, resourceRevision: 1 }, installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey,
                content: { kind: 'secret', value: `private-${resourceId}` } })];
            return createDeploymentBackupEnvironmentForHost({ repository: 's3:https://fixture.invalid/backup',
                signal, isCurrent: () => true, preparation: { environmentId: source.environmentId,
                    machineId: source.machineId, installationId: source.installationId, installationPrivateSeed: seed,
                    bindings: [binding], backupDestinationUses: [binding], grants, backupConfigBaseDir: root,
                    async assertCurrent() {} } });
        };
        const files: string[] = [];
        const result = await withNativeBackupRepositoryForHost({ cwd: source.rootPath, directory: root,
            environmentInstanceId: source.environmentInstanceId, projectName: 'configuration-only',
            operation: { operationId: 'rekey-test', kind: 'deployments.backups.configure', signal },
            runtime: { exec, nativeIo: io, settleNative: project.settleNative },
            async prepareDestination() { return destination('old-password'); },
            async prepareSuccessorDestination() { return destination('new-password'); } },
        async native => {
            expect(native.successorAccess).toBeDefined();
            if (!native.successorAccess) throw new Error('Expected successor custody');
            expect(native.access.passwordFilePath).not.toBe(native.successorAccess.passwordFilePath);
            expect(native.access.credentialFiles).toHaveLength(2);
            for (const file of native.access.credentialFiles) {
                await expect(access(file.hostPath)).resolves.toBeUndefined();
                files.push(file.hostPath);
            }
            return native.execute(buildResticRequestV1({ access: native.successorAccess,
                environmentId: source.environmentId, command: { kind: 'config' } }));
        });
        expect(result).toMatchObject({ kind: 'completed', exitCode: 0 });
        for (const file of files) await expect(access(file)).rejects.toThrow();
        const commands = (await docker.readInvocations()).filter(invocation => invocation.args.includes('--repo'));
        expect(commands).toHaveLength(1);
        expect(commands[0]!.args).toContain('RESTIC_PASSWORD_FILE=/run/happier/backup/new-repository-password');
        for (const file of files) expect(commands[0]!.args.some(arg => arg.includes(`source=${file},`))).toBe(true);
    });
});
