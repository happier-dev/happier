import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

type RefLike<T> = { current: T };

export type ActiveUnsavedChangesGuard = Readonly<{
    isDirtyRef: RefLike<boolean>;
    ignoreRef?: RefLike<boolean> | null;
    requestDecision: () => Promise<UnsavedChangesDecision>;
    /** Flush editor-owned pending input before this locked dirty decision. */
    prepareGuard?: () => void | Promise<void>;
    onDiscard?: () => void | Promise<void>;
    onSave?: () => boolean | Promise<boolean>;
    continueOnSave?: boolean;
    /** An authoring host's continuation for an app-initiated Back/history step. */
    onHistoryLeave?: () => void | Promise<void>;
    tag: string;
}>;

let activeUnsavedChangesGuard: ActiveUnsavedChangesGuard | null = null;
let activeBrowserEntry: Readonly<{ href: string; state: unknown }> | null = null;
let authorizedBrowserTraversal = false;
const guardsInFlight = new WeakSet<RefLike<boolean>>();

export function getActiveUnsavedChangesGuard(): ActiveUnsavedChangesGuard | null {
    return activeUnsavedChangesGuard;
}

export function setActiveUnsavedChangesGuard(guard: ActiveUnsavedChangesGuard): void {
    activeUnsavedChangesGuard = guard;
    authorizedBrowserTraversal = false;
    activeBrowserEntry = typeof window !== 'undefined' && window.history && window.location
        ? { href: `${window.location.pathname}${window.location.search}${window.location.hash}`, state: window.history.state }
        : null;
}

export function clearActiveUnsavedChangesGuard(): void {
    activeUnsavedChangesGuard = null;
    activeBrowserEntry = null;
    authorizedBrowserTraversal = false;
}

/** Genuinely unannotated popstate: restore before catalog/URL admission. */
export function interceptUnsavedChangesBrowserPopState(event: PopStateEvent): boolean {
    if (authorizedBrowserTraversal) {
        // WorkspaceProvider is the sole browser history consumer. This is the
        // traversal whose dirty decision has already settled.
        authorizedBrowserTraversal = false;
        return false;
    }
    const guard = activeUnsavedChangesGuard;
    const entry = activeBrowserEntry;
    if (!guard || !entry || guard.ignoreRef?.current || (!guard.isDirtyRef.current && !guard.prepareGuard)) return false;
    event.stopImmediatePropagation();
    // Without native coordinates the popped entry stays directly behind this
    // restored one. Annotated entries restore through workspaceBrowserTransport.
    window.history.pushState(entry.state, '', entry.href);
    void runUnsavedChangesGuard(guard, () => {
        // Resume the unannotated entry that actually popped, rather than an
        // app-level Back destination inferred from the workspace's view history.
        authorizedBrowserTraversal = true;
        window.history.go(-1);
    });
    return true;
}

export function runUnsavedChangesGuard(
    guard: ActiveUnsavedChangesGuard,
    navigate: () => void | Promise<void>,
    intent?: 'history',
): true | Promise<boolean> {
    if (guard.ignoreRef?.current) {
        const continuation = navigate();
        return continuation
            ? continuation.then(() => true)
            : true;
    }

    if (!guard.prepareGuard && !guard.isDirtyRef.current) {
        const continuation = navigate();
        return continuation
            ? continuation.then(() => true)
            : true;
    }

    // An accepted departure may re-enter through the workspace router. Its
    // dirty decision is already settled; only unresolved dirty exits serialize.
    if (guardsInFlight.has(guard.isDirtyRef)) {
        return Promise.resolve(false);
    }

    guardsInFlight.add(guard.isDirtyRef);

    const run = async (): Promise<boolean> => {
        try {
            await guard.prepareGuard?.();
        } catch {
            return false;
        }

        if (!guard.isDirtyRef.current) {
            try {
                await navigate();
            } catch {
                return false;
            }
            return true;
        }

        let decision: UnsavedChangesDecision;
        try {
            decision = await guard.requestDecision();
        } catch {
            return false;
        }

        if (decision === 'keepEditing') {
            return false;
        }

        if (decision === 'discard') {
            const wasDirty = guard.isDirtyRef.current;
            try {
                guard.isDirtyRef.current = false;
                await guard.onDiscard?.();
                await (intent === 'history' && guard.onHistoryLeave ? guard.onHistoryLeave : navigate)();
            } catch {
                guard.isDirtyRef.current = wasDirty;
                return false;
            }
            return true;
        }

        let didSave = false;
        try {
            didSave = await guard.onSave?.() ?? false;
        } catch {
            return false;
        }
        if (!didSave) {
            return false;
        }

        const wasDirty = guard.isDirtyRef.current;
        guard.isDirtyRef.current = false;
        if (guard.continueOnSave === false) {
            return true;
        }
        try {
            await navigate();
        } catch {
            guard.isDirtyRef.current = wasDirty;
            return false;
        }
        return true;
    };

    return run().finally(() => {
        guardsInFlight.delete(guard.isDirtyRef);
    });
}

export function runGuardedNavigation(navigate: () => void | Promise<void>, intent?: 'history'): true | Promise<boolean> {
    const guard = activeUnsavedChangesGuard;
    if (!guard) {
        navigate();
        return true;
    }

    return runUnsavedChangesGuard(guard, navigate, intent);
}
