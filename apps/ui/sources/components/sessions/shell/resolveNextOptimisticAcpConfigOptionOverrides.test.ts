import { describe, expect, it } from 'vitest';

import { resolveNextOptimisticAcpConfigOptionOverrides } from './resolveNextOptimisticAcpConfigOptionOverrides';

type Overrides = Readonly<{
    v: 1;
    updatedAt: number;
    overrides: Readonly<Record<string, Readonly<{ updatedAt: number; value: string }>>>;
}>;

describe('resolveNextOptimisticAcpConfigOptionOverrides', () => {
    it('retires a refused choice while preserving unrelated and newer optimistic choices', () => {
        const incoming: Overrides = { v: 1, updatedAt: 10, overrides: {
            effort: { updatedAt: 10, value: 'medium' },
        } };
        const current: Overrides = { v: 1, updatedAt: 30, overrides: {
            effort: { updatedAt: 20, value: 'high' },
            fast: { updatedAt: 30, value: 'true' },
        } };
        expect(resolveNextOptimisticAcpConfigOptionOverrides({
            current, incoming, sessionChanged: false, rejected: { configId: 'effort', updatedAt: 20 },
        })).toEqual({ v: 1, updatedAt: 30, overrides: {
            effort: incoming.overrides.effort,
            fast: current.overrides.fast,
        } });
        expect(resolveNextOptimisticAcpConfigOptionOverrides({
            current, incoming, sessionChanged: false, rejected: { configId: 'effort', updatedAt: 19 },
        })).toBe(current);
    });

    it('keeps the current optimistic object when the server snapshot is semantically identical', () => {
        const current: Overrides = {
            v: 1,
            updatedAt: 42,
            overrides: {
                thinking: {
                    updatedAt: 42,
                    value: 'high',
                },
            },
        };
        const incoming: Overrides = {
            v: 1,
            updatedAt: 42,
            overrides: {
                thinking: {
                    updatedAt: 42,
                    value: 'high',
                },
            },
        };

        expect(resolveNextOptimisticAcpConfigOptionOverrides({
            current,
            incoming,
            sessionChanged: false,
        })).toBe(current);
    });

    it('adopts the incoming server snapshot when it is newer than the optimistic state', () => {
        const current: Overrides = {
            v: 1,
            updatedAt: 42,
            overrides: {
                thinking: {
                    updatedAt: 42,
                    value: 'medium',
                },
            },
        };
        const incoming: Overrides = {
            v: 1,
            updatedAt: 50,
            overrides: {
                thinking: {
                    updatedAt: 50,
                    value: 'high',
                },
            },
        };

        expect(resolveNextOptimisticAcpConfigOptionOverrides({
            current,
            incoming,
            sessionChanged: false,
        })).toBe(incoming);
    });

    it('preserves the optimistic state when the server snapshot is older or missing', () => {
        const current: Overrides = {
            v: 1,
            updatedAt: 42,
            overrides: {
                thinking: {
                    updatedAt: 42,
                    value: 'high',
                },
            },
        };
        const olderIncoming: Overrides = {
            v: 1,
            updatedAt: 40,
            overrides: {
                thinking: {
                    updatedAt: 40,
                    value: 'medium',
                },
            },
        };

        expect(resolveNextOptimisticAcpConfigOptionOverrides({
            current,
            incoming: olderIncoming,
            sessionChanged: false,
        })).toBe(current);
        expect(resolveNextOptimisticAcpConfigOptionOverrides({
            current,
            incoming: null,
            sessionChanged: false,
        })).toBe(current);
    });
});
