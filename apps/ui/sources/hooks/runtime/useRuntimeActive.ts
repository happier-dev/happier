import * as React from 'react';

import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';

/**
 * Whether the runtime is active right now: the app is foregrounded and, on web,
 * the document is visible.
 *
 * Motion and polling that exist only for a user who is looking at the screen
 * read this and stop when the answer is `false`. It reads the same rule and the
 * same lifecycle signals as `startRuntimeActiveGatedInterval`, so a component
 * gate and a timer gate can never disagree about whether the user is present.
 */
export function useRuntimeActive(): boolean {
    return React.useSyncExternalStore(subscribeToRuntimeActiveChange, isRuntimeActive, isRuntimeActive);
}
