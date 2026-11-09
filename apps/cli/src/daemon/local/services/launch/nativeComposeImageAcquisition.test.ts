import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { create as createTar } from 'tar';
import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { createNativeComposeLifecycle } from './nativeComposeLifecycle';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { createOwnServerNativeImageAcquisition } from '@/deployments/targets/ownServer/nativeImageAcquisition';
import { sealMachineSecretGrant } from '@/deployments/secrets/machineSecretGrant';
import * as grants from '@/deployments/secrets/machineSecretGrant';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';

async function fixture(run: (fixture: {
    activate(): Promise<void>;
    requests: { args: readonly string[]; env: Record<string, string | undefined> }[];
    registryRoot: string;
    imageReference: string;
    setLocal(value: boolean): void;
    setPullExit(value: number): void;
    setSubstitution(value: boolean): void;
    revokeRegistry(): void;
    cancelPull(): void;
}) => Promise<void>, access: 'pull' | 'pushPull' = 'pushPull') {
    const root = await mkdtemp(join(tmpdir(), 'happier-image-acquisition-'));
    const registryRoot = join(root, 'registry');
    const controller = new AbortController();
    const requests: { args: readonly string[]; env: Record<string, string | undefined> }[] = [];
    const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64', config: { Labels: { version: 'A' } } }));
    const configDigest = `sha256:${createHash('sha256').update(config).digest('hex')}`;
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: configDigest }, layers: [] }));
    const manifestDigest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
    const imageReference = `registry.example.test/app@${manifestDigest}`;
    const image = { service: 'app', platform: 'linux/amd64', configDigest, manifestDigest, registryReference: imageReference };
    const source = { environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'retained-A',
        machineId: 'receiver', installationId: 'installation', rootPath: root, manifestFingerprint: 'manifest',
        async assertCurrent() { controller.signal.throwIfAborted(); }, async commit() {}, async abort() {} };
    const exec = createStablePluginExecService({
        signal: controller.signal, isOccurrenceCurrent: () => true, resolvePath: async () => root,
        resolveExecutable: async () => ({ command: '/docker' }),
        systemTools: { async resolve(request) { return { grantId: 'docker-fixture', toolId: request.toolId, displayName: 'Docker fixture', source: 'system', executablePath: '/docker', launch: { kind: 'binary', executablePath: '/docker' } }; } },
    });
    const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime', signal: controller.signal,
        isCurrent: () => true, async prepare() { return { env: {}, secretValues: [], refs: [], async recheck() {}, dispose() {} }; } });
    const binding: Extract<EnvironmentSecretBindingV1, { purpose: 'registry' }> = { purpose: 'registry',
        targetLinkId: 'link', registryOrigin: 'https://registry.example.test', access,
        source: { kind: 'secret', ref: 'happier:shared-secret:v1:registry', resourceRevision: 1 } };
    const seed = new Uint8Array(32).fill(17);
    const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: 'environment',
        machineId: 'receiver', installationId: 'installation', resourceId: 'registry', resourceRevision: 1 },
        installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey,
        // Current runtime admission permits only pull; the seal authenticates
        // the exact resource and installation independently of that use.
        content: { kind: 'secret', value: JSON.stringify({ username: 'deploy', password: 'registry-test-secret' }) } });
    const launchGrants = [grant];
    const imageAcquisition = createOwnServerNativeImageAcquisition({ source, operation: 'rollback', targetLinkId: 'link',
        signal: controller.signal, assertCurrent: source.assertCurrent,
        environment: { name: 'Fixture', retainPreviousDeployments: 1, definition: { kind: 'repository', ref: 'main',
            compose: { path: 'compose.yaml', profiles: [], services: ['app'] } }, bindings: [binding] },
        runtime: { exec, secrets: { installationPrivateSeed: seed, grants: launchGrants, registryConfigBaseDir: registryRoot } } });
    let local = true;
    let pullExit = 0;
    let substitution = false;
    let cancelDuringPull = false;
    const project = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source,
        files: ['compose.yaml'], services: ['app'], images: [image],
        imageAcquisition,
        io: { async resolveTool() { return { executablePath: '/docker', version: 'fixture' }; }, async run(request) {
            requests.push(request);
            const args = request.args;
            if (args.includes('version')) return { exitCode: 0, stdout: args.includes('compose') ? '2.39.4' : 'linux/amd64' };
            if (args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: 'engine', OperatingSystem: 'Ubuntu' }) };
            if (args.includes('config')) {
                // This fixture has no environment expressions. Mirror native
                // variable discovery, stdin inventory and include loading at
                // the OS boundary; keep the real phase/projection owners.
                if (args.includes('--variables')) return { exitCode: 0, stdout: '{}' };
                if (request.stdin) return { exitCode: 0, stdout: Buffer.from(request.stdin).toString('utf8') };
                if (args.includes('--no-interpolate')) return { exitCode: 0,
                    stdout: JSON.stringify({ services: { app: { image: 'mutable:latest' } } }) };
                const wrapper = JSON.parse(await readFile(args[args.indexOf('--file') + 1], 'utf8'));
                return { exitCode: 0, stdout: await readFile(wrapper.include[0].path, 'utf8') };
            }
            if (args[0] === 'image' && args[1] === 'inspect') {
                // Store-native Id differs from CONFIG, and the registry alias
                // need not remain after a retained image was loaded or retagged.
                return local && !args.includes(imageReference) ? { exitCode: 0, stdout: JSON.stringify([{ Id: manifestDigest,
                    Descriptor: { digest: manifestDigest, mediaType: 'application/vnd.oci.image.manifest.v1+json' } }]) }
                    : { exitCode: 1, stdout: '', stderr: 'No such image' };
            }
            if (args[0] === 'image' && args[1] === 'save') {
                const actualConfig = substitution ? Buffer.from(config.toString().replace('"A"', '"B"')) : config;
                await writeFile(join(root, `${configDigest.slice(7)}.json`), actualConfig);
                await writeFile(join(root, 'manifest.json'), JSON.stringify([{ Config: `${configDigest.slice(7)}.json`, Layers: [] }]));
                await createTar({ cwd: root, file: args[args.indexOf('--output') + 1] }, [`${configDigest.slice(7)}.json`, 'manifest.json']);
                return { exitCode: 0, stdout: '' };
            }
            if (args[0] === 'image' && args[1] === 'pull') {
                expect(args).toEqual(['image', 'pull', '--platform', image.platform, imageReference]);
                expect(request.env.DOCKER_CONFIG).toBeTypeOf('string');
                expect(JSON.parse(await readFile(join(request.env.DOCKER_CONFIG!, 'config.json'), 'utf8'))).toEqual({
                    auths: { 'registry.example.test': { auth: Buffer.from('deploy:registry-test-secret').toString('base64') } } });
                if (cancelDuringPull) { controller.abort(); controller.signal.throwIfAborted(); }
                local = pullExit === 0;
                return { exitCode: pullExit, stdout: '', stderr: pullExit ? 'registry-test-secret denied' : '' };
            }
            if (args[0] === 'image' && args[1] === 'tag' || args.includes('up')) return { exitCode: 0, stdout: '' };
            if (args[0] === 'ps') return { exitCode: 0, stdout: 'a'.repeat(64) };
            if (args[0] === 'inspect') return { exitCode: 0, stdout: JSON.stringify([{ Id: 'a'.repeat(64), Image: manifestDigest,
                Config: { Labels: { 'com.docker.compose.project': `happier-${createHash('sha256').update('instance').digest('hex')}`,
                    'com.docker.compose.service': 'app' } }, State: { Status: 'running' }, RestartCount: 0 }]) };
            throw new Error(`Unexpected native operation ${args.join(' ')}`);
        } }, async settleNative() {} });
    try {
        await writeFile(join(root, 'compose.yaml'), 'services:\n  app:\n    image: mutable:latest\n');
        await run({ requests, registryRoot, imageReference, setLocal(value) { local = value; },
            setPullExit(value) { pullExit = value; }, setSubstitution(value) { substitution = value; },
            revokeRegistry() { launchGrants.length = 0; }, cancelPull() { cancelDuringPull = true; },
            async activate() {
                const rendered = await project.render();
                expect(rendered.keys).toEqual([{ kind: 'composeProject', dockerEndpoint: 'engine', projectName: rendered.projectName }]);
                const activated = await machineNativeEffectAdmission.run({ operation: { operationId: 'rollback', kind: 'deployments.rollback' },
                    keys: rendered.keys }, context => project.activate({ render: rendered, context }));
                await activated.dispose();
            } });
    } finally { await project.dispose(); await rm(root, { recursive: true, force: true }); }
}

