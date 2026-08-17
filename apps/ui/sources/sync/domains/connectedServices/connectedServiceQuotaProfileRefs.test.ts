import { describe, expect, it } from 'vitest';

import { normalizeConnectedServiceQuotaProfileRefs } from './connectedServiceQuotaProfileRefs';

describe('normalizeConnectedServiceQuotaProfileRefs', () => {
    it('trims, keys and orders refs deterministically', () => {
        expect(normalizeConnectedServiceQuotaProfileRefs([
            { serviceId: 'github', profileId: ' work ' },
            { serviceId: ' anthropic ', profileId: 'personal' },
        ])).toEqual([
            { kind: 'legacy', key: 'anthropic/personal', serviceId: 'anthropic', profileId: 'personal' },
            { kind: 'legacy', key: 'github/work', serviceId: 'github', profileId: 'work' },
        ]);
    });

    it('drops refs with an unknown service id or an empty profile id', () => {
        expect(normalizeConnectedServiceQuotaProfileRefs([
            { serviceId: 'not-a-service', profileId: 'personal' },
            { serviceId: 'github', profileId: '   ' },
        ])).toEqual([]);
    });

    it('dedupes by key so a repeated ref is fetched once', () => {
        expect(normalizeConnectedServiceQuotaProfileRefs([
            { serviceId: 'github', profileId: 'work' },
            { serviceId: 'github', profileId: ' work' },
        ])).toEqual([
            { kind: 'legacy', key: 'github/work', serviceId: 'github', profileId: 'work' },
        ]);
    });

    it('keeps a novel V4 account qualified instead of dropping it through the legacy enum', () => {
        expect(normalizeConnectedServiceQuotaProfileRefs([{
            ref: {
                service: {
                    pluginId: 'acme.connected.accounts',
                    localId: 'shared-service',
                },
                accountId: 'work',
            },
        }])).toEqual([{
            kind: 'qualified',
            key: 'acme.connected.accounts%2Fshared-service/work',
            ref: {
                service: {
                    pluginId: 'acme.connected.accounts',
                    localId: 'shared-service',
                },
                accountId: 'work',
            },
        }]);
    });

    it('is idempotent, so re-feeding a normalized list changes nothing', () => {
        const once = normalizeConnectedServiceQuotaProfileRefs([
            { serviceId: 'github', profileId: 'work' },
            { serviceId: 'anthropic', profileId: 'personal' },
        ]);
        expect(normalizeConnectedServiceQuotaProfileRefs(once)).toEqual(once);
    });
});
