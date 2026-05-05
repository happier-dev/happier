import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { PluginApiV1 } from '../api';
import type { RegisterBackendEngineV1 } from '../engine';
import type { AcpBackendSpecV1 } from './types';

type AcpModuleNamespace = Readonly<{
    ACP_BACKEND_DEFINITION?: AcpBackendSpecV1;
}>;

export type AutoRegisterAcpBackendOptionsV1 = Readonly<{
    importModule?: (modulePath: string) => Promise<AcpModuleNamespace>;
    moduleExists?: (modulePath: string) => boolean;
    resolveModulePath?: (pluginPath: string) => string;
}>;

function defaultAcpModulePath(pluginPath: string): string {
    return `${pluginPath.replace(/\/+$/, '')}/agent/acp.js`;
}

export async function autoRegisterAcpBackend(
    pluginPath: string,
    api: Pick<PluginApiV1, 'registerBackendEngine'>,
    options?: AutoRegisterAcpBackendOptionsV1,
): Promise<boolean> {
    const modulePath = options?.resolveModulePath?.(pluginPath) ?? defaultAcpModulePath(pluginPath);
    const moduleExists = options?.moduleExists ?? existsSync;
    if (!moduleExists(modulePath)) {
        return false;
    }
    const importModule = options?.importModule ?? (async (path) => await import(/* @vite-ignore */ pathToFileURL(path).href) as AcpModuleNamespace);
    const namespace = await importModule(modulePath);

    const spec = namespace.ACP_BACKEND_DEFINITION;
    if (!spec) {
        return false;
    }

    const registration: RegisterBackendEngineV1 = {
        backendId: spec.backendId,
        create: (ctx) => ctx.acp.defineAcpBackend(spec),
    };
    api.registerBackendEngine(registration);
    return true;
}
