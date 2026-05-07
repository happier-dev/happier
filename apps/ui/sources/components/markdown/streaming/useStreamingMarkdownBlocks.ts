import * as React from 'react';

import type { MarkdownBlock } from '../parseMarkdown';
import { parseMarkdown } from '../parseMarkdown';
import { createMarkdownBlockParseCache } from './createMarkdownBlockParseCache';
import { parseMarkdownBlockSource } from './parseMarkdownBlockSource';
import { preprocessStreamingMarkdown } from './preprocessStreamingMarkdown';
import { splitMarkdownIntoBlockSources } from './splitMarkdownIntoBlockSources';

export type MarkdownStreamingMode = 'static' | 'streaming';

export function useStreamingMarkdownBlocks(params: {
    markdown: string;
    mode: MarkdownStreamingMode;
}): MarkdownBlock[] {
    const cacheRef = React.useRef(createMarkdownBlockParseCache());

    return React.useMemo(() => {
        if (params.mode !== 'streaming') {
            return parseMarkdown(params.markdown);
        }

        const repairedMarkdown = preprocessStreamingMarkdown(params.markdown);
        const sources = splitMarkdownIntoBlockSources(repairedMarkdown);
        return sources.flatMap((source) => cacheRef.current.parse(source, parseMarkdownBlockSource));
    }, [params.markdown, params.mode]);
}
