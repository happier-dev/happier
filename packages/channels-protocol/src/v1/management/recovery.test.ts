import { describe, expect, it } from 'vitest';

import {
    ConversationDeliveryResolveInputV1Schema,
    ConversationDeliveryResolveResultV1Schema,
    ConversationIngressRetryInputV1Schema,
    ConversationIngressRetryResultV1Schema,
} from './recovery.js';

describe('Channels V1 custody recovery contracts', () => {
    it('keeps ingress retry to one exact blocked-obligation CAS', () => {
        const obligationId = 'A'.repeat(43);
        const input = { obligationId, expectedRevision: 5 } as const;
        const result = { kind: 'retryScheduled', obligationId, revision: 6 } as const;

        expect(ConversationIngressRetryInputV1Schema.parse(input)).toEqual(input);
        expect(ConversationIngressRetryResultV1Schema.parse(result)).toEqual(result);
        expect(ConversationIngressRetryInputV1Schema.safeParse({
            ...input,
            force: true,
        }).success).toBe(false);
        expect(ConversationIngressRetryInputV1Schema.safeParse({
            ...input,
            obligationId: 'not-an-opaque-obligation',
        }).success).toBe(false);
    });

    it('settles ambiguous delivery custody without exposing another send path', () => {
        const custodyId = 'B'.repeat(43);
        const input = { custodyId, expectedRevision: 5, resolution: 'accepted' } as const;
        const result = { kind: 'resolved', custodyId, revision: 6, resolution: 'accepted' } as const;

        expect(ConversationDeliveryResolveInputV1Schema.parse(input)).toEqual(input);
        expect(ConversationDeliveryResolveResultV1Schema.parse(result)).toEqual(result);
        expect(ConversationDeliveryResolveInputV1Schema.safeParse({
            ...input,
            resolution: 'retry',
        }).success).toBe(false);
        expect(ConversationDeliveryResolveInputV1Schema.safeParse({
            ...input,
            deliveryKey: 'replay',
        }).success).toBe(false);
        expect(ConversationDeliveryResolveResultV1Schema.safeParse({
            ...result,
            state: 'ready',
        }).success).toBe(false);
    });
});
