import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareNativeComposeReferenceNetwork, readNativeComposeReferenceNetwork } from './nativeComposeReferenceNetwork';

it('asks Compose to ensure the actual shared network without creating or rescaling an application service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-reference-network-test-'));
    const network = { name: 'actual-consumer-network', driver: 'bridge', internal: true,
        driver_opts: { 'com.docker.network.bridge.enable_icc': 'true' } };
    const referenceAddresses = ['http://127.0.0.1:44111'];
    const model = { services: { app: { image: 'app-image', environment: { DATABASE_URL: referenceAddresses[0] }, networks: { private: {} } },
        worker: { image: 'worker-image', environment: { DATABASE_URL: referenceAddresses[0] }, networks: { private: {}, another: {} } } }, networks: { private: network } };
    let emitted: Readonly<{ args: readonly string[]; model: {
        services: Record<string, Readonly<{ image: string; networks: readonly string[] }>>;
        networks: Record<string, unknown>;
    } }> | undefined;
    try {
        const name = await prepareNativeComposeReferenceNetwork({ model, services: ['app', 'worker'], referenceAddresses,
            projectName: 'consumer-project', sourceRoot: directory, directory, imageReference: 'reviewed-image@sha256:1234',
            docker: { engineId: 'docker', async run(args) {
                const file = args[args.indexOf('--file') + 1]!;
                emitted = { args, model: JSON.parse(await readFile(file, 'utf8')) };
                return { exitCode: 0, stdout: '' };
            } } });
        expect(name).toBe(network.name);
        expect(emitted?.args).toContain('create');
        expect(emitted?.args).not.toContain('--remove-orphans');
        if (!emitted) throw new Error('No native Compose network preparation');
        const names = Object.keys(emitted.model.services);
        expect(names).toHaveLength(1);
        const service = names[0]!;
        expect(Object.hasOwn(model.services, service)).toBe(false);
        expect(emitted.args).toContain(`${service}=0`);
        expect(emitted.model.services[service]).toEqual({ image: 'reviewed-image@sha256:1234', networks: ['private'] });
        expect(emitted.model.networks).toEqual({ private: network });
    } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps host-network consumers on loopback and refuses disconnected container networks', () => {
    const referenceAddresses = ['http://127.0.0.1:44111'];
    expect(readNativeComposeReferenceNetwork({ services: ['app'], referenceAddresses,
        model: { services: { app: { network_mode: 'host', environment: { REF: referenceAddresses[0] } } } } })).toBeNull();
    expect(() => readNativeComposeReferenceNetwork({ services: ['app', 'worker'], referenceAddresses, model: {
        services: { app: { networks: { first: {} }, environment: { REF: referenceAddresses[0] } },
            worker: { networks: { second: {} }, environment: { REF: referenceAddresses[0] } } },
        networks: { first: { name: 'first-network' }, second: { name: 'second-network' } },
    } })).toThrow(expect.objectContaining({ code: 'private_service_container_bridge_unavailable',
        details: { reason: 'consumer_network_not_shared' } }));
});

it('selects only services containing the native-resolved Iroh reference when unrelated services use disconnected networks', () => {
    const referenceAddresses = ['http://127.0.0.1:44111'];
    const input = { services: ['app', 'worker'], referenceAddresses, model: {
        services: { app: { command: ['fetch', `${referenceAddresses[0]}/api`], networks: { first: {} } },
            worker: { environment: { MODE: 'background' }, networks: { second: {} } } },
        networks: { first: { name: 'first-network' }, second: { name: 'second-network' } },
    } };
    expect(readNativeComposeReferenceNetwork(input)?.name).toBe('first-network');
    input.model.services.worker.environment.MODE = referenceAddresses[0]!;
    expect(() => readNativeComposeReferenceNetwork(input)).toThrow(expect.objectContaining({
        code: 'private_service_container_bridge_unavailable', details: { reason: 'consumer_network_not_shared' },
    }));
});
