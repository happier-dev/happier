import { readFile } from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFunction } from 'node:vm';

import * as Sdk from '@happier-dev/plugin-sdk';
import * as Actions from '@happier-dev/plugin-sdk/actions';
import * as Agents from '@happier-dev/plugin-sdk/agents';
import * as Async from '@happier-dev/plugin-sdk/async';
import * as Automations from '@happier-dev/plugin-sdk/automations';
import * as Collections from '@happier-dev/plugin-sdk/collections';
import * as ConnectedAccounts from '@happier-dev/plugin-sdk/connected-accounts';
import * as Contributions from '@happier-dev/plugin-sdk/contributions';
import * as Errors from '@happier-dev/plugin-sdk/errors';
import * as Events from '@happier-dev/plugin-sdk/events';
import * as Manifest from '@happier-dev/plugin-sdk/manifest';
import * as MachineProvisioners from '@happier-dev/plugin-sdk/machine-provisioners';
import * as Protocol from '@happier-dev/plugin-sdk/protocol';
import * as Reviews from '@happier-dev/plugin-sdk/reviews';
import * as Scm from '@happier-dev/plugin-sdk/scm';
import * as ScmHosting from '@happier-dev/plugin-sdk/scm/hosting';
import * as Sessions from '@happier-dev/plugin-sdk/sessions';
import * as Storage from '@happier-dev/plugin-sdk/storage';
import * as Ui from '@happier-dev/plugin-sdk/ui';
import * as UiClient from '@happier-dev/plugin-sdk/ui/client';
import * as Webhooks from '@happier-dev/plugin-sdk/webhooks';
import * as Zod from 'zod';
import * as ZodMini from 'zod/mini';
import * as ZodCore from 'zod/v4/core';
import * as EnglishLocale from 'zod/v4/locales/en.js';
import * as HappierProtocol from '@happier-dev/protocol';
import {
    HAS_BUNDLED_PROTOCOL_MODULE_REQUIRE,
    PLUGIN_UI_HOST_PROVIDED_PROTOCOL_MODULE_LOADERS,
} from '@happier-dev/protocol/plugins/ui/hostProvidedProtocolModuleLoaders.generated';
import type { PluginUiHostRuntimeExternalSpecifierV1 } from '@happier-dev/protocol/plugins/ui';

import type { PluginModuleNamespace } from './loadPluginModule';

type PortableHostSpecifier = Extract<PluginUiHostRuntimeExternalSpecifierV1,
    '@happier-dev/plugin-sdk' | `@happier-dev/plugin-sdk/${string}` | '@happier-dev/protocol' | 'zod' | `zod/${string}`>;

// Static namespaces keep these bindings visible to native payload bundlers.
// This module is imported only when a portable executable is actually loaded.
const hostNamespaces = {
    '@happier-dev/plugin-sdk': Sdk,
    '@happier-dev/plugin-sdk/actions': Actions,
    '@happier-dev/plugin-sdk/agents': Agents,
    '@happier-dev/plugin-sdk/async': Async,
    '@happier-dev/plugin-sdk/automations': Automations,
    '@happier-dev/plugin-sdk/collections': Collections,
    '@happier-dev/plugin-sdk/connected-accounts': ConnectedAccounts,
    '@happier-dev/plugin-sdk/contributions': Contributions,
    '@happier-dev/plugin-sdk/errors': Errors,
    '@happier-dev/plugin-sdk/events': Events,
    '@happier-dev/plugin-sdk/manifest': Manifest,
    '@happier-dev/plugin-sdk/machine-provisioners': MachineProvisioners,
    '@happier-dev/plugin-sdk/protocol': Protocol,
    '@happier-dev/plugin-sdk/reviews': Reviews,
    '@happier-dev/plugin-sdk/scm': Scm,
    '@happier-dev/plugin-sdk/scm/hosting': ScmHosting,
    '@happier-dev/plugin-sdk/sessions': Sessions,
    '@happier-dev/plugin-sdk/storage': Storage,
    '@happier-dev/plugin-sdk/ui': Ui,
    '@happier-dev/plugin-sdk/ui/client': UiClient,
    '@happier-dev/plugin-sdk/webhooks': Webhooks,
    zod: Zod,
    'zod/mini': ZodMini,
    'zod/v4/core': ZodCore,
    'zod/v4/locales/en.js': EnglishLocale,
    '@happier-dev/protocol': HappierProtocol,
} satisfies Record<PortableHostSpecifier, unknown>;

