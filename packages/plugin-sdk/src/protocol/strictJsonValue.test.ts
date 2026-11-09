import { describe, expect, it } from 'vitest';
import { projectNativeJsonValueForTransport as canonicalProjector, normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { projectNativeJsonValueForTransport } from './index.public.js';

describe('native JSON transport projection', () => {
    it('uses the canonical projector to omit native optional members and retain strict wire data', () => {
        expect(projectNativeJsonValueForTransport).toBe(canonicalProjector);
        const native = { attempt: { attemptId: 'attempt', number: undefined }, values: [null, false, 0, ''] };
        const projected = projectNativeJsonValueForTransport(native);
        expect(projected).toEqual({ attempt: { attemptId: 'attempt' }, values: [null, false, 0, ''] });
        expect(projected).not.toHaveProperty('attempt.number');
        expect(normalizeStrictJsonValue(projected)).toEqual(projected);
        expect(native.attempt).toHaveProperty('number', undefined);
    });

    it.each([{ values: [undefined] }, { values: [Number.NaN] }, { values: [new Date(0)] }])('rejects unsupported array values rather than erasing them %#', ({ values }) => {
        expect(() => projectNativeJsonValueForTransport({ values })).toThrow();
        expect(() => canonicalProjector({ values })).toThrow();
    });
});
