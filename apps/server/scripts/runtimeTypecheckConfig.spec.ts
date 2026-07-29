import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveYarnCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

describe('server runtime TypeScript inputs', () => {
    it('generates provider clients before invoking the runtime TypeScript compiler', () => {
        const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
        const packageJson = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>;
        };
        const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-server-runtime-admission-'));
        const scriptsDir = join(fixtureDir, 'scripts');
        const eventLogPath = join(fixtureDir, 'events.log');
        const generatedMarkerPath = join(fixtureDir, 'provider-clients-ready');
        try {
            mkdirSync(scriptsDir, { recursive: true });
            writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
                private: true,
                scripts: {
                    'build:shared': packageJson.scripts?.['build:shared'],
                    'generate:providers': packageJson.scripts?.['generate:providers'],
                    'typecheck:runtime': packageJson.scripts?.['typecheck:runtime'],
                },
            }), 'utf8');
            writeFileSync(
                join(scriptsDir, 'buildSharedDeps.mjs'),
                `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.EVENT_LOG_PATH, 'workspace-build\\n');\n`,
                'utf8',
            );
            writeFileSync(
                join(scriptsDir, 'runTsx.mjs'),
                [
                    "import { appendFileSync, writeFileSync } from 'node:fs';",
                    "appendFileSync(process.env.EVENT_LOG_PATH, 'generate:start\\n');",
                    "writeFileSync(process.env.GENERATED_MARKER_PATH, 'ready\\n', 'utf8');",
                    "appendFileSync(process.env.EVENT_LOG_PATH, 'generate:done\\n');",
                ].join('\n'),
                'utf8',
            );
            writeFileSync(join(scriptsDir, 'generateClients.ts'), '// fixture input\n', 'utf8');
            writeFileSync(
                join(scriptsDir, 'runTypeScriptCli.mjs'),
                [
                    "import { appendFileSync, existsSync } from 'node:fs';",
                    "appendFileSync(process.env.EVENT_LOG_PATH, 'ts7\\n');",
                    'if (!existsSync(process.env.GENERATED_MARKER_PATH)) process.exit(42);',
                ].join('\n'),
                'utf8',
            );

            const invocation = resolveYarnCommandInvocation(
                ['-s', 'typecheck:runtime'],
                { npmExecPath: process.env.npm_execpath },
            );
            const result = spawnSync(invocation.command, invocation.args, {
                cwd: fixtureDir,
                env: {
                    ...process.env,
                    EVENT_LOG_PATH: eventLogPath,
                    GENERATED_MARKER_PATH: generatedMarkerPath,
                },
                encoding: 'utf8',
                ...(invocation.windowsVerbatimArguments
                    ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
                    : {}),
            });

            expect(result.status, result.stderr || result.stdout).toBe(0);
            expect(existsSync(generatedMarkerPath)).toBe(true);
            expect(readFileSync(eventLogPath, 'utf8').trim().split('\n')).toEqual([
                'workspace-build',
                'generate:start',
                'generate:done',
                'ts7',
            ]);
        } finally {
            rmSync(fixtureDir, { recursive: true, force: true });
        }
    });

    it('exports a strict production-only preflight while the broad developer lane still rejects test errors', () => {
        const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
        const packageJson = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')) as {
            devDependencies?: Record<string, string>;
            scripts?: Record<string, string>;
        };
        expect(packageJson.scripts?.['typecheck:runtime']).toBe(
            'yarn -s build:shared && yarn -s generate:providers && node ./scripts/runTypeScriptCli.mjs -p tsconfig.runtime.json --noEmit',
        );
        expect(packageJson.devDependencies?.['@types/node']).toBe('^22.15.3');

        const runtimeConfig = JSON.parse(readFileSync(join(serverDir, 'tsconfig.runtime.json'), 'utf8')) as {
            extends?: string;
            compilerOptions?: { strict?: boolean };
            include?: string[];
            exclude?: string[];
        };
        expect(runtimeConfig.extends).toBe('./tsconfig.json');
        expect(runtimeConfig.compilerOptions?.strict).not.toBe(false);

        const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-server-runtime-tsconfig-'));
        try {
            mkdirSync(join(fixtureDir, 'sources', 'testkit'), { recursive: true });
            writeFileSync(join(fixtureDir, 'sources', 'main.ts'), "import './runtime';\n", 'utf8');
            writeFileSync(join(fixtureDir, 'sources', 'runtime.ts'), 'export const runtime: string = "valid";\n', 'utf8');
            writeFileSync(
                join(fixtureDir, 'sources', 'testkit', 'runtimeHarness.ts'),
                'export const testOnly: string = 1;\n',
                'utf8',
            );
            writeFileSync(join(fixtureDir, 'tsconfig.runtime.json'), JSON.stringify({
                compilerOptions: {
                    strict: true,
                    noEmit: true,
                    target: 'ESNext',
                    module: 'ESNext',
                    moduleResolution: 'bundler',
                },
                include: runtimeConfig.include,
                exclude: runtimeConfig.exclude,
            }), 'utf8');
            writeFileSync(join(fixtureDir, 'tsconfig.json'), JSON.stringify({
                compilerOptions: {
                    strict: true,
                    noEmit: true,
                    target: 'ESNext',
                    module: 'ESNext',
                    moduleResolution: 'bundler',
                },
                include: ['sources/**/*.ts', 'sources/**/*.tsx'],
                exclude: ['node_modules'],
            }), 'utf8');

            const invocation = resolveTypeScriptCliInvocation({ processExecPath: process.execPath });
            const runCompiler = (config: string) => spawnSync(
                invocation.command,
                [...invocation.argsPrefix, '-p', config],
                { cwd: fixtureDir, encoding: 'utf8' },
            );

            const runtimeTypecheck = runCompiler('tsconfig.runtime.json');
            expect(runtimeTypecheck.status, runtimeTypecheck.stderr || runtimeTypecheck.stdout).toBe(0);

            const fullTypecheck = runCompiler('tsconfig.json');
            expect(fullTypecheck.status).not.toBe(0);
            expect(`${fullTypecheck.stdout}\n${fullTypecheck.stderr}`).toContain('runtimeHarness.ts');

            writeFileSync(join(fixtureDir, 'sources', 'runtime.ts'), 'export const runtime: string = 1;\n', 'utf8');
            const runtimeError = runCompiler('tsconfig.runtime.json');
            expect(runtimeError.status).not.toBe(0);
            expect(`${runtimeError.stdout}\n${runtimeError.stderr}`).toContain('runtime.ts');
        } finally {
            rmSync(fixtureDir, { recursive: true, force: true });
        }
    });

    it('typechecks the SQLite migration runtime through the native compiler owner', () => {
        const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
        const runtimeConfig = JSON.parse(readFileSync(join(serverDir, 'tsconfig.runtime.json'), 'utf8')) as {
            include?: string[];
        };
        expect(runtimeConfig.include).toContain('scripts/migrate.sqlite.deploy.ts');

        const invocation = resolveTypeScriptCliInvocation({ processExecPath: process.execPath });
        const result = spawnSync(
            invocation.command,
            [
                ...invocation.argsPrefix,
                '--project',
                './tsconfig.runtime.json',
                '--noEmit',
            ],
            { cwd: serverDir, encoding: 'utf8' },
        );

        expect(result.status, result.stderr || result.stdout).toBe(0);
    });
});
