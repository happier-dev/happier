import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(path.join(uiRoot, 'package.json'));

/**
 * Use the app's Metro transform, including inlineRequires, without starting a stack.
 * @param {{ entryFile?: string, boundaryFiles?: Record<string, string>, boundaryModules?: Record<string, string>, realExpoRouter?: boolean, asyncRoutes?: boolean, lazy?: boolean, production?: boolean }} options
 */
export async function buildWorkspaceHistoryBrowser(options = {}) {
    // Compile outside the existing Vitest heap. Retire the compiler before
    // the browser suite retains its bundle and starts Chromium.
    const scratch = await mkdtemp(path.join(tmpdir(), 'happier-workspace-browser-'));
    const outputPath = path.join(scratch, 'bundle.js');
    try {
        const child = fork(fileURLToPath(import.meta.url), ['--metro-build'], {
            execArgv: [], stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
        });
        let errors = '';
        let childError;
        child.stderr.on('data', chunk => { errors += chunk; process.stderr.write(chunk); });
        await new Promise((resolve, reject) => {
            child.once('error', error => { childError = error; child.kill(); });
            child.once('close', (code, signal) => {
                if (childError) reject(childError);
                else if (code === 0) resolve();
                else reject(new Error(`Workspace history Metro compiler exited (${signal ?? code})${errors ? `\n${errors}` : ''}`));
            });
            child.send({ options, outputPath });
        });
        return await readFile(outputPath, 'utf8');
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}

if (process.argv[2] === '--metro-build') {
    let compilerScratch;
    // An interrupted Vitest worker drops its IPC transport. Metro's transform
    // threads belong to this process, so exiting also retires an active graph.
    // Do not await server.end(): it stalled during an active-graph disconnect.
    process.once('disconnect', async () => {
        try {
            // The caller cannot run its finally after its worker has died.
            if (compilerScratch) await rm(compilerScratch, { recursive: true, force: true });
        } catch (error) {
            process.stderr.write(`${error.stack ?? error}\n`);
        } finally { process.exit(1); }
    });
    process.once('message', async ({ options, outputPath }) => {
        compilerScratch = path.dirname(outputPath);
        try {
            // Unistyles disables its Babel visitor in test mode. Only this
            // compiler owns the actual app graph's transform environment.
            process.env.NODE_ENV = options.production ? 'production' : 'development';
            process.env.BABEL_ENV = process.env.NODE_ENV;
            const code = await buildDevelopmentBrowser(options);
            await writeFile(outputPath, code);
            process.exit(0);
        } catch (error) {
            process.stderr.write(`${error.stack ?? error}\n`);
            process.exit(1);
        }
    });
}

/** @param {{ entryFile?: string, boundaryFiles?: Record<string, string>, boundaryModules?: Record<string, string>, realExpoRouter?: boolean, asyncRoutes?: boolean, lazy?: boolean, production?: boolean }} options */
async function buildDevelopmentBrowser(options) {
    const sourceConfig = await require('metro').loadConfig({ cwd: uiRoot, config: path.join(uiRoot, 'metro.config.js') });
    // Each journey owns its network/router boundary; never retain a prior entry's resolver.
    const config = { ...sourceConfig, resolver: { ...sourceConfig.resolver },
        // Keep transform workers within the compiler's lifetime, including
        // owner disconnects while a full app graph is still being transformed.
        transformer: { ...sourceConfig.transformer, unstable_workerThreads: true },
        // Keep the previously observed test-mode transforms out of this source graph.
        cacheVersion: `${sourceConfig.cacheVersion ?? ''}:workspace-browser-${options.production ? 'production' : 'development'}`,
    };
    const originalResolve = config.resolver.resolveRequest;
    config.resolver.resolveRequest = (context, name, platform) => {
        const boundaryModule = options.boundaryModules?.[name];
        if (boundaryModule) return { type: 'sourceFile', filePath: path.join(uiRoot, boundaryModule) };
        if (name === 'expo-router' && !options.realExpoRouter) return { type: 'sourceFile', filePath: path.join(uiRoot, 'sources/dev/testkit/render/workspaceHistoryBrowserBoundary.tsx') };
        const resolved = originalResolve ? originalResolve(context, name, platform) : context.resolveRequest(context, name, platform);
        if (resolved.type === 'sourceFile') {
            const replacement = options.boundaryFiles?.[path.relative(uiRoot, resolved.filePath)];
            // A boundary adapter may delegate real internal logic from its target (for example
            // RPC dispatch ordering). Only that adapter's own import bypasses the substitution.
            if (replacement && context.originModulePath !== path.join(uiRoot, replacement)) {
                return { type: 'sourceFile', filePath: path.join(uiRoot, replacement) };
            }
        }
        if (!options.realExpoRouter && resolved.type === 'sourceFile' && resolved.filePath === path.join(uiRoot, 'sources/modal/index.ts')) {
            return { type: 'sourceFile', filePath: path.join(uiRoot, 'sources/dev/testkit/render/workspaceHistoryModalBoundary.tsx') };
        }
        return resolved;
    };
    config.maxWorkers = 2;
    let lastReported = 0;
    config.reporter = { update(event) {
        if (event.type === 'bundle_transform_progressed' && event.transformedFileCount - lastReported >= 1000) {
            lastReported = event.transformedFileCount;
            process.stdout.write(`Workspace history Metro: ${lastReported} modules transformed\n`);
        }
    } };
    const Server = require('metro/private/Server').default;
    const server = new Server(config, { watch: false });
    try {
        const result = await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
            onProgress: (transformedFileCount, totalFileCount) => config.reporter.update({
                type: 'bundle_transform_progressed', transformedFileCount, totalFileCount,
            }),
            entryFile: path.join(uiRoot, options.entryFile ?? 'sources/dev/testkit/render/workspaceHistoryBrowserApp.tsx'),
            // Other destinations' dynamic graphs are outside this journey.
            // The editor below is statically bundled but evaluated lazily.
            platform: 'web', dev: !options.production, minify: false, lazy: options.lazy ?? true,
            customTransformOptions: { engine: 'hermes', routerRoot: './sources/app', ...(options.asyncRoutes ? { asyncRoutes: true } : {}) },
        });
        process.stdout.write(`Workspace history Metro: ${result.code.length} bundle characters\n`);
        return result.code;
    } finally { await server.end(); }
}
