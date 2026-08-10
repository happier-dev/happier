import * as React from 'react';

/**
 * Keeps a subtree mounted while stopping it from rendering.
 *
 * A pane that is off-screen but still mounted keeps re-rendering off every store update it
 * subscribes to. Unmounting it would stop that, but it also throws away everything the user built
 * up — scroll position, expanded rows, hydrated content — and pays a full remount when they come
 * back. Freezing is the middle ground React already supports: a boundary that suspends hides its
 * children instead of removing them, so their fibers, state and host views survive.
 *
 * Measured on React 19.1 + react-test-renderer (see `FrozenSubtree.test.tsx`), because the exact
 * semantics decide whether a caller may rely on this:
 *
 * - Renders **stop**. An update scheduled inside the frozen subtree (`setState`,
 *   `useSyncExternalStore` notification) is deferred, not applied.
 * - Component state is **preserved**, and the first render after thawing sees the *latest* value —
 *   never a stale one and never an empty one.
 * - Layout effects (`useLayoutEffect`) are **torn down** on freeze and re-run on thaw.
 * - Passive effects (`useEffect`) are **NOT** torn down. Timers, intervals and subscriptions
 *   registered there keep running. This is not `<Activity mode="hidden">`, which React 19.1 does
 *   not ship. A caller that must stop a poll has to stop it at the poll's owner; freezing only
 *   removes the render, derivation and reconciliation cost.
 *
 * The boundary also catches genuine suspensions from `children` while thawed and renders nothing
 * for them, so wrap subtrees that already own their own `Suspense` fallback.
 */
export type FrozenSubtreeProps = Readonly<{
    frozen: boolean;
    children: React.ReactNode;
}>;

const FrozenSubtreeGate = (props: FrozenSubtreeProps) => {
    // Kept on the instance so a re-freeze reuses the same never-settling promise: a fresh promise
    // on every render would make React retry the boundary in a loop instead of parking it.
    const frozenSignalRef = React.useRef<Promise<void> | null>(null);
    if (props.frozen) {
        frozenSignalRef.current ??= new Promise<void>(() => {});
        throw frozenSignalRef.current;
    }
    frozenSignalRef.current = null;
    return <>{props.children}</>;
};

export const FrozenSubtree = React.memo((props: FrozenSubtreeProps) => (
    <React.Suspense fallback={null}>
        <FrozenSubtreeGate frozen={props.frozen}>{props.children}</FrozenSubtreeGate>
    </React.Suspense>
));

FrozenSubtree.displayName = 'FrozenSubtree';
