import { describe, expect, it } from 'vitest';

import {
    ConnectedServiceQuotaRecoveryCreditsV1Schema,
    type ConnectedServiceQuotaRecoveryCreditsV1,
} from '@happier-dev/protocol';

import { buildQuotaResetRows } from './buildQuotaResetRows';
import type { ResetCountdownDaysFormatter } from './formatResetCountdown';

const formatter: ResetCountdownDaysFormatter = {
    now: () => 'now',
    inDays: ({ days }) => `in ${days}d`,
};

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

describe('buildQuotaResetRows', () => {
    it('returns no rows when there are no available credits', () => {
        expect(buildQuotaResetRows(null, NOW, formatter)).toEqual([]);
        expect(buildQuotaResetRows(undefined, NOW, formatter)).toEqual([]);
        expect(
            buildQuotaResetRows(
                ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                    availableCount: 0,
                    credits: [],
                }),
                NOW,
                formatter,
            ),
        ).toEqual([]);
    });

    it('builds one aggregate placeholder row when credits are empty but the count is positive', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                availableCount: 2,
                credits: [],
            }),
            NOW,
            formatter,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            consumableCreditId: null,
            canUse: true,
            isAggregate: true,
            expiresAtMs: null,
            countdownLabel: null,
        });
        expect(rows[0]?.key).toBeTruthy();
    });

    it('builds per-credit rows keyed and gated on the credit id', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                availableCount: 2,
                credits: [
                    { id: 'credit-a', kind: 'usage_limit_reset', status: 'available', expiresAtMs: NOW + DAY },
                    { id: 'credit-b', kind: 'usage_limit_reset', status: 'available', expiresAtMs: NOW + 3 * DAY },
                ],
            }),
            NOW,
            formatter,
        );
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            key: 'credit-a',
            consumableCreditId: 'credit-a',
            canUse: true,
            isAggregate: false,
            countdownLabel: 'in 1d',
        });
        expect(rows[1]).toMatchObject({ key: 'credit-b', consumableCreditId: 'credit-b', canUse: true, countdownLabel: 'in 3d' });
    });

    it('filters out redeemed and expired credits', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                availableCount: 3,
                credits: [
                    { id: 'gone', kind: 'usage_limit_reset', status: 'redeemed', expiresAtMs: NOW + DAY },
                    { id: 'expired', kind: 'usage_limit_reset', status: 'available', expiresAtMs: NOW - DAY },
                    { id: 'live', kind: 'usage_limit_reset', status: 'available', expiresAtMs: NOW + DAY },
                ],
            }),
            NOW,
            formatter,
        );
        expect(rows.map((row) => row.consumableCreditId)).toEqual(['live', null]);
    });

    it('returns no rows when every detailed credit is unavailable', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                availableCount: 1,
                credits: [{ id: 'gone', kind: 'usage_limit_reset', status: 'redeemed' }],
            }),
            NOW,
            formatter,
        );
        expect(rows).toEqual([expect.objectContaining({ consumableCreditId: null, canUse: true, isAggregate: true })]);
    });

    it('retains an aggregate remainder when the authoritative total exceeds capped detail rows', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                availableCount: 3,
                credits: [{ id: 'credit-a', kind: 'usage_limit_reset', status: 'available' }],
            }), NOW, formatter,
        );
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ key: 'aggregate-remainder', consumableCreditId: null, canUse: true, isAggregate: true });
    });

    it('caps individually actionable detail rows at the authoritative available count', () => {
        const rows = buildQuotaResetRows(
            ConnectedServiceQuotaRecoveryCreditsV1Schema.parse({
                availableCount: 1,
                credits: [
                    { id: 'credit-a', kind: 'usage_limit_reset', status: 'available' },
                    { id: 'credit-b', kind: 'usage_limit_reset', status: 'available' },
                ],
            }), NOW, formatter,
        );
        expect(rows.map((row) => row.consumableCreditId)).toEqual(['credit-a']);
    });

    it('preserves aggregate redemption when a legacy available detail has no usable id', () => {
        const recoveryCredits = {
            availableCount: 1,
            credits: [{ kind: 'usage_limit_reset', status: 'available' }],
        } as unknown as ConnectedServiceQuotaRecoveryCreditsV1;
        expect(buildQuotaResetRows(recoveryCredits, NOW, formatter)).toEqual([
            expect.objectContaining({
                key: 'aggregate-remainder',
                consumableCreditId: null,
                canUse: true,
                isAggregate: true,
            }),
        ]);
    });
});
