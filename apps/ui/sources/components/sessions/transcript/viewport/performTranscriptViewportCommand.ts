import { Platform } from 'react-native';

import {
    performNativeInvertedFlashListViewportCommand,
    resolveIndexScrollWriter,
} from '@/components/sessions/transcript/viewport/driver/nativeInvertedFlashList';
import { performNativeStandardListViewportCommand } from '@/components/sessions/transcript/viewport/driver/nativeStandardList';
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
    if (command.kind === 'skip-native-js-pin') {
        deps.recordViewportTelemetryEvent({
            type: 'scroll-write',
            writer: 'mvcp-skip',
            reason: command.reason,
            mode: command.mode,
            layoutHeight: deps.listLayoutHeightRef.current,
            contentHeight: deps.listContentHeightRef.current,
            distanceFromBottom: deps.lastPinOffsetForIntentRef.current ?? undefined,
            nativeMountSettleStable: deps.nativeMountSettleStable,
        });
        return true;
    }

    if (Platform.OS === 'web') {
        return performWebDomViewportCommand(command, deps);
    }

    if (deps.listRef.current?.transcriptViewportCommandSpace === 'standard') {
        return performNativeStandardListViewportCommand(command, deps);
    }

    return performNativeInvertedFlashListViewportCommand(command, deps);
}
