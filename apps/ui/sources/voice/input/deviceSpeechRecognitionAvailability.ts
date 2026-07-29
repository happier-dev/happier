export type DeviceSpeechRecognitionAvailability = 'available' | 'unavailable' | 'unknown';

type SpeechRecognitionAvailabilityModule = Readonly<{
  isRecognitionAvailable?: unknown;
}>;

/**
 * Passive normalization of the Expo speech-recognition support fact.
 *
 * This calls only the module's synchronous support probe. It never requests
 * permission, opens a microphone, or starts a recognizer.
 */
export function readDeviceSpeechRecognitionAvailability(
  module: SpeechRecognitionAvailabilityModule | null | undefined,
): DeviceSpeechRecognitionAvailability {
  if (typeof module?.isRecognitionAvailable !== 'function') {
    return 'unknown';
  }
  try {
    return module.isRecognitionAvailable() === true ? 'available' : 'unavailable';
  } catch {
    return 'unknown';
  }
}
