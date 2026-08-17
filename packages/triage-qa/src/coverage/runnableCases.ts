/** One runnable case that names the deciding row it runs, in its own title. */
export type RunnableCase = Readonly<{ qbId: string; path: string; title: string }>;

/** One test file's current bytes, as read by a caller that owns the filesystem. */
export type CaseSource = Readonly<{ path: string; text: string }>;

const CASE_TITLE = /^\s*(?:it|test)\(\s*['"`]([^'"`]+)['"`]/gmu;
const QB_IN_TITLE = /\bQB-\d+\b/gu;

/**
 * Links deciding rows to the runnable cases that name them.
 *
 * A case names its row in its title. This is the only link between the matrix
 * and executable evidence, and it is derived rather than declared so a renamed
 * or deleted case cannot leave a stale claim behind.
 */
export function linkRunnableCases(sources: readonly CaseSource[]): readonly RunnableCase[] {
    const cases: RunnableCase[] = [];
    for (const source of sources) {
        for (const match of source.text.matchAll(CASE_TITLE)) {
            const title = match[1];
            if (title === undefined) continue;
            for (const qbId of title.match(QB_IN_TITLE) ?? []) {
                cases.push(Object.freeze({ qbId, path: source.path, title }));
            }
        }
    }
    return Object.freeze(cases);
}
