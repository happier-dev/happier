import type { Href } from 'expo-router';

import { runStepMove } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { setShowcaseHomeLandingPending } from '@/onboarding/showcase/storage';
import { tryAdmitInternalRouteHref } from '@/utils/path/routeUtils';

/**
 * Apply the destination selected by the auth operation or its continuation owner.
 * Return URLs are only read for navigation because their opaque values may contain credentials.
 */
export function resolvePostAuthLanding(input: Readonly<{
    replace: (href: Href) => void;
    teamContinuation?: string;
    continuation?: Href;
    returnTo?: string | null;
    revealHome?: () => void;
}>): void {
    const team = input.teamContinuation ? tryAdmitInternalRouteHref(input.teamContinuation) : null;
    const target = team ?? input.continuation ?? (typeof input.returnTo === 'string' ? tryAdmitInternalRouteHref(input.returnTo) : null);
    if (target && target !== '/') {
        input.replace(target);
        return;
    }
    setShowcaseHomeLandingPending(true);
    runStepMove({
        kind: 'home',
        layer: 'workflow',
        commit: input.revealHome ?? (() => input.replace('/')),
        onSettled: () => setShowcaseHomeLandingPending(false),
    });
}
