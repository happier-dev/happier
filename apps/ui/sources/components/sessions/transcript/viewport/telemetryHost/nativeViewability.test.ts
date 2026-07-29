import { describe, expect, it } from 'vitest';

import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { resolveNativeViewabilityTelemetry } from './nativeViewability';

describe('native viewability observation', () => {
    it('keeps blank-recovery visibility facts available when telemetry is disabled', () => {
        const result = resolveNativeViewabilityTelemetry({
            info: { viewableItems: [] },
            itemCount: 4,
            layoutHeight: 812,
            syncTuning: {
                ...loadSyncTuning(),
                transcriptViewportTelemetryEnabled: false,
            },
        });

        expect(result).toEqual({
            observeBlankRecovery: true,
            snapshot: {
                blankAreaPx: 812,
                blankAreaSource: 'index-estimate',
                firstVisibleItemId: undefined,
                hasVisibleRows: false,
                lastVisibleItemId: undefined,
                visibleWindowSource: 'viewability-callback',
            },
        });
    });
});
