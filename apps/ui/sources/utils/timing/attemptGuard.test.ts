import { describe, expect, it } from 'vitest';

import { AttemptCancelledError, createAttemptGuard } from './attemptGuard';

describe('createAttemptGuard', () => {
    it('treats only the latest issued token as current', () => {
        const guard = createAttemptGuard();

        const first = guard.next();
        expect(guard.isCurrent(first)).toBe(true);

        const second = guard.next();
        expect(guard.isCurrent(first)).toBe(false);
        expect(guard.isCurrent(second)).toBe(true);
    });

    it('issues monotonically increasing tokens', () => {
        const guard = createAttemptGuard();

        const first = guard.next();
        const second = guard.next();

        expect(second).toBe(first + 1);
    });

    it('invalidates the active attempt on cancel without issuing a usable token', () => {
        const guard = createAttemptGuard();

        const token = guard.next();
        guard.cancel();

        expect(guard.isCurrent(token)).toBe(false);
    });

    it('assertCurrent is a no-op for the current token', () => {
        const guard = createAttemptGuard();

        const token = guard.next();

        expect(() => guard.assertCurrent(token)).not.toThrow();
    });

    it('assertCurrent throws AttemptCancelledError for a stale token', () => {
        const guard = createAttemptGuard();

        const stale = guard.next();
        guard.next();

        expect(() => guard.assertCurrent(stale)).toThrow(AttemptCancelledError);
    });

    it('isolates separate guard instances', () => {
        const a = createAttemptGuard();
        const b = createAttemptGuard();

        const tokenA = a.next();
        b.next();

        expect(a.isCurrent(tokenA)).toBe(true);
    });
});
