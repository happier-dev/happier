import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseNativeDockerEngineInfo } from '@happier-dev/cli-common/machineSetup';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { acquirePrivateServiceContainerBridge } from './privateServiceContainerBridge';
import { prepareNativeComposeReferenceNetwork } from '@/daemon/local/services/launch/nativeComposeReferenceNetwork';

const execute = promisify(execFile);
const dockerExecutable = process.env.HAPPIER_TEST_PRIVATE_SERVICE_DOCKER_EXECUTABLE ?? 'docker';
const nativeEnvironment = { ...process.env, HOME: userInfo().homedir };

// Uses the same cached BusyBox qualification image as nativeResticNetwork.testkit.
// Uses only its own Docker objects. The bridge owner acquires the pinned relay image.
it.skipIf(process.env.HAPPIER_TEST_PRIVATE_SERVICE_CONTAINER_BRIDGE !== '1')(
    'prepares only the consumer network, preserves the incumbent, and forwards only that Docker network to loopback', async () => {
        const run: ProjectNativeDockerPort['run'] = async args => {
            try {
                const output = await execute(dockerExecutable, [...args], { env: nativeEnvironment });
                return { exitCode: 0, stdout: output.stdout, stderr: output.stderr };
            } catch (error) {
                if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'number') throw error;
                return { exitCode: error.code, stdout: 'stdout' in error ? String(error.stdout) : '',
                    stderr: 'stderr' in error ? String(error.stderr) : '' };
            }
        };
        const checked = async (args: readonly string[]) => {
            const result = await run(args);
            expect(result.exitCode, result.stderr).toBe(0);
            return result.stdout.trim();
        };
        const engine = parseNativeDockerEngineInfo(await checked(['info', '--format', '{{json .}}']));
        if (!engine) throw new Error('Docker engine inspection unavailable');
        const image = await checked(['image', 'inspect', 'busybox:1.37', '--format', '{{.Id}}']);
        const prefix = `happier-private-bridge-${randomUUID()}`;
        const directory = await mkdtemp(join(tmpdir(), 'happier-private-bridge-docker-'));
        const networks: string[] = [];
        const containers: string[] = [];
        const service = createServer((_request, response) => response.end('loopback-service-reached'));
        const serviceSockets = new Set<import('node:net').Socket>();
        service.on('connection', socket => { serviceSockets.add(socket); socket.once('close', () => serviceSockets.delete(socket)); });
        service.listen(0, '127.0.0.1');
        await once(service, 'listening');
        const address = service.address();
        if (!address || typeof address === 'string') throw new Error('Missing test service address');
        let bridge: Awaited<ReturnType<typeof acquirePrivateServiceContainerBridge>> | undefined;
        try {
            const unrelated = await checked(['network', 'create', `${prefix}-unrelated`]);
            networks.push(`${prefix}-consumer`, unrelated);
            const incumbent = await checked(['create', '--label', `com.docker.compose.project=${prefix}`,
                '--label', 'com.docker.compose.service=incumbent', '--network', unrelated, image, 'httpd', '-f', '-p', '8080']);
            containers.push(incumbent);
            await checked(['start', incumbent]);
            const previous = await checked(['inspect', '--format', '{{.Id}} {{.State.Running}} {{.RestartCount}}', incumbent]);
            await prepareNativeComposeReferenceNetwork({ docker: { engineId: engine.id, async run(args) {
                const result = await run(args);
                expect(result.exitCode, result.stderr).toBe(0);
                return result;
            } }, projectName: prefix,
                sourceRoot: directory, directory, imageReference: image,
                services: ['app'], referenceAddresses: ['http://127.0.0.1:44111'],
                model: { services: { app: { environment: { REF: 'http://127.0.0.1:44111' }, networks: { private: {} } } },
                    networks: { private: { name: networks[0]!, driver_opts: { 'com.docker.network.bridge.gateway_mode_ipv4': 'nat-unprotected' } } } } });
            expect(await checked(['ps', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${prefix}`,
                '--format', '{{.ID}}'])).toBe(incumbent);
            expect(await checked(['inspect', '--format', '{{.Id}} {{.State.Running}} {{.RestartCount}}', incumbent])).toBe(previous);
            bridge = await acquirePrivateServiceContainerBridge({ docker: { engineId: engine.id, run }, engine,
                networkId: networks[0]!, route: { key: prefix }, forward: { host: '127.0.0.1', port: address.port } });
            const response = await fetch(`http://127.0.0.1:${address.port}`);
            expect(await response.text()).toBe('loopback-service-reached');
            const hostAddresses = Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address) ?? []);
            expect(hostAddresses, 'The consumer route must stay off host INPUT').not.toContain(bridge.host);
            const inspectIp = (id: string) => checked(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', id]);
            const control = await checked(['create', '--pull=never', '--network', networks[0]!, image,
                'sh', '-c', 'mkdir -p /www; echo direct-routing-control >/www/index.html; httpd -p 8080 -h /www; exec sleep 60']);
            containers.push(control);
            await checked(['start', control]);
            const read = async (network: string, url: string) => {
                const probe = await checked(['create', '--pull=never', '--network', network, image, 'wget', '-q', '-T', '2', '-O', '-', url]);
                containers.push(probe);
                return run(['start', '--attach', probe]);
            };
            const admitted = await read(networks[0]!, `http://${bridge.host}:${bridge.port}`);
            expect(admitted.exitCode, admitted.stderr).toBe(0);
            expect(admitted.stdout).toBe('loopback-service-reached');
            const controlResult = await read(unrelated, `http://${await inspectIp(control)}:8080`);
            expect(controlResult.exitCode, 'The outside network must be able to route to a sibling on the relay network').toBe(0);
            expect(controlResult.stdout.trim()).toBe('direct-routing-control');
            expect(await checked(['port', bridge.host])).toBe('');
            expect(await checked(['inspect', '--format', '{{len .NetworkSettings.Networks}}', bridge.host])).toBe('1');
            const denied = await read(unrelated, `http://${await inspectIp(bridge.host)}:${bridge.port}`);
            expect(denied.exitCode).not.toBe(0);
            expect(denied.stdout).toBe('');
        } finally {
            try {
                await bridge?.close();
            } finally {
                try {
                    const removed = await Promise.allSettled(containers.reverse().map(id => checked(['rm', '--force', id])));
                    const networksRemoved = await Promise.allSettled(networks.reverse().map(id => run(['network', 'rm', id])));
                    const failures = [...removed, ...networksRemoved].filter(result => result.status === 'rejected');
                    expect(failures).toEqual([]);
                } finally {
                    for (const socket of serviceSockets) socket.destroy();
                    await new Promise<void>(resolve => service.close(() => resolve()));
                    await rm(directory, { recursive: true, force: true });
                }
            }
        }
    }, 120_000,
);