describe('exact native image acquisition through the real Compose and P42 owners', () => {
    it('uses retained CONFIG identity with zero registry credential opens or pull when its registry alias is missing', async () => {
        const opens = vi.spyOn(grants, 'openMachineSecretGrant');
        try {
            await fixture(async input => {
                await input.activate();
                expect(input.requests.filter(request => request.args[1] === 'pull')).toHaveLength(0);
                expect(input.requests.filter(request => request.args.includes('up'))).toHaveLength(1);
                expect(opens).not.toHaveBeenCalled();
            });
        } finally { opens.mockRestore(); }
    });

    it('pulls only the recorded immutable platform digest under current pushPull custody and wipes the config', async () => {
        await fixture(async input => {
            input.setLocal(false);
            await input.activate();
            expect(input.requests.filter(request => request.args[1] === 'pull')).toHaveLength(1);
            expect(input.requests.findIndex(request => request.args[1] === 'pull')).toBeLessThan(input.requests.findIndex(request => request.args.includes('up')));
            expect(await readdir(input.registryRoot)).toEqual([]);
        });
    });

    it('keeps a failed registry acquisition visible, wipes custody and never activates or substitutes mutable bytes', async () => {
        await fixture(async input => {
            input.setLocal(false); input.setPullExit(1);
            await expect(input.activate()).rejects.toMatchObject({ code: 'native_failed', details: { reason: 'native_compose_command_failed' } });
            expect(input.requests.filter(request => request.args[1] === 'pull')).toHaveLength(1);
            expect(input.requests.some(request => request.args.includes('up') || request.args.includes('load') || request.args.includes('build'))).toBe(false);
            expect(await readdir(input.registryRoot)).toEqual([]);
        });
    });

    it('never uses a pull-only binding to recover a missing deployment image', async () => {
        await fixture(async input => {
            input.setLocal(false);
            await expect(input.activate()).rejects.toMatchObject({ code: 'rollback_image_unavailable' });
            expect(input.requests.some(request => request.args[1] === 'pull' || request.args.includes('up'))).toBe(false);
        }, 'pull');
    });

    it('proves loaded CONFIG bytes after acquisition instead of trusting a successful pull or native Id', async () => {
        await fixture(async input => {
            input.setLocal(false); input.setSubstitution(true);
            await expect(input.activate()).rejects.toMatchObject({ details: { reason: 'deployment_image_identity_mismatch' } });
            expect(input.requests.some(request => request.args.includes('up'))).toBe(false);
            expect(await readdir(input.registryRoot)).toEqual([]);
        });
    });

    it('refuses a withdrawn installation grant without a registry request or substitute effect', async () => {
        await fixture(async input => {
            input.setLocal(false); input.revokeRegistry();
            await expect(input.activate()).rejects.toMatchObject({ code: 'secret_missing' });
            expect(input.requests.some(request => request.args[1] === 'pull' || request.args.includes('up') || request.args.includes('load'))).toBe(false);
        });
    });

    it('wipes its private registry config when the native pull is cancelled', async () => {
        await fixture(async input => {
            input.setLocal(false); input.cancelPull();
            await expect(input.activate()).rejects.toMatchObject({ name: 'AbortError' });
            expect(input.requests.filter(request => request.args[1] === 'pull')).toHaveLength(1);
            expect(input.requests.some(request => request.args.includes('up'))).toBe(false);
            expect(await readdir(input.registryRoot)).toEqual([]);
        });
    });
});
