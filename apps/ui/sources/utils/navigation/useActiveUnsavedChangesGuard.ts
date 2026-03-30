import * as React from 'react';

import {
    type ActiveUnsavedChangesGuard,
    clearActiveUnsavedChangesGuard,
    getActiveUnsavedChangesGuard,
    setActiveUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';

type NavigationEventSubscription = { remove?: () => void } | (() => void);

type NavigationLike = Readonly<{
    isFocused?: () => boolean;
    addListener?: (event: 'focus' | 'blur', handler: () => void) => NavigationEventSubscription;
}>;

function unsubscribeListener(subscription: unknown): void {
    if (!subscription) return;
    if (typeof subscription === 'function') {
        subscription();
        return;
    }
    const maybeRemove = (subscription as { remove?: unknown }).remove;
    if (typeof maybeRemove === 'function') {
        maybeRemove();
    }
}

/**
 * Registers the currently focused screen as the "active unsaved-changes guard" so global navigation
 * surfaces (e.g. the sidebar) can prompt before navigating away.
 *
 * NOTE: Avoid importing `@react-navigation/native` hooks here. Some of its ESM builds include Flow
 * syntax (e.g. `import typeof`) which Node-based unit tests cannot parse without Metro transforms.
 */
export function useActiveUnsavedChangesGuard(params: Readonly<{
    navigation: unknown;
    guard: ActiveUnsavedChangesGuard | null;
    enabled?: boolean;
}>): void {
    const enabled = params.enabled ?? true;

    React.useEffect(() => {
        if (!enabled) return;

        const nav = params.navigation as NavigationLike;
        const guard = params.guard;
        if (!guard) return;

        const maybeClear = () => {
            if (getActiveUnsavedChangesGuard() === guard) {
                clearActiveUnsavedChangesGuard();
            }
        };

        const maybeSet = () => {
            // Only set while this screen is actually in control.
            if (guard.ignoreRef?.current) return;
            setActiveUnsavedChangesGuard(guard);
        };

        if (typeof nav?.isFocused === 'function') {
            try {
                if (nav.isFocused()) {
                    maybeSet();
                }
            } catch {
                // best-effort
            }
        }

        const addListener = nav.addListener;
        if (typeof addListener !== 'function') {
            // Fall back to mount/unmount only.
            maybeSet();
            return () => maybeClear();
        }

        const focusSub = addListener.call(nav, 'focus', maybeSet);
        const blurSub = addListener.call(nav, 'blur', maybeClear);

        return () => {
            unsubscribeListener(focusSub);
            unsubscribeListener(blurSub);
            maybeClear();
        };
    }, [enabled, params.guard, params.navigation]);
}
