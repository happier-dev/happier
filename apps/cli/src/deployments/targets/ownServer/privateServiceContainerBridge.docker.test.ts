import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseNativeDockerEngineInfo } from '@happier-dev/cli-common/machineSetup';
import type { ProjectNativeDockerPort } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { acquirePrivateServiceContainerBridge } from './privateServiceContainerBridge';
import { prepareNativeComposeReferenceNetwork } from '@/daemon/local/services/launch/nativeComposeReferenceNetwork';

const execute = promisify(execFile);

// Uses the same cached BusyBox qualification image as nativeResticNetwork.testkit.
// Uses only its own test networks/containers and never acquires an image.
it.skipIf(process.env.HAPPIER_TEST_PRIVATE_SERVICE_CONTAINER_BRIDGE !== '1')(
    'prepares only the consumer network, preserves the incumbent, and forwards only that Docker network to loopback', async () => {
        const run: ProjectNativeDockerPort['run'] = async args => {
            try {
                const output = await execute('docker', [...args]);
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
                    networks: { private: { name: networks[0]! } } } });
            expect(await checked(['ps', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${prefix}`,
                '--format', '{{.ID}}'])).toBe(incumbent);
            expect(await checked(['inspect', '--format', '{{.Id}} {{.State.Running}} {{.RestartCount}}', incumbent])).toBe(previous);
            bridge = await acquirePrivateServiceContainerBridge({ docker: { engineId: engine.id, run }, engine,
                networkId: networks[0]!, forward: { host: '127.0.0.1', port: address.port } });
            for (const [index, networkId] of networks.entries()) {
                const id = await checked(['create', '--pull=never', '--network', networkId, image,
                    'wget', '-q', '-T', '2', '-O', '-', `http://${bridge.host}:${bridge.port}`]);
                containers.push(id);
                const result = await run(['start', '--attach', id]);
                if (index === 0) {
                    expect(result.exitCode, result.stderr).toBe(0);
                    expect(result.stdout).toBe('loopback-service-reached');
                } else expect(result.exitCode).not.toBe(0);
            }
        } finally {
            await bridge?.close();
            for (const id of containers.reverse()) await checked(['rm', '--force', id]);
            for (const id of networks.reverse()) await run(['network', 'rm', id]);
            for (const socket of serviceSockets) socket.destroy();
            await new Promise<void>(resolve => service.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        }
    },
);
