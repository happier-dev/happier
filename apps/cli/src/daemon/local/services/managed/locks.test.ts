import { describe, expect, it } from 'vitest';

import { createLocalServiceRouteLockStore } from './locks';

describe('createLocalServiceRouteLockStore', () => {
    it('prevents two services from claiming the same route name', () => {
        const store = createLocalServiceRouteLockStore();

        expect(store.claim({ name: 'plugin-web', serviceId: 'service-a' })).toEqual({ ok: true });
        expect(store.claim({ name: 'plugin-web', serviceId: 'service-b' })).toEqual({
            ok: false,
            reason: 'route_name_claimed',
        });
        expect(store.claim({ name: 'plugin-web', serviceId: 'service-a' })).toEqual({ ok: true });
    });
});
