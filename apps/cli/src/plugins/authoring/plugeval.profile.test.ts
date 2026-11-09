import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from 'node:inspector';
import { afterAll, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({
    transforms: [] as { filename: string; bytes: number; ms: number }[],
    disposable: '',
    jitiPath: '',
    transformCache: '',
}));

// Measurement-only dependency redirect. Production retains its installed Jiti.
vi.mock('jiti', async (importOriginal) => {
    const installed = await importOriginal<typeof import('jiti')>();
    const { createRequire: requireFrom } = await import('node:module');
    const require = requireFrom(import.meta.url);
    if (process.env.PLUGEVAL_PROFILE === '1') {
        const { mkdtempSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { tmpdir } = await import('node:os');
        observed.transformCache = mkdtempSync(join(process.env.PLUGEVAL_CACHE_PARENT ?? tmpdir(), 'happier-plugeval-profile-cache-'));
    }
    let redirected = process.env.PLUGEVAL_JITI_PATH;
    if (process.env.PLUGEVAL_PATCH === '1') {
        const { cpSync, mkdtempSync } = await import('node:fs');
        const { dirname, join } = await import('node:path');
        const { tmpdir } = await import('node:os');
        const { fileURLToPath } = await import('node:url');
        const { execFileSync } = await import('node:child_process');
        observed.disposable = mkdtempSync(join(tmpdir(), 'happier-plugeval-r2-jiti-'));
        cpSync(dirname(dirname(require.resolve('jiti'))), observed.disposable, { recursive: true, dereference: true });
        const patch = fileURLToPath(new URL('../../../../../.project/plans/plugin-platform-simplification/seams-2026-10-12/lanes/PLUGRELOAD-staged/jiti@2.7.0.patch', import.meta.url));
        execFileSync('git', ['-C', observed.disposable, 'apply', '--check', patch]);
        execFileSync('git', ['-C', observed.disposable, 'apply', patch]);
        redirected = join(observed.disposable, 'lib/jiti.cjs');
    }
    observed.jitiPath = redirected ?? require.resolve('jiti');
    const actual: typeof installed = redirected
        ? require(redirected)
        : installed;
    return {
        ...actual,
        createJiti: ((id, options = {}) => {
            const measuredOptions = { ...options,
                ...(observed.transformCache ? { fsCache: observed.transformCache } : {}),
            };
            const transform = actual.createJiti(id, measuredOptions).options.transform!;
            const loader = actual.createJiti(id, {
                ...measuredOptions,
                transform(input) {
                    const start = performance.now();
                    try { return transform(input); }
                    finally {
                        observed.transforms.push({
                            filename: input.filename ?? '<unknown>',
                            bytes: Buffer.byteLength(input.source),
                            ms: performance.now() - start,
                        });
                    }
                },
            });
            // Disposable A/B isolates PLUGRELOAD's transform-count change.
            if (process.env.PLUGEVAL_FORCE_OFF === '1') Reflect.deleteProperty(loader.options, 'forceTranspile');
            return loader;
        }) satisfies typeof installed.createJiti,
    };
});

import { createPluginTypeScriptCandidateScope, loadVerifiedPluginModule } from '../runtime/loadPluginModule';
import { resolvePluginAuthorWorkspaceAliases } from './hostSdkResolution';
import { resolvePluginAuthorTypeScriptConfigBoundary } from './typescriptConfigBoundary';
import { projectPluginAuthorModule, resolvePluginAuthorSourceEntrypoint } from './sourceModule';

afterAll(async () => {
    if (observed.disposable) await rm(observed.disposable, { recursive: true, force: true });
    if (observed.transformCache) await rm(observed.transformCache, { recursive: true, force: true });
});

it.skipIf(process.env.PLUGEVAL_PROFILE === '1')('resolves a cold candidate without constructing unlimited-stack probe errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugeval-r2-cost-'));
    let unlimitedCaptures = 0;
    let missingJsStats = 0;
    const stat = fs.statSync;
    fs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
        if (args[0] === join(root, 'src/child.js')) missingJsStats += 1;
        return Reflect.apply(stat, fs, args);
    }) as typeof fs.statSync;
    const capture = Error.captureStackTrace;
    const spy = vi.spyOn(Error, 'captureStackTrace').mockImplementation((...args) => {
        if (Error.stackTraceLimit === Infinity) unlimitedCaptures += 1;
        return capture(...args);
    });
    try {
        await mkdir(join(root, 'src'));
        await writeFile(join(root, 'src/index.ts'), 'export { value } from "./child.js"; export { other } from "./extensionless";');
        await writeFile(join(root, 'src/child.ts'), 'export const value: number = 42;');
        await writeFile(join(root, 'src/extensionless.ts'), 'export const other: number = 7;');
        const namespace = await loadVerifiedPluginModule({
            entryPath: join(root, 'src/index.ts'), loadMode: 'source-ts',
            generationScope: await createPluginTypeScriptCandidateScope({ rootPath: root }),
        });
        expect(namespace.value).toBe(42);
        expect(namespace.other).toBe(7);
        console.info('PLUGEVAL cost', JSON.stringify({ unlimitedCaptures, missingJsStats }));
        // Expected RED until the staged Jiti patch is installed; no it.fails mask.
        expect(missingJsStats).toBe(1);
        expect(unlimitedCaptures).toBe(0);
    } finally {
        spy.mockRestore();
        fs.statSync = stat;
        await rm(root, { recursive: true, force: true });
    }
});

