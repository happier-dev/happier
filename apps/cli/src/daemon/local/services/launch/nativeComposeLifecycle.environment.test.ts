import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { create as createTar } from 'tar';
import { describe, expect, it } from 'vitest';
import { createNativeComposeLifecycle } from './nativeComposeLifecycle';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';

async function createNativeConfigBoundary(root: string) {
    const docker = await createOwnServerDockerBoundary(join(root, 'docker-config-boundary'));
    return (request: Parameters<ProjectNativeToolchainIo['run']>[0]) => ({ exitCode: 0,
        stdout: execFileSync(process.execPath, [docker.executablePath, ...request.args], {
            cwd: request.cwd, env: request.env, encoding: 'utf8',
            ...(request.stdin ? { input: Buffer.from(request.stdin) } : {}),
        }) });
}

/** Observe the host's JSON projection while its private carrier is alive. */
async function readNativeProjection(request: Parameters<ProjectNativeToolchainIo['run']>[0]) {
    const file = request.args[request.args.indexOf('--file') + 1]!;
    const model = JSON.parse(file === '-' ? Buffer.from(request.stdin!).toString('utf8') : await readFile(file, 'utf8'));
    return model.include ? JSON.parse(await readFile(model.include[0].path, 'utf8')) : model;
}

describe('Environment project native activation', () => {
    it('admits different apps sharing named volumes and bind sources concurrently', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-shared-app-admission-'));
        const model = { services: { web: { image: 'app:latest', volumes: [
            { type: 'volume', source: 'data', target: '/data' },
            { type: 'bind', source: root, target: '/shared' },
        ] } }, volumes: { data: { name: 'shared-app-data', external: true } } };
        const discoveryCustodyReads: number[] = [];
        let nativeExecutable = '/docker';
        const projects = ['app-A', 'app-B'].map(environmentInstanceId => {
            let custodyReads = 0;
            let admittedCustodyReads = 0;
            const exec = createStablePluginExecService({
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                resolveExecutable: async () => ({ command: '/docker' }), resolvePath: async () => root,
                systemTools: { async resolve(request) {
                    admittedCustodyReads = custodyReads;
                    return { grantId: 'docker-fixture', toolId: request.toolId, displayName: 'Docker fixture', source: 'system', executablePath: nativeExecutable, launch: { kind: 'binary', executablePath: nativeExecutable } };
                } } });
            const source = { environmentId: environmentInstanceId, environmentInstanceId, deploymentId: 'deploy',
                machineId: 'machine', installationId: 'installation', rootPath: root, manifestFingerprint: 'manifest',
                async assertCurrent() { custodyReads++; }, async commit() {}, async abort() {} };
            const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime',
                signal: new AbortController().signal, isCurrent: () => true,
                async prepare() { return { env: {}, secretValues: [], refs: [], async recheck() {}, dispose() {} }; } });
            return createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source,
                files: ['compose.yaml'], services: ['web'], images: [], async settleNative() {},
                io: { async resolveTool() { return { executablePath: '/docker', version: 'fixture' }; }, async run(request) {
                    // Docker IO is the boundary. Discovery consumes the source
                    // custody already checked before native command admission.
                    if (request.args.includes('version') || request.args.includes('info')) {
                        discoveryCustodyReads.push(custodyReads - admittedCustodyReads);
                    }
                    if (request.args.includes('version')) return { exitCode: 0, stdout: request.args.includes('compose') ? '2.39.4' : 'linux/amd64' };
                    if (request.args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: request.command === '/docker' ? 'shared-app-engine' : 'another-engine' }) };
                    if (request.args.includes('config')) return { exitCode: 0, stdout: JSON.stringify(model) };
                    throw new Error('Unexpected native effect');
                } } });
        });
        try {
            await writeFile(join(root, 'compose.yaml'), JSON.stringify(model));
            const [first, second] = await Promise.all(projects.map(project => project.render()));
            const nativeDocker = await projects[0]!.readNativeDocker({ render: first! });
            expect(nativeDocker.engineId).toBe(first!.engineId);
            nativeExecutable = '/another-docker';
            expect(JSON.parse((await nativeDocker.run(['info', '--format', '{{json .}}'])).stdout).ID).toBe('shared-app-engine');
            await nativeDocker.dispose();
            nativeExecutable = '/docker';
            await expect(projects[0]!.readNativeDocker({ render: second! })).rejects.toMatchObject({ code: 'native_failed' });
            expect(discoveryCustodyReads.length).toBeGreaterThanOrEqual(projects.length);
            expect(discoveryCustodyReads).toEqual(discoveryCustodyReads.map(() => 0));
            let effects = 0;
            await machineNativeEffectAdmission.run({ operation: { operationId: 'shared-app-A', kind: 'deploy' }, keys: first.keys }, async () => {
                await machineNativeEffectAdmission.run({ operation: { operationId: 'shared-app-B', kind: 'deploy' }, keys: second.keys }, async () => { effects++; });
                expect(effects).toBe(1);
                const beforeSameApp = effects;
                await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'same-app', kind: 'deploy' }, keys: first.keys }, async () => { effects++; }))
                    .rejects.toMatchObject({ code: 'effect_in_progress', actionOperationId: 'shared-app-A' });
                expect(effects).toBe(beforeSameApp);
            });
            await machineNativeEffectAdmission.run({ operation: { operationId: 'shared-app-B-after-settlement', kind: 'deploy' }, keys: second.keys }, async () => { effects++; });
            expect(effects).toBe(2);
        } finally { await Promise.all(projects.map(project => project.dispose())); await rm(root, { recursive: true, force: true }); }
    });

    it.each([
        { name: 'unchanged historical restarts', init: false, exited: false, historical: 3, delta: 0, exitCode: 0, accepts: true },
        { name: 'a new crash after historical restarts', init: false, exited: false, historical: 3, delta: 1, exitCode: 0, accepts: false },
        { name: 'a new-container crash', init: false, exited: false, historical: 0, delta: 1, exitCode: 0, accepts: false },
        { name: 'a successfully completed init dependency', init: true, exited: true, historical: 0, delta: 0, exitCode: 0, accepts: true },
        { name: 'an excluded successfully completed init dependency', init: true, exited: true, historical: 0, delta: 0, exitCode: 0, accepts: true, excluded: true },
        { name: 'a failed init dependency', init: true, exited: true, historical: 0, delta: 0, exitCode: 9, accepts: false },
        { name: 'a stopped ordinary service', init: false, exited: true, historical: 0, delta: 0, exitCode: 0, accepts: false },
        { name: 'a still-running init dependency', init: true, exited: false, historical: 0, delta: 0, exitCode: 0, accepts: false },
        { name: 'an excluded helper becoming unhealthy after native wait', init: false, exited: false, historical: 0, delta: 0, exitCode: 0, accepts: true, excluded: true, unhealthy: true },
        { name: 'an excluded helper already unhealthy during native wait', init: false, exited: false, historical: 0, delta: 0, exitCode: 0, accepts: true, excluded: true, unhealthy: true, unhealthyDuringWait: true },
        { name: 'a participating helper already unhealthy during native wait', init: false, exited: false, historical: 0, delta: 0, exitCode: 0, accepts: false, excluded: false, unhealthy: true, unhealthyDuringWait: true },
        { name: 'an excluded helper required healthy by its dependent', init: false, exited: false, historical: 0, delta: 0, exitCode: 0, accepts: false, excluded: true, unhealthy: true, unhealthyDuringWait: true, requiresHealthy: true },
        { name: 'all health participants explicitly excluded', init: false, exited: false, historical: 0, delta: 0, exitCode: 0, accepts: true, excluded: true, unhealthy: true, unhealthyDuringWait: true, allExcluded: true },
        { name: 'an excluded helper with a new crash', init: false, exited: false, historical: 0, delta: 1, exitCode: 0, accepts: false, excluded: true, unhealthy: false },
        { name: 'a participating helper becoming unhealthy after native wait', init: false, exited: false, historical: 0, delta: 0, exitCode: 0, accepts: false, excluded: false, unhealthy: true },
        { name: 'an excluded but stopped ordinary helper', init: false, exited: true, historical: 0, delta: 0, exitCode: 0, accepts: false, excluded: true, unhealthy: false },
    ])('proves the native generation with $name', async ({ init, exited, historical, delta, exitCode, accepts, excluded, unhealthy, unhealthyDuringWait, allExcluded, requiresHealthy }) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-generation-proof-'));
        const source = { environmentId: 'env', environmentInstanceId: 'instance', deploymentId: 'deploy', machineId: 'machine',
            installationId: 'installation', rootPath: root, manifestFingerprint: 'manifest', async assertCurrent() {}, async commit() {}, async abort() {} };
        const services = ['web', 'dependency'];
        const config = JSON.stringify({ os: 'linux', architecture: 'amd64', config: {} });
        const configDigest = `sha256:${createHash('sha256').update(config).digest('hex')}`;
        const manifestDigest = `sha256:${'b'.repeat(64)}`;
        const images = services.map(service => ({ service, platform: 'linux/amd64', configDigest, manifestDigest }));
        const model = { services: { web: { image: 'example/web:1', depends_on: { dependency: {
            condition: init ? 'service_completed_successfully' : requiresHealthy ? 'service_healthy' : 'service_started' } }, healthcheck: { disable: true } },
            dependency: { image: 'example/dependency:1', healthcheck: unhealthy ? { test: ['CMD', 'true'] } : { disable: true } } } };
        await writeFile(join(root, 'compose.yaml'), JSON.stringify(model));
        const executable = { kind: 'systemTool', id: 'docker' } as const;
        const exec = createStablePluginExecService({ signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: '/docker' }), resolvePath: async () => root,
            systemTools: { async resolve(request) { return { grantId: 'docker-fixture', toolId: request.toolId, displayName: 'Docker fixture', source: 'system', executablePath: '/docker', launch: { kind: 'binary', executablePath: '/docker' } }; } } });
        const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime', signal: new AbortController().signal,
            isCurrent: () => true, async prepare() { return { env: { HOME: root }, secretValues: [], refs: [], async recheck() {}, dispose() {} }; } });
        let activated = false;
        let restartCount = historical;
        let snapshotReads = 0;
        let engineIdentifications = 0;
        const upCommands: string[][] = [];
        const configBoundary = await createNativeConfigBoundary(root);
        // Docker IO is the genuine native/OS boundary. Rendering, image archive
        // proof, effect admission and generation classification remain real.
        const nativeIo: ProjectNativeToolchainIo = { async resolveTool() { return { executablePath: '/docker', version: 'fixture' }; },
            async run(request) {
                const args = request.args;
                if (args.includes('version')) return { exitCode: 0, stdout: args.includes('compose') ? '2.39.4' : 'linux/amd64' };
                if (args.includes('info')) { engineIdentifications++; return { exitCode: 0, stdout: JSON.stringify({ ID: 'generation-engine', OperatingSystem: 'Linux' }) }; }
                if (args.includes('config')) return configBoundary(request);
                if (args.includes('up')) {
                    upCommands.push([...args]);
                    const effective = await readNativeProjection(request);
                    expect(effective.services.dependency.healthcheck).toEqual(model.services.dependency.healthcheck);
                    if (!activated) restartCount += delta;
                    activated = true;
                    // Compose 2.39.4 start.go:72-107 waits on every service in
                    // its selected project; --no-deps excludes other services.
                    if (unhealthyDuringWait && args.includes('--wait')
                        && (!args.includes('--no-deps') || args.includes('dependency'))) return { exitCode: 1, stdout: '' };
                    if (requiresHealthy && !args.includes('--no-deps')) return { exitCode: 1, stdout: '' };
                    return { exitCode: 0, stdout: '' };
                }
                if (args.includes('save')) {
                    await writeFile(join(root, `${configDigest.slice(7)}.json`), config);
                    await writeFile(join(root, 'manifest.json'), JSON.stringify([{ Config: `${configDigest.slice(7)}.json`, Layers: [] }]));
                    await createTar({ file: args[args.indexOf('--output') + 1], cwd: root }, [`${configDigest.slice(7)}.json`, 'manifest.json']);
                }
                if (args.includes('ps')) {
                    snapshotReads++;
                    return { exitCode: 0, stdout: activated || historical ? ['a'.repeat(64), 'c'.repeat(64)].join('\n') : '' };
                }
                if (args.includes('inspect') && args.includes('container')) {
                    snapshotReads++;
                    return { exitCode: 0, stdout: JSON.stringify(services.map((service, index) => ({
                        Id: (index ? 'c' : 'a').repeat(64), Image: manifestDigest,
                        Config: { Labels: { 'com.docker.compose.project': `happier-${createHash('sha256').update('instance').digest('hex')}`,
                            'com.docker.compose.service': service } },
                        State: { Status: exited && index ? 'exited' : 'running', ExitCode: exited && index ? exitCode : 0,
                            ...(unhealthy && activated && index ? { Health: { Status: 'unhealthy' } } : {}) },
                        RestartCount: index ? restartCount : 0,
                    }))) };
                }
                return { exitCode: 0, stdout: JSON.stringify([{ Id: manifestDigest }]) };
            } };
        const createProject = () => createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source, files: ['compose.yaml'],
            services: ['web'], images, io: nativeIo, async settleNative() {},
            ...(excluded === undefined ? {} : { health: [{ service: 'dependency', participates: !excluded },
                ...(allExcluded ? [{ service: 'web', participates: false }] : [])] }) });
        const project = createProject();
        const activate = async (owner: typeof project) => {
            const render = await owner.render();
            const before = engineIdentifications;
            try {
                return await machineNativeEffectAdmission.run({ operation: { operationId: 'generation-proof', kind: 'deploy' }, keys: render.keys },
                    context => owner.activate({ render, context }));
            } finally {
                // The admitted runtime render identifies its engine once. Image
                // tags, activation and waits never re-identify per command.
                expect(engineIdentifications - before).toBe(1);
            }
        };
        try {
            if (historical && accepts) {
                const recovered = createProject();
                try {
                    const render = await recovered.render();
                    expect(await recovered.observe({ render })).toEqual({ status: 'matching', health: 'unverified' });
                    restartCount++;
                    expect(await recovered.observe({ render })).toEqual({ status: 'different', health: 'unhealthy' });
                    expect(await recovered.observe({ render })).toEqual({ status: 'different', health: 'unhealthy' });
                } finally { await recovered.dispose(); restartCount = historical; }
            }
            if (accepts) {
                const activated = await activate(project);
                expect(activated.nativeIdsForService('dependency')).toHaveLength(1);
                expect(upCommands).toHaveLength(excluded && !allExcluded ? 2 : 1);
                if (excluded) {
                    expect(upCommands[0]).not.toContain('--wait');
                    if (!allExcluded) {
                        expect(upCommands[1]).toEqual(expect.arrayContaining(['--wait', '--no-deps', '--no-recreate', 'web']));
                        expect(upCommands[1]).not.toContain('dependency');
                        expect(upCommands[1]).not.toContain('--remove-orphans');
                    }
                }
                const render = await project.render();
                const readsBefore = snapshotReads;
                expect(await project.observe({ render })).toEqual({ status: 'matching', health: 'unverified' });
                expect(snapshotReads - readsBefore).toBe(2);
                restartCount = historical + 1;
                expect(await project.observe({ render })).toEqual({ status: 'different', health: 'unhealthy' });
                expect(await project.observe({ render })).toEqual({ status: 'different', health: 'unhealthy' });
            } else await expect(activate(project)).rejects.toMatchObject({ code: 'native_failed', details: {
                reason: unhealthyDuringWait ? 'native_compose_command_failed' : 'deployment_activation_failed',
            } });
        } finally { await project.dispose(); await rm(root, { recursive: true, force: true }); }
    });
    it.each([
        { name: 'image-inherited health', imageHealth: { Test: ['CMD', 'true'], Interval: 40_000_000_000,
            Timeout: 10_000_000_000, StartPeriod: 2_000_000_000, Retries: 4 }, health: undefined, healthy: true },
        { name: 'partial Compose overrides and zero-valued image inheritance', imageHealth: { Test: ['CMD', 'true'],
            Interval: 40_000_000_000, Timeout: 10_000_000_000, StartPeriod: 2_000_000_000, Retries: 4 },
            health: { interval: '1m0s', timeout: '500ms', start_period: '0s', retries: 2 }, healthy: true },
        { name: 'Docker native health defaults', imageHealth: undefined, health: { test: ['CMD', 'true'] }, healthy: true },
        { name: 'healthy native checks on every service', imageHealth: undefined,
            health: { test: ['CMD', 'true'] }, healthy: true, allHealthy: true },
        { name: 'fractional native durations', imageHealth: undefined,
            health: { test: ['CMD', 'true'], interval: '1.2s', timeout: '50ms', start_period: '1.5s', retries: 2 }, healthy: true },
        { name: 'a long app-owned start period without a competing cap', imageHealth: undefined,
            health: { test: ['CMD', 'true'], interval: '1s', timeout: '1s', start_period: '36h0m0s', retries: 3 }, healthy: true },
        { name: 'a healthless project', imageHealth: undefined, health: undefined, healthy: false },
        { name: 'explicitly disabled image health', imageHealth: { Test: ['CMD', 'true'] },
            health: { disable: true }, healthy: false },
        { name: 'the native NONE test', imageHealth: { Test: ['CMD', 'true'] },
            health: { test: ['NONE'] }, healthy: false },
    ])('delegates native readiness to Compose without a Happier deadline for $name', async ({ imageHealth, health, healthy, ...scenario }) => {
        const allHealthy = 'allHealthy' in scenario && scenario.allHealthy;
        const root = await mkdtemp(join(tmpdir(), 'happier-compose-health-wait-'));
        const source = { environmentId: 'env', environmentInstanceId: 'instance', deploymentId: 'deploy', machineId: 'machine',
            installationId: 'installation', rootPath: root, manifestFingerprint: 'manifest', async assertCurrent() {}, async commit() {}, async abort() {} };
        const config = JSON.stringify({ os: 'linux', architecture: 'amd64', config: imageHealth ? { Healthcheck: imageHealth } : {} });
        const configDigest = `sha256:${createHash('sha256').update(config).digest('hex')}`;
        const manifestDigest = `sha256:${'b'.repeat(64)}`;
        const executable = { kind: 'systemTool', id: 'docker' } as const;
        const exec = createStablePluginExecService({ signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: '/docker' }), resolvePath: async () => root,
            systemTools: { async resolve(request) { return { grantId: 'docker-fixture', toolId: request.toolId, displayName: 'Docker fixture', source: 'system', executablePath: '/docker', launch: { kind: 'binary', executablePath: '/docker' } }; } } });
        const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime', signal: new AbortController().signal,
            isCurrent: () => true, async prepare() { return { env: { PATH: '/tools', HOME: root }, secretValues: [], refs: [], async recheck() {}, dispose() {} }; } });
        const commands: string[][] = [];
        const model = { services: { web: { image: 'app:latest', ...(health ? { healthcheck: health } : {}) },
            worker: { image: 'worker:latest', healthcheck: allHealthy ? { test: ['CMD', 'true'] } : { disable: true } } } };
        const project = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source, files: ['compose.yaml'],
            services: ['web', 'worker'], images: ['web', 'worker'].map(service => ({ service, platform: 'linux/amd64', configDigest, manifestDigest })),
            async settleNative() {}, io: { resolveTool: async () => ({ executablePath: '/docker', version: '29.9.0' }), async run(request) {
                commands.push([...request.args]);
                if (request.args.includes('version')) return { exitCode: 0, stdout: request.args.includes('compose') ? '2.39.4' : 'linux/amd64' };
                if (request.args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: 'health-engine', OperatingSystem: 'Linux' }) };
                if (request.args.includes('config')) return { exitCode: 0, stdout: JSON.stringify(model) };
                if (request.args.includes('save')) {
                    await writeFile(join(root, `${configDigest.slice(7)}.json`), config);
                    await writeFile(join(root, 'manifest.json'), JSON.stringify([{ Config: `${configDigest.slice(7)}.json`, Layers: [] }]));
                    await createTar({ file: request.args[request.args.indexOf('--output') + 1], cwd: root }, [`${configDigest.slice(7)}.json`, 'manifest.json']);
                }
                if (request.args.includes('ps')) return { exitCode: 0, stdout: ['a'.repeat(64), 'c'.repeat(64)].join('\n') };
                if (request.args.includes('inspect') && request.args.includes('container')) return { exitCode: 0,
                    stdout: JSON.stringify(['web', 'worker'].map((service, index) => ({ Id: (index ? 'c' : 'a').repeat(64), Image: manifestDigest,
                        Config: { Labels: { 'com.docker.compose.project': `happier-${createHash('sha256').update('instance').digest('hex')}`,
                            'com.docker.compose.service': service } }, State: { Status: 'running',
                            ...(healthy && (service === 'web' || allHealthy) ? { Health: { Status: 'healthy' } } : {}) },
                        RestartCount: 0, NetworkSettings: { Ports: {} } }))) };
                return { exitCode: 0, stdout: JSON.stringify([{ Id: manifestDigest }]) };
            } } });
        try {
            await writeFile(join(root, 'compose.yaml'), JSON.stringify(model));
            const rendered = await project.render();
            const activated = await machineNativeEffectAdmission.run({ operation: { operationId: 'health-wait', kind: 'deploy' }, keys: rendered.keys },
                context => project.activate({ render: rendered, context }));
            expect(activated.health).toBe(allHealthy ? 'healthy' : 'unverified');
            expect(await project.observe({ render: rendered })).toEqual({ status: 'matching', health: activated.health });
            const up = commands.filter(args => args.includes('up'));
            expect(up).toHaveLength(1);
            expect(up[0]).toEqual(expect.arrayContaining(['up', '--detach', '--wait']));
            expect(up[0]).not.toContain('--wait-timeout');
            expect(commands.some(args => args.includes('stop') || args.includes('down'))).toBe(false);
        } finally { await project.dispose(); await rm(root, { recursive: true, force: true }); }
    });

    it('admits stored inline configs only on a capable Compose version before rendering their content', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-stored-inline-config-'));
        let version = '2.23.0';
        let configReads = 0;
        let engineRunning = true;
        let hostPlatform = 'linux/amd64';
        let runtimeProjection: Awaited<ReturnType<typeof readNativeProjection>>;
        const configBoundary = await createNativeConfigBoundary(root);
        const document = { services: { web: { image: 'example/app', configs: [{ source: 'settings', target: '/app/settings.json' }] } },
            configs: { settings: { content: '{"port":"${PORT:?required}","password":"${PASSWORD:?required}"}' } } };
        let model: Record<string, unknown> = document;
        const source = { environmentId: 'env', environmentInstanceId: 'instance', deploymentId: 'deploy', machineId: 'machine',
            installationId: 'installation', rootPath: root, manifestFingerprint: 'manifest', async assertCurrent() {}, async commit() {}, async abort() {} };
        const executable = { kind: 'systemTool', id: 'docker' } as const;
        const exec = createStablePluginExecService({ signal: new AbortController().signal,
            isOccurrenceCurrent: () => true, resolveExecutable: async () => ({ command: '/docker' }), resolvePath: async () => root,
            systemTools: { async resolve(request) { return { grantId: 'docker-fixture', toolId: request.toolId, displayName: 'Docker fixture', source: 'system', executablePath: '/docker', launch: { kind: 'binary', executablePath: '/docker' } }; } } });
        const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime', signal: new AbortController().signal,
            isCurrent: () => true, async prepare() { return { env: { PATH: '/tools', HOME: root, PORT: '3000', PASSWORD: 'inline-secret', RUNTIME_PLATFORM: 'linux/arm64' },
                secretValues: ['inline-secret'], refs: [], async recheck() {}, dispose() {} }; } });
        const io: ProjectNativeToolchainIo = { resolveTool: async () => ({ executablePath: '/docker', version }), async run(request) {
            if (request.args.includes('version')) return { exitCode: 0, stdout: request.args.includes('compose') ? version : hostPlatform };
            if (request.args.includes('info')) return engineRunning
                ? { exitCode: 0, stdout: JSON.stringify({ ID: 'engine', OperatingSystem: 'Linux' }) }
                : { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' };
            if (request.args.includes('config')) {
                configReads++;
                if (!request.args.includes('--no-interpolate') && !request.args.includes('--variables')) {
                    runtimeProjection = await readNativeProjection(request);
                    expect(request.env.PASSWORD).not.toBe('inline-secret');
                }
                const response = configBoundary(request);
                if (!request.args.includes('--no-interpolate') && !request.args.includes('--variables')
                    && request.args[request.args.indexOf('--file') + 1] !== '-'
                    && runtimeProjection.configs?.settings) {
                    expect(JSON.parse(response.stdout).configs.settings.content).toBe('{"port":"3000","password":"inline-secret"}');
                }
                return response;
            }
            throw new Error('Unexpected native effect');
        } };
        const project = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source, sourceKind: 'stored',
            files: ['compose.yaml'], services: ['web'], images: [{ service: 'web', platform: 'linux/amd64',
                configDigest: `sha256:${'a'.repeat(64)}`, manifestDigest: `sha256:${'b'.repeat(64)}` }], io, async settleNative() {} });
        try {
            await writeFile(join(root, 'compose.yaml'), JSON.stringify(document));
            await expect(project.render()).rejects.toMatchObject({ code: 'unsupported', details: { reason: 'compose_inline_config_unsupported' } });
            await expect(project.prepareImages()).rejects.toMatchObject({ code: 'unsupported', details: { reason: 'compose_inline_config_unsupported' } });
            expect(configReads).toBe(0);
            model = { services: { web: { image: 'example/app' } } };
            await writeFile(join(root, 'compose.yaml'), JSON.stringify(model));
            expect((await project.render()).review.services).toMatchObject([{ name: 'web' }]);
            model = document;
            await writeFile(join(root, 'compose.yaml'), JSON.stringify(document));
            version = '2.23.1';
            const render = await project.render();
            expect(render.review.services).toMatchObject([{ name: 'web' }]);
            expect(JSON.stringify(render)).not.toContain('inline-secret');
            expect(runtimeProjection.configs.settings.content).toBe(document.configs.settings.content);
            model = { services: { web: { image: '${BUILD_ONLY_IMAGE:?required}', platform: '${RUNTIME_PLATFORM:?required}' } } };
            await writeFile(join(root, 'compose.yaml'), JSON.stringify(model));
            const armProject = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source,
                files: ['compose.yaml'], services: ['web'], images: [{ service: 'web', platform: 'linux/arm64',
                    configDigest: `sha256:${'c'.repeat(64)}`, manifestDigest: `sha256:${'d'.repeat(64)}` }], io, async settleNative() {} });
            try {
                const effective = await armProject.render();
                expect(effective).toMatchObject({ platform: 'linux/amd64', servicePlatforms: [{ service: 'web', platform: 'linux/arm64' }],
                    review: { inspection: 'complete' } });
                expect(runtimeProjection.services.web.image).toBeUndefined();
                expect(runtimeProjection.services.web.platform).toBe('${RUNTIME_PLATFORM:?required}');
                hostPlatform = 'linux/arm';
                expect(await armProject.render()).toMatchObject({ platform: 'linux/arm/v7',
                    servicePlatforms: [{ service: 'web', platform: 'linux/arm64' }] });
            } finally { hostPlatform = 'linux/amd64'; await armProject.dispose(); }
            const beforeUnavailableEngine = configReads;
            engineRunning = false;
            await expect(project.render()).rejects.toMatchObject({ code: 'native_tool_unavailable',
                details: { prerequisite: { cause: 'not_running' } } });
            expect(configReads).toBe(beforeUnavailableEngine);
        } finally { await project.dispose(); await rm(root, { recursive: true, force: true }); }
    });
    it('renders native risks and actual mount keys, activates pinned images once and retains N observation leases', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-environment-compose-'));
        const requests: Parameters<ProjectNativeToolchainIo['run']>[0][] = [];
        let disposed = 0;
        let prepared = 0;
        let current = true;
        const reviewReferenceAddress = 'http://127.0.0.1:44111';
        const containerReferenceAddress = 'http://172.22.0.1:44111';
        let referenceAddress = reviewReferenceAddress;
        const config = JSON.stringify({ os: 'linux', architecture: 'amd64', config: {} });
        const configDigest = `sha256:${createHash('sha256').update(config).digest('hex')}`;
        const manifestDigest = `sha256:${'b'.repeat(64)}`;
        const projectName = `happier-${createHash('sha256').update('instance').digest('hex')}`;
        const source = { environmentId: 'env', environmentInstanceId: 'instance', deploymentId: 'deploy',
            machineId: 'machine', installationId: 'installation', rootPath: root, manifestFingerprint: 'manifest',
            async assertCurrent() { if (!current) throw new Error('source_stale'); }, async commit() {}, async abort() {} };
        const executable = { kind: 'systemTool', id: 'docker' } as const;
        const exec = createStablePluginExecService({
            environment: { DOCKER_HOST: 'unix:///admitted-engine.sock' },
            signal: new AbortController().signal, isOccurrenceCurrent: () => current,
            resolveExecutable: async () => ({ command: '/docker' }), resolvePath: async () => root,
            systemTools: { async resolve(request) { return { grantId: 'docker-fixture', toolId: request.toolId, displayName: 'Docker fixture', source: 'system', executablePath: '/docker', launch: { kind: 'binary', executablePath: '/docker' } }; } },
        });
        const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime',
            signal: new AbortController().signal, isCurrent: () => current,
            async prepare() { prepared += 1; return { env: { PATH: '/tools', HOME: root, SECRET: 'native-secret', PORT: '3000', DATABASE_URL: referenceAddress },
                secretValues: ['native-secret'], refs: [{ resourceId: 'credential', resourceRevision: 7 }],
                referenceAddresses: [{ machineId: 'machine', installationId: 'installation', phase: 'runtime' as const, name: 'DATABASE_URL',
                    source: { kind: 'reference' as const, environmentId: 'database-env', export: 'database', via: 'auto' as const },
                    address: referenceAddress, route: { kind: 'iroh' as const, observedPath: 'unknown' as const } }],
                async recheck() {}, dispose() { disposed += 1; } }; },
        });
        let runtimePath = '';
        let runtimeProjection: Awaited<ReturnType<typeof readNativeProjection>>;
        let selectedSubset = false;
        const configBoundary = await createNativeConfigBoundary(root);
        const model = { name: 'happier-project', 'x-build': { args: { BUILDER_ONLY: '${BUILD_PUBLIC:?required}' } }, services: {
            web: { image: 'mutable:latest', deploy: { replicas: 2, resources: { limits: { cpus: '0.5', memory: '512M' } } },
                build: { args: { BUILDER_ONLY: '${BUILD_PUBLIC:?required}' }, secrets: ['BUILD_SECRET'] },
                environment: { SECRET: '${SECRET:?required}', DATABASE_URL: '${DATABASE_URL:?required}', 'x-setting': 'runtime-literal' },
                networks: { default: {} }, configs: ['runtime'], privileged: true,
                volumes: [{ type: 'bind', source: '/actual-native-bind', target: '/data' }] },
            db: { image: 'mutable-db:latest', volumes: [{ type: 'volume', source: 'db', target: '/db' }] },
        }, networks: { default: { name: 'reference-consumer-network' } },
            configs: { runtime: { environment: 'SECRET' } }, volumes: { db: { name: 'preserved-database' } },
            secrets: { BUILD_SECRET: { environment: 'BUILD_SECRET' } } };
        const io: ProjectNativeToolchainIo = { resolveTool: async () => ({ executablePath: '/docker', version: '29.9.0' }),
            async run(request) {
                requests.push(request);
                if (request.args.includes('version')) return { exitCode: 0, stdout: request.args.includes('compose') ? '2.39.4' : 'linux/amd64' };
                if (request.args.includes('info')) return { exitCode: 0, stdout: JSON.stringify({ ID: 'actual-engine', OperatingSystem: 'Ubuntu 24.04.3 LTS' }) };
                if (request.args.includes('config')) {
                    if (request.args.includes('--no-interpolate')) {
                        // Compose 2.39.4 / compose-go 2.9.0 resolves bare env
                        // values and environment-backed configs even without
                        // interpolation. Source normalization must have no app inputs.
                        expect(request.env).not.toHaveProperty('SECRET');
                        return configBoundary(request);
                    }
                    if (request.args.includes('--variables')) return configBoundary(request);
                    runtimeProjection = await readNativeProjection(request);
                    if (request.args[request.args.indexOf('--file') + 1] !== '-') {
                        runtimePath = request.args[request.args.indexOf('--file') + 1]!;
                        expect(runtimeProjection.services.web.build).toBeUndefined();
                        expect(runtimeProjection.services.web.image).not.toBe('mutable:latest');
                        expect(runtimeProjection.secrets).toEqual({});
                        expect(JSON.stringify(runtimeProjection)).not.toContain('BUILD_PUBLIC');
                        expect(JSON.stringify(runtimeProjection)).not.toContain('BUILD_SECRET');
                    }
                    expect(request.env).not.toHaveProperty('BUILD_PUBLIC');
                    expect(request.env).not.toHaveProperty('BUILD_SECRET');
                    expect(request.env.SECRET).not.toBe('native-secret');
                    return configBoundary(request);
                }
                if (request.args.includes('save')) {
                    await writeFile(join(root, `${configDigest.slice(7)}.json`), config);
                    await writeFile(join(root, 'manifest.json'), JSON.stringify([{ Config: `${configDigest.slice(7)}.json`, RepoTags: ['fixture:latest'], Layers: [] }]));
                    await createTar({ file: request.args[request.args.indexOf('--output') + 1], cwd: root }, [`${configDigest.slice(7)}.json`, 'manifest.json']);
                }
                if (request.args.includes('ps')) return { exitCode: 0, stdout: ['a'.repeat(64), 'c'.repeat(64)].join('\n') };
                if (request.args.includes('up')) {
                    const projection = await readNativeProjection(request);
                    expect(projection.services.web.environment.DATABASE_URL).toBe(containerReferenceAddress);
                }
                if (selectedSubset && request.args.includes('up')) {
                    const projection = await readNativeProjection(request);
                    expect(Object.keys(projection.services)).toEqual(['web', 'db']);
                    expect(projection.services.web.environment.SECRET).toBe('native-secret');
                    expect(projection.services.web.environment['x-setting']).toBe('runtime-literal');
                    expect(projection.configs.runtime.content).toBe('native-secret');
                    expect(request.env).not.toHaveProperty('SECRET');
                }
                if (request.args.includes('inspect') && request.args.includes('container')) return { exitCode: 0, stdout: JSON.stringify(['web', 'db'].map((service, index) => ({
                    Id: (index ? 'c' : 'a').repeat(64), Image: manifestDigest,
                    Config: { Image: 'fixture/app:release', Env: ['SECRET=native-secret'], Cmd: ['app'],
                        Labels: { 'com.docker.compose.project': projectName, 'com.docker.compose.service': service } },
                    HostConfig: { Memory: 512 * 1024 * 1024, CpuShares: 1024,
                        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } },
                    State: { Status: 'running' }, RestartCount: 0, NetworkSettings: { Ports: {} },
                }))) };
                return { exitCode: 0, stdout: JSON.stringify([{ Id: manifestDigest,
                    Descriptor: { digest: manifestDigest, mediaType: 'application/vnd.oci.image.manifest.v1+json' },
                    RepoDigests: [`native-secret@${manifestDigest}`], Os: 'linux', Architecture: 'amd64', Config: {} }]) };
            },
        };
        try {
            await writeFile(join(root, 'compose.yaml'), JSON.stringify(model));
            const project = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source, files: ['compose.yaml'],
                services: ['web', 'db'], images: ['web', 'db'].map(service => ({ service, platform: 'linux/amd64', configDigest, manifestDigest })), io,
                async prepareReferenceContainerNetwork(request) {
                    expect(request.networkId).toBe('reference-consumer-network');
                    referenceAddress = containerReferenceAddress;
                },
                async settleNative() {} });
            await expect(project.prepareImages()).rejects.toMatchObject({ code: 'unsupported' });
            expect(requests.some(request => request.args.includes('build') || request.args.includes('up'))).toBe(false);
            const rendered = await project.render();
            expect(referenceAddress).toBe(reviewReferenceAddress);
            expect(rendered.referenceAddresses?.[0]?.address).toBe(reviewReferenceAddress);
            const sourceDigest = `sha256:${createHash('sha256').update(await readFile(join(root, 'compose.yaml'))).digest('hex')}`;
            expect(rendered.basis.configInputDigests).toEqual([{ path: 'compose.yaml', digest: sourceDigest }]);
            expect(rendered).toMatchObject({ engine: { id: 'actual-engine', kind: 'native' } });
            expect(rendered.keys).toEqual([
                { kind: 'composeProject', dockerEndpoint: 'actual-engine', projectName: rendered.projectName },
            ]);
            expect(rendered.review).toMatchObject({ inspection: 'complete', services: [{ name: 'web' }, { name: 'db' }],
                risks: expect.arrayContaining([{ kind: 'privileged', service: 'web' }]) });
            expect(rendered).not.toHaveProperty('reviewModel');
            expect(JSON.stringify(rendered)).not.toContain('native-secret');
            const activation = await machineNativeEffectAdmission.run({ operation: { operationId: 'deploy', kind: 'deploy' }, keys: rendered.keys },
                context => project.activate({ render: rendered, context }));
            expect(referenceAddress).toBe(containerReferenceAddress);
            expect(rendered.basis.configInputDigests).toEqual([{ path: 'compose.yaml', digest: sourceDigest }]);
            expect(activation.nativeIdsForService('web')).toEqual(['a'.repeat(64)]);
            expect(activation.nativeIdsForService('db')).toEqual(['c'.repeat(64)]);
            expect(() => activation.nativeIdsForService('unadmitted')).toThrow();
            const effective = activation.nativeFactsForService('web');
            expect(effective).toMatchObject({ configuration: { name: 'web', replicas: 2,
                resources: { cpus: '0.5', memory: '512M' }, healthcheck: 'absent' },
                containerImages: [{ id: 'a'.repeat(64), nativeImageId: manifestDigest, imageConfigDigest: configDigest }] });
            expect(JSON.stringify(effective)).not.toContain('native-secret');
            expect(() => activation.nativeFactsForService('unadmitted')).toThrow();
            let nativeEvents: Parameters<NonNullable<import('./dockerEngineObservation').DockerEngineEventSource>>[0] | undefined;
            let observedNativeImage = manifestDigest;
            let observedMemory = 512 * 1024 * 1024;
            let observedSecret = 'native-secret';
            let hostConfigurationAvailable = true;
            let observationChanges = 0;
            const native = createNativeComposeLifecycle({ args: activation.composeArgs, engineId: 'actual-engine',
                environment: { composeService: 'web', containerIds: activation.nativeIdsForService('web'), facts: effective },
                io: { ...io, async events(request) { nativeEvents = request; return { async dispose() {} }; },
                    async run(request) {
                        expect(request.env).not.toHaveProperty('SECRET');
                        expect(request.env).not.toHaveProperty('PORT');
                        expect(request.env.DOCKER_HOST).toBe('unix:///admitted-engine.sock');
                        const response = await io.run(request);
                        if (request.args.includes('inspect') && request.args.includes('container')) {
                            const rows: unknown[] = JSON.parse(response.stdout);
                            return { ...response, stdout: JSON.stringify(rows.flatMap(row => {
                                if (row === null || typeof row !== 'object' || !('Id' in row) || row.Id !== 'a'.repeat(64)) return [];
                                const updated = { ...row, Image: observedNativeImage,
                                    ...('Config' in row && row.Config !== null && typeof row.Config === 'object'
                                        ? { Config: { ...row.Config, Env: [`SECRET=${observedSecret}`] } } : {}),
                                    HostConfig: { Memory: observedMemory, CpuShares: 1024,
                                        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } } };
                                if (!hostConfigurationAvailable) Reflect.deleteProperty(updated, 'HostConfig');
                                return [updated];
                            })) };
                        }
                        return response;
                    } } });
            const observerLaunch = activation.authorizeServiceObserver();
            native.bindLaunch(observerLaunch);
            expect(native.lifecycle.runtimeFacts!()).toMatchObject({ configuration: effective.configuration,
                freshness: 'unavailable', observedAt: null });
            const observation = await native.lifecycle.observe!(() => { observationChanges += 1; });
            try {
                const facts = native.lifecycle.runtimeFacts!();
                expect(facts).toMatchObject({ configuration: effective.configuration, freshness: 'current', observedAt: expect.any(Number) });
                expect(native.lifecycle.nativeContainers!()).toMatchObject([{ id: 'a'.repeat(64),
                    nativeImageId: manifestDigest, imageConfigDigest: configDigest, configurationMatches: true }]);
                const nativeReadCount = requests.length;
                for (let index = 0; index < 100; index++) expect(native.lifecycle.runtimeFacts!()).toBe(facts);
                nativeEvents!.event({ Type: 'container', Action: 'start', Actor: { ID: 'unrelated-container' } });
                await Promise.resolve();
                expect(requests).toHaveLength(nativeReadCount);
                expect(native.lifecycle.runtimeFacts!()).toBe(facts);
                nativeEvents!.event({ Type: 'container', Action: 'start', Actor: { ID: 'a'.repeat(64) } });
                await nextTurn();
                expect(requests).toHaveLength(nativeReadCount + 1);
                expect(native.lifecycle.runtimeFacts!()).toBe(facts);
                const unchangedContainers = native.lifecycle.nativeContainers!();
                const unchangedPublications = observationChanges;
                observedMemory *= 2;
                nativeEvents!.event({ Type: 'container', Action: 'update', Actor: { ID: 'unrelated-container' } });
                await nextTurn();
                expect(requests).toHaveLength(nativeReadCount + 1);
                nativeEvents!.event({ Type: 'container', Action: 'update', Actor: { ID: 'a'.repeat(64) } });
                await nextTurn();
                expect(requests).toHaveLength(nativeReadCount + 2);
                expect(native.lifecycle.nativeContainers!()).toMatchObject([{ id: 'a'.repeat(64),
                    nativeImageId: manifestDigest, imageConfigDigest: configDigest, configurationMatches: false }]);
                expect(observationChanges).toBe(unchangedPublications + 1);
                const changedContainers = native.lifecycle.nativeContainers!();
                nativeEvents!.event({ Type: 'container', Action: 'update', Actor: { ID: 'a'.repeat(64) } });
                await nextTurn();
                expect(native.lifecycle.nativeContainers!()).toBe(changedContainers);
                expect(observationChanges).toBe(unchangedPublications + 1);
                observedMemory /= 2;
                nativeEvents!.event({ Type: 'container', Action: 'update', Actor: { ID: 'a'.repeat(64) } });
                await nextTurn();
                expect(native.lifecycle.nativeContainers!()).toEqual(unchangedContainers);
                // Config changes are distinct from HostConfig updates and must
                // never publish either the value or its private witness.
                observedSecret = 'changed-native-secret';
                nativeEvents!.event({ Type: 'container', Action: 'update', Actor: { ID: 'a'.repeat(64) } });
                await nextTurn();
                expect(native.lifecycle.nativeContainers!()).toMatchObject([{ configurationMatches: false }]);
                expect(native.lifecycle.nativeContainers!()![0]).not.toHaveProperty('configurationWitness');
                expect(JSON.stringify(native.lifecycle.nativeContainers!())).not.toContain(observedSecret);
                observedSecret = 'native-secret';
                hostConfigurationAvailable = false;
                nativeEvents!.event({ Type: 'container', Action: 'update', Actor: { ID: 'a'.repeat(64) } });
                await nextTurn();
                expect(native.lifecycle.nativeContainers!()![0]).not.toHaveProperty('configurationMatches');
                hostConfigurationAvailable = true;
                // A native alias is not itself portable proof: contradictory
                // inspection cannot inherit the activation's CONFIG witness.
                observedNativeImage = `sha256:${'e'.repeat(64)}`;
                nativeEvents!.event({ Type: 'container', Action: 'start', Actor: { ID: 'a'.repeat(64) } });
                await nextTurn();
                expect(native.lifecycle.nativeContainers!()).toMatchObject([{ nativeImageId: observedNativeImage }]);
                expect(native.lifecycle.nativeContainers!()![0]).not.toHaveProperty('imageConfigDigest');
                const latest = native.lifecycle.runtimeFacts!();
                nativeEvents!.disconnected();
                expect(native.lifecycle.runtimeFacts!()).toMatchObject({ configuration: effective.configuration,
                    freshness: 'unavailable', observedAt: latest.observedAt });
                expect(native.lifecycle.nativeContainers!()).toBeNull();
            } finally { await observation.dispose(); await observerLaunch.release(); }
            const first = activation.authorizeServiceObserver();
            const second = activation.authorizeServiceObserver();
            // Detached native observation keeps the sanitizer, never the
            // application environment that was delivered during activation.
            expect(first.env).not.toHaveProperty('SECRET');
            expect(second.env).not.toHaveProperty('SECRET');
            expect(first.env).not.toHaveProperty('PORT');
            expect(first.env.DOCKER_HOST).toBe('unix:///admitted-engine.sock');
            expect(first).toHaveProperty('deploymentSecretRefs', [{ resourceId: 'credential', resourceRevision: 7 }]);
            expect(disposed).toBe(prepared);
            expect(first.secretRedactionLease?.redact('native-secret PORT=3000'))
                .toBe('[REDACTED] PORT=3000');
            const initialDisposals = disposed;
            await activation.dispose();
            await project.dispose();
            expect(disposed).toBe(initialDisposals);
            await expect(readFile(runtimePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            await first.release();
            expect(disposed).toBe(initialDisposals);
            expect(second.secretRedactionLease?.isActive()).toBe(true);
            await second.release();
            expect(disposed).toBe(initialDisposals);
            expect(second.secretRedactionLease?.isActive()).toBe(false);
            expect(requests.filter(request => request.args.includes('up'))).toHaveLength(1);
            expect(requests.find(request => request.args.includes('up'))?.args).toEqual(expect.arrayContaining([
                'up', '--detach', '--wait', '--remove-orphans', '--no-build', '--pull', 'never',
            ]));
            expect(requests.some(request => request.args.includes('stop') || request.args.includes('down') || request.args.includes('pull') && !request.args.includes('never'))).toBe(false);
            const mismatchedConfig = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source,
                files: ['compose.yaml'], services: ['web', 'db'],
                images: ['web', 'db'].map(service => ({ service, platform: 'linux/amd64', configDigest: `sha256:${'d'.repeat(64)}`, manifestDigest })), io,
                async settleNative() {} });
            try {
                const changed = await mismatchedConfig.render();
                await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'wrong-manifest', kind: 'deploy' }, keys: changed.keys },
                    context => mismatchedConfig.activate({ render: changed, context })))
                    .rejects.toMatchObject({ details: { reason: 'deployment_image_identity_mismatch' } });
                expect(requests.filter(request => request.args.includes('up'))).toHaveLength(1);
            } finally { await mismatchedConfig.dispose(); }
            let archiveTransfers = 0;
            const unpreparedRuntime = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source,
                files: ['compose.yaml'], services: ['web', 'db'],
                images: [{ service: 'web', platform: 'linux/amd64', configDigest, manifestDigest }],
                imageAcquisition: { operation: 'deploy', archives: [{
                    image: { service: 'web', platform: 'linux/amd64', configDigest, manifestDigest }, sizeBytes: 1, sha256: '0'.repeat(64),
                    async acquire() { archiveTransfers += 1; throw new Error('archive_transfer_unavailable'); },
                }] },
                // Docker has no local image: complete receipt admission must
                // precede the real archive-transfer boundary for any service.
                io: { ...io, async run(request) { return request.args[0] === 'image' && request.args[1] === 'inspect'
                    ? { exitCode: 1, stdout: '' } : io.run(request); } },
                async settleNative() {} });
            try {
                const preview = await unpreparedRuntime.render();
                expect(preview).toMatchObject({ platform: 'linux/amd64',
                    review: { inspection: 'unknown', risks: expect.arrayContaining([{ kind: 'inspection_unknown', service: 'db' }]) } });
                expect(runtimeProjection.services.db.image).toBeUndefined();
                expect(requests.filter(request => request.args.includes('up'))).toHaveLength(1);
                expect(requests.some(request => request.args.includes('pull') && !request.args.includes('never'))).toBe(false);
                await expect(machineNativeEffectAdmission.run({ operation: { operationId: 'missing-pin', kind: 'deploy' }, keys: preview.keys },
                    context => unpreparedRuntime.activate({ render: preview, context })))
                    .rejects.toMatchObject({ details: { reason: 'deployment_image_unavailable' } });
                expect(archiveTransfers).toBe(0);
            } finally { await unpreparedRuntime.dispose(); }
            const unbuilt = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source,
                files: ['compose.yaml'], services: ['web', 'db'],
                images: [{ service: 'db', platform: 'linux/amd64', configDigest, manifestDigest }], io,
                async settleNative() {} });
            try {
                const preview = await unbuilt.render();
                expect(preview).toMatchObject({ platform: 'linux/amd64', buildServices: ['web'],
                    review: { inspection: 'unknown', risks: expect.arrayContaining([{ kind: 'inspection_unknown', service: 'web' }]) } });
                expect(requests.some(request => request.args.includes('config') && request.args.includes('--no-consistency'))).toBe(true);
                expect(requests.filter(request => request.args.includes('up'))).toHaveLength(1);
                expect(requests.some(request => request.args.includes('build'))).toBe(false);
            } finally { await unbuilt.dispose(); }
            selectedSubset = true;
            await writeFile(join(root, 'compose.yaml'), JSON.stringify({ ...model, services: { ...model.services,
                web: { ...model.services.web, depends_on: { db: { condition: 'service_started' } } },
                unused: { image: 'required-unselected:latest', build: { args: { REQUIRED: '${BUILD_PUBLIC:?unselected build only}' } } },
            } }));
            const subset = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source,
                files: ['compose.yaml'], services: ['web'], images: ['web', 'db'].map(service => ({ service,
                    platform: 'linux/amd64', configDigest, manifestDigest })), io, async settleNative() {} });
            try {
                const selected = await subset.render();
                expect(selected.services).toEqual(['web', 'db']);
                expect(selected.buildServices).toEqual(['web']);
                expect(selected.review).toMatchObject({ inspection: 'complete', services: [{ name: 'web' }, { name: 'db' }] });
                const activated = await machineNativeEffectAdmission.run({ operation: { operationId: 'selected-subset', kind: 'deploy' }, keys: selected.keys },
                    context => subset.activate({ render: selected, context }));
                expect(activated.services).toEqual(['web', 'db']);
                expect(requests.filter(request => request.args.includes('up')).at(-1)?.args).not.toContain('unused');
            } finally { selectedSubset = false; await subset.dispose(); }
            await writeFile(join(root, 'compose.yaml'), JSON.stringify({ services: { web: { image: '${SECRET}' } } }));
            const candidate = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source,
                files: ['compose.yaml'], services: ['web'], images: [], io, async settleNative() {} });
            try {
                const { images } = await candidate.prepareImages();
                expect(images).toEqual([{ service: 'web', platform: 'linux/amd64', configDigest, manifestDigest }]);
                expect(JSON.stringify(images)).not.toContain('native-secret');
                expect(requests.filter(request => request.args.includes('up'))).toHaveLength(2);
            } finally { await candidate.dispose(); }
            current = false;
            await expect(project.render()).rejects.toThrow();
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
