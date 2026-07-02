import { describe, expect, it } from 'vitest';

import {
    ConnectedServiceLimitCategoryV1Schema,
    normalizeConnectedServiceLimitCategoryV1,
    readConnectedServiceLimitCategoryV1,
} from './connectedServiceLimitCategory.js';

describe('connectedServiceLimitCategory', () => {
    it('accepts canonical public limit-category names unchanged', () => {
        expect(ConnectedServiceLimitCategoryV1Schema.parse('usage_limit')).toBe('usage_limit');
        expect(ConnectedServiceLimitCategoryV1Schema.parse('auth_invalid')).toBe('auth_invalid');
        expect(ConnectedServiceLimitCategoryV1Schema.parse('temporary_throttle')).toBe('temporary_throttle');
    });

    it('normalizes legacy aliases to the canonical public vocabulary', () => {
        expect(ConnectedServiceLimitCategoryV1Schema.parse('quota')).toBe('usage_limit');
        expect(ConnectedServiceLimitCategoryV1Schema.parse('auth')).toBe('auth_invalid');
        expect(ConnectedServiceLimitCategoryV1Schema.parse('plan')).toBe('plan_invalid');
        expect(ConnectedServiceLimitCategoryV1Schema.parse('validation')).toBe('validation_failed');
        expect(ConnectedServiceLimitCategoryV1Schema.parse('account_disabled')).toBe('disabled');
    });

    it('exposes the same normalization through the helper', () => {
        expect(normalizeConnectedServiceLimitCategoryV1('quota')).toBe('usage_limit');
        expect(normalizeConnectedServiceLimitCategoryV1('auth')).toBe('auth_invalid');
        expect(normalizeConnectedServiceLimitCategoryV1('plan')).toBe('plan_invalid');
        expect(normalizeConnectedServiceLimitCategoryV1('validation')).toBe('validation_failed');
        expect(normalizeConnectedServiceLimitCategoryV1('account_disabled')).toBe('disabled');
    });

    it('reads and trims canonical or legacy input while failing closed on unknown values', () => {
        expect(readConnectedServiceLimitCategoryV1(' usage_limit ')).toBe('usage_limit');
        expect(readConnectedServiceLimitCategoryV1(' auth ')).toBe('auth_invalid');
        expect(readConnectedServiceLimitCategoryV1('')).toBeNull();
        expect(readConnectedServiceLimitCategoryV1('unsupported')).toBeNull();
        expect(readConnectedServiceLimitCategoryV1(null)).toBeNull();
    });
});
