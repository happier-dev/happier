import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(path.join(uiRoot, 'package.json'));

/**
 * Use the app's Metro transform, including inlineRequires, without starting a stack.
 * @param {{ entryFile?: string, boundaryFiles?: Record<string, string>, boundaryModules?: Record<string, string>, realExpoRouter?: boolean, asyncRoutes?: boolean, lazy?: boolean, production?: boolean }} options
 */
export async function buildWorkspaceHistoryBrowser(options = {}) {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBabelEnv = process.env.BABEL_ENV;
    // Unistyles deliberately disables its Babel visitor in test mode. Build the
    // actual app graph, not an unstyled Vitest transform.
    process.env.NODE_ENV = options.production ? 'production' : 'development';
    process.env.BABEL_ENV = process.env.NODE_ENV;
    try {
        return await buildDevelopmentBrowser(options);
    } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        if (previousBabelEnv === undefined) delete process.env.BABEL_ENV;
        else process.env.BABEL_ENV = previousBabelEnv;
    }
}

/** @param {{ entryFile?: string, boundaryFiles?: Record<string, string>, boundaryModules?: Record<string, string>, realExpoRouter?: boolean, asyncRoutes?: boolean, lazy?: boolean, production?: boolean }} options */
async function buildDevelopmentBrowser(options) {
    const sourceConfig = require(path.join(uiRoot, 'metro.config.js'));
    // Each journey owns its network/router boundary; never retain a prior entry's resolver.
    const config = { ...sourceConfig, resolver: { ...sourceConfig.resolver },
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
            if (replacement) return { type: 'sourceFile', filePath: path.join(uiRoot, replacement) };
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
