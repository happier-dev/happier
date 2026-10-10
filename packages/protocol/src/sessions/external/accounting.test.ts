import { describe, expect, it } from 'vitest';
import { AgentExternalSessionsReadAccountingResultSchema } from './accounting.js';

const observation = {
    nativeSessionId: 'native-1', observedAt: 10, inferenceId: 'generation-1',
    observation: { provider: 'fixture', source: 'native', scope: 'turn_delta', key: 'generation-1', modelId: null,
        tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
        cost: null, contextUsedTokens: null, contextWindowTokens: null },
};

describe('external accounting admission', () => {
    it('admits an exact machine-local project witness and rejects guessed or transcript-bearing project data', () => {
        const result = { outcome: 'advanced', observations: [{ ...observation,
            project: { rootPath: '/native/project', label: 'Native project' } }],
            nextCursor: 'frontier', coverage: { complete: true } };
        expect(AgentExternalSessionsReadAccountingResultSchema.parse(result)).toEqual(result);
        for (const rootPath of ['/', 'C:\\']) {
            expect(AgentExternalSessionsReadAccountingResultSchema.safeParse({ ...result,
                observations: [{ ...observation, project: { rootPath } }] }).success).toBe(true);
        }
        for (const project of [{ rootPath: '~/guessed' }, { rootPath: '/native/project', label: ' ' },
            { rootPath: '/native/project', transcript: 'private' }]) {
            expect(AgentExternalSessionsReadAccountingResultSchema.safeParse({ ...result,
                observations: [{ ...observation, project }] }).success).toBe(false);
        }
    });
    it('admits explicit counter inclusivity without changing native counters and rejects untyped evidence', () => {
        const result = { outcome: 'advanced', observations: [{ ...observation,
            accounting: { inputIncludesCache: true, outputIncludesReasoning: false } }],
            nextCursor: 'frontier', coverage: { complete: true } };
        expect(AgentExternalSessionsReadAccountingResultSchema.parse(result)).toEqual(result);
        expect(AgentExternalSessionsReadAccountingResultSchema.safeParse({ ...result,
            observations: [{ ...observation, accounting: { inputIncludesCache: 'true' } }] }).success).toBe(false);
        expect(AgentExternalSessionsReadAccountingResultSchema.safeParse({ ...result,
            observations: [{ ...observation, accounting: { raw: 'private' } }] }).success).toBe(false);
    });
    it('admits normalized accounting without a Happier Session and rejects nested transcript and invalid counter data', () => {
        const result = { outcome: 'advanced', observations: [observation], nextCursor: 'frontier', coverage: { complete: false, reason: 'missing_native_identity' } };
        expect(AgentExternalSessionsReadAccountingResultSchema.parse(result)).toEqual(result);
        for (const invalid of [
            { ...result, transcript: [] },
            { ...result, observations: [{ ...observation, sessionId: 'fabricated' }] },
            { ...result, observations: [{ ...observation, observation: { ...observation.observation, content: 'private' } }] },
            { ...result, observations: [{ ...observation, observation: { ...observation.observation, tokens: { ...observation.observation.tokens, input: -1 } } }] },
            { ...result, nextCursor: '' },
        ]) expect(AgentExternalSessionsReadAccountingResultSchema.safeParse(invalid).success).toBe(false);
    });
    it('keeps replacement and missing-cursor outcomes free of an acknowledged frontier', () => {
        for (const outcome of ['unchanged', 'source_replaced', 'gap_or_cursor_expired', 'source_unavailable', 'read_failed']) {
            expect(AgentExternalSessionsReadAccountingResultSchema.safeParse({ outcome }).success).toBe(true);
            expect(AgentExternalSessionsReadAccountingResultSchema.safeParse({ outcome, nextCursor: 'false-ack' }).success).toBe(false);
        }
    });
});
