import * as React from 'react';

import type { MarkdownStreamingMode } from './useStreamingMarkdownBlocks';
import { preprocessStreamingMarkdown } from './preprocessStreamingMarkdown';
import { repairStreamingMarkdownAsync } from './repairStreamingMarkdownAsync';
import {
    STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS,
    STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS,
} from './streamingMarkdownRepairConfig';

type PreparedStreamingMarkdownState = Readonly<{
    sourceMarkdown: string;
    preparedMarkdown: string;
}>;

function shouldUseAsyncStreamingRepair(markdown: string): boolean {
    return markdown.length >= STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS;
}

export function usePreparedStreamingMarkdown(params: Readonly<{
    markdown: string;
    mode: MarkdownStreamingMode;
}>): string {
    const markdown = typeof params.markdown === 'string' ? params.markdown : '';
    const useAsyncRepair = params.mode === 'streaming' && shouldUseAsyncStreamingRepair(markdown);
    const requestVersionRef = React.useRef(0);
    const [preparedState, setPreparedState] = React.useState<PreparedStreamingMarkdownState | null>(null);

    const syncPreparedMarkdown = React.useMemo(() => {
        if (params.mode !== 'streaming') return markdown;
        if (useAsyncRepair) return null;
        return preprocessStreamingMarkdown(markdown);
    }, [markdown, params.mode, useAsyncRepair]);

    React.useEffect(() => {
        if (!useAsyncRepair) {
            requestVersionRef.current += 1;
            setPreparedState((current) => current == null ? current : null);
            return;
        }

        const requestVersion = requestVersionRef.current + 1;
        requestVersionRef.current = requestVersion;
        let cancelled = false;

        const timeout = setTimeout(() => {
            void repairStreamingMarkdownAsync(markdown)
                .then((preparedMarkdown) => {
                    if (cancelled || requestVersionRef.current !== requestVersion) return;
                    setPreparedState({ sourceMarkdown: markdown, preparedMarkdown });
                })
                .catch(() => {
                    if (cancelled || requestVersionRef.current !== requestVersion) return;
                    setPreparedState({
                        sourceMarkdown: markdown,
                        preparedMarkdown: preprocessStreamingMarkdown(markdown),
                    });
                });
        }, STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS);

        return () => {
            cancelled = true;
            clearTimeout(timeout);
        };
    }, [markdown, useAsyncRepair]);

    if (syncPreparedMarkdown != null) return syncPreparedMarkdown;
    if (preparedState?.sourceMarkdown === markdown) return preparedState.preparedMarkdown;
    return markdown;
}
