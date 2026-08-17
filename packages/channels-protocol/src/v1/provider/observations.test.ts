import { describe, expect, it } from 'vitest';

import {
    ConversationPollInputV1Schema,
    ConversationPollResultV1Schema,
} from './observations.js';

describe('Channels V1 provider observations', () => {
    it('owns one poll input/output boundary rather than a provider checkpoint writer', () => {
        const input = {
            v: 1,
            connectionId: 'connection-1',
            providerConnectionKey: 'provider:connection-1',
            providerConfigVersion: 1,
            providerConfig: { installation: 'installation-1' },
            credentialRef: null,
            checkpoint: { cursor: 'before' },
            limit: 100,
            waitMs: 60_000,
        } as const;
        const result = {
            kind: 'checkpointOnly',
            checkpointAfterBatch: { cursor: 'after' },
            retryHint: { retryAfterMs: 500 },
        } as const;

        expect(ConversationPollInputV1Schema.parse(input)).toEqual(input);
        expect(ConversationPollResultV1Schema.parse(result)).toEqual(result);
        expect(ConversationPollInputV1Schema.safeParse({
            ...input,
            limit: 101,
        }).success).toBe(false);
        expect(ConversationPollResultV1Schema.safeParse({
            ...result,
            checkpointTransition: { providerOwned: true },
        }).success).toBe(false);
        expect(ConversationPollResultV1Schema.safeParse({
            kind: 'historyGap',
            reason: 'applicationAdmissionLost',
        }).success).toBe(false);
    });
});
