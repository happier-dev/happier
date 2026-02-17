import { describe, expect, it } from "vitest";
import { LRUSet, LRUTtlMap } from "./lru";

describe("LRUSet", () => {
    it.each([0, -1])(
        "throws when maxSize is %i",
        (maxSize) => {
            expect(() => new LRUSet(maxSize)).toThrow(/maxSize must be greater than 0/i);
        },
    );

    it("creates set with positive maxSize", () => {
        const lru = new LRUSet(3);
        expect(lru.size).toBe(0);
    });

    it("adds values and deduplicates repeated inserts", () => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3);
        lru.add(1);
        lru.add(1);

        expect(lru.size).toBe(3);
        expect(lru.has(1)).toBe(true);
        expect(lru.has(2)).toBe(true);
        expect(lru.has(3)).toBe(true);
    });

    it("evicts least recently used item when capacity is exceeded", () => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3);
        lru.add(4);

        expect(lru.size).toBe(3);
        expect(lru.has(1)).toBe(false);
        expect(lru.has(2)).toBe(true);
        expect(lru.has(3)).toBe(true);
        expect(lru.has(4)).toBe(true);
    });

    it.each([
        {
            label: "moves has()-accessed item to front",
            touch: (lru: LRUSet<number>) => {
                lru.has(1);
            },
        },
        {
            label: "moves re-added item to front",
            touch: (lru: LRUSet<number>) => {
                lru.add(1);
            },
        },
    ])("$label", ({ touch }) => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3);

        touch(lru);
        lru.add(4);

        expect(lru.has(1)).toBe(true);
        expect(lru.has(2)).toBe(false);
        expect(lru.has(3)).toBe(true);
        expect(lru.has(4)).toBe(true);
    });

    it("deletes values and returns deletion status", () => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3);

        expect(lru.delete(2)).toBe(true);
        expect(lru.size).toBe(2);
        expect(lru.has(2)).toBe(false);
        expect(lru.delete(2)).toBe(false);
    });

    it.each([
        { label: "head", deleteValue: 3, expected: [2, 1] },
        { label: "tail", deleteValue: 1, expected: [3, 2] },
    ])("handles delete of $label node", ({ deleteValue, expected }) => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3);

        expect(lru.delete(deleteValue)).toBe(true);
        expect(lru.size).toBe(2);
        expect(lru.toArray()).toEqual(expected);
    });

    it("clears all values", () => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3);

        lru.clear();

        expect(lru.size).toBe(0);
        expect(lru.toArray()).toEqual([]);
        expect(Array.from(lru.values())).toEqual([]);
    });

    it("iterates and serializes in most-recent-first order", () => {
        const lru = new LRUSet<number>(4);
        lru.add(1);
        lru.add(2);
        lru.add(3);
        lru.add(4);

        expect(Array.from(lru.values())).toEqual([4, 3, 2, 1]);
        expect(lru.toArray()).toEqual([4, 3, 2, 1]);
    });

    it("works with string values", () => {
        const lru = new LRUSet<string>(3);
        lru.add("a");
        lru.add("b");
        lru.add("c");
        lru.add("d");

        expect(lru.has("a")).toBe(false);
        expect(lru.has("b")).toBe(true);
        expect(lru.has("c")).toBe(true);
        expect(lru.has("d")).toBe(true);
    });

    it("works with object identity values", () => {
        const lru = new LRUSet<{ id: number }>(2);
        const obj1 = { id: 1 };
        const obj2 = { id: 2 };
        const obj3 = { id: 3 };

        lru.add(obj1);
        lru.add(obj2);
        lru.add(obj3);

        expect(lru.has(obj1)).toBe(false);
        expect(lru.has(obj2)).toBe(true);
        expect(lru.has(obj3)).toBe(true);
    });

    it("handles single item capacity", () => {
        const lru = new LRUSet<number>(1);
        lru.add(1);
        lru.add(2);

        expect(lru.size).toBe(1);
        expect(lru.has(1)).toBe(false);
        expect(lru.has(2)).toBe(true);
    });

    it("handles operations on empty set", () => {
        const lru = new LRUSet<number>(3);

        expect(lru.size).toBe(0);
        expect(lru.has(1)).toBe(false);
        expect(lru.delete(1)).toBe(false);
        expect(lru.toArray()).toEqual([]);
        expect(Array.from(lru.values())).toEqual([]);
    });
});

describe("LRUTtlMap", () => {
    it.each([0, -1])("throws when maxSize is %i", (maxSize) => {
        expect(() => new LRUTtlMap({ maxSize })).toThrow(/maxSize must be greater than 0/i);
    });

    it("returns undefined for missing keys", () => {
        const lru = new LRUTtlMap<string, number>({ maxSize: 2 });
        expect(lru.get("missing")).toBeUndefined();
        expect(lru.size).toBe(0);
    });

    it("evicts least recently used entry when capacity is exceeded", () => {
        const lru = new LRUTtlMap<string, number>({ maxSize: 2 });
        lru.set("a", 1);
        lru.set("b", 2);
        expect(lru.get("a")).toBe(1); // touch "a" to keep it
        lru.set("c", 3); // should evict "b"

        expect(lru.get("b")).toBeUndefined();
        expect(lru.get("a")).toBe(1);
        expect(lru.get("c")).toBe(3);
        expect(lru.size).toBe(2);
    });

    it("expires entries after ttlMs since last access", () => {
        let nowMs = 0;
        const lru = new LRUTtlMap<string, number>({
            maxSize: 2,
            ttlMs: 10,
            now: () => nowMs,
        });

        lru.set("a", 1);
        expect(lru.get("a")).toBe(1);

        nowMs += 11;
        expect(lru.get("a")).toBeUndefined();
        expect(lru.size).toBe(0);
    });

    it("refreshes ttl window on access", () => {
        let nowMs = 0;
        const lru = new LRUTtlMap<string, number>({
            maxSize: 2,
            ttlMs: 10,
            now: () => nowMs,
        });

        lru.set("a", 1);

        nowMs += 9;
        expect(lru.get("a")).toBe(1); // refresh at t=9

        nowMs += 9; // t=18, still within 10ms of last access
        expect(lru.get("a")).toBe(1);
    });
});
