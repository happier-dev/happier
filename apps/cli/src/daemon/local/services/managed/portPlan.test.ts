import { describe, expect, it } from 'vitest';

import type { LocalServiceDeclarationV1 } from '@/plugins/runtime/exec/privateContract';

import { buildLocalServicePortPlan, createLocalServicePortAllocator, normalizeServiceEnvName } from './portPlan';

function assignDeclaration(id: string, overrides: Partial<LocalServiceDeclarationV1> = {}): LocalServiceDeclarationV1 {
    return {
        id,
        launch: { kind: 'binary', executablePath: '/bin/svc' },
        launchMode: { kind: 'assignAndInject', portPolicy: { kind: 'allocated' }, environment: { inject: ['PORT', 'HOST'] } },
        hostPolicy: { kind: 'loopback' },
        name: { strategy: 'derived', base: id },
        healthCheck: { kind: 'none' },
        restart: { kind: 'never' },
        cleanup: { staleAfterMs: 30_000 },
        ...overrides,
    };
}

describe('normalizeServiceEnvName', () => {
    it('upcases and collapses non-alnum to underscore', () => {
        expect(normalizeServiceEnvName('web-1')).toBe('WEB_1');
        expect(normalizeServiceEnvName('web.1')).toBe('WEB_1');
        expect(normalizeServiceEnvName('Api')).toBe('API');
    });
});

describe('buildLocalServicePortPlan', () => {
    it('resolves every peer port up front so inherited can read them', () => {
        const allocator = createLocalServicePortAllocator({ range: { start: 5_000, end: 5_010 }, isPortAvailable: () => true });
        const plan = buildLocalServicePortPlan({
            host: '127.0.0.1',
            allocator,
            declarations: [
                { serviceKey: 'k:api', declaration: assignDeclaration('api') },
                {
                    serviceKey: 'k:web',
                    declaration: assignDeclaration('web', {
                        launchMode: { kind: 'assignAndInject', portPolicy: { kind: 'inherited', envName: 'api' }, environment: { inject: ['PORT'] } },
                    }),
                },
            ],
        });

        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        const api = plan.entries.find((entry) => entry.serviceId === 'api');
        const web = plan.entries.find((entry) => entry.serviceId === 'web');
        expect(api?.port).toBeGreaterThanOrEqual(5_000);
        // web inherits api's port + url.
        expect(web?.port).toBe(api?.port);
        expect(web?.url).toBe(`http://127.0.0.1:${api?.port}`);
    });

    it('honors a fixed configured port verbatim', () => {
        const allocator = createLocalServicePortAllocator({ range: { start: 5_000, end: 5_010 }, isPortAvailable: () => true });
        const plan = buildLocalServicePortPlan({
            host: '127.0.0.1',
            allocator,
            declarations: [{
                serviceKey: 'k:web',
                declaration: assignDeclaration('web', {
                    launchMode: { kind: 'assignAndInject', portPolicy: { kind: 'fixed', port: 4_321 }, environment: { inject: ['PORT'] } },
                }),
            }],
        });
        expect(plan).toMatchObject({ ok: true, entries: [{ serviceId: 'web', port: 4_321 }] });
    });

    it('fails fast when two ids collapse to the same env name', () => {
        const allocator = createLocalServicePortAllocator({ range: { start: 5_000, end: 5_010 }, isPortAvailable: () => true });
        const plan = buildLocalServicePortPlan({
            host: '127.0.0.1',
            allocator,
            declarations: [
                { serviceKey: 'k:web-1', declaration: assignDeclaration('web-1') },
                { serviceKey: 'k:web.1', declaration: assignDeclaration('web.1') },
            ],
        });
        expect(plan).toMatchObject({ ok: false, reason: 'env_name_collision', collision: { envName: 'WEB_1' } });
    });

    it('surfaces a typed reason when no ports are available', () => {
        const allocator = createLocalServicePortAllocator({ range: { start: 5_000, end: 5_000 }, isPortAvailable: () => false });
        const plan = buildLocalServicePortPlan({
            host: '127.0.0.1',
            allocator,
            declarations: [{ serviceKey: 'k:web', declaration: assignDeclaration('web') }],
        });
        expect(plan).toMatchObject({ ok: false, reason: 'no_available_ports', serviceId: 'web' });
    });
});
