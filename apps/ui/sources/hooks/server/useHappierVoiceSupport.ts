import { useFeatureDecision } from './useFeatureDecision';

/**
 * Returns:
 * - `null` while unknown (network error / not fetched yet)
 * - `true` when the server reports Happier Voice is available
 * - `false` when the server explicitly reports voice is unavailable/misconfigured
 */
export function useHappierVoiceSupport(): boolean | null {
    const decision = useFeatureDecision('voice');
    if (!decision) return null;
    return decision.state === 'enabled';
}
