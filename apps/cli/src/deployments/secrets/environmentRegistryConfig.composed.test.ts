import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { EnvironmentSecretBindingV1Schema, environmentSecretBindingIdentityV1, type EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealMachineSecretGrant } from './machineSecretGrant';
import * as grantCustody from './machineSecretGrant';
import { prepareEnvironmentSecretBindingsForLaunch } from './prepareEnvironmentSecretBindingsForLaunch';
import { createDeploymentExecEnvPortForHost } from './deploymentExecEnvPort';
import { authorizePluginExecLaunchForHost, createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';

const seed = new Uint8Array(32).fill(43);
const registryPassword = 'registry-custody-sentinel-a80d';
const credential = JSON.stringify({ username: 'deployer', password: registryPassword });
const use = EnvironmentSecretBindingV1Schema.parse({ purpose: 'registry', targetLinkId: 'own-server',
    registryOrigin: 'https://registry.example.test', access: 'pull',
    source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('registry-credential'), resourceRevision: 2 } });
if (use.purpose !== 'registry') throw new Error('Registry fixture must use the canonical registry arm');

function launchInput(baseDir: string, assertCurrent = async () => {}, value = credential) {
    const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: 'environment',
        machineId: 'runtime', installationId: 'installed', resourceId: 'registry-credential', resourceRevision: 2 },
    installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey,
    content: { kind: 'secret', value } });
    return { environmentId: 'environment', machineId: 'runtime', installationId: 'installed',
        installationPrivateSeed: seed, bindings: [use], use, grants: [grant],
        registryConfigBaseDir: baseDir, assertCurrent };
}

function buildLaunchInput(baseDir: string) {
    const base = launchInput(baseDir);
    const build: EnvironmentSecretBindingV1 = { purpose: 'variable', phase: 'build', name: 'BUILD_TOKEN',
        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('build-token'), resourceRevision: 2 } };
    const runtime: EnvironmentSecretBindingV1 = { ...build, phase: 'runtime', name: 'RUNTIME_TOKEN',
        source: { kind: 'secret', ref: formatSharedSavedSecretRefV1('runtime-token'), resourceRevision: 2 } };
    const registryUses = [{ ...use, access: 'pushPull' as const },
        { ...use, registryOrigin: 'https://base.example.test', access: 'pull' as const }];
    const seal = (resourceId: string, value: string) => sealMachineSecretGrant({
        subject: { v: 1, kind: 'secret', environmentId: base.environmentId, machineId: base.machineId,
            installationId: base.installationId, resourceId, resourceRevision: 2 },
        installationPublicKey: nacl.sign.keyPair.fromSeed(seed).publicKey, content: { kind: 'secret', value } });
    return { ...base, use: undefined, phase: 'build' as const, registryUses,
        bindings: [build, runtime, ...registryUses],
        grants: [seal('build-token', 'build-secret-sentinel-47be'), seal('registry-credential', credential)] };
}

