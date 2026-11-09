import { describe, expect, it } from 'vitest';
import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { isConnectedServiceQuotaMeterVisible } from './connectedServiceQuotaMeterVisibility';

const meter = {
    meterId: 'balance', label: 'Balance', used: null, limit: null, utilizationPct: null,
    resetsAt: null, status: 'ok', unit: 'usd', currency: 'USD', details: {},
} satisfies ConnectedServiceQuotaMeterV1;

describe('reported quota amounts', () => {
    it('keeps uncapped usage and remaining balances, including zero, without claiming a percentage', () => {
        for (const value of [0, 4.2]) {
            expect(isConnectedServiceQuotaMeterVisible({ ...meter, used: value }, 1_000)).toBe(true);
            expect(isConnectedServiceQuotaMeterVisible({ ...meter, remaining: value }, 1_000)).toBe(true);
        }
    });

    it('keeps empty and unavailable amounts hidden unless pinned', () => {
        expect(isConnectedServiceQuotaMeterVisible(meter, 1_000)).toBe(false);
        expect(isConnectedServiceQuotaMeterVisible({ ...meter, used: 4.2, status: 'unavailable' }, 1_000)).toBe(false);
        expect(isConnectedServiceQuotaMeterVisible({ ...meter, used: Number.NaN }, 1_000)).toBe(false);
        expect(isConnectedServiceQuotaMeterVisible(meter, 1_000, ['balance'])).toBe(true);
    });
});
