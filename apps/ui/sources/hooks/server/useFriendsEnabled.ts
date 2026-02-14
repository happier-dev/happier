import { useFeatureDecision } from './useFeatureDecision';

export function useFriendsEnabled(): boolean {
    // Friends surfaces always target the active server; avoid blocking on mixed multi-server selections.
    const decision = useFeatureDecision('social.friends', { scopeKind: 'runtime' });
    return decision?.state === 'enabled';
}
