import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { observeFailure } from './manager.loadFailure.testkit';
import { mapDaemonModuleLoadErrorToDiagnostic } from './utils';

const execFileAsync = promisify(execFile);
const fixtures = [
    { name: 'missing module', source: "import 'happier-loaderreason-absent'; export function activate() {}", phase: 'resolve', code: 'ERR_MODULE_NOT_FOUND', retryable: true },
    { name: 'CommonJS missing module', source: "require('happier-loaderreason-absent'); exports.activate = () => {};", phase: 'resolve', code: 'MODULE_NOT_FOUND', retryable: true },
    { name: 'unexported package path', source: "import 'happier-loaderreason-private/internal'; export function activate() {}", phase: 'resolve', code: 'ERR_PACKAGE_PATH_NOT_EXPORTED', retryable: false },
    { name: 'missing export', source: "import { absent } from './dependency.mjs'; export function activate() { return absent; }", phase: 'evaluate', code: 'SyntaxError', retryable: false },
    { name: 'syntax error', source: 'export const = ;', phase: 'evaluate', code: 'SyntaxError', retryable: false },
    { name: 'TypeScript syntax error', source: 'export const = ;', phase: 'transpile', code: 'ParseError', retryable: false },
    { name: 'preparation syntax error', source: 'export const = ;', phase: 'evaluate', code: 'SyntaxError', retryable: false },
    { name: 'temporal dead zone', source: "import { present } from './dependency.mjs'; export const cycle = present; export function activate() {}", phase: 'evaluate', code: 'ReferenceError-in-TDZ', retryable: false },
    { name: 'missing activate export', source: 'export const version = 1;', phase: 'activate', code: 'PLUGIN_ACTIVATION_EXPORT_MISSING', retryable: false },
    { name: 'activation throw', source: "import { appendFileSync } from 'node:fs'; export function activate() { appendFileSync(new URL('./attempts', import.meta.url), 'x'); throw Object.assign(new Error('PRIVATE_PLUGIN_CONTENT'), { code: 'PRIVATE_PLUGIN_CONTENT' }); }", phase: 'activate', code: 'PLUGIN_ACTIVATION_THROW', retryable: false },
];

