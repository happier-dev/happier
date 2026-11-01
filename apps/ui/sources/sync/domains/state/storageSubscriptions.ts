import type { StorageState } from '@/sync/store/types';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

export type StorageSubscriptionScope = Readonly<{
    [Key in keyof StorageState]?: true | readonly PropertyKey[];
}>;
type Notification = Readonly<{ kind: 'state'; state: StorageState; previous: StorageState }>
    | Readonly<{ kind: 'settings'; scope: AccountSettingsScope }>;
type Subscription = { listener: (event: Notification) => void; active: boolean; order: number };
type Node = { children: Map<PropertyKey, Node>; subscriptions: Set<Subscription> };
const node = (): Node => ({ children: new Map(), subscriptions: new Set() });
const root = node();
let nextOrder = 0;

/** One notification index for live state and addressed persisted Settings demand. No state is stored here. */
export function subscribeStoragePaths(paths: readonly (readonly PropertyKey[])[], listener: (event: Notification) => void): () => void {
    const subscription: Subscription = { listener, active: true, order: nextOrder++ };
    const branches = paths.map(path => {
        let current = root;
        const parents: [Node, PropertyKey, Node][] = [];
        for (const key of path) {
            let child = current.children.get(key);
            if (!child) { child = node(); current.children.set(key, child); }
            parents.push([current, key, child]);
            current = child;
        }
        current.subscriptions.add(subscription);
        return { current, parents };
    });
    return () => {
        if (!subscription.active) return;
        subscription.active = false;
        for (const { current, parents } of branches) {
            current.subscriptions.delete(subscription);
            for (const [parent, key, child] of parents.reverse()) {
                if (child.subscriptions.size || child.children.size) break;
                parent.children.delete(key);
            }
        }
    };
}

/** Diff only demanded keys; replacement snapshots and ordinary domain writes use exactly this path. */
export function publishStoragePaths(prefix: readonly PropertyKey[], next: unknown, previous: unknown, event: Notification,
    equal: (path: readonly PropertyKey[], next: unknown, previous: unknown) => boolean = (_path, a, b) => Object.is(a, b)): void {
    let branch: Node | undefined = root;
    for (const key of prefix) branch = branch?.children.get(key);
    if (!branch) return;
    const ready = new Set<Subscription>();
    const property = (value: unknown, key: PropertyKey): unknown => value !== null && typeof value === 'object'
        ? Reflect.get(value, key) : undefined;
    const visit = (current: Node, path: readonly PropertyKey[], after: unknown, before: unknown) => {
        if (equal(path, after, before)) return;
        for (const subscription of current.subscriptions) ready.add(subscription);
        for (const [key, child] of current.children) visit(child, [...path, key], property(after, key), property(before, key));
    };
    visit(branch, prefix, next, previous);
    // Keep the existing subscribe contract's registration order across changed keys.
    for (const subscription of [...ready].sort((left, right) => left.order - right.order)) {
        if (!subscription.active) continue;
        try {
            subscription.listener(event);
        } catch (error) {
            // The state is committed. A consumer failure belongs to that
            // consumer, not to the producer or the remaining subscribers.
            console.error('[storage] Subscriber failed', error);
        }
    }
}

export function storageScopePaths(scope?: StorageSubscriptionScope): readonly (readonly PropertyKey[])[] {
    if (!scope) return [['state']];
    return Object.entries(scope).flatMap(([key, entries]) => entries === true
        ? [['state', key]] : entries?.map(entry => ['state', key, entry]) ?? []);
}
