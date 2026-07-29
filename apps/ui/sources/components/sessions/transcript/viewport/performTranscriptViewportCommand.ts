import { Platform } from 'react-native';

import {
    performNativeStandardListViewportCommand,
    resolveIndexScrollWriter,
} from '@/components/sessions/transcript/viewport/driver/nativeStandardList';
import { performWebDomViewportCommand } from '@/components/sessions/transcript/viewport/driver/webDom';
import type { TranscriptViewportDriverDeps } from '@/components/sessions/transcript/viewport/driver/types';
import type { TranscriptViewportCommand } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

export { resolveIndexScrollWriter };
export type TranscriptViewportPerformDeps = TranscriptViewportDriverDeps;

/**
 * Compatibility dispatcher between the existing viewport command surface and the final platform drivers.
 *
 * D2 moves raw platform writes and raw offset conversions into `viewport/driver/*`. This module intentionally
 * remains while `ChatList` still emits the transitional `TranscriptViewportCommand` shape; D3 removes the
 * remaining raw-ish command fields when host integration can be serialized.
 */
export function performTranscriptViewportCommand(
    command: TranscriptViewportCommand,
    deps: TranscriptViewportPerformDeps,
): boolean {
    if (Platform.OS === 'web') {
        return performWebDomViewportCommand(command, deps);
    }

    // Legend is the only renderer; native commands always execute in standard space.
    return performNativeStandardListViewportCommand(command, deps);
}