describe('current registry grants through operation-private Docker config custody', () => {
    it('creates an explicitly empty private Docker config without opening either variable phase', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-public-registry-'));
        const opens = vi.spyOn(grantCustody, 'openMachineSecretGrant');
        const input = buildLaunchInput(root);
        try {
            for (const phase of [undefined, 'build'] as const) {
                const material = await prepareEnvironmentSecretBindingsForLaunch({ ...input, phase,
                    bindings: phase ? input.bindings.filter(binding => binding.purpose !== 'variable') : input.bindings,
                    registryUses: [], grants: [] });
                try {
                    expect(Object.keys(material.env)).toEqual(['DOCKER_CONFIG']);
                    expect(JSON.parse(await readFile(join(material.env.DOCKER_CONFIG, 'config.json'), 'utf8')))
                        .toEqual({ auths: {}, credHelpers: { '': '' } });
                    expect(opens).not.toHaveBeenCalled();
                } finally { material.dispose(); }
                expect(await readdir(root)).toEqual([]);
            }
        } finally { opens.mockRestore(); await rm(root, { recursive: true, force: true }); }
    });

    it('composes build secrets and exact registry uses in one opaque Exec attachment without opening runtime secrets', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-build-registry-'));
        const executable = { kind: 'systemTool', id: 'docker-fixture' } as const;
        const opens = vi.spyOn(grantCustody, 'openMachineSecretGrant');
        try {
            const input = buildLaunchInput(root);
            const controller = new AbortController();
            const exec = createStablePluginExecService({ signal: controller.signal,
                isOccurrenceCurrent: () => true, resolvePath: async () => root,
                resolveExecutable: async () => ({ command: process.execPath }) });
            const bindingIdentity = 'admitted-build';
            const port = createDeploymentExecEnvPortForHost({ bindingIdentity, signal: controller.signal,
                isCurrent: () => true, prepare: () => prepareEnvironmentSecretBindingsForLaunch(input) });
            const deploymentEnv = await port.prepare({ bindingIdentity });
            expect(JSON.stringify(deploymentEnv)).toBe('{}');
            const script = 'const fs=require("node:fs"),path=require("node:path");'
                + 'const config=JSON.parse(fs.readFileSync(path.join(process.env.DOCKER_CONFIG,"config.json"),"utf8"));'
                + 'if(!process.env.BUILD_TOKEN||process.env.RUNTIME_TOKEN)process.exit(9);'
                + 'process.stdout.write(Object.keys(config.auths).sort().join(",")+" "+process.env.BUILD_TOKEN);';
            const result = await exec.run({ executable, deploymentEnv, args: ['-e', script] });
            expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: 0 });
            expect(Buffer.from(result.stdout).toString()).toBe('base.example.test,registry.example.test [REDACTED]');
            expect(opens).toHaveBeenCalledTimes(2);
            expect(opens.mock.calls.map(([value]) => value.grant.kind === 'secret' ? value.grant.resourceId : value.grant.kind).sort())
                .toEqual(['build-token', 'registry-credential']);
            expect(await readdir(root)).toEqual([]);
        } finally { opens.mockRestore(); await rm(root, { recursive: true, force: true }); }
    });

    it('rejects unadmitted build registry origin, access, Machine grant or revision before executable resolution', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-build-registry-refusal-'));
        const executable = { kind: 'systemTool', id: 'docker-fixture' } as const;
        const controller = new AbortController();
        const resolveExecutable = vi.fn(async () => ({ command: process.execPath }));
        const exec = createStablePluginExecService({ signal: controller.signal,
            isOccurrenceCurrent: () => true, resolvePath: async () => root, resolveExecutable });
        const input = buildLaunchInput(root);
        const wrongOrigin = input.registryUses.map(row => ({ ...row, registryOrigin: 'https://unadmitted.example.test' }));
        const wrongAccess = input.registryUses.map(row => ({ ...row, access: 'pushPull' as const }));
        try {
            for (const changed of [
                { registryUses: wrongOrigin }, { registryUses: wrongAccess }, { installationId: 'replaced' },
                { grants: input.grants.filter(grant => grant.kind !== 'secret' || grant.resourceId !== 'registry-credential') },
                { phase: 'runtime' as const },
                { use: input.registryUses[0] },
            ]) {
                const bindingIdentity = 'admitted-build';
                const port = createDeploymentExecEnvPortForHost({ bindingIdentity, signal: controller.signal,
                    isCurrent: () => true, prepare: () => prepareEnvironmentSecretBindingsForLaunch({ ...input, ...changed }) });
                await expect(port.prepare({ bindingIdentity })).rejects.toMatchObject({ data: { code: 'secret_missing' } });
                expect(await readdir(root)).toEqual([]);
            }
            expect(resolveExecutable).not.toHaveBeenCalled();
        } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
    });

    it('opens no registry credentials for ordinary runtime custody and opens once for its exact admitted use', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-registry-demand-'));
        // Call-through instrumentation measures credential demand; the actual
        // opener, installation crypto and materializer remain unchanged.
        const opens = vi.spyOn(grantCustody, 'openMachineSecretGrant');
        try {
            const input = launchInput(root);
            const runtime = await prepareEnvironmentSecretBindingsForLaunch({ ...input, use: undefined, phase: 'runtime' });
            try {
                expect(runtime.env).toEqual({});
                expect(opens).not.toHaveBeenCalled();
                expect(await readdir(root)).toEqual([]);
            } finally { runtime.dispose(); }
            const registry = await prepareEnvironmentSecretBindingsForLaunch(input);
            try {
                expect(opens).toHaveBeenCalledTimes(1);
                expect(registry.env.DOCKER_CONFIG).toBeTypeOf('string');
            } finally { registry.dispose(); }
            expect(await readdir(root)).toEqual([]);
        } finally { opens.mockRestore(); await rm(root, { recursive: true, force: true }); }
    });

    it('materializes only the exact registry config, isolates concurrent launches and clears both on disposal', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-registry-custody-'));
        const globalConfig = join(root, 'global');
        const registryConfigs = join(root, 'operations');
        await mkdir(globalConfig);
        const originalConfig = JSON.stringify({ auths: { 'unrelated.example.test': { auth: 'global-config-must-stay' } } });
        await writeFile(join(globalConfig, 'config.json'), originalConfig);
        vi.stubEnv('DOCKER_CONFIG', globalConfig);
        const input = launchInput(registryConfigs);
        const first = await prepareEnvironmentSecretBindingsForLaunch(input);
        const second = await prepareEnvironmentSecretBindingsForLaunch(input);
        try {
            expect(first.env.DOCKER_CONFIG).toBeTypeOf('string');
            expect(second.env.DOCKER_CONFIG).toBeTypeOf('string');
            expect(first.env.DOCKER_CONFIG).not.toBe(second.env.DOCKER_CONFIG);
            expect(Object.keys(first.env)).toEqual(['DOCKER_CONFIG']);
            const configPath = join(first.env.DOCKER_CONFIG, 'config.json');
            expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ auths: {
                'registry.example.test': { auth: Buffer.from(`deployer:${registryPassword}`).toString('base64') },
            } });
            if (process.platform !== 'win32') {
                expect((await stat(first.env.DOCKER_CONFIG)).mode & 0o777).toBe(0o700);
                expect((await stat(configPath)).mode & 0o777).toBe(0o600);
            }
            expect(JSON.stringify(first.env)).not.toContain(registryPassword);
            expect(first.operationalValues.size).toBe(0);
            expect(process.env.DOCKER_CONFIG).toBe(globalConfig);
            expect(await readFile(join(globalConfig, 'config.json'), 'utf8')).toBe(originalConfig);
        } finally {
            first.dispose(); second.dispose();
            vi.unstubAllEnvs();
            expect(await readdir(registryConfigs)).toEqual([]);
            expect(await readFile(join(globalConfig, 'config.json'), 'utf8')).toBe(originalConfig);
            await rm(root, { recursive: true, force: true });
        }
    });

    it('uses the same public opaque attachment and Exec owner, redacts native auth echoes and cleans success or executable refusal', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-registry-exec-'));
        const signal = new AbortController().signal;
        let executableAvailable = true;
        const executable = { kind: 'systemTool', id: 'docker' } as const;
        const exec = createStablePluginExecService({ signal,
            isOccurrenceCurrent: () => true, resolvePath: async () => root,
            async resolveExecutable() {
                if (!executableAvailable) throw Object.assign(new Error('executable_unavailable'), { code: 'executable_unavailable' });
                return { command: '/docker' };
            } });
        const bindingIdentity = environmentSecretBindingIdentityV1(use);
        const port = createDeploymentExecEnvPortForHost({ bindingIdentity, signal, isCurrent: () => true,
            prepare: () => prepareEnvironmentSecretBindingsForLaunch(launchInput(root)) });
        try {
            const handle = await port.prepare({ bindingIdentity });
            expect(JSON.stringify(handle)).toBe('{}');
            const request = { executable, args: ['pull', 'registry.example.test/app@sha256:' + 'a'.repeat(64)], deploymentEnv: handle };
            expect(JSON.stringify(request)).not.toContain(registryPassword);
            const launch = await authorizePluginExecLaunchForHost(exec, request, { agentIsolation: null });
            try {
                expect(await readFile(join(launch.env.DOCKER_CONFIG, 'config.json'), 'utf8')).toContain('auths');
                const echo = `${registryPassword} ${Buffer.from(`deployer:${registryPassword}`).toString('base64')} PORT=3000`;
                const redacted = launch.secretRedactionLease!.redact(echo);
                expect(redacted).not.toContain(registryPassword);
                expect(redacted).not.toContain(Buffer.from(`deployer:${registryPassword}`).toString('base64'));
                expect(redacted).toContain('PORT=3000');
            } finally { await launch.release(); }
            expect(await readdir(root)).toEqual([]);
            executableAvailable = false;
            const refused = await port.prepare({ bindingIdentity });
            await expect(authorizePluginExecLaunchForHost(exec, { executable, args: ['pull', 'registry.example.test/app'], deploymentEnv: refused }, { agentIsolation: null }))
                .rejects.toMatchObject({ code: 'plugin_exec_resolve_failed' });
            expect(await readdir(root)).toEqual([]);
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('retains native encoded-auth and token semantics without accepting a whole Docker configuration', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-registry-auth-'));
        try {
            for (const native of [{ auth: Buffer.from(`deployer:${registryPassword}`).toString('base64') },
                { identitytoken: `${registryPassword}\nsecond-line` }, { registrytoken: registryPassword }]) {
                const material = await prepareEnvironmentSecretBindingsForLaunch(launchInput(root, async () => {}, JSON.stringify(native)));
                try {
                    expect(JSON.parse(await readFile(join(material.env.DOCKER_CONFIG, 'config.json'), 'utf8')))
                        .toEqual({ auths: { 'registry.example.test': native } });
                    expect(material.operationalValues.size).toBe(0);
                    if ('identitytoken' in native) {
                        const lease = createProviderRedactionLease({ values: material.secretValues });
                        try {
                            expect(lease.redact(JSON.stringify({ error: native.identitytoken })))
                                .not.toContain(JSON.stringify(native.identitytoken).slice(1, -1));
                        } finally { lease.close(); }
                    }
                } finally { material.dispose(); }
            }
            expect(await readdir(root)).toEqual([]);
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('uses the captured registry origin if a caller later mutates its input', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-registry-captured-use-'));
        let reads = 0;
        const basis = launchInput(root);
        const mutableUse = { ...basis.use };
        const input = { ...basis, use: mutableUse, async assertCurrent() {
            if (++reads === 2) mutableUse.registryOrigin = 'https://unadmitted.example.test';
        } };
        try {
            const material = await prepareEnvironmentSecretBindingsForLaunch(input);
            try {
                expect(Object.keys(JSON.parse(await readFile(join(material.env.DOCKER_CONFIG, 'config.json'), 'utf8')).auths))
                    .toEqual(['registry.example.test']);
            } finally { material.dispose(); }
            expect(await readdir(root)).toEqual([]);
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('cleans prepared configs on cancellation and stale authority before a process can start', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-registry-cancel-'));
        const controller = new AbortController();
        const executable = { kind: 'systemTool', id: 'docker' } as const;
        const exec = createStablePluginExecService({ signal: controller.signal,
            isOccurrenceCurrent: () => true, resolvePath: async () => root,
            resolveExecutable: async () => ({ command: '/docker' }) });
        let current = true;
        const bindingIdentity = environmentSecretBindingIdentityV1(use);
        const port = createDeploymentExecEnvPortForHost({ bindingIdentity, signal: controller.signal, isCurrent: () => true,
            prepare: () => prepareEnvironmentSecretBindingsForLaunch(launchInput(root, async () => {
                if (!current) throw Object.assign(new Error('secret_missing'), { code: 'secret_missing' });
            })) });
        try {
            const stale = await port.prepare({ bindingIdentity });
            current = false;
            await expect(authorizePluginExecLaunchForHost(exec, { executable, args: ['pull', 'registry.example.test/app'], deploymentEnv: stale }, { agentIsolation: null }))
                .rejects.toMatchObject({ code: 'secret_missing' });
            expect(await readdir(root)).toEqual([]);
            current = true;
            await port.prepare({ bindingIdentity });
            expect(await readdir(root)).toHaveLength(1);
            controller.abort();
            expect(await readdir(root)).toEqual([]);
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('cleans finite process success, nonzero exit, spawn failure and cancellation through the real Exec lifecycle', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-registry-process-'));
        const executable = { kind: 'systemTool', id: 'docker-fixture' } as const;
        const bindingIdentity = environmentSecretBindingIdentityV1(use);
        try {
            for (const outcome of ['success', 'failure', 'spawnFailure', 'cancel'] as const) {
                const controller = new AbortController();
                const observed: string[] = [];
                const exec = createStablePluginExecService({ signal: controller.signal,
                    isOccurrenceCurrent: () => true, resolvePath: async () => root,
                    // A real fixture process substitutes Docker only. Crypto,
                    // custody, redaction, supervision and cleanup remain real.
                    resolveExecutable: async () => ({ command: process.execPath }),
                    observeProcessOutput(event) {
                        const chunk = Buffer.from(event.data).toString('utf8');
                        observed.push(chunk);
                        if (outcome === 'cancel' && chunk.includes('ready')) controller.abort();
                    } });
                const port = createDeploymentExecEnvPortForHost({ bindingIdentity, signal: controller.signal, isCurrent: () => true,
                    prepare: () => prepareEnvironmentSecretBindingsForLaunch(buildLaunchInput(root)) });
                const deploymentEnv = await port.prepare({ bindingIdentity });
                if (outcome === 'spawnFailure') {
                    await expect(exec.spawn({ executable, deploymentEnv, args: ['bad\0argument'] }))
                        .rejects.toMatchObject({ code: 'plugin_exec_spawn_failed' });
                } else {
                    const script = 'const fs=require("node:fs");const path=require("node:path");'
                        + 'const config=JSON.parse(fs.readFileSync(path.join(process.env.DOCKER_CONFIG,"config.json"),"utf8"));'
                        + 'if(Object.keys(config.auths).length!==2||!process.env.BUILD_TOKEN||process.env.RUNTIME_TOKEN)process.exit(9);'
                        + 'process.stdout.write(Object.values(config.auths)[0].auth+" PORT=3000 ready"+" ".repeat(512));'
                        + (outcome === 'cancel' ? 'setInterval(()=>{},1000);' : `process.exitCode=${outcome === 'failure' ? 7 : 0};`);
                    const result = await exec.run({ executable, deploymentEnv, args: ['-e', script] }, { outputDelivery: 'invocation' });
                    if (outcome === 'cancel') {
                        expect(controller.signal.aborted).toBe(true);
                        expect(result.termination.requestedBy).toEqual({ kind: 'abort' });
                        expect(result.termination.observed.kind).toBe('signal');
                    }
                    else expect(result.termination.observed).toEqual({ kind: 'exit', exitCode: outcome === 'failure' ? 7 : 0 });
                    expect(Buffer.from(result.stdout).toString()).not.toContain(Buffer.from(`deployer:${registryPassword}`).toString('base64'));
                    expect(observed.join('')).toContain('PORT=3000');
                }
                expect(await readdir(root)).toEqual([]);
            }
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('rejects stale identity/access/material and malformed native config without writing a file', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-registry-refusal-'));
        const input = launchInput(root);
        try {
            for (const changed of [
                { installationId: 'replacement' },
                { use: { ...input.use, access: 'pushPull' as const } },
                { use: { ...input.use, registryOrigin: 'https://other.example.test' } },
            ]) {
                await expect(prepareEnvironmentSecretBindingsForLaunch({ ...input, ...changed })).rejects.toMatchObject({ data: { code: 'secret_missing' } });
                expect(await readdir(root)).toEqual([]);
            }
            for (const value of [registryPassword, JSON.stringify({ auth: 'not-base64' }),
                JSON.stringify({ username: 'deployer', password: registryPassword, credsStore: 'unsafe-helper' }),
                JSON.stringify({ auths: { 'another.example.test': { identitytoken: registryPassword } } })]) {
                await expect(prepareEnvironmentSecretBindingsForLaunch(launchInput(root, async () => {}, value)))
                    .rejects.toMatchObject({ data: { code: 'invalid_request' } });
                expect(await readdir(root)).toEqual([]);
            }
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
