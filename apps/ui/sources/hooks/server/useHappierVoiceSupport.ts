import { useFeatureDecision } from './useFeatureDecision';

/**
 * Returns `true` when the server reports Happier Voice is available; otherwise `false`.
 *
 * This fails closed: if the decision cannot be resolved (network error / not fetched yet),
 * treat the feature as disabled so UI does not assume support.
 */
export function useHappierVoiceSupport(): boolean {
    const decision = useFeatureDecision('voice.happierVoice');
    return decision?.state === 'enabled';
}
