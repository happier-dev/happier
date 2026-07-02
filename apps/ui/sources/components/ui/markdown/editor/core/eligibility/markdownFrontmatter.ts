/**
 * Frontmatter handling for the rich markdown editor.
 *
 * A leading YAML frontmatter block (`---\n…\n---\n`) is stripped before the
 * eligibility gate runs and before the body is handed to the rich editor (it is
 * shown as a read-only banner instead), then re-prepended verbatim on serialize
 * so round-trips stay idempotent.
 *
 * PURE — no `@tiptap/*` import (R18). Safe to import from the native graph.
 */

export type FrontMatterSplit = Readonly<{
    /** The raw frontmatter block (including the delimiter lines), or `null` if absent. */
    frontmatter: string | null;
    /** The markdown body with the frontmatter block removed. */
    body: string;
}>;

/**
 * Matches a leading frontmatter block:
 * - opening `---` on its own line (the very start of the document),
 * - any number of (non-greedy) content lines,
 * - a closing `---` (or `...`) on its own line,
 * - and the trailing newline that separates it from the body.
 *
 * Anchored to the document start so frontmatter is only recognized at the top.
 */
const FRONT_MATTER_PATTERN = /^(---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*\r?\n?)/;

/**
 * Splits a leading YAML frontmatter block off the document body.
 *
 * Returns `{ frontmatter: null, body: raw }` when no frontmatter is present.
 * The captured `frontmatter` includes the delimiter lines and trailing newline
 * so `reattachFrontMatter(...)` can restore the exact byte sequence.
 */
export function extractFrontMatter(raw: string): FrontMatterSplit {
    const match = FRONT_MATTER_PATTERN.exec(raw);
    if (!match) {
        return { frontmatter: null, body: raw };
    }

    const frontmatter = match[1];
    const body = raw.slice(frontmatter.length);
    return { frontmatter, body };
}

/**
 * Re-prepends a previously-extracted frontmatter block to a body.
 *
 * `reattachFrontMatter(extractFrontMatter(raw).frontmatter, extractFrontMatter(raw).body) === raw`.
 */
export function reattachFrontMatter(frontmatter: string | null, body: string): string {
    if (frontmatter === null) {
        return body;
    }
    return frontmatter + body;
}
