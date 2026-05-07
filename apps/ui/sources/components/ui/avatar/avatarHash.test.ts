import { describe, expect, it } from 'vitest';

import { createSeededRandom, hashStringToPositiveInt, pickSeeded } from './avatarHash';

describe('avatarHash', () => {
    it('preserves the legacy positive hash used by generated avatar styles', () => {
        expect(hashStringToPositiveInt('session-1')).toBe(607795898);
        expect(hashStringToPositiveInt('session-mesh')).toBe(732634428);
    });

    it('creates deterministic pseudo-random sequences from a seed', () => {
        const first = createSeededRandom(12345);
        const second = createSeededRandom(12345);

        expect([first(), first(), first()]).toEqual([second(), second(), second()]);
    });

    it('picks values deterministically from a non-empty list', () => {
        const values = ['a', 'b', 'c'] as const;
        const random = createSeededRandom(9876);

        expect(pickSeeded(values, random)).toBe(pickSeeded(values, createSeededRandom(9876)));
    });
});
