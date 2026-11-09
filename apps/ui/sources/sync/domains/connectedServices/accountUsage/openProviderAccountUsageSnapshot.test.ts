import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageRecordId} from '@happier-dev/protocol/connect/account-usage-primitives';
import { sealProviderAccountUsageSnapshot } from '@happier-dev/protocol/connect/accountUsage';

import { encodeBase64 } from '@/encryption/base64';
import { openProviderAccountUsageSnapshot } from './openProviderAccountUsageSnapshot';

describe('openProviderAccountUsageSnapshot', () => {
    it('opens sealed supplemental facts through the V4 encrypted PAU response', () => {
        const secret = new Uint8Array(32).fill(7);
        const recordKey = {
            providerId: 'codex', accountSubjectId: 'account',
            subjectKind: 'account', quotaScope: 'account',
        } as const;
        const snapshot = {
            v: 1 as const,
            recordId: buildProviderAccountUsageRecordId(recordKey),
            recordKey,
            providerId: 'codex',
            accountSubject: { kind: 'providerSubject' as const, id: 'account' },
            observedAtMs: 1_000, fetchedAtMs: 1_000, staleAfterMs: 60_000,
            source: 'providerHttp' as const, confidence: 'confirmed' as const,
            state: 'loaded_empty' as const, meters: [],
            recoveryCreditDetails: { saved: { remainingCount: 2, appliesToProviderLimitIds: ['seven_day'], unavailableReason: 'paused' as const } },
            subscription: {
                status: 'subscribed' as const, renewal: 'off' as const,
                observedAtMs: 900, staleAfterMs: 60_000,
                currentPeriodEndAtMs: 1_800_000_000_000,
            },
        };
        const sealed = sealProviderAccountUsageSnapshot({
            material: { type: 'legacy', secret }, snapshot,
            randomBytes: (length) => new Uint8Array(length).fill(3),
        });
        const credentials = { token: 'synthetic', secret: encodeBase64(secret, 'base64url') };
        expect(openProviderAccountUsageSnapshot(credentials, {
            t: 'encrypted', c: sealed.ciphertext, subscription: sealed.subscription, recoveryCreditDetails: sealed.recoveryCreditDetails,
        })).toEqual(snapshot);
    });
});
