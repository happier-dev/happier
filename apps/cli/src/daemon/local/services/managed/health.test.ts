import { describe, expect, it } from 'vitest';

import { resolveManagedLocalServiceHealthTarget } from './health';

describe('resolveManagedLocalServiceHealthTarget', () => {
    it('builds loopback HTTP health targets and rejects non-loopback hosts', () => {
        expect(resolveManagedLocalServiceHealthTarget({
            host: '127.0.0.1',
            port: 5173,
            path: 'health',
        })).toEqual({ ok: true, url: 'http://127.0.0.1:5173/health' });

        expect(resolveManagedLocalServiceHealthTarget({
            host: '0.0.0.0',
            port: 5173,
            path: '/health',
        })).toEqual({
            ok: false,
            reason: 'non_loopback_health_host',
        });
    });

    it('rejects hostnames that only look like IPv4 loopback prefixes', () => {
        expect(resolveManagedLocalServiceHealthTarget({
            host: '127.example.test',
            port: 5173,
            path: '/health',
        })).toEqual({
            ok: false,
            reason: 'non_loopback_health_host',
        });
    });
});
