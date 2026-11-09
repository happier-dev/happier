import { Platform } from 'react-native';
import { useSegments } from 'expo-router';
import { useCurrentRoutePathname } from './currentRouteLocation';
import { useAuth } from '@/auth/context/AuthContext';
import { useIsTablet } from '@/utils/platform/responsive';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { isTerminalConnectWebPathname } from '@/utils/path/terminalConnectUrl';
import { isPublicRouteForUnauthenticated } from '@/auth/routing/authRouting';
import { useOnboardingJourneySessionActive } from '@/components/onboarding/tour/state/journeySession';
import { matchWorkspaceDestinationRoute } from './workspaceRoutes';

/** The same shell eligibility owns both navigation and responsive chrome. */
export function useWorkspaceShellEnabled(): boolean {
    return useWorkspacePresentation() === 'shell';
}

/**
 * Where the workspace owner runs: the desktop/tablet shell (it owns navigation), a phone (it owns
 * the open-tab set while the phone's stack keeps navigation), or nowhere (signed out, native
 * onboarding, the activity overlay). Standalone authenticated public web pages retain only
 * route entry, so their explicit destination goes through the workspace before
 * its chrome appears. Deferred web presentation claims routes without hosting
 * them while onboarding releases its viewport.
 */
export function useWorkspacePresentation(): 'shell' | 'destination' | 'phone' | 'entry' | 'deferred' | null {
    const auth = useAuth();
    const pathname = useCurrentRoutePathname();
    const segments = useSegments();
    const isTablet = useIsTablet();
    const windowContext = resolveDesktopWindowContext();
    const onboarding = useOnboardingJourneySessionActive();
    const normalized: readonly string[] = segments.filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
    // Public access does not remove chrome from an authenticated workspace destination.
    // Standalone link/auth flows keep their entry host; route admission owns the distinction.
    const standalonePublicRoute = normalized.length > 0 && normalized[0] !== 'index'
        && isPublicRouteForUnauthenticated([...segments]) && !matchWorkspaceDestinationRoute(pathname);
    const bypass = Platform.OS === 'web' && (isTerminalConnectWebPathname(pathname) || standalonePublicRoute);
    if (!auth.isAuthenticated || windowContext.role === 'presenter') return null;
    if (windowContext.role === 'secondary') return windowContext.chrome === 'destination' ? 'destination' : 'shell';
    if (bypass) return 'entry';
    if (onboarding) return Platform.OS === 'web' ? 'deferred' : null;
    return isTablet ? 'shell' : 'phone';
}
