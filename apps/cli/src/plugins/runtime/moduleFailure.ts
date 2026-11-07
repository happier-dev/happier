import type { PluginCompatibilityDiagnostic } from '../validation/diagnostics/types';

const NODE_LOAD_ERROR_CODES = [
    'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ENOENT',
    'ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE', 'ERR_REQUIRE_CYCLE_MODULE',
    'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_PACKAGE_IMPORT_NOT_DEFINED',
    'ERR_UNSUPPORTED_DIR_IMPORT', 'ERR_INVALID_MODULE_SPECIFIER',
    'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_INVALID_PACKAGE_CONFIG', 'ERR_INVALID_PACKAGE_TARGET',
    'ERR_UNKNOWN_BUILTIN_MODULE', 'ERR_INVALID_TYPESCRIPT_SYNTAX', 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
    'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING', 'ERR_DLOPEN_FAILED', 'EACCES', 'EPERM',
] as const;
type NodeLoadErrorCode = typeof NODE_LOAD_ERROR_CODES[number];
const nodeLoadErrorCodes = new Set<string>(NODE_LOAD_ERROR_CODES);
const MODULE_LOAD_ERROR_CODES = [
    'PLUGIN_DAEMON_ENTRY_MISSING', 'PLUGIN_DAEMON_ENTRY_KIND_UNSUPPORTED',
    'PLUGIN_DAEMON_MODULE_LOAD_FAILED', 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED',
    'PLUGIN_DAEMON_TRUST_UNTRUSTED',
] as const;
const moduleLoadErrorCodes = new Set<string>(MODULE_LOAD_ERROR_CODES);
const PLUGIN_MODULE_FAILURE_CODES = [
    ...NODE_LOAD_ERROR_CODES, ...MODULE_LOAD_ERROR_CODES,
    'SyntaxError', 'BABEL_PARSE_ERROR', 'BABEL_PARSER_SYNTAX_ERROR', 'PARSER_SYNTAX_ERROR', 'ParseError', 'ReferenceError',
    'ReferenceError-in-TDZ', 'PLUGIN_ACTIVATION_EXPORT_MISSING',
    'PLUGIN_ACTIVATION_EXPORT_INVALID', 'PLUGIN_ACTIVATION_THROW', 'UNKNOWN',
] as const;
const failureCodes = new Set<string>(PLUGIN_MODULE_FAILURE_CODES);

export type PluginModuleLoadErrorCode = typeof MODULE_LOAD_ERROR_CODES[number];

export type PluginFailurePhase = 'resolve' | 'transpile' | 'evaluate' | 'activate';
export type PluginModuleFailureCause = Readonly<{
    phase: PluginFailurePhase;
    code: typeof PLUGIN_MODULE_FAILURE_CODES[number];
    /** True means retry after dependency/source refresh, never automatic polling. */
    retryable: boolean | 'unknown';
    reason?: 'missing_export';
    specifier?: string;
}>;

function readField(value: unknown, key: string): unknown {
    try {
        return value !== null && (typeof value === 'object' || typeof value === 'function')
            ? Reflect.get(value, key) : undefined;
    } catch {
        return undefined;
    }
}

function errorChain(error: unknown): readonly unknown[] {
    const chain: unknown[] = [];
    const seen = new Set<unknown>();
    for (let current = error; current !== undefined && current !== null && !seen.has(current); current = readField(current, 'cause')) {
        seen.add(current);
        chain.push(current);
    }
    return chain;
}

/** Preserve an already projected failure when another owner must throw it. */
export class PluginDiagnosticError extends Error {
    readonly code: PluginCompatibilityDiagnostic['code'];
    readonly details: PluginCompatibilityDiagnostic['details'];

    constructor(readonly diagnostic: PluginCompatibilityDiagnostic) {
        super(diagnostic.message);
        this.name = 'PluginDiagnosticError';
        this.code = diagnostic.code;
        this.details = diagnostic.details;
    }
}

export class PluginModuleLoadError extends Error {
    readonly details: Readonly<{ cause: PluginModuleFailureCause }>;

    constructor(
        readonly code: PluginModuleLoadErrorCode,
        message: string,
        cause?: unknown,
        phase: PluginFailurePhase = code === 'PLUGIN_DAEMON_MODULE_LOAD_FAILED' ? 'evaluate' : 'resolve',
    ) {
        super(message, { cause });
        this.name = 'PluginModuleLoadError';
        this.details = { cause: classifyPluginModuleFailure(cause ?? { code }, phase) };
    }
}

export function findPluginFailureDiagnostic(error: unknown): PluginCompatibilityDiagnostic | undefined {
    for (const entry of errorChain(error)) {
        try {
            if (entry instanceof PluginDiagnosticError) return entry.diagnostic;
        } catch { /* A foreign error may trap prototype access. */ }
    }
    return undefined;
}

export function findPluginModuleLoadError(error: unknown): PluginModuleLoadError | undefined {
    for (const entry of errorChain(error)) {
        try {
            if (entry instanceof PluginModuleLoadError) return entry;
        } catch { /* A foreign error may trap prototype access. */ }
    }
    return undefined;
}

function packageSpecifier(message: unknown): string | undefined {
    if (typeof message !== 'string') return undefined;
    const candidate = /^(?:Cannot find (?:package|module)|The requested module) ['"]([^'"\r\n]+)['"]/u.exec(message)?.[1];
    // Only package grammar is admitted. In particular, never publish an
    // absolute/file URL, query, credential, arbitrary prose or private path.
    return safePackageSpecifier(candidate);
}

