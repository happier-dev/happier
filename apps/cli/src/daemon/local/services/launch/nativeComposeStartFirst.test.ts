import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { DeploymentImageV1 } from '@happier-dev/deployment-protocol';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createNativeComposeLifecycle, type NativeComposeEnvironmentProject, type NativeComposeActivatedProject } from './nativeComposeLifecycle';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';
import { createNativeCaddyRoutes } from '@/machines/reachability/nativeCaddyRoutes';
import { materializeCaddyDomainRouteV1, type CaddyDomainRouteInput, type CaddyRoute } from '@/deployments/targets/ownServer/caddyRouteMaterialization';

describe('Environment start-first native generation', () => {
    // Docker executable and Caddy HTTP are external boundaries. Native rendering,
    // image/generation proof, admission and route ownership remain production logic.
    it.skipIf(process.platform === 'win32').each(['switched', 'unknown', 'cancelled', 'unhealthy', 'healthless', 'stateful', 'imageVolume', 'fixedPort',
        'rollbackStable', 'rollbackStableUnknown', 'rollbackCandidate', 'rollbackCandidateUnknown'] as const)(
        'preserves the native start-first contract with %s', async outcome => {
        const root = await mkdtemp(join(tmpdir(), 'happier-start-first-'));
        const projects: NativeComposeEnvironmentProject[] = [];
        const rollback = outcome.startsWith('rollback');
        const rollbackCandidate = outcome.includes('Candidate');
        try {
            const docker = await createOwnServerDockerBoundary(join(root, 'docker'));
            const imagesA = [await docker.registerImage('web', 'A'), await docker.registerImage('api', 'A')];
            const imagesB = [await docker.registerImage('web', 'B', outcome === 'imageVolume' ? { volumes: ['/data'] } : undefined),
                await docker.registerImage('api', 'B')];
            const controller = new AbortController();
            const signal = new AbortController().signal;
            // Exercise the canonical Docker executable testkit at the OS
            // boundary directly; process custody has its own adjacent suite.
            const io: ProjectNativeToolchainIo = { async resolveTool() { return { executablePath: docker.executablePath, version: 'fixture' }; },
                async run(request) {
                    request.signal?.throwIfAborted();
                    const output = spawnSync(process.execPath, [docker.executablePath, ...request.args], {
                        cwd: request.cwd, env: request.env, encoding: 'utf8',
                        ...(request.stdin ? { input: Buffer.from(request.stdin) } : {}) });
                    if (output.error) throw output.error;
                    if (output.status === null) throw new Error(`Docker boundary terminated by signal ${output.signal}`);
                    request.signal?.throwIfAborted();
                    return { exitCode: output.status, stdout: output.stdout, stderr: output.stderr };
                } };
            const makeProject = async (deploymentId: string, images: readonly DeploymentImageV1[]) => {
                const rootPath = join(root, deploymentId);
                await mkdir(rootPath, { recursive: true });
                await writeFile(join(rootPath, 'compose.yaml'), JSON.stringify({ services: Object.fromEntries(images.map(image => [image.service, {
                    image: image.registryReference, deploy: { replicas: 2 }, healthcheck: { test: ['CMD', 'true'] },
                    restart: 'unless-stopped', stop_grace_period: '17s',
                    ...(deploymentId === 'B' && outcome === 'healthless' ? { healthcheck: { disable: true } } : {}),
                    ...(deploymentId === 'B' && outcome === 'stateful' ? { volumes: [{ type: 'bind', source: root, target: '/data' }] } : {}),
                    ...(deploymentId === 'B' && outcome === 'fixedPort' ? { ports: [{ target: 3000, published: '3000' }] } : {}),
                }])) }));
                const source = { environmentId: 'env', environmentInstanceId: 'instance', deploymentId,
                    machineId: 'machine', installationId: 'installation', rootPath, manifestFingerprint: deploymentId,
                    async assertCurrent() {}, async commit() {}, async abort() {} };
                const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
                    async resolveExecutable() { return { command: docker.executablePath }; }, async resolvePath() { return rootPath; },
                    systemTools: { async resolve(request) { return { grantId: 'docker-fixture', toolId: request.toolId, displayName: 'Docker fixture', source: 'system', executablePath: docker.executablePath,
                        launch: { kind: 'binary', executablePath: docker.executablePath } }; } } });
                const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime', signal, isCurrent: () => true,
                    async prepare() { return { env: { PATH: process.env.PATH ?? '', HOME: root }, secretValues: [], refs: [],
                        async recheck() {}, dispose() {} }; } });
                const project = createNativeComposeLifecycle({ kind: 'environmentProject', source, exec, envPort,
                    files: ['compose.yaml'], services: ['web', 'api'], images, io,
                    async settleNative() {} });
                projects.push(project);
                return project;
            };
            const makeRetained = async () => {
                const stable = await makeProject('A', imagesA);
                if (!rollbackCandidate) return stable;
                const retained = stable.createStartFirstCandidate();
                projects.push(retained);
                return retained;
            };
            const first = await makeRetained();
            const initial = await first.render();
            let incumbent = await machineNativeEffectAdmission.run({ operation: { operationId: 'A', kind: 'deploy' }, keys: initial.keys },
                context => first.activate({ render: initial, context }));
            let observeIncumbent: (() => Promise<Readonly<{ kind: 'active'; activation: NativeComposeActivatedProject }>
                | Readonly<{ kind: 'absent' | 'unknown' }>>) | undefined;
            if (outcome === 'switched' || rollback) {
                // A fresh runtime owner has no in-memory activation. Recover
                // the incumbent from Docker without up/recreate or a stored copy.
                const cold = await makeRetained();
                const coldRender = await cold.render();
                const observe = Reflect.get(cold, 'observeActivated') as ((input: Readonly<{ render: typeof coldRender }>) =>
                    ReturnType<NonNullable<typeof observeIncumbent>>) | undefined;
                expect(observe, 'the native owner must expose its Docker-observed incumbent').toBeTypeOf('function');
                observeIncumbent = () => observe!({ render: coldRender });
                const observed = await observeIncumbent();
                expect(observed.kind).toBe('active');
                if (observed.kind !== 'active') throw new Error('Expected the native incumbent');
                incumbent = observed.activation;
            }
            const domainRoute = (service: string, names: readonly string[]): CaddyDomainRouteInput => {
                const [firstName, ...rest] = names;
                if (!firstName) throw new Error('missing native replica');
                return { domainId: `domain-${service}`, domain: { hostname: `${service}.example.test`,
                    target: { service, containerPort: 3000 }, healthCheck: { path: '/healthz', expectStatus: 200 } },
                    listener: 'privateOrigin', upstreams: { kind: 'replicas', containerNames: [firstName, ...rest] }, privateSourceRanges: [] };
            };
            const previousRoutes = incumbent.routingGeneration().services.map(service => domainRoute(service.service, service.replicas.map(replica => replica.name)));
            const nativeRoutes: CaddyRoute[] = previousRoutes.map(route => materializeCaddyDomainRouteV1(route).route);
            let version = 1;
            let restoring = false;
            // Only the Caddy HTTP exchange is substituted; the native route
            // materializer, exact prior-material check and acknowledgement are real.
            const routeOwner = createNativeCaddyRoutes({ machineId: 'machine', installationId: 'installation', privateKey: new Uint8Array(64),
                async exchange(request) {
                    request.signal?.throwIfAborted();
                    if (request.method === 'GET') return { status: 200, etag: `"v${version}"`, value: { routes: structuredClone(nativeRoutes), errors: { routes: [] } } };
                    if (request.method !== 'PATCH' || request.etag !== `"v${version}"`) return { status: 412 };
                    const id = decodeURIComponent(request.path.slice('/id/'.length));
                    const index = nativeRoutes.findIndex(route => route['@id'] === id);
                    if (index < 0 || !request.value || typeof request.value !== 'object' || !('handle' in request.value)) return { status: 404 };
                    nativeRoutes[index] = request.value as CaddyRoute; // Native JSON boundary mirrors the Caddy response schema.
                    version++;
                    if (outcome === 'unknown' || restoring && outcome.endsWith('Unknown')) throw new Error('native acknowledgement lost after write');
                    return { status: 200 };
                } });
            const second = await makeProject('B', imagesB);
            const candidate = second.createStartFirstCandidate();
            projects.push(candidate);
            const rendered = await candidate.render();
            expect(rendered.projectName).not.toBe(initial.projectName);
            expect(rendered.keys).toEqual(initial.keys);
            if (outcome === 'unhealthy') await docker.failImageHealth(imagesB[1]!.configDigest);
            let switches = 0;
            const incumbentIds = ['web', 'api'].flatMap(service => incumbent.nativeIdsForService(service));
            const activated = await machineNativeEffectAdmission.run({ operation: { operationId: 'B', kind: 'deploy' }, keys: rendered.keys },
                async context => {
                    const beforeSwitch = (await docker.readInvocations()).length;
                    const operation = candidate.activateStartFirst({ render: rendered, context, incumbent, signal: controller.signal,
                        routes: { async switch(request) {
                            switches++;
                            expect(request.candidate.services.map(service => service.replicas.length)).toEqual([2, 2]);
                            expect(await first.observe({ render: initial })).toMatchObject({ status: 'matching', health: 'healthy' });
                            expect((await docker.readInvocations()).slice(beforeSwitch).some(call => call.args.includes('stop'))).toBe(false);
                            for (const service of request.candidate.services) {
                                const previous = previousRoutes.find(route => route.domain.target.service === service.service)!;
                                const result = await routeOwner.activate({ placement: { serverId: 'home', accountId: 'account', environmentId: 'env',
                                    targetLinkId: 'link', domainId: previous.domainId, machineId: 'machine', installationId: 'installation',
                                    actionOperationId: 'B', requestId: 'request-B', nativeServer: 'happier_private' },
                                    route: domainRoute(service.service, service.replicas.map(replica => replica.name)),
                                    expected: materializeCaddyDomainRouteV1(previous), signal: request.signal });
                                if ('reason' in result) return result;
                                if (result.kind === 'absent') return { kind: 'unavailable', reason: 'native_route_absent' };
                            }
                            if (outcome === 'cancelled') controller.abort();
                            return { kind: 'switched' };
                        } } });
                    if (outcome === 'cancelled' || outcome === 'unhealthy' || outcome === 'healthless' || outcome === 'stateful' || outcome === 'imageVolume' || outcome === 'fixedPort') {
                        await expect(operation).rejects.toBeDefined();
                        return null;
                    }
                    const result = await operation;
                    expect(result.kind).toBe(outcome === 'switched' || rollback ? 'activated' : 'route_not_switched');
                    return result.activation;
                });
            if (outcome !== 'switched' && !rollback) {
                expect((await docker.readInvocations()).filter(call => call.args.includes('stop'))).toHaveLength(0);
                expect(switches).toBe(outcome === 'unknown' || outcome === 'cancelled' ? 1 : 0);
                expect(await first.observe({ render: initial })).toMatchObject({ status: 'matching', health: 'healthy' });
                return;
            }
            expect(activated).not.toBeNull();
            if (!activated) throw new Error('candidate activation missing');
            expect(activated.health).toBe('healthy');
            const generation = activated.routingGeneration();
            expect(generation.services.map(service => service.replicas.length)).toEqual([2, 2]);
            expect(new Set(generation.services.flatMap(service => service.replicas.map(replica => replica.name))).size).toBe(4);
            for (const service of generation.services) {
                expect(service.stopGracePeriodSeconds).toBe(17);
                expect(service.replicas.every(replica => replica.networks.includes(`${rendered.projectName}_default`))).toBe(true);
            }
            expect(await first.observe({ render: initial })).toMatchObject({ status: 'different' });
            expect(await observeIncumbent!()).toMatchObject({ kind: 'absent' });
            expect(incumbentIds).not.toEqual(['web', 'api'].flatMap(service => activated.nativeIdsForService(service)));
            const up = (await docker.readInvocations()).filter(call => call.args.includes('up'));
            expect(up).toHaveLength(2);
            expect(up.every(call => call.args.includes('--wait') && !call.args.includes('--wait-timeout'))).toBe(true);
            const stops = (await docker.readInvocations()).filter(call => call.args.includes('stop'));
            expect(stops).toHaveLength(1);
            expect(stops[0]!.args).toEqual(['container', 'stop', ...incumbentIds]);
            expect(stops[0]!.args).not.toContain('--timeout');
            if (rollback) {
                const custody = await candidate.observeActivated({ render: rendered, purpose: 'retire' });
                expect(custody).toMatchObject({ kind: 'active', activation: { health: 'unverified' } });
                // Retirement custody is never a cached readiness certificate.
                // A later target read still traverses strict native inspection.
                expect(await candidate.observeActivated({ render: rendered }))
                    .toMatchObject({ kind: 'active', activation: { health: 'healthy' } });
                // The earlier forward cutover retired A. The controller's
                // existing restore(A) first reactivates its deterministic owner;
                // this alone does NOT switch routes away from B.
                const restored = await makeRetained();
                const restoreRender = await restored.render();
                expect(restoreRender.projectName).toBe(initial.projectName);
                const losingIds = generation.services.flatMap(service => service.replicas.map(replica => replica.id));
                let observedTarget: NativeComposeActivatedProject | undefined;
                const result = await machineNativeEffectAdmission.run({ operation: { operationId: 'restore-A', kind: 'restore' }, keys: restoreRender.keys }, async context => {
                    await restored.activate({ render: restoreRender, context });
                    const cold = await makeRetained();
                    const targetRender = await cold.render();
                    const target = await cold.observeActivated({ render: targetRender });
                    if (target.kind !== 'active') throw new Error('Expected retained A observed through its native owner');
                    observedTarget = target.activation;
                    const before = await docker.readInvocations();
                    restoring = true;
                    const cutover = await cold.activateStartFirst({ render: targetRender, context, incumbent: activated,
                        target: target.activation, routes: { async switch(request) {
                            expect(request.candidate.projectName).toBe(initial.projectName);
                            expect(request.incumbent.projectName).toBe(rendered.projectName);
                            for (const service of request.candidate.services) {
                                const losing = generation.services.find(value => value.service === service.service)!;
                                const result = await routeOwner.activate({ placement: { serverId: 'home', accountId: 'account', environmentId: 'env',
                                    targetLinkId: 'link', domainId: `domain-${service.service}`, machineId: 'machine', installationId: 'installation',
                                    actionOperationId: 'restore-A', requestId: 'request-restore-A', nativeServer: 'happier_private' },
                                    route: domainRoute(service.service, service.replicas.map(replica => replica.name)),
                                    expected: materializeCaddyDomainRouteV1(domainRoute(service.service, losing.replicas.map(replica => replica.name))) });
                                if ('reason' in result) return result;
                                if (result.kind === 'absent') return { kind: 'unavailable', reason: 'native_route_absent' };
                            }
                            return { kind: 'switched' };
                        } } });
                    expect((await docker.readInvocations()).slice(before.length).some(call => call.args.includes('up')),
                        'an observed target cutover must not recreate the retained generation').toBe(false);
                    expect(await cold.observeActivated({ render: targetRender })).toMatchObject({ kind: 'active' });
                    return cutover;
                });
                if (outcome.endsWith('Unknown')) {
                    expect(result).toMatchObject({ kind: 'route_not_switched', route: { kind: 'unknown' } });
                    expect(await candidate.observeActivated({ render: rendered })).toMatchObject({ kind: 'active' });
                    expect((await docker.readInvocations()).filter(call => call.args.includes('stop'))).toHaveLength(1);
                } else {
                    expect(result).toMatchObject({ kind: 'activated', activation: observedTarget });
                    expect(await candidate.observeActivated({ render: rendered })).toMatchObject({ kind: 'absent' });
                    const stopped = (await docker.readInvocations()).filter(call => call.args.includes('stop'));
                    expect(stopped).toHaveLength(2);
                    expect(stopped[1]!.args).toEqual(['container', 'stop', ...losingIds]);
                    for (const service of observedTarget!.routingGeneration().services) for (const replica of service.replicas)
                        expect(JSON.stringify(nativeRoutes)).toContain(replica.name);
                }
            }
        } finally {
            await Promise.all(projects.map(project => project.dispose()));
            await rm(root, { recursive: true, force: true });
        }
    });
});
