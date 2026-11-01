import * as React from 'react';
import { Platform } from 'react-native';

import type { MarkdownSelectionAction } from '@/components/markdown/MarkdownView';
import { t } from '@/text';

import { buildTranscriptQuoteSourceTestId } from './readTranscriptQuoteSelection';

/**
 * Quotes a selected transcript passage into this Session's composer, or `null` while the composer
 * cannot take it (hidden, view-only, or another surface has focus).
 */
export type TranscriptQuoteHandler = (selectedText: string) => void;

const TranscriptQuoteContext = React.createContext<TranscriptQuoteHandler | null>(null);

export const TranscriptQuoteProvider = TranscriptQuoteContext.Provider;

type TranscriptQuoteMarkdownProps = Readonly<{
    selectionActions?: readonly MarkdownSelectionAction[];
    testID?: string;
}>;

const NO_QUOTE_MARKDOWN_PROPS: TranscriptQuoteMarkdownProps = {};

/**
 * Makes a message body quotable: native renderers get a Quote item in the OS selection menu; on web
 * the body carries the DOM marker that `TranscriptQuoteSelectionControls` reads. `eligible` is the
 * row's own decision (current, non-discarded prose); the composer's availability comes from context.
 */
export function useTranscriptQuoteMarkdownProps(sessionId: string, eligible: boolean): TranscriptQuoteMarkdownProps {
    const quote = React.useContext(TranscriptQuoteContext);
    return React.useMemo(() => {
        if (!quote || !eligible) return NO_QUOTE_MARKDOWN_PROPS;
        if (Platform.OS === 'web') return { testID: buildTranscriptQuoteSourceTestId(sessionId) };
        return {
            selectionActions: [{ label: t('transcript.quote.action'), onPress: ({ text }) => quote(text) }],
        };
    }, [eligible, quote, sessionId]);
}
