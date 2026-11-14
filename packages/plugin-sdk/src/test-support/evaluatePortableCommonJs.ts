import { runInThisContext } from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS } from '@happier-dev/protocol/plugins/ui';
import { readWorkspacePackages, resolveWorkspaceSource } from '../../../cli-common/sourceRuntimeEntries.mjs';
import * as Zod from 'zod';
import * as ZodMini from 'zod/mini';
import { PLUGIN_UI_HOST_PROVIDED_PROTOCOL_MODULES } from '@happier-dev/protocol/plugins/ui/hostProvidedProtocolModules.generated';

type PortableModule = { exports: Record<string, unknown> };
type RequireHost = (specifier: string) => unknown;

// The source harness supplies the same real portable schema modules as the app.
const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../..'));
const hostSchemaModules: Readonly<Record<string, unknown>> = {
    ...PLUGIN_UI_HOST_PROVIDED_PROTOCOL_MODULES,
    ...Object.fromEntries(await Promise.all(PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS
        .filter(specifier => specifier.startsWith('@happier-dev/plugin-sdk'))
        .map(async specifier => [specifier, await import(pathToFileURL(resolveWorkspaceSource(packages, specifier,
            { conditions: ['react-native', 'browser'] })).href)]))),
    zod: Zod,
    'zod/mini': ZodMini,
    'zod/v4/core': await import('zod/v4/core'),
    'zod/v4/locales/en.js': await import('zod/v4/locales/en.js'),
};

/** Portable UI/Account modules execute in the host realm, with host framework imports. */
export function evaluatePortableCommonJs(
    source: string,
    module: PortableModule,
    requireHost: RequireHost = (specifier) => {
        throw new Error(`Unexpected host import: ${specifier}`);
    },
): void {
    const evaluate = runInThisContext(`(function(module, exports, require) { ${source}\n})`) as (
        module: PortableModule,
        exports: PortableModule['exports'],
        requireHost: RequireHost,
    ) => void;
    evaluate(module, module.exports, (specifier) => Object.hasOwn(hostSchemaModules, specifier)
        ? hostSchemaModules[specifier] : requireHost(specifier));
}
