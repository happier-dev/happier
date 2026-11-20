import type { Href } from 'expo-router';

import { runStepMove } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { setShowcaseHomeLandingPending } from '@/onboarding/showcase/storage';
import { tryAdmitInternalRouteHref } from '@/utils/path/routeUtils';

export function revealFirstArrivalHome(layer: string, commit: () => void): void {
    setShowcaseHomeLandingPending(true);
    runStepMove({
        kind: 'home', layer, commit,
        onSettled: () => setShowcaseHomeLandingPending(false),
    });
}

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
    let target: Href | null = null;
    if (input.teamContinuation) target = tryAdmitInternalRouteHref(input.teamContinuation);
    if (target === null && input.continuation !== undefined) target = input.continuation;
    if (target === null && typeof input.returnTo === 'string') target = tryAdmitInternalRouteHref(input.returnTo);
    if (target && target !== '/') {
        input.replace(target);
        return;
    }
    revealFirstArrivalHome('workflow', input.revealHome ?? (() => input.replace('/')));
}
