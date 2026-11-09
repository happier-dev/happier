import { readFile, readdir, stat } from 'node:fs/promises';
import nacl from 'tweetnacl';
import { expect, it } from 'vitest';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealMachineSecretGrant } from './machineSecretGrant';
import { prepareEnvironmentSecretBindingsForLaunch } from './prepareEnvironmentSecretBindingsForLaunch';
import { createDeploymentExecEnvPortForHost } from './deploymentExecEnvPort';
import { authorizePluginExecLaunchForHost, createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { withTempDir } from '@/testkit/fs/tempDir';
import { prepareEnvironmentSecretBindingsV1 } from '@happier-dev/deployments';

const seed = new Uint8Array(32).fill(47);
const roles = ['repositoryPassword', 'accessKeyId', 'secretAccessKey', 'sessionToken'] as const;
const values = ['repository-secret-sentinel', 'access-id-sentinel', 'access-secret-sentinel', 'session-sentinel'];

function input(baseDir: string) {
    const uses = roles.map((role): Extract<EnvironmentSecretBindingV1, { purpose: 'backupDestination' }> => ({
        purpose: 'backupDestination', configKey: 'destination', role,
        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(role), resourceRevision: 2 },
    }));
    const grants = uses.map((_use, index) => sealMachineSecretGrant({
        subject: { v: 1, kind: 'secret', environmentId: 'environment', machineId: 'runtime', installationId: 'installed',
            resourceId: roles[index], resourceRevision: 2 },
        installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey,
        content: { kind: 'secret', value: values[index] },
    }));
    return { environmentId: 'environment', machineId: 'runtime', installationId: 'installed', installationPrivateSeed: seed,
        bindings: uses, backupDestinationUses: uses, backupConfigBaseDir: baseDir, grants,
        assertCurrent: async () => {} };
}

it('prepares saved backup secrets for admitted runtime recipients and opens only their private restic credentials', async () => {
    await withTempDir('backup-destination-custody-', async root => {
        const request = input(root);
        const installation = { machineId: request.machineId, installationId: request.installationId,
            publicKey: nacl.sign.keyPair.fromSeed(seed).publicKey };
        const second = { machineId: 'second-runtime', installationId: 'second-installation',
            publicKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23)).publicKey };
        const prepared = await prepareEnvironmentSecretBindingsV1({ environmentId: request.environmentId,
            bindings: request.bindings, previousBindings: [], runtimeInstallations: [installation, second],
            buildInstallation: { ...installation, machineId: 'builder', installationId: 'builder-installation' },
            existingGrants: [], assertCurrent: request.assertCurrent, sealGrant: sealMachineSecretGrant,
            resolveSecret: async source => values[roles.findIndex(role => source.ref === formatSharedSavedSecretRefV1(role))]!,
        });
        expect(prepared.grants).toHaveLength(roles.length * 2);
        expect(new Set(prepared.grants.map(grant => grant.machineId))).toEqual(new Set([request.machineId, second.machineId]));
        request.grants = prepared.grants;
        const material = await prepareEnvironmentSecretBindingsForLaunch(request);
        try {
            expect(material.env.RESTIC_PASSWORD_FILE, 'the repository password belongs in an operation-private file').toEqual(expect.any(String));
            expect(await readFile(material.env.RESTIC_PASSWORD_FILE, 'utf8')).toBe(values[0]);
            expect((await stat(material.env.RESTIC_PASSWORD_FILE)).mode & 0o777).toBe(0o600);
            expect(material.credentialFiles).toEqual([{ hostPath: material.env.RESTIC_PASSWORD_FILE,
                containerPath: '/run/happier/backup/repository-password', readOnly: true }]);
            expect(material.env).toMatchObject({ AWS_ACCESS_KEY_ID: values[1], AWS_SECRET_ACCESS_KEY: values[2], AWS_SESSION_TOKEN: values[3] });
            expect(Object.keys(material.env).sort()).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'RESTIC_PASSWORD_FILE']);
            expect(material.operationalValues.size).toBe(0);
            expect(material.secretValues).toEqual(expect.arrayContaining(values));
            await material.recheck();
        } finally { material.dispose(); }
        expect(await readdir(root)).toEqual([]);
        expect(Object.keys(material.env)).toEqual([]);
    });
});

