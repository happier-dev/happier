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

type PluginUiCommonJsModuleFunction = (
    module: { exports: unknown },
    exports: unknown,
    require: (specifier: string) => unknown,
) => void;

/**
 * An Artifact's compiled module function: decoding and `new Function` (the Hermes
 * compile) depend only on the bytes, so the byte owner may keep it beside them.
 * Running it is instantiation, which always gets a fresh namespace.
 */
export type PluginUiCommonJsProgram = Readonly<{
    identity: PluginUiCommonJsArtifactIdentity;
    moduleFunction: PluginUiCommonJsModuleFunction;
}>;

export function compilePluginUiCommonJsBundle(
    input: Pick<PluginUiCommonJsEvaluationInput, 'bytes' | 'identity' | 'requestedExport'>,
): PluginUiCommonJsProgram {
    // The program outlives this call: close over identity facts, not the input or its bytes.
    const { identity, requestedExport } = input;
    let source: string;
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
    } catch {
        fail({ code: 'module_instantiation_failed', identity, requestedExport });
    }
    try {
        const moduleFunction = new Function(
            'module',
            'exports',
            'require',
            `"use strict";\n${source}${boundedSourceUrl(identity)}`,
        ) as PluginUiCommonJsModuleFunction;
        return Object.freeze({ identity, moduleFunction });
    } catch {
        fail({ code: 'module_instantiation_failed', identity, requestedExport });
    }
}

/** Run a compiled program in a fresh namespace, separately from selecting an export or activating a scope. */
export function instantiatePluginUiCommonJsProgram(
    program: PluginUiCommonJsProgram,
    input: Pick<PluginUiCommonJsEvaluationInput, 'requestedExport' | 'hostModules'>,
): PluginUiCommonJsModule {
    const module = { exports: {} as unknown };
    const exports = module.exports;
    const hostModules = input.hostModules ?? PLUGIN_UI_COMMON_JS_HOST_MODULES;
    // The module keeps `require` for its lifetime: it must close over these facts, not the artifact bytes.
    const { identity } = program;
    const { requestedExport } = input;
    const requireHostModule = (specifier: string): unknown => {
        if (!Object.prototype.hasOwnProperty.call(hostModules, specifier)) {
            fail({ code: 'unknown_host_module', identity, requestedExport, specifier });
        }
        return (hostModules as Readonly<Record<string, unknown>>)[specifier];
    };

    try {
        program.moduleFunction(module, exports, requireHostModule);
    } catch (error) {
        if (error instanceof PluginUiCommonJsEvaluationError) throw error;
        fail({ code: 'module_instantiation_failed', identity, requestedExport });
    }

    const namespace = module.exports;
    return Object.freeze({
        readExport: (exportName) => {
            const exported = namespace && (typeof namespace === 'object' || typeof namespace === 'function')
                ? Reflect.get(namespace, exportName)
                : undefined;
            if (typeof exported !== 'function') {
                fail({ code: 'invalid_executable_export', identity, requestedExport: exportName });
            }
            return exported as (...args: never[]) => unknown;
        },
    });
}

/** Instantiate bytes separately from selecting an export or activating a scope. */
export function instantiatePluginUiCommonJsBundle(input: PluginUiCommonJsEvaluationInput): PluginUiCommonJsModule {
    return instantiatePluginUiCommonJsProgram(compilePluginUiCommonJsBundle(input), input);
}

export function evaluatePluginUiCommonJsBundle(input: PluginUiCommonJsEvaluationInput): (...args: never[]) => unknown {
    return instantiatePluginUiCommonJsBundle(input).readExport(input.requestedExport);
}
