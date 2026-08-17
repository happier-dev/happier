import remend from 'remend';

import {
    STREAMING_INCOMPLETE_LINK_HREF,
    STREAMING_MARKDOWN_REMEND_OPTIONS,
    STREAMING_MARKDOWN_REMEND_OPTIONS_WITHOUT_LINKS,
} from './streamingMarkdownRepairConfig';

const INCOMPLETE_LINK_TAIL = `](${STREAMING_INCOMPLETE_LINK_HREF})`;

/**
 * Finishes a remend pass that stopped early on an incomplete link.
 *
 * Shared with the native Worklet repair, which runs the first pass off the JS thread and
 * cannot make this decision there. A no-op for every chunk that does not end in the
 * placeholder, which is the overwhelming majority of them.
 */
export function completeStreamingMarkdownRepair(repairedMarkdown: string): string {
    if (!repairedMarkdown.endsWith(INCOMPLETE_LINK_TAIL)) return repairedMarkdown;
    return remend(repairedMarkdown, STREAMING_MARKDOWN_REMEND_OPTIONS_WITHOUT_LINKS);
}

export function preprocessStreamingMarkdown(markdown: string): string {
    return completeStreamingMarkdownRepair(remend(markdown, STREAMING_MARKDOWN_REMEND_OPTIONS));
}
