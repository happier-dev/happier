import type { FindCoverage } from '@happier-dev/plugin-ui/presentation';
import type { TranscriptHistoryState } from '../source/types';

export type TranscriptFindCoverageInput = Readonly<{
    history: Pick<TranscriptHistoryState, 'isLoaded' | 'hasOlder' | 'hasNewer'>;
    stopped: boolean;
    partialErrors: boolean;
    hasPendingText?: boolean;
    hasUnreadableText?: boolean;
}>;

export function resolveTranscriptFindCoverage(input: TranscriptFindCoverageInput): FindCoverage {
    if (input.partialErrors || input.hasUnreadableText) return 'partialErrors';
    if (input.stopped) return 'olderRemaining';
    return !input.history.isLoaded || input.history.hasOlder || input.history.hasNewer || input.hasPendingText ? 'loaded' : 'complete';
}
