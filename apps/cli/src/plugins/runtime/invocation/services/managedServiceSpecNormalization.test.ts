import { describe, expect, it } from 'vitest';

import type { ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';

import { normalizeManagedServiceSpec } from './managedServiceSpecNormalization';

function attachedSpec(id: string): ManagedServiceSpec {
    return Object.freeze({
        id,
        mode: Object.freeze({
            kind: 'attach' as const,
            baseUrl: 'http://127.0.0.1:4312',
        }),
    });
}

describe('managed-service specification normalization', () => {
    it.each([
        'Gateway',
        'gateway_v2',
        'providers//gateway',
        'a'.repeat(257),
    ])('rejects noncanonical managed-service id %j', (id) => {
        expect(() => normalizeManagedServiceSpec(attachedSpec(id)))
            .toThrow(expect.objectContaining({
                code: 'plugin_managed_service_spec_invalid',
            }));
    });

    it.each([
        'gateway',
        'gateway-v2',
        'providers/gateway',
        'a'.repeat(256),
    ])('accepts canonical managed-service id %j', (id) => {
        expect(normalizeManagedServiceSpec(attachedSpec(id)).id).toBe(id);
    });

    it.each([
        ['a host-owned credential header name', { Authorization: 'Basic abc' }],
        ['a transport-owned header name', { 'Proxy-Authorization': 'Basic abc' }],
        ['a host-owned credential header alias', { 'X-Api-Key': 'abc' }],
        ['a control-character value', { 'x-trace': 'one\r\nx-injected: two' }],
        [
            'an excessive header count',
            Object.fromEntries(
                Array.from({ length: 65 }, (_value, index) => [
                    `x-probe-${index}`,
                    'ok',
                ]),
            ),
        ],
    ])('refuses %s in a static health-check header set', (_label, headers) => {
        expect(() => normalizeManagedServiceSpec({
            ...attachedSpec('gateway'),
            healthCheck: {
                kind: 'http',
                target: { kind: 'servicePath', path: '/health' },
                headers: headers as Readonly<Record<string, string>>,
            },
        })).toThrow(expect.objectContaining({
            code: 'plugin_managed_service_spec_invalid',
        }));
    });

    it('preserves ordinary non-secret health headers in canonical form', () => {
        const normalized = normalizeManagedServiceSpec({
            ...attachedSpec('gateway'),
            healthCheck: {
                kind: 'http',
                target: { kind: 'servicePath', path: '/health' },
                headers: {
                    'X-Probe': 'ready',
                    Accept: 'application/json',
                },
            },
        });
        expect(
            normalized.healthCheck?.kind === 'http'
                ? normalized.healthCheck.headers
                : undefined,
        ).toEqual({ accept: 'application/json', 'x-probe': 'ready' });
    });
});
