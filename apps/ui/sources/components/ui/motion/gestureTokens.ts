import { HAPPIER_GESTURE_TIMING } from '@happier-dev/plugin-ui/presentation';
/** Shared platform conventions; key repeat remains the editor's on-screen-key contract. */
export const gestureTokens = {
    ...HAPPIER_GESTURE_TIMING,
    /** A held on-screen key (the editor's arrow keys) repeats like a hardware key: first after the delay, then every interval. */
    keyRepeatDelayMs: 400,
    keyRepeatIntervalMs: 60,
};
