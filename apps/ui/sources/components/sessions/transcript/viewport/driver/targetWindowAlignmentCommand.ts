import type { TranscriptNavigationEntry } from '../../navigation/transcriptNavigationTypes';
import type { TranscriptViewportJumpAlignment } from '../transcriptViewportTypes';

const TRANSCRIPT_NAVIGATION_TOP_ALIGNMENT_OFFSET_PX = 24;

export type TargetWindowAlignmentAnchorKind = TranscriptNavigationEntry['kind'] | 'far-target';

export function resolveTargetWindowAlignmentCommand(params: Readonly<{
    anchorKind: TargetWindowAlignmentAnchorKind;
    requestedAlign?: 'top' | 'center' | null;
}>): TranscriptViewportJumpAlignment {
    if (params.requestedAlign === 'top') {
        return { kind: 'top-with-item-offset', itemOffsetPx: TRANSCRIPT_NAVIGATION_TOP_ALIGNMENT_OFFSET_PX };
    }
    if (params.requestedAlign === 'center') {
        return { kind: 'center' };
    }
    return params.anchorKind === 'user-turn'
        ? { kind: 'top-with-item-offset', itemOffsetPx: TRANSCRIPT_NAVIGATION_TOP_ALIGNMENT_OFFSET_PX }
        : { kind: 'center' };
}