it('refuses a foreign installation, undeclared role or incomplete required S3 roles before writing credentials', async () => {
    await withTempDir('backup-destination-refusal-', async root => {
        const request = input(root);
        for (const invalid of [
            { ...request, installationId: 'foreign' },
            { ...request, backupDestinationUses: request.backupDestinationUses.slice(0, 2) },
            { ...request, backupDestinationUses: [...request.backupDestinationUses, { ...request.bindings[0], role: 'sshPrivateKey' as const }] },
            { ...request, backupDestinationUses: [...request.backupDestinationUses, request.backupDestinationUses[0]] },
            { ...request, phase: 'runtime' as const },
            { ...request, use: request.backupDestinationUses[0] },
            { ...request, registryUses: [] },
        ]) await expect(prepareEnvironmentSecretBindingsForLaunch(invalid)).rejects.toMatchObject({ data: { code: 'secret_missing' } });
        expect(await readdir(root)).toEqual([]);
    });
});

it('uses the captured role group if a caller later mutates its selection', async () => {
    await withTempDir('backup-destination-selection-change-', async root => {
        const request = input(root);
        let checks = 0;
        request.assertCurrent = async () => {
            if (++checks === 2) request.backupDestinationUses.pop();
        };
        const material = await prepareEnvironmentSecretBindingsForLaunch(request);
        try { expect(material.env.AWS_SESSION_TOKEN).toBe('session-sentinel'); }
        finally { material.dispose(); }
        expect(await readdir(root)).toEqual([]);
    });
});

it('keeps cancellation/currentness through materialization and removes owned files when admission is withdrawn', async () => {
    await withTempDir('backup-destination-withdrawal-', async root => {
        const request = input(root);
        let current = true;
        const assertCurrent = async () => { if (!current) throw Object.assign(new Error('withdrawn'), { code: 'secret_missing' }); };
        const material = await prepareEnvironmentSecretBindingsForLaunch({ ...request, assertCurrent });
        try {
            expect(material.env.RESTIC_PASSWORD_FILE).toEqual(expect.any(String));
            current = false;
            await expect(material.recheck()).rejects.toMatchObject({ code: 'secret_missing' });
        } finally { material.dispose(); }
        expect(await readdir(root)).toEqual([]);
    });
});

it('allows an optional session token to be absent without opening or delivering it', async () => {
    await withTempDir('backup-destination-no-session-', async root => {
        const request = input(root);
        const material = await prepareEnvironmentSecretBindingsForLaunch({ ...request,
            backupDestinationUses: request.backupDestinationUses.slice(0, 3) });
        try {
            expect(material.env).not.toHaveProperty('AWS_SESSION_TOKEN');
            expect(material.refs.map(ref => ref.resourceId).sort()).toEqual(roles.slice(0, 3).sort());
            expect(material.secretValues).not.toContain(values[3]);
        } finally { material.dispose(); }
        expect(await readdir(root)).toEqual([]);
    });
});

