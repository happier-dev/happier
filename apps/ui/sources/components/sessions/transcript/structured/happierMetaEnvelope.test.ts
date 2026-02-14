import { describe, expect, it } from 'vitest';

import { parseHappierMetaEnvelope } from './happierMetaEnvelope';

describe('parseHappierMetaEnvelope', () => {
    it('returns null when meta does not contain a happier envelope', () => {
        expect(parseHappierMetaEnvelope(undefined)).toBeNull();
        expect(parseHappierMetaEnvelope({})).toBeNull();
        expect(parseHappierMetaEnvelope({ happier: null })).toBeNull();
    });

    it('returns kind + payload when meta contains a valid envelope', () => {
        const parsed = parseHappierMetaEnvelope({
            happier: { kind: 'review_comments.v1', payload: { ok: true } },
        });
        expect(parsed).toEqual({ kind: 'review_comments.v1', payload: { ok: true } });
    });
});

