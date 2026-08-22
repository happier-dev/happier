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
});
