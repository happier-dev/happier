import { describe, expect, it } from 'vitest';
import { retainDeep, retainIfEqual, retainKeyedRows, retainShallow } from './structuralSharing';

describe('retainDeep', () => {
    it('returns the previous value for an equal value regardless of member order', () => {
        const previous = { a: 1, nested: { x: [1, 2], y: 'v' } };
        expect(retainDeep(previous, { nested: { y: 'v', x: [1, 2] }, a: 1 })).toBe(previous);
    });

    it('treats an undefined member as an omitted member', () => {
        const previous: { a: number; b?: number | undefined } = { a: 1 };
        expect(retainDeep(previous, { a: 1, b: undefined })).toBe(previous);
    });

    it('keeps unchanged members and array entries when a sibling changes', () => {
        const previous = { keep: { v: 1 }, list: [{ id: 'a' }, { id: 'b' }], title: 'old' };
        const next = { keep: { v: 1 }, list: [{ id: 'a' }, { id: 'c' }], title: 'old' };
        const retained = retainDeep(previous, next);
        expect(retained).not.toBe(previous);
        expect(retained.keep).toBe(previous.keep);
        expect(retained.list).not.toBe(previous.list);
        expect(retained.list[0]).toBe(previous.list[0]);
        expect(retained.list[1]).toBe(next.list[1]);
    });

    it('keeps items a caller already reconciled by key instead of re-diffing them by position', () => {
        const a = { id: 'a', v: 1 };
        const b = { id: 'b', v: 2 };
        const previous = { rows: [a, b] };
        const reordered = { rows: [b, { id: 'a', v: 3 }] };
        const retained = retainDeep(previous, reordered);
        expect(retained.rows[0]).toBe(b);
        expect(retained.rows[1]).toEqual({ id: 'a', v: 3 });
    });

    it('returns the next value itself when nothing is shared', () => {
        const previous = { a: { v: 1 } };
        const next = { a: { v: 2 } };
        expect(retainDeep(previous, next)).toBe(next);
    });

    it('does not fold opaque objects or drop symbol members', () => {
        const sidecar = Symbol('sidecar');
        const previous = { when: new Date(1), kind: new Map([['a', 1]]), [sidecar]: { admitted: true }, title: 'a' };
        const next = { when: new Date(1), kind: new Map([['a', 1]]), [sidecar]: { admitted: true }, title: 'b' };
        const retained = retainDeep(previous, next);
        expect(retained.when).toBe(next.when);
        expect(retained.kind).toBe(next.kind);
        expect(retained[sidecar]).toBe(next[sidecar]);
    });
});

describe('retainKeyedRows', () => {
    const key = (row: { id: string }) => row.id;

    it('keeps the previous array when ordered contents are equal', () => {
        const previous = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
        expect(retainKeyedRows(previous, [{ v: 1, id: 'a' }, { id: 'b', v: 2 }], key)).toBe(previous);
    });

    it('keeps unchanged rows by key across reordering and edits', () => {
        const previous = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
        const rows = retainKeyedRows(previous, [{ id: 'b', v: 2 }, { id: 'a', v: 9 }], key);
        expect(rows).not.toBe(previous);
        expect(rows[0]).toBe(previous[1]);
        expect(rows[1]).not.toBe(previous[0]);
    });

    it('publishes a frozen array unless the caller keeps a mutable contract', () => {
        const incoming = [{ id: 'a' }];
        expect(Object.isFrozen(retainKeyedRows(null, incoming, key))).toBe(true);
        expect(Object.isFrozen(retainKeyedRows(null, incoming, key, { freeze: false }))).toBe(false);
    });
});

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

describe('retainDeep freeze', () => {
    it('freezes only the containers it rebuilds', () => {
        const previous = { keep: { v: 1 }, title: 'a' };
        const retained = retainDeep(previous, { keep: { v: 1 }, title: 'b' }, { freeze: true });
        expect(Object.isFrozen(retained)).toBe(true);
        expect(retained.keep).toBe(previous.keep);
    });
});

describe('retainShallow', () => {
    const open = () => undefined;
    it('keeps the previous bundle while every member keeps its identity, even for equal-looking new members', () => {
        const previous = { open, tabs: [1], scope: 'a' };
        expect(retainShallow(previous, { open, tabs: previous.tabs, scope: 'a' })).toBe(previous);
        const next = { open, tabs: [1], scope: 'a' };
        expect(retainShallow(previous, next)).toBe(next);
        expect(retainShallow(previous, { open, tabs: previous.tabs, scope: 'b' })).toEqual({ open, tabs: previous.tabs, scope: 'b' });
    });
    it('treats a different member set as a change', () => {
        const previous: { a: number; b?: number | undefined } = { a: 1 };
        const next = { a: 1, b: undefined };
        expect(retainShallow(previous, next)).toBe(next);
    });
});
