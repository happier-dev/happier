import { PLUGIN_UI_COMMON_JS_HOST_MODULES } from './hostModules';

export type PluginUiCommonJsHostModules = Readonly<Record<string, unknown>>;

export type PluginUiCommonJsArtifactIdentity = Readonly<{
    pluginId: string;
    artifactId: string;
    digest: string;
}>;

export type PluginUiCommonJsEvaluationErrorCode =
    | 'module_instantiation_failed'
    | 'unknown_host_module'
    | 'invalid_executable_export';

export class PluginUiCommonJsEvaluationError extends Error {
    readonly code: PluginUiCommonJsEvaluationErrorCode;
    readonly identity: PluginUiCommonJsArtifactIdentity;
    readonly requestedExport: string;
    /** The module an `unknown_host_module` artifact required that this host does not provide. */
    readonly specifier?: string;

    constructor(input: Readonly<{
        code: PluginUiCommonJsEvaluationErrorCode;
        identity: PluginUiCommonJsArtifactIdentity;
        requestedExport: string;
        specifier?: string;
    }>) {
        super(`${input.code}:${input.identity.pluginId}:${input.identity.artifactId}${input.specifier ? `:${input.specifier}` : ''}`);
        this.name = 'PluginUiCommonJsEvaluationError';
        this.code = input.code;
        this.identity = input.identity;
        this.requestedExport = input.requestedExport;
        if (input.specifier) this.specifier = input.specifier;
    }
}

function fail(input: ConstructorParameters<typeof PluginUiCommonJsEvaluationError>[0]): never {
    throw new PluginUiCommonJsEvaluationError(input);
}

function boundedSourceUrl(identity: PluginUiCommonJsArtifactIdentity): string {
    const safe = `${identity.pluginId}-${identity.artifactId}`
        .replace(/[^a-zA-Z0-9._-]/gu, '-')
        .slice(0, 160);
    return `\n//# sourceURL=happier-plugin-ui-${safe}.cjs`;
}

type PluginUiCommonJsEvaluationInput = Readonly<{
    bytes: Uint8Array;
    identity: PluginUiCommonJsArtifactIdentity;
    requestedExport: string;
    hostModules?: PluginUiCommonJsHostModules;
}>;

export type PluginUiCommonJsModule = Readonly<{
    readExport: (requestedExport: string) => (...args: never[]) => unknown;
}>;

/** Instantiate bytes separately from selecting an export or activating a scope. */
export function instantiatePluginUiCommonJsBundle(input: PluginUiCommonJsEvaluationInput): PluginUiCommonJsModule {
    let source: string;
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
    } catch {
        fail({
            code: 'module_instantiation_failed',
            identity: input.identity,
            requestedExport: input.requestedExport,
        });
    }

    const module = { exports: {} as unknown };
    const exports = module.exports;
    const hostModules = input.hostModules ?? PLUGIN_UI_COMMON_JS_HOST_MODULES;
    const requireHostModule = (specifier: string): unknown => {
        if (!Object.prototype.hasOwnProperty.call(hostModules, specifier)) {
            fail({
                code: 'unknown_host_module',
                identity: input.identity,
                requestedExport: input.requestedExport,
                specifier,
            });
        }
        return (hostModules as Readonly<Record<string, unknown>>)[specifier];
    };

    try {
        const instantiate = new Function(
            'module',
            'exports',
            'require',
            `"use strict";\n${source}${boundedSourceUrl(input.identity)}`,
        ) as (module: { exports: unknown }, exports: unknown, require: (specifier: string) => unknown) => void;
        instantiate(module, exports, requireHostModule);
    } catch (error) {
        if (error instanceof PluginUiCommonJsEvaluationError) throw error;
        fail({
            code: 'module_instantiation_failed',
            identity: input.identity,
            requestedExport: input.requestedExport,
        });
    }

    const namespace = module.exports;
    return Object.freeze({
        readExport: (requestedExport) => {
            const exported = namespace && (typeof namespace === 'object' || typeof namespace === 'function')
                ? Reflect.get(namespace, requestedExport)
                : undefined;
            if (typeof exported !== 'function') {
                fail({ code: 'invalid_executable_export', identity: input.identity, requestedExport });
            }
            return exported as (...args: never[]) => unknown;
        },
    });
}

export function evaluatePluginUiCommonJsBundle(input: PluginUiCommonJsEvaluationInput): (...args: never[]) => unknown {
    return instantiatePluginUiCommonJsBundle(input).readExport(input.requestedExport);
}
