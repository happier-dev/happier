import { sync } from '@/sync/sync';
import type { TranscriptMountSettleTuning } from '@/components/sessions/transcript/viewport/lifecycle/mountSettle';

export function resolveTranscriptMountSettleTuning(): TranscriptMountSettleTuning {
    const tuning = sync.getSyncTuning();
    return {
        quiescentWindowMs: tuning.transcriptMountSettleQuiescentWindowMs,
        dimensionNoiseFloorPx: tuning.transcriptMountSettleDimensionNoiseFloorPx,
        bottomDistanceNoiseFloorPx: tuning.transcriptMountSettleBottomDistanceNoiseFloorPx,
    };
}
