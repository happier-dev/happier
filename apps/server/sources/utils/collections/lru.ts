class Node<T> {
    constructor(
        public value: T,
        public prev: Node<T> | null = null,
        public next: Node<T> | null = null
    ) {}
}

export class LRUSet<T> {
    private readonly maxSize: number;
    private readonly map: Map<T, Node<T>>;
    private head: Node<T> | null = null;
    private tail: Node<T> | null = null;

    constructor(maxSize: number) {
        if (maxSize <= 0) {
            throw new Error('LRUSet maxSize must be greater than 0');
        }
        this.maxSize = maxSize;
        this.map = new Map();
    }

    private moveToFront(node: Node<T>): void {
        if (node === this.head) return;

        // Remove from current position
        if (node.prev) node.prev.next = node.next;
        if (node.next) node.next.prev = node.prev;
        if (node === this.tail) this.tail = node.prev;

        // Move to front
        node.prev = null;
        node.next = this.head;
        if (this.head) this.head.prev = node;
        this.head = node;
        if (!this.tail) this.tail = node;
    }

    add(value: T): void {
        const existingNode = this.map.get(value);
        
        if (existingNode) {
            // Move to front (most recently used)
            this.moveToFront(existingNode);
            return;
        }

        // Create new node
        const newNode = new Node(value);
        this.map.set(value, newNode);

        // Add to front
        newNode.next = this.head;
        if (this.head) this.head.prev = newNode;
        this.head = newNode;
        if (!this.tail) this.tail = newNode;

        // Remove LRU if over capacity
        if (this.map.size > this.maxSize) {
            if (this.tail) {
                this.map.delete(this.tail.value);
                this.tail = this.tail.prev;
                if (this.tail) this.tail.next = null;
            }
        }
    }

    has(value: T): boolean {
        const node = this.map.get(value);
        if (node) {
            this.moveToFront(node);
            return true;
        }
        return false;
    }

    delete(value: T): boolean {
        const node = this.map.get(value);
        if (!node) return false;

        // Remove from linked list
        if (node.prev) node.prev.next = node.next;
        if (node.next) node.next.prev = node.prev;
        if (node === this.head) this.head = node.next;
        if (node === this.tail) this.tail = node.prev;

        return this.map.delete(value);
    }

    clear(): void {
        this.map.clear();
        this.head = null;
        this.tail = null;
    }

    get size(): number {
        return this.map.size;
    }

    *values(): IterableIterator<T> {
        let current = this.head;
        while (current) {
            yield current.value;
            current = current.next;
        }
    }

    toArray(): T[] {
        return Array.from(this.values());
    }
}

type NowFn = () => number;

export class LRUTtlMap<K, V> {
    private readonly maxSize: number;
    private readonly ttlMs: number | null;
    private readonly now: NowFn;
    private readonly map = new Map<K, { value: V; lastAccessedAt: number }>();

    constructor(options: { maxSize: number; ttlMs?: number | null; now?: NowFn }) {
        const { maxSize, ttlMs, now } = options;
        if (maxSize <= 0) {
            throw new Error("LRUTtlMap maxSize must be greater than 0");
        }
        this.maxSize = maxSize;
        this.ttlMs = typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : null;
        this.now = now ?? Date.now;
    }

    get size(): number {
        return this.map.size;
    }

    clear(): void {
        this.map.clear();
    }

    delete(key: K): boolean {
        return this.map.delete(key);
    }

    private pruneExpiredWithNow(nowMs: number): void {
        if (this.ttlMs === null) {
            return;
        }

        const cutoffMs = nowMs - this.ttlMs;
        while (this.map.size > 0) {
            const oldestEntry = this.map.values().next().value as
                | { value: V; lastAccessedAt: number }
                | undefined;
            if (!oldestEntry || oldestEntry.lastAccessedAt > cutoffMs) {
                break;
            }
            const oldestKey = this.map.keys().next().value as K | undefined;
            if (oldestKey === undefined) {
                break;
            }
            this.map.delete(oldestKey);
        }
    }

    pruneExpired(): void {
        this.pruneExpiredWithNow(this.now());
    }

    peekOldestAccessedAt(): number | null {
        const oldest = this.map.values().next().value as
            | { value: V; lastAccessedAt: number }
            | undefined;
        return oldest ? oldest.lastAccessedAt : null;
    }

    *entries(): IterableIterator<[K, V]> {
        for (const [key, entry] of this.map.entries()) {
            yield [key, entry.value];
        }
    }

    get(key: K): V | undefined {
        const nowMs = this.now();
        this.pruneExpiredWithNow(nowMs);

        const entry = this.map.get(key);
        if (!entry) {
            return undefined;
        }

        // Refresh LRU position + idle TTL window.
        entry.lastAccessedAt = nowMs;
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    set(key: K, value: V): void {
        const nowMs = this.now();
        this.pruneExpiredWithNow(nowMs);

        if (this.map.has(key)) {
            this.map.delete(key);
        }
        this.map.set(key, { value, lastAccessedAt: nowMs });

        while (this.map.size > this.maxSize) {
            const oldestKey = this.map.keys().next().value as K | undefined;
            if (oldestKey === undefined) {
                break;
            }
            this.map.delete(oldestKey);
        }
    }
}
