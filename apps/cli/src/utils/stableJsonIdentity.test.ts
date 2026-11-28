import { describe, expect, it } from 'vitest';

import { hashStableJsonIdentity, stableJsonStringify } from './stableJsonIdentity';

describe('stableJsonIdentity', () => {
    it('serializes an object referenced twice in full, so distinct values keep distinct identities', () => {
        const shared = { agentId: 'codex' };
        expect(stableJsonStringify({ b: shared, a: shared })).toBe('{"a":{"agentId":"codex"},"b":{"agentId":"codex"}}');
        expect(hashStableJsonIdentity({ a: shared, b: shared })).not.toBe(hashStableJsonIdentity({ a: shared, b: null }));
    });

    it('still terminates on a true cycle', () => {
        const cyclic: Record<string, unknown> = { id: 'x' };
        cyclic.self = cyclic;
        expect(stableJsonStringify(cyclic)).toBe('{"id":"x","self":null}');
    });
});
