import { legendListRenderer } from './legendListRenderer';
import type { TranscriptListRenderer } from './types';

export function resolveTranscriptListRenderer(): TranscriptListRenderer {
    return legendListRenderer;
}