// The compiler emits ESM-to-CommonJS interop wrappers. Mark namespace values
// as ESM so their existing default exports are not wrapped a second time.
// Protocol subpaths are the same generated set every Plugin UI host provides;
// the CLI already holds these module instances for its own Protocol imports.
const hostModules: Record<string, unknown> = Object.fromEntries(
    Object.entries(hostNamespaces)
        .map(([specifier, namespace]) => [specifier, { __esModule: true, ...(namespace as object) }]));
const requireFromHost = HAS_BUNDLED_PROTOCOL_MODULE_REQUIRE ? undefined : createRequire(import.meta.url);
const authoredProtocolTablePath = requireFromHost?.resolve('@happier-dev/protocol/plugins/ui/hostProvidedProtocolModules.generated');
const loadProtocolModule = requireFromHost
    ?? ((specifier: string): unknown => PLUGIN_UI_HOST_PROVIDED_PROTOCOL_MODULE_LOADERS[specifier]());

function isProtocolSpecifier(specifier: string): boolean {
    return specifier === '@happier-dev/protocol' || specifier.startsWith('@happier-dev/protocol/');
}

export async function loadPortableCommonJsModule(entryPath: string): Promise<PluginModuleNamespace> {
    // The development TS loader can transpile require(TS) as a second copy of
    // an imported ESM module. Borrow the authored ESM namespaces on that path.
    const authoredProtocolModules = authoredProtocolTablePath?.endsWith('.ts')
        ? ((await import(pathToFileURL(authoredProtocolTablePath).href)) as typeof import('@happier-dev/protocol/plugins/ui/hostProvidedProtocolModules.generated')).PLUGIN_UI_HOST_PROVIDED_PROTOCOL_MODULES
        : undefined;
    const nativeRequire = createRequire(entryPath);
    const pluginModule = new Module(entryPath);
    pluginModule.filename = entryPath;
    pluginModule.paths = nativeRequire.resolve.paths('@happier-dev/plugin-sdk') ?? [];
    const pluginRequire = Object.assign((specifier: string): unknown => {
        if (Object.hasOwn(hostModules, specifier)) return hostModules[specifier];
        if (Object.hasOwn(PLUGIN_UI_HOST_PROVIDED_PROTOCOL_MODULE_LOADERS, specifier)) {
            const namespace = authoredProtocolModules ? authoredProtocolModules[specifier] : loadProtocolModule(specifier);
            const hostModule = { __esModule: true, ...(namespace as object) };
            hostModules[specifier] = hostModule;
            return hostModule;
        }
        // Never fall through to another Protocol copy beside the artifact.
        if (isProtocolSpecifier(specifier)) {
            throw Object.assign(new Error(`Plugin artifact requires host module "${specifier}", which this host does not provide`),
                { code: 'unknown_host_module', specifier });
        }
        return nativeRequire(specifier);
    }, nativeRequire);
    pluginModule.require = pluginRequire;
    nativeRequire.cache[entryPath] = pluginModule;
    try {
        // Pass require explicitly: Bun's Module._compile does not use an
        // overridden module.require. Both hosts retain their native Module,
        // cache and artifact-relative dependency resolver around this wrapper.
        const execute = compileFunction(await readFile(entryPath, 'utf8'),
            ['exports', 'require', 'module', '__filename', '__dirname'], { filename: entryPath });
        execute.call(pluginModule.exports, pluginModule.exports, pluginRequire,
            pluginModule, entryPath, dirname(entryPath));
        pluginModule.loaded = true;
        return pluginModule.exports as PluginModuleNamespace;
    } catch (error) {
        delete nativeRequire.cache[entryPath];
        throw error;
    }
}
