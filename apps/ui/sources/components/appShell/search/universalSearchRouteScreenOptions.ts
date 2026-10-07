import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

import { resolveUniversalSearchRoutePresentation } from '@/components/appShell/search/universalSearchRoutePresentation';

export function buildUniversalSearchRouteScreenOptions(input: Readonly<{
    platformOs: string;
}>): NativeStackNavigationOptions {
    const presentation = resolveUniversalSearchRoutePresentation(input);
    if (presentation === undefined) return { headerShown: false };
    return {
        headerShown: false,
        presentation,
        contentStyle: { backgroundColor: 'transparent' },
        // Search owns its high-frequency transition through the scrim. Moving the entire native
        // route would animate the backdrop too and give gestures a dismissal path that bypasses
        // the host's close/barrier lifecycle.
        animation: 'none',
        gestureEnabled: false,
        fullScreenGestureEnabled: false,
    };
}
