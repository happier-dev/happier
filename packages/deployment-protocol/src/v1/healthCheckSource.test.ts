import { describe, expect, it } from 'vitest';
import * as health from './index.js';

const serviceSubject = { kind: 'machineService', machineId: 'machine-b', serviceId: 'watch-b' };
const check = { checkId: 'availability', kind: { pluginId: 'example.health', localId: 'http' },
    periodMs: 60000, consecutiveFailuresBeforeAlerting: 1,
    binding: { kind: 'healthCheck' },
    config: { endpoint: 'http://127.0.0.1:8080/health', expectStatus: 204, keyword: 'ready' } };

describe('saved subject check configuration', () => {
    it('round-trips the exact service endpoint without inventing an Environment or a second host assignment', () => {
        expect(health).toHaveProperty('HealthCheckSourceConfigV1Schema');
        const source = { v: 1, subject: serviceSubject, checks: [check] };
        expect(health.HealthCheckSourceConfigV1Schema.parse(JSON.parse(JSON.stringify(source)))).toEqual(source);
        for (const invalid of [
            { ...source, observerMachineId: 'machine-c' },
            { ...source, checks: [check, { ...check, periodMs: 10000 }] },
            { ...source, checks: [{ ...check, periodMs: 0 }] },
            { ...source, checks: [{ ...check, consecutiveFailuresBeforeAlerting: 0 }] },
            { ...source, checks: [{ ...check, binding: { kind: 'domain', domainId: 'domain-a', targetLinkId: 'link-a', condition: 'domain_probe_failed' } }] },
        ]) expect(health.HealthCheckSourceConfigV1Schema.safeParse(invalid).success).toBe(false);
    });

    it('keeps Domain path/status solely on the Domain while allowing saved service expectations', () => {
        expect(health).toHaveProperty('HealthCheckDomainHttpConfigV1Schema');
        expect(health.HealthCheckDomainHttpConfigV1Schema.parse({ keyword: 'ready' })).toEqual({ keyword: 'ready' });
        for (const invalid of [{ path: '/stale' }, { expectStatus: 200 }, { endpoint: 'https://arbitrary.example/' }])
            expect(health.HealthCheckDomainHttpConfigV1Schema.safeParse(invalid).success).toBe(false);
        const endpoint = { endpoint: 'http://127.0.0.1:8080/health', expectStatus: 204, keyword: 'ready' };
        expect(health.HealthCheckServiceHttpConfigV1Schema.parse(endpoint)).toEqual(endpoint);
        for (const invalid of [
            { ...endpoint, endpoint: 'file:///etc/passwd' },
            { ...endpoint, endpoint: 'https://user:password@app.example/' },
            { ...endpoint, expectStatus: 600 }, { ...endpoint, headers: { authorization: 'secret' } },
        ]) expect(health.HealthCheckServiceHttpConfigV1Schema.safeParse(invalid).success).toBe(false);
    });

    it('keeps one explicit condition binding and selects manual checks by saved identity only', () => {
        expect(health).toHaveProperty('SavedHealthCheckSelectorV1Schema');
        const selector = { sourceInstanceId: 'source-a', checkId: 'availability' };
        expect(health.SavedHealthCheckSelectorV1Schema.parse(selector)).toEqual(selector);
        expect(health.SavedHealthCheckSelectorV1Schema.safeParse({ ...selector, endpoint: 'http://127.0.0.1/' }).success).toBe(false);
        const domain = { ...check, binding: { kind: 'domain', domainId: 'domain-a', targetLinkId: 'link-a', condition: 'domain_probe_failed' }, config: { keyword: 'ready' } };
        const source = { v: 1, subject: { kind: 'environment', environmentId: 'environment-a' }, checks: [domain] };
        expect(health.HealthCheckSourceConfigV1Schema.parse(source)).toEqual(source);
    });
});
