import { expect, it } from 'vitest';
import { access, chmod, mkdir, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { RESTIC_RUNTIME_V1, buildResticRequestV1, testDeploymentBackupDestinationV1 } from '@happier-dev/deployments';
import { withFiniteComposeFixture } from '@/daemon/local/services/launch/serviceExec.testkit';
import { nativeRestic0191 } from '@/daemon/local/services/launch/nativeResticRegistry.testkit';
import { createDeploymentBackupEnvironmentForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import { installRestoreBoundary } from './nativeRestore.testkit';
import { withNativeBackupRepositoryForHost } from '@/daemon/local/services/launch/nativeResticCommand';

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
        const boundary = await installRestoreBoundary(root, 'repositoryOnly');
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
        const destination = createDeploymentBackupEnvironmentForHost({ repository, local,
            signal, isCurrent: () => true, preparation: { environmentId: source.environmentId,
                machineId: source.machineId, installationId: source.installationId, installationPrivateSeed: seed,
                bindings: [binding], backupDestinationUses: [binding], grants, backupConfigBaseDir: root,
                async assertCurrent() {} } });
        try {
            const result = await withNativeBackupRepositoryForHost({ cwd: source.rootPath, directory: root,
                environmentInstanceId: source.environmentInstanceId, projectName: 'configuration-only',
                operation: { operationId: 'configure-local', kind: 'deployments.backups.configure', signal },
                runtime: { exec, nativeIo: io, settleNative: project.settleNative },
                async prepareDestination() { return destination; } },
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
        } finally {
            const firstCreated = missingBase ? join(root, 'missing-base') : join(mountPath, 'previews');
            try { await chmod(firstCreated, 0o700); }
            catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
        }
    });
});
