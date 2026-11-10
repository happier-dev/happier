import { expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import nacl from 'tweetnacl';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { RESTIC_RUNTIME_V1, buildResticRequestV1 } from '@happier-dev/deployments';
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
