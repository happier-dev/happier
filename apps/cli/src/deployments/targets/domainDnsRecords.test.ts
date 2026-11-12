import { expect, it } from 'vitest';
import { buildDomainDnsRecordChildren } from './domainDnsRecords.js';
const input = { serverId: 'home', environmentId: 'environment', domainId: 'domain', expectedDomainRevision: 4,
    expectedRevision: 2, requestKey: 'dns-create', dns: { action: { pluginId: 'happier.dns.route53', localId: 'records-create' },
        credentialRef: { service: { pluginId: 'happier.dns.route53', localId: 'aws' }, accountId: 'account' }, zoneId: 'Z123', ttl: 300 } };
it('builds one reviewed record set for each provider-required name/type and preserves multiple values', () => {
    const result = buildDomainDnsRecordChildren(input, { hostname: 'app.example.test', target: { kind: 'provider' }, providerObservation: {
        v: 1, hostname: 'app.example.test', state: 'pending', dns: [
            { name: 'app.example.test', type: 'A', value: '192.0.2.1' },
            { name: 'app.example.test', type: 'A', value: '192.0.2.2' },
            { name: '_proof.app.example.test', type: 'TXT', value: 'proof' },
        ],
    } });
    expect(result).toEqual({ children: [
        { action: input.dns.action, role: 'domain-dns:0', input: { credentialRef: input.dns.credentialRef, zoneId: 'Z123',
            name: 'app.example.test.', type: 'A', ttl: 300, values: ['192.0.2.1', '192.0.2.2'] } },
        { action: input.dns.action, role: 'domain-dns:1', input: { credentialRef: input.dns.credentialRef, zoneId: 'Z123',
            name: '_proof.app.example.test.', type: 'TXT', ttl: 300, values: ['proof'] } },
    ] });
});
it('never fabricates native required records from a hostname, token-probe success or private origin', () => {
    expect(buildDomainDnsRecordChildren(input, { hostname: 'app.example.test', target: { service: 'app', containerPort: 8080 } }))
        .toMatchObject({ ok: false, errorCode: 'required_fact_unavailable', details: { requiredFact: 'domain_dns_records', source: 'expected_ingress' } });
});
it('requires retained provider records and never reuses observations for another hostname', () => {
    expect(buildDomainDnsRecordChildren(input, { hostname: 'app.example.test', target: { kind: 'provider' }, providerObservation: {
        v: 1, hostname: 'other.example.test', state: 'pending', dns: [{ name: 'other.example.test', type: 'A', value: '192.0.2.1' }],
    } })).toMatchObject({ ok: false, errorCode: 'required_fact_unavailable' });
});
