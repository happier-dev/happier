import * as React from 'react';
import { onboardingHistoryState, useOnboardingHistoryTimestamp } from '@/sync/domains/state/onboardingUiState';

export type HomeWelcome = Readonly<{
  /** The assembly is on screen: Home's planet waits under it. */
  playing: boolean;
  /** Home's planet takes over from the landed assembly in the same frame. */
  arrive: 'fade' | 'instant';
  onLanded: () => void;
  /** After Welcome, this visit may re-type digits. Only the drawing leaf owns the rest clock. */
  retype: boolean;
}>;

/**
 * Plays Welcome once per device: on the first arrival at Home with its planet after sign-in. A Loading
 * cloud already assembled the planet in that arrival counts as the Welcome. Under reduced motion the
 * rest is shown at once and nothing re-types.
 */
export function useHomeWelcome(
  input: Readonly<{
    /** Home shows its planet, is in front, and the planet's place is known. */
    eligible: boolean;
    loadingShown: boolean;
    reducedMotion: boolean;
    /** Re-typing pauses while the person writes. */
    writing: boolean;
  }>,
): HomeWelcome {
  const seenAt = useOnboardingHistoryTimestamp('homeWelcomeSeenAt');
  const [status, setStatus] = React.useState<
    'idle' | 'playing' | 'resting' | 'done'
  >('idle');
  const play = status === 'idle' && input.eligible && seenAt === null;
  React.useEffect(() => {
    if (!play) return;
    onboardingHistoryState.set('homeWelcomeSeenAt', Date.now());
    setStatus(input.loadingShown || input.reducedMotion ? 'done' : 'playing');
  }, [input.loadingShown, input.reducedMotion, play]);
  const [instant, setInstant] = React.useState(false);
  React.useEffect(() => {
    if (instant) setInstant(false);
  }, [instant]);
  const onLanded = React.useCallback(() => {
    setStatus((current) => (current === 'playing' ? 'resting' : current));
    setInstant(true);
  }, []);
  React.useEffect(() => {
    if (status !== 'playing' || !input.reducedMotion) return;
    setStatus('done');
    setInstant(true);
  }, [input.reducedMotion, status]);
  // A retained Home pauses its landed rest while ineligible, without replaying Welcome on return.
  const resting = status === 'resting';
  return {
    playing: status === 'playing' || play,
    arrive: instant ? 'instant' : 'fade',
    onLanded,
    retype: resting && input.eligible,
  };
}
