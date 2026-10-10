import { describe, expect, it } from 'vitest';
import { UsagePromptCompositionSchema } from './usagePromptComposition.js';
import { TranscriptRawAgentEventV1Schema } from '../../sessions/messages/transcriptRawRecordV1.js';

describe('content-free prompt composition admission', () => {
    const host = { v: 1, evidenceId: 'evidence-1', sessionId: 'session-1', turnId: null, inputId: 'input-1',
        observedAtMs: 100, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only',
        components: [{ sourceId: 'a'.repeat(64), digest: 'b'.repeat(64), kind: 'instructions', location: 'user',
            byteLength: 20, tokenCount: null, tokenizerId: null, cacheClass: 'unknown', overlap: 'none' }],
        nativePrefix: null, contextWindowTokens: null };
    it('accepts witnessed byte facts while rejecting retained content and invented native authority', () => {
        expect(UsagePromptCompositionSchema.parse(host)).toEqual(host);
        expect(UsagePromptCompositionSchema.safeParse({ ...host, components: [{ ...host.components[0], text: 'private' }] }).success).toBe(false);
        expect(UsagePromptCompositionSchema.safeParse({ ...host, coverage: 'complete_native' }).success).toBe(false);
        expect(UsagePromptCompositionSchema.safeParse({ ...host, components: [{ ...host.components[0], sourceId: '/private/repo' }] }).success).toBe(false);
        expect(UsagePromptCompositionSchema.safeParse({ ...host, components: [{ ...host.components[0], tokenCount: 5 }] }).success).toBe(false);
    });
    it('accepts the composition only through the existing strict Session event arm', () => {
        const event = { type: 'prompt-composition', composition: host };
        expect(TranscriptRawAgentEventV1Schema.parse(event)).toEqual(event);
        expect(TranscriptRawAgentEventV1Schema.safeParse({ ...event, rawPrompt: 'private' }).success).toBe(false);
        expect(TranscriptRawAgentEventV1Schema.safeParse({ ...event,
            composition: { ...host, path: '/private/repo' } }).success).toBe(false);
    });
    it('refuses a native prefix token measurement without its tokenizer basis', () => {
        const native = { ...host, boundary: 'agent_native_request', coverage: 'complete_native', nativePrefix: {
            digest: 'c'.repeat(64), tokenCount: 100, tokenizerId: null, cacheOutcome: 'unknown', missCause: 'unknown',
            cacheReadTokens: null, cacheWriteTokens: null, ttlMs: null,
        } };
        expect(UsagePromptCompositionSchema.safeParse(native).success).toBe(false);
        expect(UsagePromptCompositionSchema.safeParse({ ...native,
            nativePrefix: { ...native.nativePrefix, tokenizerId: 'native' } }).success).toBe(true);
    });
});
