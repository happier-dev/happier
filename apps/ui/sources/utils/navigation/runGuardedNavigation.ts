import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

type RefLike<T> = { current: T };

export type ActiveUnsavedChangesGuard = Readonly<{
    isDirtyRef: RefLike<boolean>;
    ignoreRef?: RefLike<boolean> | null;
    requestDecision: () => Promise<UnsavedChangesDecision>;
    onDiscard?: () => void;
    onSave?: () => boolean | Promise<boolean>;
    tag: string;
}>;

let activeUnsavedChangesGuard: ActiveUnsavedChangesGuard | null = null;

export function getActiveUnsavedChangesGuard(): ActiveUnsavedChangesGuard | null {
    return activeUnsavedChangesGuard;
}

export function setActiveUnsavedChangesGuard(guard: ActiveUnsavedChangesGuard): void {
    activeUnsavedChangesGuard = guard;
}

export function clearActiveUnsavedChangesGuard(): void {
    activeUnsavedChangesGuard = null;
}

export function runGuardedNavigation(navigate: () => void): true | Promise<boolean> {
    const guard = activeUnsavedChangesGuard;
    if (!guard) {
        navigate();
        return true;
    }

    if (guard.ignoreRef?.current) {
        navigate();
        return true;
    }

    if (!guard.isDirtyRef.current) {
        navigate();
        return true;
    }

    return (async () => {
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
            try {
                guard.isDirtyRef.current = false;
                guard.onDiscard?.();
                navigate();
            } catch {
                guard.isDirtyRef.current = true;
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

        guard.isDirtyRef.current = false;
        try {
            navigate();
        } catch {
            guard.isDirtyRef.current = true;
            return false;
        }
        return true;
    })();
}