function safePackageSpecifier(candidate: unknown): string | undefined {
    if (typeof candidate !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)*$/u.test(candidate)) return undefined;
    return candidate.split('/').some((part) => part === '.' || part === '..') ? undefined : candidate;
}

export function readPluginModuleFailureCause(details: unknown): PluginModuleFailureCause | undefined {
    const cause = readField(details, 'cause');
    const phase = readField(cause, 'phase');
    const code = readField(cause, 'code');
    const retryable = readField(cause, 'retryable');
    if ((phase !== 'resolve' && phase !== 'transpile' && phase !== 'evaluate' && phase !== 'activate')
        || typeof code !== 'string' || !failureCodes.has(code)
        || (typeof retryable !== 'boolean' && retryable !== 'unknown')) return undefined;
    const specifier = safePackageSpecifier(readField(cause, 'specifier'));
    return { phase, code: code as PluginModuleFailureCause['code'], retryable,
        ...(readField(cause, 'reason') === 'missing_export' ? { reason: 'missing_export' as const } : {}),
        ...(specifier ? { specifier } : {}),
    };
}

export function describePluginModuleFailure(message: string, details: unknown): string | undefined {
    const cause = readPluginModuleFailureCause(details);
    if (!cause) return undefined;
    return `${message} [${cause.phase}/${cause.code}; retryable=${cause.retryable === true ? 'after_refresh' : cause.retryable}${cause.reason ? `; reason=${cause.reason}` : ''}${cause.specifier ? `; specifier=${cause.specifier}` : ''}]`;
}

/** One content-free classifier for native Node, Jiti and activation failures. */
export function classifyPluginModuleFailure(
    error: unknown,
    phase: PluginFailurePhase = 'evaluate',
): PluginModuleFailureCause {
    const chain = errorChain(error);
    for (const entry of chain) {
        // Serialized failures have no Error prototype. Re-admit only the
        // closed cause fields, never a raw exception bag or message.
        const inherited = readPluginModuleFailureCause(readField(entry, 'details'));
        if (inherited) return inherited;
    }
    for (const entry of [...chain].reverse()) {
        const code = readField(entry, 'code');
        const name = readField(entry, 'name');
        const message = readField(entry, 'message');
        if (typeof code === 'string' && moduleLoadErrorCodes.has(code)
            && code !== 'PLUGIN_DAEMON_MODULE_LOAD_FAILED') {
            return { phase: 'resolve', code: code as PluginModuleLoadErrorCode,
                retryable: code === 'PLUGIN_DAEMON_ENTRY_MISSING' };
        }
        if (typeof code === 'string' && nodeLoadErrorCodes.has(code)) {
            const retryable = code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ENOENT';
            const specifier = packageSpecifier(message);
            const evaluationFailure = code === 'ERR_REQUIRE_ESM' || code === 'ERR_REQUIRE_ASYNC_MODULE'
                || code === 'ERR_REQUIRE_CYCLE_MODULE' || code === 'ERR_DLOPEN_FAILED';
            const transpileFailure = code === 'ERR_INVALID_TYPESCRIPT_SYNTAX' || code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'
                || code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING';
            const filesystemFailure = code === 'ENOENT' || code === 'EACCES' || code === 'EPERM';
            return {
                phase: phase === 'activate' || filesystemFailure ? phase
                    : transpileFailure ? 'transpile' : evaluationFailure ? 'evaluate' : 'resolve',
                code: code as NodeLoadErrorCode,
                retryable,
                ...(specifier ? { specifier } : {}),
            };
        }
        // Jiti 2.7's transform serializes __JITI_ERROR__, then its evaluator
        // creates Error(`${code}: ${message} ...`) without copying code. Read
        // only that pinned closed prefix, never forward the compiler prose.
        const transpileCode = code === 'BABEL_PARSE_ERROR' || code === 'BABEL_PARSER_SYNTAX_ERROR'
            || code === 'PARSER_SYNTAX_ERROR' || code === 'ParseError' ? code
            : code === undefined && typeof message === 'string' && message.startsWith('ParseError:') ? 'ParseError'
                : code === undefined && typeof message === 'string' && message.startsWith('PARSER_SYNTAX_ERROR:') ? 'PARSER_SYNTAX_ERROR' : undefined;
        if (transpileCode || name === 'SyntaxError') {
            const missingExport = typeof message === 'string'
                && /does not provide an export named|Named export ['"].*['"] not found/u.test(message);
            return {
                phase: phase === 'activate' ? phase : transpileCode ? 'transpile' : phase,
                code: transpileCode ?? 'SyntaxError',
                retryable: false,
                ...(missingExport ? { reason: 'missing_export' as const } : {}),
            };
        }
        if (name === 'ReferenceError') {
            return {
                phase,
                code: typeof message === 'string' && /^Cannot access .+ before initialization\.?$/u.test(message)
                    ? 'ReferenceError-in-TDZ' : 'ReferenceError',
                retryable: false,
            };
        }
    }
    return { phase, code: phase === 'activate' ? 'PLUGIN_ACTIVATION_THROW' : 'UNKNOWN', retryable: phase === 'activate' ? false : 'unknown' };
}
