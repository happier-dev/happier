import { readFile, readdir } from 'node:fs/promises';
import nacl from 'tweetnacl';
import { expect, it } from 'vitest';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { withTempDir } from '@/testkit/fs/tempDir';
import { sealMachineSecretGrant } from './machineSecretGrant';
import { consumeDeploymentExecEnvForHost } from './deploymentExecEnvPort';
import * as backupEnvironment from './deploymentExecEnvPort';

it.each(['POSTGRES_DB', 'AWS_ACCESS_KEY_ID', 'RESTIC_PASSWORD_FILE'])('resolves database binding %s separately from the destination loan', async databaseName => {
    await withTempDir('pre-migration-operands-', async root => {
        const seed = new Uint8Array(32).fill(67);
        const installationPublicKey = nacl.sign.keyPair.fromSeed(seed).publicKey;
        const subject = { v: 1 as const, environmentId: 'environment', machineId: 'machine', installationId: 'installed' };
        const database: Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }> = {
            purpose: 'variable', phase: 'runtime', name: databaseName, source: { kind: 'value', value: 'reviewed database' },
        };
        const roles = ['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const;
        const uses = roles.map((role): Extract<EnvironmentSecretBindingV1, { purpose: 'backupDestination' }> => ({
            purpose: 'backupDestination', configKey: 'destination', role,
            source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(role), resourceRevision: 1 },
        }));
        const grants = roles.map(role => sealMachineSecretGrant({ subject: { ...subject, kind: 'secret', resourceId: role,
            resourceRevision: 1 }, installationPublicKey, content: { kind: 'secret', value: `credential-${role}` } }));
        grants.push(sealMachineSecretGrant({ subject: { ...subject, kind: 'environmentValues',
            binding: { purpose: 'variable', phase: 'runtime', name: database.name } }, installationPublicKey,
            content: { kind: 'environmentValues', definition: database.source } }));
        const preparation = { ...subject, installationPrivateSeed: seed, bindings: [...uses, database], grants,
            backupDestinationUses: uses, backupConfigBaseDir: root, assertCurrent: async () => {} };
        const prepare = Reflect.get(backupEnvironment, 'prepareDeploymentBackupEnvironmentForHost');
        expect(prepare).toBeTypeOf('function');
        for (const invalid of [undefined, { ...database, phase: 'build' }, { ...database, name: 'ABSENT' },
            { ...database, source: uses[0].source }]) {
            await expect(prepare({ repository: 's3:https://storage.invalid/recovery', databaseBinding: invalid,
                preparation, signal: new AbortController().signal, isCurrent: () => true }))
                .rejects.toMatchObject({ data: { code: 'secret_missing' } });
            expect(await readdir(root)).toEqual([]);
        }
        const job = new AbortController();
        const opened = await prepare({ repository: 's3:https://storage.invalid/recovery', s3: { region: 'eu-west-1' },
            databaseBinding: database, preparation, signal: job.signal, isCurrent: () => true });
        expect(opened.database).toBe('reviewed database');
        const attachment = await opened.execEnv.prepare({ backupDestination: { configKey: 'destination' } }, { signal: job.signal });
        expect(await opened.execEnv.prepare({ backupDestination: { configKey: 'destination' } })).toBe(attachment);
        const material = await consumeDeploymentExecEnvForHost(attachment, job.signal);
        try {
            expect(Object.values(material.env)).not.toContain('reviewed database');
            expect(material.env.AWS_ACCESS_KEY_ID).toBe('credential-accessKeyId');
            expect(await readFile(material.env.RESTIC_PASSWORD_FILE, 'utf8')).toBe('credential-repositoryPassword');
            expect(opened.readAccess()).toMatchObject({ repository: 's3:https://storage.invalid/recovery', s3: { region: 'eu-west-1' } });
            job.abort();
            await opened.dispose();
            // Cancellation closes admission; an active finite native loan keeps
            // its credential files until that child has settled.
            expect(await readFile(material.env.RESTIC_PASSWORD_FILE, 'utf8')).toBe('credential-repositoryPassword');
        } finally { await material.dispose(); await opened.dispose(); }
        expect(await readdir(root)).toEqual([]);
        await expect(opened.execEnv.prepare({ backupDestination: { configKey: 'destination' } })).rejects.toThrow();
    });
});
