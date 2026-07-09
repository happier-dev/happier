import type { TranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';

export type TranscriptRendererSurface = 'readOnly' | 'sidechain' | 'main';

export function resolveTranscriptRendererSurface(frame: TranscriptListShellFrame): TranscriptRendererSurface {
    return frame.capability.kind;
}
