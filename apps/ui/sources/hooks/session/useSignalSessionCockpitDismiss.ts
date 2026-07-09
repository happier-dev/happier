import * as React from 'react';
import { useNavigation } from 'expo-router';

import { useSessionCockpitDismissController } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

type TransitionEvent = Readonly<{ data?: Readonly<{ closing?: boolean }> }>;

/**
 * Flags the session cockpit as dismissing at the **start** of a gesture/native
 * back, before `usePathname()` commits the destination route. The chrome host
 * uses the flag to cross-fade to the main bar and dissolve the reserved band as
 * soon as the slide begins, instead of waiting for route-commit (slide-end).
 *
 * `transitionStart {closing:true}` fires when this screen begins animating out;
 * `{closing:false}` fires when it animates back in (a cancelled swipe), and
 * `gestureCancel` covers the interactive-cancel case — both clear the flag so the
 * cockpit chrome reappears. Surface switches stay in-flow via the registry (no
 * navigation), so they never reach here. The flag drives visuals only; the in-
 * flow reservation is keyed off the route, so the composer never moves.
 */
export function useSignalSessionCockpitDismiss(sessionId: string): void {
    const navigation = useNavigation();
    const { markDismissing, clearDismissing } = useSessionCockpitDismissController();

    React.useEffect(() => {
        if (!sessionId) {
            return;
        }

        const handleTransitionStart = (event: TransitionEvent) => {
            if (event?.data?.closing === true) {
                markDismissing(sessionId);
            } else {
                clearDismissing(sessionId);
            }
        };
        const handleGestureCancel = () => {
            clearDismissing(sessionId);
        };

        const unsubscribeTransitionStart = navigation.addListener(
            'transitionStart' as never,
            handleTransitionStart as never,
        );
        const unsubscribeGestureCancel = navigation.addListener(
            'gestureCancel' as never,
            handleGestureCancel as never,
        );

        return () => {
            unsubscribeTransitionStart();
            unsubscribeGestureCancel();
            clearDismissing(sessionId);
        };
    }, [navigation, sessionId, markDismissing, clearDismissing]);
}
