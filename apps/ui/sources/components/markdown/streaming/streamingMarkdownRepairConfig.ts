import type { RemendOptions } from 'remend';

export const STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS = 4096;
export const STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS = 32;

export const STREAMING_MARKDOWN_REMEND_OPTIONS = {
    inlineKatex: false,
    katex: true,
    linkMode: 'text-only',
    htmlTags: false,
} satisfies RemendOptions;