// Opt-in measurement: select exactly one candidate per command for process-cold evidence.
it.runIf(process.env.PLUGEVAL_PROFILE === '1').each(['channels', 'channel-email'])('profiles cold and warm %s candidate stages', async (name) => {
    const root = fileURLToPath(new URL(`../../../../../packages/plugins/${name}/`, import.meta.url));
    console.info('PLUGEVAL identity', JSON.stringify({ node: process.version, pid: process.pid,
        jiti: observed.jitiPath, forceOff: process.env.PLUGEVAL_FORCE_OFF }));
    const session = process.env.PLUGEVAL_CPU === '1' ? new Session() : undefined;
    const post = (method: string): Promise<unknown> => new Promise((resolve, reject) => {
        session!.post(method, (error, result) => error ? reject(error) : resolve(result));
    });
    if (session) { session.connect(); await post('Profiler.enable'); await post('Profiler.start'); }
    const projectionFailures: unknown[] = [];
    try {
        for (const revision of [1, 2]) {
            observed.transforms = [];
            let stats = 0, unlimitedCaptures = 0;
            const stat = fs.statSync;
            const capture = Error.captureStackTrace;
            fs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
                stats += 1;
                return Reflect.apply(stat, fs, args);
            }) as typeof fs.statSync;
            Error.captureStackTrace = (...args) => {
                if (Error.stackTraceLimit === Infinity) unlimitedCaptures += 1;
                return capture(...args);
            };
            const start = performance.now();
            const cpuStart = process.cpuUsage();
            let lastTick = start, maxLagMs = 0;
            const heartbeat = setInterval(() => {
                const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - lastTick); lastTick = now;
            }, 10);
            try {
                const configStart = performance.now();
                const entry = await resolvePluginAuthorSourceEntrypoint(root);
                const config = await resolvePluginAuthorTypeScriptConfigBoundary({ packageRootPath: entry.packageRoot, entryPath: entry.entryPath });
                const configMs = performance.now() - configStart;
                const aliasStart = performance.now();
                const aliases = await resolvePluginAuthorWorkspaceAliases(root, config.aliases);
                const aliasesMs = performance.now() - aliasStart;
                const scopeStart = performance.now();
                const scope = await createPluginTypeScriptCandidateScope({ rootPath: root, aliases });
                const scopeMs = performance.now() - scopeStart;
                const loadStart = performance.now();
                const namespace = await loadVerifiedPluginModule({ entryPath: entry.entryPath, loadMode: 'source-ts', generationScope: scope });
                const loadMs = performance.now() - loadStart;
                const projectionStart = performance.now();
                let projected: ReturnType<typeof projectPluginAuthorModule> | undefined;
                let projectionError: string | undefined;
                try { projected = projectPluginAuthorModule(namespace); }
                catch (error) {
                    projectionFailures.push(error);
                    projectionError = error instanceof Error ? error.message : String(error);
                }
                const projectionMs = performance.now() - projectionStart;
                expect(projected?.manifest ?? namespace.manifest)
                    .toMatchObject({ id: name === 'channels' ? 'happier.channels' : 'happier.channel.email' });
                maxLagMs = Math.max(maxLagMs, performance.now() - lastTick);
                const packages: Record<string, { count: number; bytes: number; ms: number }> = {};
                for (const item of observed.transforms) {
                    const key = item.filename.split('/packages/')[1]?.split('/src/')[0] ?? 'external';
                    const group = packages[key] ??= { count: 0, bytes: 0, ms: 0 };
                    group.count += 1; group.bytes += item.bytes; group.ms += item.ms;
                }
                console.info('PLUGEVAL profile', JSON.stringify({ name, revision, wallMs: performance.now() - start,
                    cpu: process.cpuUsage(cpuStart), configMs, aliasesMs, aliases: Object.keys(aliases).length,
                    scopeMs, loadMs, projectionMs, projectionError, maxLagMs, transforms: observed.transforms.length, stats, unlimitedCaptures, packages }));
            } finally {
                clearInterval(heartbeat); fs.statSync = stat; Error.captureStackTrace = capture;
            }
        }
    } finally {
        if (session) {
            const result = await post('Profiler.stop');
            if (process.env.PLUGEVAL_CPU_OUTPUT) await writeFile(process.env.PLUGEVAL_CPU_OUTPUT, JSON.stringify(result));
            session.disconnect();
        }
    }
    if (projectionFailures.length) throw projectionFailures[0];
}, 240_000);
