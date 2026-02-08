import { describe, it, expect } from 'vitest';
import { customerInfoToPurchases } from './purchases';
import type { CustomerInfo } from './revenueCat/types';

function makeCustomerInfo(entitlements: Record<string, boolean>): CustomerInfo {
    return {
        activeSubscriptions: {},
        entitlements: {
            all: Object.fromEntries(
                Object.entries(entitlements).map(([id, isActive]) => [
                    id,
                    { isActive, identifier: id },
                ])
            ),
        },
        originalAppUserId: 'user_1',
        requestDate: new Date(),
    };
}

describe('purchases', () => {
    describe('customerInfoToPurchases', () => {
        it('treats RevenueCat pro entitlement as voice (alias)', () => {
            const purchases = customerInfoToPurchases(makeCustomerInfo({ pro: true }));
            expect(purchases.entitlements.pro).toBe(true);
            expect(purchases.entitlements.voice).toBe(true);
        });

        it('treats RevenueCat voice entitlement as pro (alias)', () => {
            const purchases = customerInfoToPurchases(makeCustomerInfo({ voice: true }));
            expect(purchases.entitlements.voice).toBe(true);
            expect(purchases.entitlements.pro).toBe(true);
        });

        it('does not alias inactive entitlements', () => {
            const purchases = customerInfoToPurchases(makeCustomerInfo({ pro: false, voice: false }));
            expect(purchases.entitlements.pro).toBe(false);
            expect(purchases.entitlements.voice).toBe(false);
        });
    });
});

