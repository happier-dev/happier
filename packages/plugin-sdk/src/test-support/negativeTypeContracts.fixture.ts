import { Buffer } from 'node:buffer';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';

type NegativeTypeCase = Readonly<{
    id: string;
    reason: string;
    fileName: string;
    start: number;
    end: number;
}>;

const CASE_PATTERN = /\/\* @sdk-negative-type-case:([^:]+):([^:]+):([^ ]+) \*\/[\s\S]*?\/\* @sdk-negative-type-case-end \*\//gu;

function sourceFilesBelow(directory: string): readonly string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return sourceFilesBelow(path);
        return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    });
}

function decode(value: string): string {
    return Buffer.from(value, 'base64url').toString('utf8');
}

function reconstructNegativeTypeCases(
    fileName: string,
    source: string,
): Readonly<{ source: string; cases: readonly NegativeTypeCase[] }> {
    const cases: NegativeTypeCase[] = [];
    let output = '';
    let previousEnd = 0;

    for (const match of source.matchAll(CASE_PATTERN)) {
        const matchStart = match.index;
        output += source.slice(previousEnd, matchStart);
        const code = decode(match[3]);
        const start = output.length;
        output += code;
        cases.push({
            id: match[1],
            reason: decode(match[2]),
            fileName,
            start,
            end: output.length,
        });
        previousEnd = matchStart + match[0].length;
    }
    output += source.slice(previousEnd);
    return { source: output, cases };
}

export type NegativeTypeContractsFixtureResult = Readonly<{
    caseCount: number;
    syntacticDiagnostics: readonly Readonly<{ fileName: string; message: string }>[];
    missing: readonly Readonly<{ id: string; reason: string }>[];
    unexpectedFiles: readonly Readonly<{ fileName: string; message: string }>[];
}>;

export async function evaluateNegativeTypeContracts(sourceRoot: string): Promise<NegativeTypeContractsFixtureResult> {
    const reconstructedSources = new Map<string, string>();
    const cases: NegativeTypeCase[] = [];

    for (const fileName of sourceFilesBelow(sourceRoot)) {
        const source = readFileSync(fileName, 'utf8');
        if (!source.includes('@sdk-negative-type-case:')) continue;
        const reconstructed = reconstructNegativeTypeCases(fileName, source);
        reconstructedSources.set(fileName, reconstructed.source);
        cases.push(...reconstructed.cases);
    }

    const { compileNegativeCaseSources }: typeof import('./negativeTypeProject.js') = await import(new URL('./negativeTypeProject.ts', import.meta.url).href);
    const diagnostics = await compileNegativeCaseSources(sourceRoot, reconstructedSources);
    const position = (diagnostic: (typeof diagnostics)[number]): number | undefined => {
        const source = reconstructedSources.get(diagnostic.fileName);
        if (source === undefined) return undefined;
        const parsed = ts.createSourceFile(diagnostic.fileName, source, ts.ScriptTarget.Latest);
        return parsed.getPositionOfLineAndCharacter(diagnostic.line - 1, diagnostic.column - 1);
    };
    const syntacticDiagnostics = diagnostics.filter(diagnostic => diagnostic.code >= 1000 && diagnostic.code < 2000);
    return {
        caseCount: cases.length,
        syntacticDiagnostics: syntacticDiagnostics.map((diagnostic) => ({
            fileName: diagnostic.fileName,
            message: diagnostic.message,
        })),
        missing: cases
            .filter((negativeCase) => !diagnostics.some((diagnostic) => (
                diagnostic.fileName === negativeCase.fileName
                && position(diagnostic) !== undefined
                && negativeCase.start <= position(diagnostic)!
                && position(diagnostic)! <= negativeCase.end
            )))
            .map(({ id, reason }) => ({ id, reason })),
        unexpectedFiles: diagnostics
            .filter((diagnostic) => (
                !reconstructedSources.has(diagnostic.fileName)
            ))
            .map((diagnostic) => ({
                fileName: diagnostic.fileName,
                message: diagnostic.message,
            })),
    };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    process.stdout.write(`${JSON.stringify(await evaluateNegativeTypeContracts(resolve(import.meta.dirname, '..')))}\n`);
}
