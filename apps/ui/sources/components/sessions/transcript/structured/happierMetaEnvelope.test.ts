import { describe, expect, it } from 'vitest';

import { parseHappierMetaEnvelope } from './happierMetaEnvelope';

describe('parseHappierMetaEnvelope', () => {
    it('returns null when meta does not contain a happier envelope', () => {
        expect(parseHappierMetaEnvelope(undefined)).toBeNull();
        expect(parseHappierMetaEnvelope({})).toBeNull();
        expect(parseHappierMetaEnvelope({ happier: null })).toBeNull();
    });

    it('accepts a payload-free internal marker through the shared envelope', () => {
        expect(parseHappierMetaEnvelope({ happier: { kind: 'claude_jsonl_consumed_marker.v1' } }))
            .toEqual({ kind: 'claude_jsonl_consumed_marker.v1' });
    });

    it('returns kind + payload when meta contains a valid envelope', () => {
        const parsed = parseHappierMetaEnvelope({
            happier: { kind: 'review_comments.v1', payload: { ok: true } },
        });
        expect(parsed).toEqual({ kind: 'review_comments.v1', payload: { ok: true } });
    });

    it('rejects an empty envelope kind through the canonical protocol contract', () => {
        expect(parseHappierMetaEnvelope({ happier: { kind: '', payload: {} } })).toBeNull();
    });

    it('projects structured input only when the primary envelope is absent', () => {
        const completion = { runId: 'run-1' };
        const meta = { happierStructuredInputV1: { executionRunCompletion: completion } };
        expect(parseHappierMetaEnvelope(meta)).toEqual({ kind: 'execution_run_completion.v1', payload: completion });
        for (const happier of [undefined, null, {}, { kind: 1 }]) {
            expect(parseHappierMetaEnvelope({ ...meta, happier })).toBeNull();
        }
        expect(parseHappierMetaEnvelope(meta, 'custom')).toBeNull();
    });
});

