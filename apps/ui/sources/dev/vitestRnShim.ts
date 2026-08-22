import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import expoConstantsStub from './expoConstantsStub';
import expoModulesCoreStub from './expoModulesCoreStub';
import * as expoNotificationsStub from './expoNotificationsStub';
import * as expoTaskManagerStub from './expoTaskManagerStub';
import * as posthogReactNativeStub from './posthogReactNativeStub';
import * as reactNativeRootStub from './reactNativeStub';
import reactNativeInternalProxy from './reactNativeInternalStub';
import reactNativeVirtualizedListsStub from './reactNativeVirtualizedListsStub';

type NodeModuleWithLoader = {
    _load?: (...args: unknown[]) => unknown;
    _extensions?: Record<string, (mod: { exports: unknown }, filename: string) => void>;
};

export type VitestRnShimOptions = Readonly<{
    traceFile?: string | null;
}>;

const SHIM_INSTALLED_KEY = '__HAPPIER_VITEST_RN_SHIM_INSTALLED__';
const ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ttf', '.otf']);
const ALIAS_REQUIRE_ALLOWLIST: readonly string[] = [];

function hasAssetExtension(path: string): boolean {
    for (const ext of ASSET_EXTENSIONS) {
        if (path.toLowerCase().endsWith(ext)) return true;
    }
    return false;
}

function isAllowedAliasRequire(aliasPath: string): boolean {
    if (hasAssetExtension(aliasPath)) return true;
    return ALIAS_REQUIRE_ALLOWLIST.some((prefix) => aliasPath.startsWith(prefix));
}

function isPathInsideDirectory(filePath: string, directoryPath: string): boolean {
    const relativePath = relative(directoryPath, filePath);
    return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function readParentModuleFilename(parent: unknown): string | null {
    const filename = (parent as { filename?: unknown } | null | undefined)?.filename;
    return typeof filename === 'string' && filename.length > 0 ? filename : null;
}

export function installVitestRnShim(options: VitestRnShimOptions = {}): void {
    const globalState = globalThis as Record<string, unknown>;
    if (globalState[SHIM_INSTALLED_KEY] === true) return;
    globalState[SHIM_INSTALLED_KEY] = true;

    const traceFile = options.traceFile ?? process.env.VITEST_TRACE_LOAD ?? null;
    const nodeRequire = createRequire(import.meta.url);
    const sourcesDir = (() => {
        try {
            const url = new URL('..', import.meta.url);
            if (url.protocol === 'file:') return fileURLToPath(url);
        } catch {
            // ignore
        }
        // Some Vitest environments (for example jsdom) can evaluate modules with non-file URLs.
        // Fall back to the UI workspace root.
        return resolve(process.cwd(), 'sources');
    })();
    const Module = nodeRequire('node:module') as NodeModuleWithLoader;
    const recentLoads: string[] = [];

    const resolveAlias = (request: string): string => resolve(sourcesDir, request.slice(2));
    /**
     * A relative `require()` whose caller AND target both live in this package's `sources/`.
     *
     * Vite-node injects `require: createRequire(<module href>)` into every module it
     * transforms, so such a require is Node's own CJS loader: it loads a second copy of the
     * target outside the Vitest module graph, where `vi.mock` does not apply and the
     * React Native / Expo / workspace aliases configured for the test run do not exist.
     * Data files (assets, JSON) carry no module-graph semantics and stay allowed.
     */
    const resolveFirstPartySourceRequire = (
        request: string,
        parent: unknown,
    ): Readonly<{ target: string; importer: string }> | null => {
        if (!request.startsWith('./') && !request.startsWith('../')) return null;
        if (hasAssetExtension(request) || request.toLowerCase().endsWith('.json')) return null;
        const importer = readParentModuleFilename(parent);
        if (!importer || !isPathInsideDirectory(importer, sourcesDir)) return null;
        const target = resolve(dirname(importer), request);
        if (!isPathInsideDirectory(target, sourcesDir)) return null;
        return { target, importer };
    };
    const loadAlias = (request: string): unknown => {
        const aliasPath = request.slice(2);
        if (!isAllowedAliasRequire(aliasPath)) {
            throw new Error(
                `[vitestRnShim] Unsupported alias require("${request}") in Node test runtime. ` +
                'Only asset paths and explicitly allowlisted modules are supported.',
            );
        }
        return nodeRequire(resolveAlias(request));
    };

    if (Module._load) {
        const originalLoad = Module._load;
        Module._load = function patchedLoad(...args: unknown[]): unknown {
            const request = args[0];
            if (typeof request === 'string') {
                if (traceFile) {
                    recentLoads.push(request);
                    if (recentLoads.length > 250) recentLoads.shift();
                }

                if (request === 'react-native') return reactNativeRootStub;
                if (request.startsWith('react-native/')) return reactNativeInternalProxy;
                if (request === 'expo-constants' || request.startsWith('expo-constants/')) return expoConstantsStub;
                if (request === 'expo-modules-core' || request.startsWith('expo-modules-core/')) return expoModulesCoreStub;
                if (request === 'expo-notifications') return expoNotificationsStub;
                if (request === 'expo-task-manager') return expoTaskManagerStub;
                if (request === 'posthog-react-native' || request.startsWith('posthog-react-native/')) {
                    return posthogReactNativeStub;
                }
                if (request === '@react-native/virtualized-lists' || request.startsWith('@react-native/virtualized-lists/')) {
                    return reactNativeVirtualizedListsStub;
                }
                if (request === 'react-native-web' || request.startsWith('react-native-web/')) {
                    return reactNativeInternalProxy;
                }
                if (request.startsWith('@/')) {
                    return loadAlias(request);
                }

                const firstPartyRequire = resolveFirstPartySourceRequire(request, args[1]);
                if (firstPartyRequire) {
                    try {
                        return originalLoad.apply(this, args as []);
                    } catch (cause) {
                        throw new Error(
                            `[vitestRnShim] require("${request}") from ${firstPartyRequire.importer} `
                            + `loaded ${firstPartyRequire.target} through Node's loader instead of the `
                            + 'Vitest module graph, so its React Native / Expo / workspace imports bypass '
                            + 'this run\'s aliases and stubs. Inject the dependency through the caller seam, '
                            + 'or mock the module that owns this lazy require, instead of relying on the '
                            + `bundler-only require. Underlying loader error: ${String(
                                (cause as { message?: unknown } | null)?.message ?? cause,
                            )}`,
                            { cause },
                        );
                    }
                }
            }

            return originalLoad.apply(this, args as []);
        };
    }

    if (Module._extensions) {
        for (const ext of ASSET_EXTENSIONS) {
            if (!Module._extensions[ext]) {
                Module._extensions[ext] = (mod, filename) => {
                    mod.exports = filename;
                };
            }
        }
    }

    (globalThis as Record<string, unknown>).require = (id: string): unknown => {
        if (id.startsWith('@/')) {
            return loadAlias(id);
        }
        return nodeRequire(id);
    };

    if (traceFile) {
        const flush = (suffix: string) => {
            try {
                writeFileSync(traceFile, [...recentLoads, suffix].join('\n'));
            } catch {
                // best effort only
            }
        };

        process.once('exit', () => flush('[exit]'));
        process.once('uncaughtException', (err) => {
            flush(`[uncaughtException] ${String((err as Error)?.stack ?? err)}`);
        });
        process.once('unhandledRejection', (err) => {
            flush(`[unhandledRejection] ${String((err as Error)?.stack ?? err)}`);
        });
    }
}
