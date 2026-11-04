import { Platform } from 'react-native';
import { useHappierPrecisePrimaryPointer } from '../../environment/interactiveTarget.js';

/**
 * Whether the primary pointer can hover (a mouse or trackpad on the web). Native and touch-first browsers
 * answer false. Uses the shared pointer store so mounted hover affordances update with the device.
 */
export function useHappierPrecisePointer(): boolean {
  return useHappierPrecisePrimaryPointer(Platform.OS);
}
