import { access } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PluginDaemonModuleNamespace } from './types';

const daemonModuleLoadCache = new Map<string, Promise<PluginDaemonModuleNamespace>>();
const SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function createDaemonModuleLoadError(
    code: 'PLUGIN_DAEMON_ENTRY_MISSING' | 'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED' | 'PLUGIN_DAEMON_MODULE_LOAD_FAILED',
    message: string,
    cause?: unknown,
): Error & Readonly<{ code: string; cause?: unknown }> {
    const error = new Error(message) as Error & Readonly<{ code: string; cause?: unknown }>;
    Object.defineProperty(error, 'code', {
        value: code,
        enumerable: true,
    });
    if (cause !== undefined) {
        Object.defineProperty(error, 'cause', {
            value: cause,
            enumerable: false,
        });
    }
    return error;
}

export async function loadPluginDaemonModule(params: Readonly<{
    daemonEntryPath: string;
}>): Promise<PluginDaemonModuleNamespace> {
    const resolvedEntryPath = resolve(params.daemonEntryPath);
    const extension = extname(resolvedEntryPath).toLowerCase();
    if (!SUPPORTED_PLUGIN_DAEMON_ENTRY_EXTENSIONS.has(extension)) {
        throw createDaemonModuleLoadError(
            'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED',
            `Unsupported plugin daemon entry extension '${extension || '<none>'}' for '${resolvedEntryPath}'`,
        );
    }

    try {
        await access(resolvedEntryPath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'ENOENT') {
            throw createDaemonModuleLoadError(
                'PLUGIN_DAEMON_ENTRY_MISSING',
                `Plugin daemon entry does not exist: ${resolvedEntryPath}`,
                error,
            );
        }
        throw error;
    }

    const cached = daemonModuleLoadCache.get(resolvedEntryPath);
    if (cached) {
        return await cached;
    }

    const modulePromise = import(pathToFileURL(resolvedEntryPath).href) as Promise<PluginDaemonModuleNamespace>;
    daemonModuleLoadCache.set(resolvedEntryPath, modulePromise);

    try {
        return await modulePromise;
    } catch (error) {
        daemonModuleLoadCache.delete(resolvedEntryPath);
        throw createDaemonModuleLoadError(
            'PLUGIN_DAEMON_MODULE_LOAD_FAILED',
            `Failed to load plugin daemon entry '${resolvedEntryPath}': ${error instanceof Error ? error.message : 'unknown error'}`,
            error,
        );
    }
}
