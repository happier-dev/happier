import * as React from 'react';
import { Platform } from 'react-native';

import type { MarkdownSelectionAction, MarkdownSourceRangeAction } from '../MarkdownView';

/** One native event adapter for every Markdown prose renderer. */
export function useMarkdownSelectionMenu(
    actions: readonly MarkdownSelectionAction[] | undefined,
    source: MarkdownSourceRangeAction | null,
) {
    return React.useMemo(() => Platform.OS === 'web' || !actions?.length || !source ? undefined
        : actions.map(action => ({ text: action.label, onPress: (event: {
            text: string; renderedText?: string; selection: { start: number; end: number };
        }) => action.onPress(source, {
            renderedText: event.renderedText, text: event.text,
            start: event.selection.start, end: event.selection.end,
        }) })), [actions, source]);
}
