import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Triage plan corpus this harness derives its coverage, recipe and count
 * checks from. The corpus is authored Markdown, not a second contract: nothing
 * here restates a requirement, invariant, or QB row, and every id this harness
 * knows is parsed from those bytes at run time.
 */
export type PlanCorpus = Readonly<{
    /** Absolute path of the plan corpus root. */
    root: string;
    /** Reads one corpus-relative authored document. */
    read: (relativePath: string) => string;
    /** Whether one corpus-relative path exists. */
    has: (relativePath: string) => boolean;
    /**
     * Every living authored document, corpus-relative path plus current bytes.
     *
     * `evidence/` is excluded because `PLAN.md` §7.4's surrounding ruling states
     * it is frozen, read-only, and carries no authority of its own; a frozen
     * record cannot drift, so holding it to §7.3 would only produce permanent
     * noise. `execution/` is lane reporting and `scripts/` is not prose.
     */
    livingDocuments: () => readonly Readonly<{ path: string; markdown: string }>[];
}>;

const harnessDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * The corpus root relative to this package. Resolved rather than hard-coded per
 * caller so a moved plan corpus fails in exactly one place.
 */
export const DEFAULT_PLAN_CORPUS_ROOT = resolve(
    harnessDirectory,
    '../../../../.project/plans/2026-08-12-triage',
);

export const PLAN_DOCUMENT = 'PLAN.md';
export const QA_PROTOCOL_DOCUMENT = 'qa/QA-PROTOCOL.md';

/** Corpus directories that hold no living authored prose. */
const NON_LIVING_DIRECTORIES: ReadonlySet<string> = new Set(['evidence', 'execution', 'scripts']);

function walkMarkdown(root: string, directory: string, found: string[]): void {
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
            if (directory === root && NON_LIVING_DIRECTORIES.has(entry.name)) continue;
            walkMarkdown(root, absolute, found);
            continue;
        }
        if (entry.name.endsWith('.md')) found.push(relative(root, absolute));
    }
}

/** Opens a plan corpus rooted at `root`, defaulting to this program's corpus. */
export function openPlanCorpus(root: string = DEFAULT_PLAN_CORPUS_ROOT): PlanCorpus {
    const absoluteRoot = isAbsolute(root) ? root : resolve(process.cwd(), root);
    const read = (relativePath: string): string =>
        readFileSync(join(absoluteRoot, relativePath), 'utf8');
    return Object.freeze({
        root: absoluteRoot,
        read,
        has: (relativePath: string): boolean => {
            try {
                read(relativePath);
                return true;
            } catch {
                return false;
            }
        },
        livingDocuments: () => {
            const paths: string[] = [];
            walkMarkdown(absoluteRoot, absoluteRoot, paths);
            return Object.freeze(
                paths.sort().map((path) => Object.freeze({ path, markdown: read(path) })),
            );
        },
    });
}
