import remend from 'remend';

import { STREAMING_MARKDOWN_REMEND_OPTIONS } from './streamingMarkdownRepairConfig';

export function preprocessStreamingMarkdown(markdown: string): string {
    return remend(markdown, STREAMING_MARKDOWN_REMEND_OPTIONS);
}
