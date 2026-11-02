import { describe, expect, it } from 'vitest';
import { retainIfEqual } from './structuralSharing';

describe('retainIfEqual', () => {
    it('keeps an equal value whole and never rebuilds a partially equal one', () => {
        const previous = { shared: { v: 1 }, title: 'a' };
        expect(retainIfEqual(previous, { title: 'a', shared: { v: 1 } })).toBe(previous);
        const changed = { shared: { v: 1 }, title: 'b' };
        const retained = retainIfEqual(previous, changed);
        expect(retained).toBe(changed);
        expect(retained.shared).toBe(changed.shared);
    });
});
