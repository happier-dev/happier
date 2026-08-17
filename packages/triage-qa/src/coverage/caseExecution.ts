import type { CaseSource } from './runnableCases.ts';

/**
 * A repository runner that selects its case files by naming each one.
 *
 * Most deciding-case roots belong to a package whose own test configuration
 * matches every case file under it by glob, so a new case file is executed the
 * moment it is written. A root reached by an enumerated command is different:
 * the file exists, `linkRunnableCases` counts the row it names, and no lane
 * ever runs it. That is a coverage claim with nothing behind it, which is worse
 * than an uncovered row because it reads as covered.
 */
export type EnumeratedCaseRunner = Readonly<{
    /** Repository-relative directory whose case files this command selects. */
    root: string;
    /** Repository-relative file declaring the command, for the finding message. */
    declaredBy: string;
    /** Directory the command's own paths are relative to. */
    commandRoot: string;
    /** The command text, or `undefined` when the declaring file has no such command. */
    commandText: string | undefined;
}>;

export type UnrunCaseFile = Readonly<{
    path: string;
    declaredBy: string;
    message: string;
}>;

function relativeToCommandRoot(path: string, commandRoot: string): string {
    const prefix = `${commandRoot}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Case files that live under an enumerated runner's root and that the runner
 * does not name.
 *
 * A root with no enumerated runner contributes nothing: its package
 * configuration reaches every case file under it, so there is no per-file
 * selection to falsify.
 */
export function findUnrunCaseFiles(
    sources: readonly CaseSource[],
    runners: readonly EnumeratedCaseRunner[],
): readonly UnrunCaseFile[] {
    const unrun: UnrunCaseFile[] = [];
    for (const runner of runners) {
        const owned = sources.filter((source) => source.path.startsWith(`${runner.root}/`));
        if (runner.commandText === undefined) {
            for (const source of owned) {
                unrun.push(Object.freeze({
                    path: source.path,
                    declaredBy: runner.declaredBy,
                    message: `${source.path} has no runner: ${runner.declaredBy} declares no command for ${runner.root}.`,
                }));
            }
            continue;
        }
        for (const source of owned) {
            const named = relativeToCommandRoot(source.path, runner.commandRoot);
            if (runner.commandText.includes(named)) continue;
            unrun.push(Object.freeze({
                path: source.path,
                declaredBy: runner.declaredBy,
                message: `${source.path} is never executed: ${runner.declaredBy} names its case files one by one `
                    + `and does not name ${named}.`,
            }));
        }
    }
    return Object.freeze(unrun);
}
