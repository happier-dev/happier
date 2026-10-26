import type { TranscriptQuoteHandler } from './TranscriptQuoteContext';

export type TranscriptQuoteSelectionControlsProps = Readonly<{
    sessionId: string;
    onQuote: TranscriptQuoteHandler | null;
}>;

/** Native quoting lives in the OS text-selection menu (`useTranscriptQuoteMarkdownProps`). */
export function TranscriptQuoteSelectionControls(_props: TranscriptQuoteSelectionControlsProps): null {
    return null;
}
