import { describe, expect, it } from 'vitest';

import { createPluginLocalServicesService } from './localServices';

const declaration = {
    id: 'web',
    launch: { kind: 'binary', executablePath: '/bin/sh', args: ['-lc', 'npm run dev'] },
    launchMode: { kind: 'detectAfterLaunch', minimumConfidence: 'medium' },
    hostPolicy: { kind: 'loopback' },
    name: { strategy: 'derived', base: 'web' },
    healthCheck: { kind: 'none' },
    restart: { kind: 'never' },
    cleanup: { staleAfterMs: 30_000 },
} as const;

describe('plugin local services context', () => {
    it('records declarations and fails closed with a daemon bridge blocker until launch is wired', async () => {
        const service = createPluginLocalServicesService();

        await service.declare(declaration);

        expect(await service.get('web')).toMatchObject({
            id: 'web',
            phase: 'stopped',
        });

        const handle = await service.start('web');

        expect(handle.snapshot()).toMatchObject({
            id: 'web',
            phase: 'failed',
            diagnostics: [
                expect.objectContaining({ code: 'PLUGIN_LOCAL_SERVICE_DAEMON_BRIDGE_UNAVAILABLE' }),
            ],
        });
    });

    it('projects correlated daemon preview access URLs from managed local-service snapshots', async () => {
        const service = createPluginLocalServicesService({
            daemonBridge: {
                start: async (serviceDeclaration) => ({
                    id: serviceDeclaration.id,
                    phase: 'running',
                    inventoryId: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400',
                    port: 5173,
                    url: 'https://preview.happier.test/v1/local-services/preview/plugin-web/',
                    diagnostics: [],
                }),
            },
        });

        await service.declare(declaration);

        const handle = await service.start('web');

        expect(handle.snapshot()).toEqual({
            id: 'web',
            phase: 'running',
            inventoryId: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400',
            port: 5173,
            url: 'https://preview.happier.test/v1/local-services/preview/plugin-web/',
            diagnostics: [],
        });
        await expect(service.get('web')).resolves.toMatchObject({
            phase: 'running',
            url: 'https://preview.happier.test/v1/local-services/preview/plugin-web/',
        });
    });
});
