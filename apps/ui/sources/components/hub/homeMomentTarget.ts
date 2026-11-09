import type { PlanetMomentTarget } from '@/components/atmosphere/moments/planetMomentTimeline';
import { isSessionGettingStartedGuidanceHome, type SessionGettingStartedDecisionKind } from '@/components/sessions/guidance/gettingStartedModel';

type HomePlanetTarget = Extract<PlanetMomentTarget, { kind: 'planet' }>;

/**
 * Where Home's Loading moment ends: nowhere yet while Home does not know what it shows, on Home's
 * planet when the hub (the only page that draws it) is Home, otherwise centred. The getting-started
 * guidance (no machine running) draws no planet, so a moment that waited for one there
 * would cover the page for good.
 */
export function resolveHomeMomentTarget(input: Readonly<{
    guidanceKind: SessionGettingStartedDecisionKind;
    heroActive: boolean;
    planetSource: boolean;
    options: HomePlanetTarget['options'] | null;
    fade: HomePlanetTarget['fade'];
}>): PlanetMomentTarget | null {
    if (input.guidanceKind === 'loading') return null;
    if (isSessionGettingStartedGuidanceHome(input.guidanceKind) || !input.heroActive || !input.planetSource) return { kind: 'none' };
    return input.options ? { kind: 'planet', options: input.options, fade: input.fade } : null;
}
