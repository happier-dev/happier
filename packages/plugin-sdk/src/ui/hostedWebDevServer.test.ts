import { describe, expect, it } from 'vitest';

import { defineHostedWebDevServer } from './hostedWebDevServer';

describe('hosted web dev server SDK helper', () => {
    it('binds a hosted-web contribution to a local service and runtime mode from one declaration', () => {
        const binding = defineHostedWebDevServer({
            contributionId: 'preview-web',
            service: {
                id: 'preview-dev-server',
                launch: {
                    kind: 'binary',
                    executablePath: 'plugin-preview-dev-server',
                    args: ['--host', '127.0.0.1'],
                },
                launchMode: {
                    kind: 'assignAndInject',
                    portPolicy: { kind: 'allocated', preferredPort: 5173 },
                    environment: { inject: ['PORT', 'HOST', 'HAPPIER_URL', 'HAPPIER_PREVIEW_URL'] },
                },
                hostPolicy: { kind: 'loopback' },
                name: { strategy: 'derived', base: 'preview-web' },
                healthCheck: { kind: 'http', path: '/' },
                restart: { kind: 'never' },
                cleanup: { staleAfterMs: 60_000 },
            },
        });

        expect(binding).toMatchObject({
            contributionId: 'preview-web',
            hostedWebServiceRef: {
                kind: 'managedService',
                serviceId: 'preview-dev-server',
            },
            runtimeMode: {
                kind: 'managedLocalService',
                localServiceId: 'preview-dev-server',
            },
        });
        expect(binding.localService.id).toBe('preview-dev-server');
        expect(Object.isFrozen(binding)).toBe(true);
    });
});
