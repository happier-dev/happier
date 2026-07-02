/**
 * Byte-verbatim raw-HTML atom nodes for the rich markdown editor (Phase-1.5).
 *
 * The SECOND half of the risky-markdown pre-pass (the first being the pure
 * `core/eligibility/encodeRiskyMarkdown.ts` scanner). These two `@tiptap/core`
 * atom nodes give the markdown manager a way to tokenize the sentinels emitted
 * by the pre-pass back into opaque nodes and, crucially, re-emit the ORIGINAL
 * bytes verbatim on serialize — making raw HTML / HTML comments round-trip
 * losslessly so the eligibility gate stops forcing a whole-document raw fallback.
 *
 * Why two nodes: marked distinguishes block-level from inline tokenizers, so an
 * inline HTML run mid-paragraph (`<span>`) and a block-only HTML line (`<div>` on
 * its own line) need separate tokenizers/atoms to slot into the doc at the right
 * level.
 *
 * D4: NO React node view — plain `renderHTML`/`parseHTML` only, so this file is
 * consumed identically by the `@tiptap/react` web surface and the headless
 * `@tiptap/core` WebView bundle entry.
 *
 * R18: imports `@tiptap/core`, so it MUST live in `core/tiptap/` (never
 * `core/eligibility/`). It imports the sentinel grammar (prefixes +
 * `matchPlaceholder`) from the PURE `encodeRiskyMarkdown.ts` — a tiptap→pure
 * import, which is allowed (the reverse is not).
 */

import { Node, mergeAttributes } from '@tiptap/core';
import type { MarkdownToken } from '@tiptap/core';

import {
    RAW_HTML_BLOCK_PLACEHOLDER_PREFIX,
    RAW_HTML_INLINE_PLACEHOLDER_PREFIX,
    matchPlaceholder,
} from '../eligibility/encodeRiskyMarkdown';

/** Node name for an inline raw-HTML atom. */
export const RAW_MARKDOWN_HTML_INLINE_NODE_NAME = 'rawMarkdownHtmlInline';
/** Node name for a block raw-HTML atom. */
export const RAW_MARKDOWN_HTML_BLOCK_NODE_NAME = 'rawMarkdownHtmlBlock';

/** Reads the decoded raw-HTML bytes off a node's `value` attribute. */
function nodeValue(node: { attrs?: { value?: unknown } }): string {
    return typeof node.attrs?.value === 'string' ? node.attrs.value : '';
}

/** Reads the decoded raw-HTML bytes off a parsed marked token. */
function tokenText(token: MarkdownToken): string {
    return typeof token.text === 'string' ? token.text : '';
}

/**
 * Inline raw-HTML atom. Holds the decoded original bytes in `value` and re-emits
 * them VERBATIM on serialize (`renderMarkdown` → `node.attrs.value`), which is
 * what makes the round-trip byte-preserving.
 */
export const RawMarkdownHtmlInline = Node.create({
    name: RAW_MARKDOWN_HTML_INLINE_NODE_NAME,
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,

    addAttributes() {
        return {
            value: {
                default: '',
            },
        };
    },

    // Converting embedded HTML into a placeholder token BEFORE the markdown
    // parser runs keeps marked's paragraph tokenization intact while still
    // letting us round-trip the raw markup verbatim.
    markdownTokenName: RAW_MARKDOWN_HTML_INLINE_NODE_NAME,
    markdownTokenizer: {
        name: RAW_MARKDOWN_HTML_INLINE_NODE_NAME,
        level: 'inline',
        start: RAW_HTML_INLINE_PLACEHOLDER_PREFIX,
        tokenize(src) {
            const matched = matchPlaceholder(src, 'inline');
            if (!matched) {
                return undefined;
            }
            return {
                type: RAW_MARKDOWN_HTML_INLINE_NODE_NAME,
                raw: matched.placeholder,
                text: matched.value,
            };
        },
    },
    parseMarkdown: (token, helpers) => {
        if (token.type !== RAW_MARKDOWN_HTML_INLINE_NODE_NAME) {
            return [];
        }
        return helpers.createNode(RAW_MARKDOWN_HTML_INLINE_NODE_NAME, {
            value: tokenText(token),
        });
    },
    renderMarkdown: (node) => nodeValue(node),

    parseHTML() {
        return [{ tag: 'span[data-raw-markdown-html-inline]' }];
    },

    renderHTML({ HTMLAttributes, node }) {
        return [
            'span',
            mergeAttributes(HTMLAttributes, {
                'data-raw-markdown-html-inline': '',
                contenteditable: 'false',
                class: 'raw-markdown-html-inline',
            }),
            nodeValue(node),
        ];
    },
});

/**
 * Block raw-HTML atom. Same byte-verbatim contract as the inline node, but slots
 * in at the block level for HTML that occupies a whole line.
 */
export const RawMarkdownHtmlBlock = Node.create({
    name: RAW_MARKDOWN_HTML_BLOCK_NODE_NAME,
    group: 'block',
    atom: true,
    selectable: true,

    addAttributes() {
        return {
            value: {
                default: '',
            },
        };
    },

    markdownTokenName: RAW_MARKDOWN_HTML_BLOCK_NODE_NAME,
    markdownTokenizer: {
        name: RAW_MARKDOWN_HTML_BLOCK_NODE_NAME,
        level: 'block',
        start: RAW_HTML_BLOCK_PLACEHOLDER_PREFIX,
        tokenize(src) {
            const matched = matchPlaceholder(src, 'block');
            if (!matched) {
                return undefined;
            }
            return {
                type: RAW_MARKDOWN_HTML_BLOCK_NODE_NAME,
                raw: matched.placeholder,
                text: matched.value,
                block: true,
            };
        },
    },
    parseMarkdown: (token, helpers) => {
        if (token.type !== RAW_MARKDOWN_HTML_BLOCK_NODE_NAME) {
            return [];
        }
        return helpers.createNode(RAW_MARKDOWN_HTML_BLOCK_NODE_NAME, {
            value: tokenText(token),
        });
    },
    renderMarkdown: (node) => nodeValue(node),

    parseHTML() {
        return [{ tag: 'div[data-raw-markdown-html-block]' }];
    },

    renderHTML({ HTMLAttributes, node }) {
        return [
            'div',
            mergeAttributes(HTMLAttributes, {
                'data-raw-markdown-html-block': '',
                contenteditable: 'false',
                class: 'raw-markdown-html-block',
            }),
            ['pre', nodeValue(node)],
        ];
    },
});
