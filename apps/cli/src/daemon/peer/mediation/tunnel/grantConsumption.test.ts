import { describe, expect, it } from 'vitest';

import { createAtomicRouteGrantConsumption } from './grantConsumption';

describe('createAtomicRouteGrantConsumption', () => {
    it('admits one winner per grant identity and retains committed grants until expiry', () => {
        const consumption = createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' });
        const first = consumption.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_000 });

        expect(first).not.toBeNull();
        expect(consumption.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_000 })).toBeNull();

        first?.commit();
        expect(consumption.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_999 })).toBeNull();
        expect(consumption.reserve({ grantId: 'grant_1', expiresAt: 3_000, nowMs: 2_000 })).not.toBeNull();
    });

    it('releases a direct reservation when activation rejects before returning a connection', () => {
        const consumption = createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' });
        const reservation = consumption.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_000 });

        reservation?.activationFailed();

        expect(consumption.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_001 })).not.toBeNull();
    });

    it('does not release a committed direct grant through a stale activation-failure callback', () => {
        const consumption = createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' });
        const reservation = consumption.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_000 });

        reservation?.commit();
        reservation?.activationFailed();

        expect(consumption.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_001 })).toBeNull();
    });

    it('retains a relay reservation when daemon activation fails after server consumption', () => {
        const consumption = createAtomicRouteGrantConsumption({ activationFailurePolicy: 'consume' });
        const reservation = consumption.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_000 });

        reservation?.activationFailed();

        expect(consumption.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_001 })).toBeNull();
    });

    it('keeps direct and relay stores independent and clears only the selected lifecycle', () => {
        const direct = createAtomicRouteGrantConsumption({ activationFailurePolicy: 'release' });
        const relay = createAtomicRouteGrantConsumption({ activationFailurePolicy: 'consume' });

        direct.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_000 })?.commit();
        relay.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_000 })?.commit();
        direct.clear();

        expect(direct.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_001 })).not.toBeNull();
        expect(relay.reserve({ grantId: 'grant_1', expiresAt: 2_000, nowMs: 1_001 })).toBeNull();
    });
});
