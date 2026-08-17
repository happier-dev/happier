import { describe, expect, it } from 'vitest';

import {
    ConversationBindingIdV1Schema,
    ConversationConnectionIdV1ProtocolSchema,
    ConversationConnectionIdV1Schema,
} from './identity.js';

describe('Channels V1 relation identities', () => {
    it('accepts bounded printable ASCII identifiers and rejects whitespace or an unknown field carrier', () => {
        expect(ConversationConnectionIdV1Schema.parse('connection-1')).toBe('connection-1');
        expect(ConversationBindingIdV1Schema.parse('binding/1')).toBe('binding/1');
        expect(ConversationConnectionIdV1Schema.safeParse('connection 1').success).toBe(false);
        expect(ConversationBindingIdV1Schema.safeParse('\n').success).toBe(false);
    });

    it('shares one relative-only protocol source with composed V1 schemas', () => {
        expect(ConversationConnectionIdV1ProtocolSchema.safeParse('connection-1').success).toBe(true);
        expect(ConversationConnectionIdV1ProtocolSchema.safeParse('connection 1').success).toBe(false);
    });
});
