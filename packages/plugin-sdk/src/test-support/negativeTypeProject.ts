import { spawnSync } from 'node:child_process';
import { fixtureCommandMaxOutputBytes } from './boundedFixtureCommand.js';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Diagnostic = Readonly<{ fileName: string; line: number; column: number; code: number; message: string }>;

/** Reconstruct only fixture bytes; compile through the repository's real selector. */
export async function compileNegativeCaseSources(
    sourceRoot: string,
    sources: ReadonlyMap<string, string>,
): Promise<readonly Diagnostic[]> {
    const packageRoot = dirname(sourceRoot);
    const repositoryRoot = resolve(packageRoot, '../..');
    const directory = mkdtempSync(join(tmpdir(), 'happier-sdk-negative-types-'));
    const fixturePackages = join(directory, 'packages');
    const fixturePackage = join(fixturePackages, 'plugin-sdk');
    try {
        mkdirSync(fixturePackage, { recursive: true });
        cpSync(sourceRoot, join(fixturePackage, 'src'), { recursive: true });
        // Relative cross-package imports and ordinary package dependencies keep
        // their real owners. No install, package input edit, or source-tree probe.
        for (const entry of readdirSync(join(repositoryRoot, 'packages'), { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name !== 'plugin-sdk') {
                symlinkSync(join(repositoryRoot, 'packages', entry.name), join(fixturePackages, entry.name), 'junction');
            }
        }
        symlinkSync(join(repositoryRoot, 'node_modules'), join(directory, 'node_modules'), 'junction');
        symlinkSync(join(packageRoot, 'node_modules'), join(fixturePackage, 'node_modules'), 'junction');
        const originals = new Map<string, string>();
        for (const [fileName, text] of sources) {
            const fixture = join(fixturePackage, 'src', relative(sourceRoot, fileName));
            writeFileSync(fixture, text);
            originals.set(fixture, fileName);
        }
        const config = join(fixturePackage, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({
            extends: join(packageRoot, 'tsconfig.tests.json'),
            compilerOptions: {
                incremental: false, noEmit: true, rootDir: directory,
                paths: {
                    '@happier-dev/plugin-sdk': [join(fixturePackage, 'src/index.ts')],
                    '@happier-dev/plugin-sdk/*': [join(fixturePackage, 'src/*/index.ts'), join(fixturePackage, 'src/*.ts')],
                },
            },
            files: [...originals.keys()], include: [], exclude: [],
        }));
        // The containing bounded fixture process owns timeout, output and tree
        // cancellation. This child neither increases nor competes with them.
        const result = spawnSync(process.execPath, [
            join(repositoryRoot, 'scripts/workspaces/runTypeScriptCli.mjs'),
            '--project', config, '--pretty', 'false',
        ], { cwd: packageRoot, encoding: 'utf8', maxBuffer: fixtureCommandMaxOutputBytes });
        if (result.error || result.signal || ![0, 1, 2].includes(result.status ?? -1)) {
            throw new Error(`Negative compiler failed: ${result.error?.message ?? result.signal ?? result.status}\n${result.stderr}`);
        }
        const modulePath = pathToFileURL(join(repositoryRoot, 'scripts/testing/lib/compilerBaseline.mjs')).href;
        const { compilerDiagnosticFromLine }: {
            compilerDiagnosticFromLine(line: string, cwd: string, root: string): null | Readonly<{
                file: string; line: number; column: number; code: number; message: string;
            }>;
        } = await import(modulePath);
        const diagnostics: Diagnostic[] = [];
        for (const line of result.stdout.split(/\r?\n/u)) {
            if (!line.trim() || /^\s/u.test(line) || line.startsWith('[typecheck-delta]')) continue;
            const row = compilerDiagnosticFromLine(line, packageRoot, directory);
            if (!row) throw new Error(`Unrecognized negative compiler output: ${line}\n${result.stderr}`);
            const fixture = resolve(directory, row.file);
            diagnostics.push({ ...row, fileName: originals.get(fixture) ?? fixture });
        }
        if ((result.status === 0) !== (diagnostics.length === 0)) {
            throw new Error(`Negative compiler status disagrees with diagnostics\n${result.stdout}\n${result.stderr}`);
        }
        return diagnostics;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}
