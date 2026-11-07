/** Immutable Inbox indexes: a changed page copies search paths, never the retained inventory. */
export type InboxTree<Key, Value> = Readonly<{
    key: Key;
    value: Value;
    left: InboxTree<Key, Value>;
    right: InboxTree<Key, Value>;
    height: number;
    size: number;
}> | null;

type Compare<Key> = (left: Key, right: Key) => number;
const height = <Key, Value>(tree: InboxTree<Key, Value>) => tree?.height ?? 0;
export const inboxTreeSize = <Key, Value>(tree: InboxTree<Key, Value>) => tree?.size ?? 0;

function node<Key, Value>(key: Key, value: Value, left: InboxTree<Key, Value>, right: InboxTree<Key, Value>): NonNullable<InboxTree<Key, Value>> {
    return { key, value, left, right, height: 1 + Math.max(height(left), height(right)),
        size: 1 + inboxTreeSize(left) + inboxTreeSize(right) };
}

function balance<Key, Value>(key: Key, value: Value, left: InboxTree<Key, Value>, right: InboxTree<Key, Value>): NonNullable<InboxTree<Key, Value>> {
    if (height(left) > height(right) + 1 && left) {
        if (height(left.left) >= height(left.right)) {
            return node(left.key, left.value, left.left, node(key, value, left.right, right));
        }
        const middle = left.right!;
        return node(middle.key, middle.value, node(left.key, left.value, left.left, middle.left),
            node(key, value, middle.right, right));
    }
    if (height(right) > height(left) + 1 && right) {
        if (height(right.right) >= height(right.left)) {
            return node(right.key, right.value, node(key, value, left, right.left), right.right);
        }
        const middle = right.left!;
        return node(middle.key, middle.value, node(key, value, left, middle.left),
            node(right.key, right.value, middle.right, right.right));
    }
    return node(key, value, left, right);
}

export function setInboxTree<Key, Value>(tree: InboxTree<Key, Value>, key: Key, value: Value, compare: Compare<Key>): InboxTree<Key, Value> {
    if (!tree) return node(key, value, null, null);
    const compared = compare(key, tree.key);
    if (compared === 0) return tree.value === value ? tree : node(key, value, tree.left, tree.right);
    if (compared < 0) {
        const left = setInboxTree(tree.left, key, value, compare);
        return left === tree.left ? tree : balance(tree.key, tree.value, left, tree.right);
    }
    const right = setInboxTree(tree.right, key, value, compare);
    return right === tree.right ? tree : balance(tree.key, tree.value, tree.left, right);
}

export function deleteInboxTree<Key, Value>(tree: InboxTree<Key, Value>, key: Key, compare: Compare<Key>): InboxTree<Key, Value> {
    if (!tree) return tree;
    const compared = compare(key, tree.key);
    if (compared < 0) {
        const left = deleteInboxTree(tree.left, key, compare);
        return left === tree.left ? tree : balance(tree.key, tree.value, left, tree.right);
    }
    if (compared > 0) {
        const right = deleteInboxTree(tree.right, key, compare);
        return right === tree.right ? tree : balance(tree.key, tree.value, tree.left, right);
    }
    if (!tree.left) return tree.right;
    if (!tree.right) return tree.left;
    let successor = tree.right;
    while (successor.left) successor = successor.left;
    return balance(successor.key, successor.value, tree.left, deleteInboxTree(tree.right, successor.key, compare));
}

export function getInboxTree<Key, Value>(tree: InboxTree<Key, Value>, key: Key, compare: Compare<Key>): Value | undefined {
    while (tree) {
        const compared = compare(key, tree.key);
        if (compared === 0) return tree.value;
        tree = compared < 0 ? tree.left : tree.right;
    }
    return undefined;
}

function at<Key, Value>(tree: InboxTree<Key, Value>, index: number): Value | undefined {
    while (tree) {
        const leftSize = inboxTreeSize(tree.left);
        if (index === leftSize) return tree.value;
        if (index < leftSize) tree = tree.left;
        else { index -= leftSize + 1; tree = tree.right; }
    }
    return undefined;
}

function* values<Key, Value>(tree: InboxTree<Key, Value>): Generator<Value> {
    if (!tree) return;
    yield* values(tree.left);
    yield tree.value;
    yield* values(tree.right);
}

const arrays = new WeakMap<object, Map<unknown, readonly unknown[]>>();
const EMPTY: readonly never[] = Object.freeze([]);
const identity = <Value>(value: Value) => value;
const arrayIndex = (key: string | symbol) => typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;

/**
 * Read-only indexed view, with ordinary Array read semantics. Creating or publishing it is O(1);
 * indexing/slicing touches only requested rows. Whole-list methods remain explicit whole-list reads.
 * The empty target has no inventory-sized backing allocation. Ingress never flattens these views.
 */
export function inboxTreeArray<Key, Value, Item = Value>(tree: InboxTree<Key, Value>,
    select: (value: Value) => Item = identity as (value: Value) => Item,
    metadata?: Readonly<{ key: symbol; value: unknown }>): readonly Item[] {
    if (!tree && !metadata) return EMPTY;
    const cached = tree && !metadata ? arrays.get(tree)?.get(select) : undefined;
    if (cached) return cached as readonly Item[];
    const size = inboxTreeSize(tree);
    const read = (index: number) => {
        const value = at(tree, index);
        return value === undefined ? undefined : select(value);
    };
    const view = new Proxy<Item[]>([], {
        get(target, key, receiver) {
            if (metadata && key === metadata.key) return metadata.value;
            if (key === 'length') return size;
            if (key === Symbol.iterator || key === 'values') return function* () {
                for (const value of values(tree)) yield select(value);
            };
            const index = arrayIndex(key);
            return index >= 0 ? read(index) : Reflect.get(target, key, receiver);
        },
        has(target, key) {
            const index = arrayIndex(key);
            return index >= 0 ? index < size : Reflect.has(target, key);
        },
        ownKeys() { return [...Array.from({ length: size }, (_, index) => String(index)), 'length']; },
        getOwnPropertyDescriptor(target, key) {
            if (key === 'length') return { ...Reflect.getOwnPropertyDescriptor(target, key)!, value: size };
            const index = arrayIndex(key);
            return index >= 0 && index < size ? { configurable: true, enumerable: true, writable: false, value: read(index) }
                : Reflect.getOwnPropertyDescriptor(target, key);
        },
        set() { return false; },
        defineProperty() { return false; },
        deleteProperty() { return false; },
    });
    if (tree && !metadata) {
        let cachedArrays = arrays.get(tree);
        if (!cachedArrays) { cachedArrays = new Map(); arrays.set(tree, cachedArrays); }
        cachedArrays.set(select, view);
    }
    return view;
}
