import { loadSyncTuning, type SyncTuning } from '@/sync/runtime/syncTuning';

import { flashListRenderer } from './flashListRenderer';
import { legendListRenderer } from './legendListRenderer';
import { resolveTranscriptRendererSurface } from './transcriptRendererSurface';
import type { TranscriptListRenderer } from './types';
import type { TranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';

export function resolveTranscriptListRendererKind(params: Readonly<{
    frameSurface: ReturnType<typeof resolveTranscriptRendererSurface>;
    transcriptLegendListSpikeSurface?: SyncTuning['transcriptLegendListSpikeSurface'];
}>): TranscriptListRenderer['kind'] {
    const requestedSurface =
        params.transcriptLegendListSpikeSurface ?? loadSyncTuning().transcriptLegendListSpikeSurface;

    if (requestedSurface === 'flashList') return 'flashList';
    if (requestedSurface !== 'off' && requestedSurface === params.frameSurface) return 'legendList';
    return 'legendList';
}

export function resolveTranscriptListRenderer(params: Readonly<{
    frame: TranscriptListShellFrame;
    platformOS?: string;
    transcriptLegendListSpikeSurface?: SyncTuning['transcriptLegendListSpikeSurface'];
}>): TranscriptListRenderer {
    const frameSurface = resolveTranscriptRendererSurface(params.frame);
    const rendererKind = resolveTranscriptListRendererKind({
        frameSurface,
        transcriptLegendListSpikeSurface: params.transcriptLegendListSpikeSurface,
    });

    return rendererKind === 'flashList' ? flashListRenderer : legendListRenderer;
}
