import { isTeamEntryRoute, isTerminalConnectEntryRoute, isWelcomeRoute } from '@/auth/routing/authRouting';
import { readReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { readOpeningSeenAt, onboardingAuthHistoryState, onboardingHistoryState } from '@/sync/domains/state/onboardingUiState';

export type FirstOpenDecision = 'none' | 'reduced' | 'in-app' | 'overlay-eligible';

/** Boot has already resolved auth and the destination. Only eligible launches read device history. */
export function resolveFirstOpen(facts: Readonly<{
    accountRestored: boolean;
    segments: readonly string[];
    desktopCandidate?: 'overlay' | 'in-app' | null;
}>): FirstOpenDecision {
    if (facts.accountRestored || facts.desktopCandidate === null) return 'none';
    const welcome = isWelcomeRoute(facts.segments);
    if (!welcome && !isTeamEntryRoute(facts.segments) && !isTerminalConnectEntryRoute(facts.segments)) return 'none';
    if (readOpeningSeenAt() != null) return 'none';
    if (onboardingHistoryState.read('brandHeroSeenAt') != null) return 'none';
    if (onboardingAuthHistoryState.read('completed') === true) return 'none';
    if (readReducedMotionPreference()) return 'reduced';
    return welcome && facts.desktopCandidate === 'overlay' ? 'overlay-eligible' : 'in-app';
}
