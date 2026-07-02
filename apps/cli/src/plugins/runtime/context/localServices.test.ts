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
    it('records declarations and fails closed until the local-services runtime substrate owns launch', async () => {
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
                expect.objectContaining({ code: 'PLUGIN_LOCAL_SERVICE_SUBSTRATE_UNAVAILABLE' }),
            ],
        });
    });
});
