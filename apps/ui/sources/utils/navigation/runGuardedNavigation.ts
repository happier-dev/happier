import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

type RefLike<T> = { current: T };

export type ActiveUnsavedChangesGuard = Readonly<{
    isDirtyRef: RefLike<boolean>;
    ignoreRef?: RefLike<boolean> | null;
    requestDecision: () => Promise<UnsavedChangesDecision>;
    onDiscard?: () => void | Promise<void>;
    onSave?: () => boolean | Promise<boolean>;
    continueOnSave?: boolean;
    tag: string;
}>;

let activeUnsavedChangesGuard: ActiveUnsavedChangesGuard | null = null;
const guardsInFlight = new WeakSet<RefLike<boolean>>();

export function getActiveUnsavedChangesGuard(): ActiveUnsavedChangesGuard | null {
    return activeUnsavedChangesGuard;
}

export function setActiveUnsavedChangesGuard(guard: ActiveUnsavedChangesGuard): void {
    activeUnsavedChangesGuard = guard;
}

export function clearActiveUnsavedChangesGuard(): void {
    activeUnsavedChangesGuard = null;
}

export function runUnsavedChangesGuard(
    guard: ActiveUnsavedChangesGuard,
    navigate: () => void | Promise<void>,
): true | Promise<boolean> {
    if (guard.ignoreRef?.current) {
        const continuation = navigate();
        return continuation
            ? continuation.then(() => true)
            : true;
    }

    if (guardsInFlight.has(guard.isDirtyRef)) {
        return Promise.resolve(false);
    }

    if (!guard.isDirtyRef.current) {
        const continuation = navigate();
        return continuation
            ? continuation.then(() => true)
            : true;
    }

    guardsInFlight.add(guard.isDirtyRef);

    const run = async (): Promise<boolean> => {
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
                await navigate();
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

export function runGuardedNavigation(navigate: () => void | Promise<void>): true | Promise<boolean> {
    const guard = activeUnsavedChangesGuard;
    if (!guard) {
        navigate();
        return true;
    }

    return runUnsavedChangesGuard(guard, navigate);
}