describe('plugin module failure publication in the native module host', () => {
    let sandbox: string;
    let loaderUrl: string;
    beforeAll(async () => {
        sandbox = await mkdtemp(join(tmpdir(), 'happier-loaderreason-native-'));
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
        await symlink(join(repoRoot, 'node_modules'), join(sandbox, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        const loaderPath = join(sandbox, 'loader.mjs');
        // Compile only the actual evaluator, keeping native imports native.
        // The host composition itself remains in the canonical source harness.
        await build({ entryPoints: [join(repoRoot, 'apps/cli/src/plugins/runtime/loadPluginModule.ts')],
            outfile: loaderPath, bundle: true, platform: 'node', format: 'esm',
            conditions: ['happier-source'], external: ['jiti'],
            tsconfig: join(repoRoot, 'apps/cli/tsconfig.json'),
        });
        loaderUrl = pathToFileURL(loaderPath).href;
    });
    afterAll(async () => {
        if (sandbox) await rm(sandbox, { recursive: true, force: true });
    });

    it.each(fixtures)('carries $name through activation, daemon introspection and engine resolution', async (fixture) => {
        const childLifetime = new AbortController();
        onTestFinished(() => childLifetime.abort());
        const root = join(sandbox, fixture.name.replaceAll(' ', '-'));
        await mkdir(root);
        const entryPath = join(root, fixture.name === 'TypeScript syntax error'
            ? 'daemon.ts' : fixture.name === 'CommonJS missing module' ? 'daemon.cjs' : 'daemon.mjs');
        await writeFile(entryPath, fixture.source);
        await writeFile(join(root, 'dependency.mjs'), fixture.name === 'temporal dead zone'
            ? "import { cycle } from './daemon.mjs'; export const present = cycle;" : 'export const present = 1;');
        if (fixture.name === 'unexported package path') {
            const dependencyRoot = join(root, 'node_modules/happier-loaderreason-private');
            await mkdir(dependencyRoot, { recursive: true });
            await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({ name: 'happier-loaderreason-private', type: 'module', exports: {} }));
        }
        if (fixture.name === 'activation throw') await appendFile(join(root, 'staging.ts'), fixture.source);
        const nativeEntryPath = join(root, 'native.cjs.bundle');
        await writeFile(nativeEntryPath, `module.exports = require(${JSON.stringify(entryPath)});`);
        const observed = await observeFailure({ root, entryPath, nativeEntryPath, name: fixture.name });
        const expected = { cause: { phase: fixture.phase, code: fixture.code, retryable: fixture.retryable } };
        expect(observed).toMatchObject({
            diagnostic: { details: expected }, parsedDiagnostic: { details: expected },
            publicDiagnostic: { data: { details: expected } }, engineDiagnostic: { details: expected },
        });
        if (!observed || typeof observed !== 'object' || !('diagnostic' in observed)) throw new Error('Missing observed diagnostic');
        const diagnostic = observed.diagnostic;
        if (!diagnostic || typeof diagnostic !== 'object' || !('details' in diagnostic)) throw new Error('Missing diagnostic cause');
        expect(JSON.stringify(diagnostic.details)).not.toContain('PRIVATE_PLUGIN_CONTENT');
        expect(JSON.stringify(diagnostic.details)).not.toContain(root);
        if (fixture.name === 'missing module' || fixture.name === 'CommonJS missing module') {
            expect(observed).toMatchObject({ diagnostic: { details: { cause: { specifier: 'happier-loaderreason-absent' } } } });
        }
        if (fixture.name === 'missing export') expect(observed).toMatchObject({ diagnostic: { details: { cause: { reason: 'missing_export' } } } });
        if (fixture.name === 'CommonJS missing module') expect(observed).toMatchObject({ producerFailure: {
            code: 'PLUGIN_DAEMON_MODULE_LOAD_FAILED', details: expected,
        } });
        if (fixture.name === 'activation throw' || fixture.name === 'preparation syntax error') {
            expect(observed).toMatchObject({ attemptsAfterDemand: 'x' });
        }
        if (fixture.name === 'activation throw') expect(observed).toMatchObject({ stagingDiagnostic: { code: 'plugin_activation_failed', details: expected } });
        if (fixture.name === 'missing module') expect(observed).toMatchObject({
            changeResult: { code: 'plugin_daemon_module_load_failed', details: expected },
            userFailure: { code: 'plugin_daemon_module_load_failed', details: expected },
            developmentControl: { kind: 'failed', code: 'plugin_daemon_module_load_failed', details: expected,
                status: { plugins: [{ diagnostic: { details: expected } }] },
            },
        });
        if (['missing module', 'unexported package path', 'missing export', 'syntax error', 'temporal dead zone'].includes(fixture.name)) {
            const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', [
                'const { loadPluginModule } = await import(process.argv[1]);',
                'const entryPath = process.argv[2];',
                'try { await loadPluginModule({ source: { kind: "file_backed", entryPath, committedAuthorization: { pluginId: "acme.loaderreason", immutableGenerationId: entryPath } } }); throw new Error("Expected failure"); }',
                'catch (error) { console.log(JSON.stringify({ code: error.code, details: error.details })); }',
            ].join('\n'), loaderUrl, entryPath], { signal: childLifetime.signal });
            const packet: unknown = JSON.parse(stdout.trim());
            expect(packet).toMatchObject({ code: 'PLUGIN_DAEMON_MODULE_LOAD_FAILED', details: expected });
            expect(mapDaemonModuleLoadErrorToDiagnostic(packet)).toMatchObject({ details: expected });
        }
    });
});
