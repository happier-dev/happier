import type {
    ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
    ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
    ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import type {
    ConnectedAccountRuntimeEstablishedOperation,
    ConnectedAccountRuntimeEstablishedResult,
} from './runtimeInvoker';

type PluginConnectedAccountRefreshResult = Awaited<
    ReturnType<PluginConnectedAccountRuntime['refresh']>
>;
type PluginConnectedAccountRevocationResult = Awaited<
    ReturnType<PluginConnectedAccountRuntime['revoke']>
>;

export type ConnectedAccountProducerResultErrorCode =
    | 'connected_account_producer_result_invalid'
    | 'connected_account_producer_result_stale';

export class ConnectedAccountProducerResultError extends Error {
    readonly code: ConnectedAccountProducerResultErrorCode;
    readonly operation: ConnectedAccountRuntimeEstablishedOperation['kind'];

    constructor(
        code: ConnectedAccountProducerResultErrorCode,
        operation: ConnectedAccountRuntimeEstablishedOperation['kind'],
    ) {
        super(
            code === 'connected_account_producer_result_stale'
                ? 'Connected-account established runtime target is no longer current'
                : 'Connected-account producer result is invalid',
        );
        this.name = 'ConnectedAccountProducerResultError';
        this.code = code;
        this.operation = operation;
    }
}


export function staleConnectedAccountProducerResult(
    operation: ConnectedAccountRuntimeEstablishedOperation['kind'],
): ConnectedAccountProducerResultError {
    return new ConnectedAccountProducerResultError(
        'connected_account_producer_result_stale',
        operation,
    );
}



type RedactConnectedAccountDiagnosticText = (value: string) => string;

type RedactConnectedAccountDiagnosticDetailsTask = Readonly<{
    input: unknown;
    assign(value: unknown): void;
}>;

/**
 * Project diagnostic text through the credential-redaction owner before it
 * leaves the invocation. Wire readers retain their own schema admission.
 */
function redactConnectedAccountDiagnosticDetails(
    value: unknown,
    redactText: RedactConnectedAccountDiagnosticText,
): unknown {
    let output: unknown;
    const tasks: RedactConnectedAccountDiagnosticDetailsTask[] = [{
        input: value,
        assign(next) {
            output = next;
        },
    }];
    while (tasks.length > 0) {
        const task = tasks.pop();
        if (!task) continue;
        if (typeof task.input === 'string') {
            const redacted = redactText(task.input);
            if (typeof redacted !== 'string') {
                throw new TypeError('Connected Account diagnostic redactor returned non-text');
            }
            task.assign(redacted);
            continue;
        }
        if (
            task.input === null
            || typeof task.input === 'boolean'
            || typeof task.input === 'number'
        ) {
            task.assign(task.input);
            continue;
        }
        if (Array.isArray(task.input)) {
            const redacted = new Array<unknown>(task.input.length);
            task.assign(redacted);
            for (let index = task.input.length - 1; index >= 0; index -= 1) {
                const valueAtIndex = task.input[index];
                tasks.push({
                    input: valueAtIndex,
                    assign(next) {
                        redacted[index] = next;
                    },
                });
            }
            continue;
        }
        if (typeof task.input !== 'object') {
            throw new TypeError('Connected Account diagnostic details are not JSON');
        }
        const redacted: Record<string, unknown> =
            Object.create(null) as Record<string, unknown>;
        task.assign(redacted);
        for (const key of Object.keys(task.input).reverse()) {
            const property = Object.getOwnPropertyDescriptor(task.input, key);
            if (!property || !('value' in property)) {
                throw new TypeError('Connected Account diagnostic details have a non-data property');
            }
            tasks.push({
                input: property.value,
                assign(next) {
                    Object.defineProperty(redacted, key, {
                        value: next,
                        enumerable: true,
                        writable: false,
                        configurable: false,
                    });
                },
            });
        }
    }
    return output;
}

function snapshotConnectedAccountDiagnostic(
    value: unknown,
    redactDiagnosticText?: RedactConnectedAccountDiagnosticText,
): Readonly<Record<string, unknown>> | null {
    try {
        const snapshot = structuredClone(value) as Readonly<Record<string, unknown>>;
        return Object.freeze({
            ...snapshot,
            ...(redactDiagnosticText === undefined ? {} : {
                ...(typeof snapshot.message === 'string' ? { message: redactDiagnosticText(snapshot.message) } : {}),
                ...(snapshot.details === undefined ? {} : {
                    details: redactConnectedAccountDiagnosticDetails(snapshot.details, redactDiagnosticText),
                }),
            }),
        });
    } catch {
        // An unavailable redaction projection must never publish credential text.
        return null;
    }
}

export function redactConnectedAccountAuthenticationResultDiagnostic(
    value: unknown,
    redactDiagnosticText: RedactConnectedAccountDiagnosticText,
): unknown {
    const result = value as Readonly<Record<string, unknown>>;
    if (result.diagnostic === undefined) return value;
    const diagnostic = snapshotConnectedAccountDiagnostic(result.diagnostic, redactDiagnosticText);
    if (diagnostic === null) throw new TypeError('Connected Account diagnostic redaction failed');
    return Object.freeze({ ...result, diagnostic });
}

export function snapshotConnectedAccountEstablishedResult<
    TOperation extends ConnectedAccountRuntimeEstablishedOperation,
>(
    operation: TOperation,
    raw: unknown,
    options: Readonly<{
        quotaLeafUnavailable: boolean;
        redactDiagnosticText?: RedactConnectedAccountDiagnosticText;
    }>,
): ConnectedAccountRuntimeEstablishedResult<TOperation> {
    // Runtime registration owns the SDK ABI. These values come from trusted
    // executable code; wire and persistence owners parse their own boundaries.
    if (options.quotaLeafUnavailable) return null as ConnectedAccountRuntimeEstablishedResult<TOperation>;
    if (operation.kind === 'materialize') {
        const result = raw as PluginConnectedAccountMaterialization;
        if (result.kind === 'files') {
            return Object.freeze({
                kind: 'files',
                files: Object.freeze(Object.fromEntries(Object.entries(result.files)
                    .map(([id, bytes]) => [id, new Uint8Array(bytes)]))),
            }) as ConnectedAccountRuntimeEstablishedResult<TOperation>;
        }
        return Object.freeze(result.kind === 'httpHeaders'
            ? { kind: result.kind, headers: Object.freeze({ ...result.headers }) }
            : { kind: result.kind, env: Object.freeze({ ...result.env }) }) as ConnectedAccountRuntimeEstablishedResult<TOperation>;
    }
    if (operation.kind === 'quota' || operation.kind === 'recoveryCredits.read'
        || operation.kind === 'recoveryCredits.consume') {
        return structuredClone(raw) as ConnectedAccountRuntimeEstablishedResult<TOperation>;
    }
    const result = raw as PluginConnectedAccountRefreshResult | PluginConnectedAccountHealthResult | PluginConnectedAccountRevocationResult;
    const diagnostic = result.diagnostic === undefined ? undefined
        : snapshotConnectedAccountDiagnostic(result.diagnostic, options.redactDiagnosticText);
    if (result.diagnostic !== undefined && diagnostic === null) {
        throw new TypeError('Connected Account diagnostic redaction failed');
    }
    return Object.freeze({
        ...result,
        ...('scopes' in result && result.scopes !== undefined ? { scopes: Object.freeze([...result.scopes]) } : {}),
        ...(diagnostic === undefined ? {} : { diagnostic }),
    }) as ConnectedAccountRuntimeEstablishedResult<TOperation>;
}
