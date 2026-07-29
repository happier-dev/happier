import { hapticsLight } from '@/components/ui/theme/haptics';

export type VoiceSurfaceHapticEvent = 'start_stop' | 'confirmed_interruption';

export function createVoiceSurfaceHapticNotifier(deps: Readonly<{
  emit: () => void;
  now?: () => number;
  minimumIntervalMs?: number;
}>) {
  const now = deps.now ?? (() => Date.now());
  const minimumIntervalMs = Math.max(0, deps.minimumIntervalMs ?? 200);
  let lastEmittedAt = Number.NEGATIVE_INFINITY;

  return Object.freeze({
    notify(_event: VoiceSurfaceHapticEvent): void {
      const currentTime = now();
      if (!Number.isFinite(currentTime) || currentTime - lastEmittedAt < minimumIntervalMs) return;
      lastEmittedAt = currentTime;
      deps.emit();
    },
  });
}

/**
 * One process-wide haptic owner prevents sidebar/session surfaces observing the
 * same canonical transition from emitting duplicate native feedback.
 */
export const voiceSurfaceHaptics = createVoiceSurfaceHapticNotifier({ emit: hapticsLight });
