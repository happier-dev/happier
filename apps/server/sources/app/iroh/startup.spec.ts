import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import { createFileHomeConnectionDescriptorContinuityStore } from '@/app/features/homeConnectionDescriptorContinuity';
import { resolveBoundServerListener } from '@/app/runtime/startupReceipt';
import { getHomeIrohEndpointState, resetHomeIrohEndpointStateForTests } from './homeIrohEndpoint';
import { prepareHomeIrohStartup } from './startup';
import { installHomeIrohIngress } from '@/app/api/irohIngress';
import { logger } from '@/utils/logging/log';

// Only the optional native/OS binding fails; startup and HTTP remain real.
vi.mock('./homeIrohNativeLifecycle', () => ({
    loadHomeIrohNativeLifecycle: () => { throw new Error('native loading refused'); },
}));

it.each([
    { label: 'optional Iroh startup throws', config: {}, status: 'unavailable', failureReason: 'native_error' },
    { label: 'a redis-streams holder opts out', config: {
        HAPPIER_SOCKET_ADAPTER: 'redis-streams', HAPPIER_HOME_IROH_HOLDER: '1', HAPPIER_HOME_IROH_MODE: 'disabled',
    }, status: 'retired', failureReason: null },
])('keeps HTTP serving when $label', async ({ config, status, failureReason }) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'happier-iroh-startup-failure-'));
    const app = Fastify({ logger: false });
    const ingress = installHomeIrohIngress(app);
    app.get('/health', async () => ({ ok: true }));
    try {
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        const ingressPort = await ingress.listen();
        await expect(prepareHomeIrohStartup({
            HAPPIER_CANONICAL_SERVER_URL: 'https://home.example.test',
            AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
            HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
            ...config,
        })({
            listener: resolveBoundServerListener(app),
            ingressPort,
            continuityStore: createFileHomeConnectionDescriptorContinuityStore(join(dataDir, 'descriptor.json')),
        })).resolves.toBeUndefined();
        expect(await getHomeIrohEndpointState()).toMatchObject({ status, failureReason });
        expect((await fetch(`${origin}/health`)).status).toBe(200);
    } finally {
        await app.close();
        await resetHomeIrohEndpointStateForTests();
        await rm(dataDir, { recursive: true, force: true });
    }
});

it.each([
    { label: 'Redis process without a sole holder', config: { HAPPIER_SOCKET_ADAPTER: 'redis-streams' }, failureReason: 'iroh_multi_instance_unsupported' },
    { label: 'missing continuity store', missingStore: true, failureReason: 'continuity_metadata_unavailable' },
    { label: 'missing internal ingress', missingIngress: true, failureReason: 'api_listen_port_unavailable' },
    { label: 'ingress-less bootstrap with signup open', config: { AUTH_ANONYMOUS_SIGNUP_ENABLED: '1' }, failureReason: 'exposure_proof_missing' },
])('settles $label with a typed, logged reason before native startup', async (scenario) => {
    // The logger is the diagnostics output boundary; admission and lifecycle stay real.
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
        await prepareHomeIrohStartup({
            HAPPIER_CANONICAL_SERVER_URL: 'https://home.example.test',
            AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
            ...scenario.config,
        })({
            listener: { host: '127.0.0.1', port: 3005 },
            ingressPort: scenario.missingIngress ? null : 3006,
            continuityStore: scenario.missingStore ? null : createFileHomeConnectionDescriptorContinuityStore(join(tmpdir(), 'unused-iroh-descriptor.json')),
        });
        expect(await getHomeIrohEndpointState()).toMatchObject({ status: 'unavailable', failureReason: scenario.failureReason });
        expect(warning).toHaveBeenCalledWith(
            expect.objectContaining({ module: 'iroh', failureReason: scenario.failureReason }),
            expect.any(String),
        );
    } finally {
        warning.mockRestore();
        await resetHomeIrohEndpointStateForTests();
    }
});
