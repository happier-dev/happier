import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const ALIAS_REQUIRE_ALLOWLIST = ['agents/providers/auggie/AuggieIndexingChip'];

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

export function installVitestRnShim(options: VitestRnShimOptions = {}): void {
    const globalState = globalThis as Record<string, unknown>;
    if (globalState[SHIM_INSTALLED_KEY] === true) return;
    globalState[SHIM_INSTALLED_KEY] = true;

    const traceFile = options.traceFile ?? process.env.VITEST_TRACE_LOAD ?? null;
    const nodeRequire = createRequire(import.meta.url);
    const sourcesDir = fileURLToPath(new URL('..', import.meta.url));
    const Module = nodeRequire('node:module') as NodeModuleWithLoader;
    const recentLoads: string[] = [];

    const resolveAlias = (request: string): string => resolve(sourcesDir, request.slice(2));
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
                if (request === '@react-native/virtualized-lists' || request.startsWith('@react-native/virtualized-lists/')) {
                    return reactNativeVirtualizedListsStub;
                }
                if (request === 'react-native-web' || request.startsWith('react-native-web/')) {
                    return reactNativeInternalProxy;
                }
                if (request.startsWith('@/')) {
                    return loadAlias(request);
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
