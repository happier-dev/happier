import { composeServerConfigRegistry, defineServerConfigRegistry, readServerConfig } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { projectHomeSettings } from './homeConfigOverlay';
import { loadStartupHomeEnv } from './startupHomeEnv';

const CONFIG = defineServerConfigRegistry({
    METRICS_PORT: { type: 'int', default: 9090, bounds: { min: 0, max: 65_535 }, sensitivity: 'plain', apply: 'restart', editable: 'home', section: 'server', description: 'Metrics port.' },
    REDIS_URL: { type: 'string', sensitivity: 'secret', apply: 'restart', editable: 'home', section: 'server', description: 'Redis.' },
    S3_SECRET_KEY: { type: 'string', sensitivity: 'secret', apply: 'restart', editable: 'home', section: 'server', description: 'S3 secret.' },
    MAIL_HOST: { type: 'string', sensitivity: 'plain', apply: 'live', editable: 'home', section: 'email', description: 'Mail host.' },
});
const REGISTRY = composeServerConfigRegistry(CONFIG);
const NOW = new Date('2026-09-26T12:00:00.000Z');

describe('loadStartupHomeEnv', () => {
    it('applies a stored restart value at start, and the console projects it as applied, not pending', async () => {
        const log = vi.fn();
        const stored = { values: { METRICS_PORT: 9191, MAIL_HOST: 'smtp.home' }, secrets: { REDIS_URL: 'redis://cache:6379' } };
        const startup = await loadStartupHomeEnv({ env: {}, readStored: async () => stored, registry: REGISTRY, log, now: () => NOW });

        expect(readServerConfig(startup.env, CONFIG.METRICS_PORT)).toBe(9191);
        expect(startup.env.REDIS_URL).toBe('redis://cache:6379');
        // Live keys reach readers through the request/job overlay, never the startup snapshot.
        expect(startup.env.MAIL_HOST).toBeUndefined();
        expect(startup.snapshot).toEqual({ appliedAt: NOW.toISOString(), applied: ['METRICS_PORT', 'REDIS_URL'], ignored: {} });
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0]![0]).toContain('METRICS_PORT');
        expect(log.mock.calls[0]![0]).not.toContain('redis://cache');

        const rows = projectHomeSettings({ registry: REGISTRY, env: {}, persisted: stored.values, persistedSecretKeys: ['REDIS_URL'], persistedRestartSecrets: stored.secrets, startup });
        const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
        expect(byKey.METRICS_PORT).toMatchObject({ value: 9191, source: 'home', applied: { value: 9191, pending: false } });
        expect(byKey.REDIS_URL).toMatchObject({ value: null, secretSet: true, applied: { value: null, pending: false } });
        expect(byKey.MAIL_HOST).not.toHaveProperty('applied');
    });

    it('ignores an out-of-bounds or unreadable stored value with a reason and starts on the default', async () => {
        const log = vi.fn();
        const stored = { values: { METRICS_PORT: 70_000 }, secrets: { S3_SECRET_KEY: { unreadable: true as const } } };
        const startup = await loadStartupHomeEnv({ env: {}, readStored: async () => stored, registry: REGISTRY, log, now: () => NOW });

        expect(readServerConfig(startup.env, CONFIG.METRICS_PORT)).toBe(9090);
        expect(startup.env.S3_SECRET_KEY).toBeUndefined();
        expect(startup.snapshot.ignored).toEqual({ METRICS_PORT: 'out_of_bounds', S3_SECRET_KEY: 'secret_unreadable' });
        expect(log.mock.calls[0]![0]).toMatch(/ignored.*METRICS_PORT \(out_of_bounds\)/);

        const rows = projectHomeSettings({ registry: REGISTRY, env: {}, persisted: stored.values, persistedSecretKeys: ['S3_SECRET_KEY'], startup });
        const metrics = rows.find((row) => row.key === 'METRICS_PORT');
        expect(metrics).toMatchObject({ value: 9090, source: 'default', applied: { value: 9090, pending: false, ignoredReason: 'out_of_bounds' } });
    });

    it('lets an explicitly set env value win over a stored value, projected as fixed', async () => {
        const startup = await loadStartupHomeEnv({
            env: { METRICS_PORT: '9300' },
            readStored: async () => ({ values: { METRICS_PORT: 9191 }, secrets: {} }),
            registry: REGISTRY,
            log: vi.fn(),
            now: () => NOW,
        });

        expect(readServerConfig(startup.env, CONFIG.METRICS_PORT)).toBe(9300);
        expect(startup.snapshot.applied).toEqual([]);
        const rows = projectHomeSettings({ registry: REGISTRY, env: { METRICS_PORT: '9300' }, persisted: { METRICS_PORT: 9191 }, persistedSecretKeys: [], startup });
        expect(rows.find((row) => row.key === 'METRICS_PORT')).toMatchObject({ value: 9300, source: 'deployment', fixed: true, applied: { value: 9300, pending: false } });
    });

    it('marks a restart value stored after the start as pending until the next start', async () => {
        const startup = await loadStartupHomeEnv({ env: {}, readStored: async () => ({ values: {}, secrets: {} }), registry: REGISTRY, log: vi.fn(), now: () => NOW });
        const rows = projectHomeSettings({ registry: REGISTRY, env: {}, persisted: { METRICS_PORT: 9191 }, persistedSecretKeys: [], startup });
        expect(rows.find((row) => row.key === 'METRICS_PORT')).toMatchObject({ value: 9191, applied: { value: 9090, pending: true } });
    });

    it('compares restart secret values privately, including replacement, removal and deployment locks', async () => {
        const secret = 'startup-secret';
        const startup = await loadStartupHomeEnv({ env: {}, readStored: async () => ({ values: {}, secrets: { S3_SECRET_KEY: secret } }), registry: REGISTRY, log: () => {}, now: () => NOW });
        for (const [current, pending] of [[secret, false], ['replacement-secret', true], [null, true]] as const) {
            const rows = projectHomeSettings({ registry: REGISTRY, env: {}, persisted: {}, persistedSecretKeys: current ? ['S3_SECRET_KEY'] : [], persistedRestartSecrets: current ? { S3_SECRET_KEY: current } : {}, startup });
            expect(rows.find((row) => row.key === 'S3_SECRET_KEY')).toMatchObject({ value: null, applied: { value: null, pending } });
            expect(JSON.stringify(rows)).not.toContain(secret);
            expect(JSON.stringify(rows)).not.toContain('replacement-secret');
        }
        const locked = await loadStartupHomeEnv({ env: { S3_SECRET_KEY: 'deployment-secret' }, readStored: async () => ({ values: {}, secrets: { S3_SECRET_KEY: secret } }), registry: REGISTRY, log: () => {}, now: () => NOW });
        const rows = projectHomeSettings({ registry: REGISTRY, env: locked.deploymentEnv, persisted: {}, persistedSecretKeys: ['S3_SECRET_KEY'], persistedRestartSecrets: { S3_SECRET_KEY: 'replacement-secret' }, startup: locked });
        expect(rows.find((row) => row.key === 'S3_SECRET_KEY')).toMatchObject({ value: null, fixed: true, applied: { value: null, pending: false } });
    });
});