it.each(['dispose', 'cancel', 'cancelBetweenCommands'] as const)('loans one backup preparation to three sequential Exec commands and retires it at job %s', async end => {
    await withTempDir('backup-destination-exec-', async root => {
        const request = input(root);
        const controller = new AbortController();
        const job = new AbortController();
        let preparations = 0;
        let disposals = 0;
        const executable = { kind: 'systemTool', id: 'fixture.node' } as const;
        const exec = createStablePluginExecService({
            signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => root });
        const port = createDeploymentExecEnvPortForHost({ signal: controller.signal,
            isCurrent: () => !controller.signal.aborted, backupDestination: { configKey: 'destination' },
            prepare: async () => {
                preparations++;
                const material = await prepareEnvironmentSecretBindingsForLaunch(request);
                return { ...material, dispose() { disposals++; material.dispose(); } };
            } });
        try {
            await expect(port.prepare({ bindingIdentity: 'backupDestination:destination:repositoryPassword' }))
                .rejects.toMatchObject({ code: 'unavailable' });
            expect(await readdir(root)).toEqual([]);
            const attachment = await port.prepare({ backupDestination: { configKey: 'destination' } }, { signal: job.signal });
            expect(Object.keys(attachment)).toEqual(['dispose']);
            const args = ['-e',
                'const fs=require("node:fs");process.stdout.write(JSON.stringify({password:fs.readFileSync(process.env.RESTIC_PASSWORD_FILE,"utf8").startsWith("repository-"),access:process.env.AWS_ACCESS_KEY_ID.startsWith("access-id-"),secret:process.env.AWS_SECRET_ACCESS_KEY.startsWith("access-secret-"),session:process.env.AWS_SESSION_TOKEN.startsWith("session-"),app:process.env.PASSWORD!==undefined}));process.stderr.write(fs.readFileSync(process.env.RESTIC_PASSWORD_FILE,"utf8")+process.env.AWS_ACCESS_KEY_ID+process.env.AWS_SECRET_ACCESS_KEY+process.env.AWS_SESSION_TOKEN)' ];
            for (const command of ['config', 'snapshots', 'tree']) {
                const result = await exec.run({ executable, cwd: root, deploymentEnv: attachment, args: [...args, command] });
                expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual({ password: true, access: true, secret: true, session: true, app: false });
                expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
                for (const value of values) expect(JSON.stringify(result)).not.toContain(value);
            }
            expect(preparations).toBe(1);
            expect(disposals).toBe(0);
            if (end === 'cancelBetweenCommands') {
                job.abort();
                expect(await readdir(root)).toEqual([]);
                expect(disposals).toBe(1);
                await expect(exec.run({ executable, cwd: root, deploymentEnv: attachment, args: [] }))
                    .rejects.toMatchObject({ code: 'unavailable' });
                attachment.dispose();
                expect(disposals).toBe(1);
                return;
            }
            // A current loan loses effect permission immediately, but its
            // command settlement still owns the final child release.
            const current = await authorizePluginExecLaunchForHost(exec, { executable, cwd: root,
                deploymentEnv: attachment, args }, { agentIsolation: null });
            if (end === 'cancel') job.abort(); else attachment.dispose();
            expect(await readdir(root)).toHaveLength(1);
            expect(disposals).toBe(0);
            await expect(current.recheckInputs!()).rejects.toMatchObject({ code: 'unavailable' });
            await expect(exec.run({ executable, cwd: root, deploymentEnv: attachment, args: [] }))
                .rejects.toMatchObject({ code: 'unavailable' });
            await current.release();
            attachment.dispose();
            expect(await readdir(root)).toEqual([]);
            expect(disposals).toBe(1);
        } finally { controller.abort(); }
    });
});

it('refuses a NUL-bearing process credential without exposing its value in a spawn error cause', async () => {
    await withTempDir('backup-destination-nul-', async root => {
        const request = input(root);
        const credential = 'private-nul-prefix\0private-nul-suffix';
        request.grants[2] = sealMachineSecretGrant({
            subject: { v: 1, kind: 'secret', environmentId: 'environment', machineId: 'runtime', installationId: 'installed',
                resourceId: 'secretAccessKey', resourceRevision: 2 },
            installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey,
            content: { kind: 'secret', value: credential },
        });
        const controller = new AbortController();
        const executable = { kind: 'systemTool', id: 'fixture.node' } as const;
        const exec = createStablePluginExecService({
            signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
            resolveExecutable: async () => ({ command: process.execPath }), resolvePath: async () => root });
        const port = createDeploymentExecEnvPortForHost({ signal: controller.signal,
            isCurrent: () => !controller.signal.aborted, backupDestination: { configKey: 'destination' },
            prepare: async () => prepareEnvironmentSecretBindingsForLaunch(request) });
        try {
            const attachment = await port.prepare({ backupDestination: { configKey: 'destination' } });
            let failure: unknown;
            try { await exec.run({ executable, cwd: root, deploymentEnv: attachment, args: ['-e', 'process.stdout.write("started")'] }); }
            catch (error) { failure = error; }
            expect(failure !== null && typeof failure === 'object' && 'code' in failure ? failure.code : undefined)
                .toBe('unavailable');
            for (let cause = failure; cause instanceof Error; cause = cause.cause) {
                expect(cause.message.includes('private-nul-')).toBe(false);
            }
            // Failed child admission does not own the backup job's lifetime.
            attachment.dispose();
            expect(await readdir(root)).toEqual([]);
        } finally { controller.abort(); }
    });
});
