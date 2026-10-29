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
    /** A host-owned internal Back step retains the same edited content. */
    canLeaveHistoryWithoutDiscard?: () => boolean;
    tag: string;
}>;

let activeUnsavedChangesGuard: ActiveUnsavedChangesGuard | null = null;
const mountedTabGuards = new Map<string, ActiveUnsavedChangesGuard>();
let activeBrowserEntry: Readonly<{ href: string; state: unknown }> | null = null;
let authorizedBrowserTraversal = false;
const guardsInFlight = new WeakSet<RefLike<boolean>>();
const guardsContinuing = new WeakSet<RefLike<boolean>>();

/** Only a backwards stack step may spend page-local history. */
export function isBackwardRouteRemovalAction(action: unknown): boolean {
    if (typeof action !== 'object' || action === null) return false;
    const type = (action as Readonly<{ type?: unknown }>).type;
    return type === 'GO_BACK' || type === 'POP';
}

export function getActiveUnsavedChangesGuard(): ActiveUnsavedChangesGuard | null {
    return activeUnsavedChangesGuard;
}

/** Retained editors keep their guard until their tab body actually unmounts. */
export function registerMountedTabUnsavedChangesGuard(tabId: string, guard: ActiveUnsavedChangesGuard): () => void {
    mountedTabGuards.set(tabId, guard);
    return () => {
        if (mountedTabGuards.get(tabId) === guard) mountedTabGuards.delete(tabId);
    };
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
    const continueNavigation = (continuation = navigate) => {
        guardsContinuing.add(guard.isDirtyRef);
        try {
            return continuation();
        } finally {
            guardsContinuing.delete(guard.isDirtyRef);
        }
    };
    if (guard.ignoreRef?.current || guardsContinuing.has(guard.isDirtyRef)) {
        const continuation = navigate();
        return continuation
            ? continuation.then(() => true)
            : true;
    }

    if (intent === 'history' && guard.canLeaveHistoryWithoutDiscard?.()) {
        try {
            const continuation = continueNavigation(guard.onHistoryLeave ?? navigate);
            return continuation ? continuation.then(() => true, () => false) : true;
        } catch {
            return Promise.resolve(false);
        }
    }

    if (!guard.isDirtyRef.current && !guard.prepareGuard) {
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
                await continueNavigation();
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
            const wasIgnored = guard.ignoreRef?.current;
            try {
                guard.isDirtyRef.current = false;
                await guard.onDiscard?.();
                await continueNavigation(intent === 'history' && guard.onHistoryLeave ? guard.onHistoryLeave : navigate);
            } catch {
                guard.isDirtyRef.current = wasDirty;
                if (guard.ignoreRef && wasIgnored !== undefined) guard.ignoreRef.current = wasIgnored;
                return false;
            }
            return true;
        }

        let didSave = false;
        const dirtyBeforeSave = guard.isDirtyRef.current;
        const ignoredBeforeSave = guard.ignoreRef?.current;
        try {
            didSave = await guard.onSave?.() ?? false;
        } catch {
            didSave = false;
        }
        if (!didSave) {
            // A refused or failed save leaves the editor mounted and protective.
            guard.isDirtyRef.current = dirtyBeforeSave;
            if (guard.ignoreRef && ignoredBeforeSave !== undefined) guard.ignoreRef.current = ignoredBeforeSave;
            return false;
        }

        const wasDirty = guard.isDirtyRef.current;
        guard.isDirtyRef.current = false;
        if (guard.continueOnSave === false) {
            return true;
        }
        try {
            await continueNavigation();
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

/**
 * Settle every affected editor before the caller changes tab membership once.
 * A continuation that cannot perform the admitted close returns false.
 */
export function runGuardedTabNavigation(
    tabIds: readonly string[],
    navigate: () => void | boolean | Promise<void | boolean>,
    options: Readonly<{ includeActiveGuard?: boolean; isCurrent?: () => boolean }> = {},
): true | Promise<boolean> {
    const mountedEditors = tabIds.map(tabId => ({ tabId, dirtyRef: mountedTabGuards.get(tabId)?.isDirtyRef }));
    const guards = [...new Set([
        ...tabIds.map(tabId => mountedTabGuards.get(tabId)),
        ...(options.includeActiveGuard ? [activeUnsavedChangesGuard] : []),
    ].filter((guard): guard is ActiveUnsavedChangesGuard => guard != null))];
    const pendingDiscards: ActiveUnsavedChangesGuard[] = [];
    const savedEditors: { guard: ActiveUnsavedChangesGuard; wasIgnored: boolean | undefined }[] = [];
    // A saved editor stays mounted if the batch is not admitted: re-arm its
    // guard (its content is saved, so it is clean) without a second prompt path.
    const settle = (result: true | Promise<boolean>): true | Promise<boolean> => {
        if (result === true) return true;
        return result.then(allowed => {
            if (!allowed) {
                for (const { guard, wasIgnored } of savedEditors) {
                    if (guard.ignoreRef && wasIgnored !== undefined) guard.ignoreRef.current = wasIgnored;
                }
            }
            return allowed;
        });
    };
    const discardAndNavigate = async (): Promise<boolean> => {
        const ignored = pendingDiscards.map(guard => guard.ignoreRef?.current);
        let departed = false;
        try {
            for (const guard of pendingDiscards) {
                guard.isDirtyRef.current = false;
                await guard.onDiscard?.();
            }
            departed = await navigate() !== false;
            return departed;
        } catch {
            return false;
        } finally {
            if (!departed) {
                for (const [index, guard] of pendingDiscards.entries()) {
                    guard.isDirtyRef.current = true;
                    const wasIgnored = ignored[index];
                    if (guard.ignoreRef && wasIgnored !== undefined) guard.ignoreRef.current = wasIgnored;
                }
            }
        }
    };
    const proceed = (index: number): true | Promise<boolean> => {
        if (options.isCurrent && !options.isCurrent()) return Promise.resolve(false);
        if (mountedEditors.some(editor => mountedTabGuards.get(editor.tabId)?.isDirtyRef !== editor.dirtyRef)) {
            return Promise.resolve(false);
        }
        const guard = guards[index];
        if (!guard) {
            if (pendingDiscards.length) return discardAndNavigate();
            const continuation = navigate();
            if (continuation === false) return Promise.resolve(false);
            return continuation && typeof continuation !== 'boolean'
                ? continuation.then(allowed => allowed !== false)
                : true;
        }
        let continued = false;
        const result = runUnsavedChangesGuard({
            ...guard,
            onSave: guard.onSave && (async () => {
                const wasIgnored = guard.ignoreRef?.current;
                const saved = await guard.onSave!();
                if (saved) savedEditors.push({ guard, wasIgnored });
                return saved;
            }),
            onDiscard: () => {
                // A later refusal (or a save that owns departure) leaves this
                // editor mounted. Keep its draft protective until batch admission.
                guard.isDirtyRef.current = true;
                pendingDiscards.push(guard);
            },
        }, () => { continued = true; });
        if (result === true) return proceed(index + 1);
        // A successful save may own its own continuation. Never turn that
        // success into permission to execute the originally requested close.
        return result.then(allowed => allowed && continued ? proceed(index + 1) : allowed);
    };
    return settle(proceed(0));
}
