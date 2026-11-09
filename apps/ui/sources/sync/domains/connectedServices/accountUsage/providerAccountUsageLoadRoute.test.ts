import { describe, expect, it } from 'vitest';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema} from '@happier-dev/protocol/connect/account-usage-primitives';
import {
    sealProviderAccountUsageSnapshot } from '@happier-dev/protocol/connect/accountUsage';
import { encodeBase64 } from '@/encryption/base64';
import { openProviderAccountUsageSnapshot } from './openProviderAccountUsageSnapshot';

import {
    buildProviderAccountUsageScopeKey,
    readProviderAccountUsageSnapshotForMode,
} from './providerAccountUsageLoadRoute';

describe('providerAccountUsageLoadRoute', () => {
    it('uses the plaintext route exclusively when the selected mode returns no snapshot', async () => {
        await expect(readProviderAccountUsageSnapshotForMode({
            mode: 'plain',
            readPlain: async () => null,
            readSealed: async () => { throw new Error('A plaintext miss must not request encrypted content'); },
            openSealed: () => { throw new Error('A plaintext miss must not invoke encrypted opening'); },
        })).resolves.toBeNull();
    });

    it('uses only the sealed route for an e2ee account', async () => {
        const secret = new Uint8Array(32).fill(7);
        const recordKey = { providerId: 'codex', accountSubjectId: 'account',
            subjectKind: 'account', quotaScope: 'account' } as const;
        const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
            v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
            providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'account' },
            observedAtMs: 1000, fetchedAtMs: 1000, staleAfterMs: 60_000,
            source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [],
        });
        const sealed = sealProviderAccountUsageSnapshot({ material: { type: 'legacy', secret }, snapshot,
            randomBytes: length => new Uint8Array(length).fill(3) });
        const credentials = { token: 'synthetic', secret: encodeBase64(secret, 'base64url') };

        await expect(readProviderAccountUsageSnapshotForMode({
            mode: 'e2ee',
            readPlain: async () => { throw new Error('An E2EE Account must not request plaintext content'); },
            readSealed: async () => sealed,
            openSealed: content => openProviderAccountUsageSnapshot(credentials, content),
        })).resolves.toEqual(snapshot);
    });

    it('separates identical credentials across active servers', () => {
        expect(buildProviderAccountUsageScopeKey({
            serverId: 'server-a',
            generation: 1,
            credentialScope: 'same-credentials',
        })).not.toBe(buildProviderAccountUsageScopeKey({
            serverId: 'server-b',
            generation: 1,
            credentialScope: 'same-credentials',
        }));
    });

    it('separates cache scope across generations of the same active server', () => {
        expect(buildProviderAccountUsageScopeKey({
            serverId: 'server-a',
            generation: 1,
            credentialScope: 'same-credentials',
        })).not.toBe(buildProviderAccountUsageScopeKey({
            serverId: 'server-a',
            generation: 2,
            credentialScope: 'same-credentials',
        }));
    });
});
