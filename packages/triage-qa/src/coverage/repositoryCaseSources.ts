import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EnumeratedCaseRunner } from './caseExecution.ts';
import type { CaseSource } from './runnableCases.ts';

const harnessDirectory = dirname(fileURLToPath(import.meta.url));

/** The repository root relative to this package. */
export const REPOSITORY_ROOT = resolve(harnessDirectory, '../../../..');

/**
 * Where a runnable deciding case may live today. A row's owner adds its root
 * here when it lands cases; an absent root contributes nothing rather than
 * failing, so this check cannot go permanently red on a lane that has not
 * started.
 */
export const DECIDING_CASE_ROOTS: readonly string[] = Object.freeze([
    'packages/tests/fixtures/plugin-platform/out-of-tree-triage-source/test',
    'packages/triage-protocol/src',
    'packages/plugins/triage/src',
]);

/**
 * The deciding-case roots a repository command reaches by naming each file.
 *
 * The other roots in `DECIDING_CASE_ROOTS` belong to a package whose own test
 * configuration globs every case file under it, so nothing there can exist
 * unrun. This fixture is reached by an explicit list in another package's
 * scripts, which is the one shape where a case file can be counted as coverage
 * and never executed.
 */
const ENUMERATED_CASE_RUNNERS: readonly Readonly<{
    root: string;
    declaredBy: string;
    commandRoot: string;
    scriptKey: string;
}>[] = Object.freeze([{
    root: 'packages/tests/fixtures/plugin-platform/out-of-tree-triage-source/test',
    declaredBy: 'packages/tests/package.json',
    commandRoot: 'packages/tests',
    scriptKey: 'test:plugin-platform:out-of-tree-triage-source',
}]);

const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage']);
const CASE_FILE = /\.test\.(?:ts|tsx|mts|mjs|js)$/u;

function walk(root: string, directory: string, found: CaseSource[]): void {
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (SKIPPED.has(entry.name)) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
            walk(root, absolute, found);
            continue;
        }
        if (!CASE_FILE.test(entry.name)) continue;
        found.push(Object.freeze({
            // Repository-relative and always forward-slashed: a runner names its
            // files that way in a script, and a Windows separator here would
            // make every root prefix miss and report zero unrun files.
            path: relative(root, absolute).split(sep).join('/'),
            text: readFileSync(absolute, 'utf8'),
        }));
    }
}

/** Reads the current command text of every enumerated deciding-case runner. */
export function readEnumeratedCaseRunners(
    repositoryRoot: string = REPOSITORY_ROOT,
): readonly EnumeratedCaseRunner[] {
    return ENUMERATED_CASE_RUNNERS.map((runner) => {
        let scripts: Record<string, unknown> = {};
        try {
            const manifest = JSON.parse(
                readFileSync(join(repositoryRoot, runner.declaredBy), 'utf8'),
            ) as Readonly<{ scripts?: Record<string, unknown> }>;
            scripts = manifest.scripts ?? {};
        } catch {
            scripts = {};
        }
        const command = scripts[runner.scriptKey];
        return Object.freeze({
            root: runner.root,
            declaredBy: `${runner.declaredBy} ${runner.scriptKey}`,
            commandRoot: runner.commandRoot,
            commandText: typeof command === 'string' ? command : undefined,
        });
    });
}

/** Reads the current bytes of every case file under the declared case roots. */
export function readDecidingCaseSources(
    repositoryRoot: string = REPOSITORY_ROOT,
    roots: readonly string[] = DECIDING_CASE_ROOTS,
): readonly CaseSource[] {
    const found: CaseSource[] = [];
    for (const root of roots) walk(repositoryRoot, join(repositoryRoot, root), found);
    return Object.freeze(found);
}
