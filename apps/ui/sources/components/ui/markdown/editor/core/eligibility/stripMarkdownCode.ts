/**
 * Strips markdown code regions so eligibility blocker regexes (reference links,
 * footnotes, HTML/JSX) don't trip on examples written *inside* code.
 *
 * Mirrors Orca's `stripMarkdownCode` (verified vs `markdown-rich-mode.ts`):
 * - fenced code blocks delimited by ``` or ~~~ (with optional info string), and
 * - inline code spans delimited by matching runs of backticks.
 *
 * The removed regions are replaced with whitespace-preserving blanks so that
 * line-anchored regexes (`/^…/m`) keep their original line positions — only the
 * code *content* is erased, never the line structure.
 *
 * PURE — no `@tiptap/*` import (R18). Safe to import from the native graph.
 */

/**
 * Returns `md` with fenced code blocks and inline code spans blanked out,
 * preserving line count so downstream line-anchored regexes (`/^…/m`) keep
 * their original line offsets. Line-based state machine mirroring Orca's
 * verified `stripMarkdownCode` (a single regex mis-handles fence pairing and
 * over-blanks past the closing fence).
 */
export function stripMarkdownCode(md: string): string {
    const lines = md.split(/\r?\n/);
    const out: string[] = [];
    let activeFence: '`' | '~' | null = null;

    for (const line of lines) {
        const fence = line.match(/^\s*(`{3,}|~{3,})/);
        if (fence) {
            const marker = fence[1][0] as '`' | '~';
            // A same-marker fence closes the active block; otherwise it opens one.
            activeFence = activeFence === marker ? null : marker;
            out.push('');
            continue;
        }
        if (activeFence) {
            out.push('');
            continue;
        }
        // Outside code: blank inline code spans so examples don't trip blockers.
        out.push(line.replace(/`+[^`\n]*`+/g, ''));
    }

    return out.join('\n');
}
