export type RuntimeErrorKindV1 =
    | 'abort'
    | 'timeout'
    | 'permission'
    | 'network'
    | 'transient'
    | 'unsupported'
    | 'unknown';

export type ClassifiedRuntimeErrorV1 = Readonly<{
    kind: RuntimeErrorKindV1;
    code: string | null;
    message: string;
    retryable: boolean;
}>;

export interface ErrorRuntimeServiceV1 {
    classify(error: unknown): ClassifiedRuntimeErrorV1;
    wrap(error: unknown, fallbackCode?: string): Error;
    report(error: unknown, fields?: Readonly<Record<string, unknown>>): void;
}

import type { PluginRemediationData } from './availability.js';
import type { PluginDiagnosticData } from './diagnostics.js';
import type { JsonValue } from './identity.js';

export type PluginErrorData = Readonly<{
    name: 'PluginError';
    code: string;
    message?: string;
    retryable?: boolean;
    details?: JsonValue;
    remediation?: PluginRemediationData;
    diagnostics?: readonly PluginDiagnosticData[];
}>;

export class PluginError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly details?: JsonValue;
    readonly remediation?: PluginRemediationData;
    readonly diagnostics?: readonly PluginDiagnosticData[];
    readonly data: PluginErrorData;

    constructor(data: Omit<PluginErrorData, 'name'>, options?: ErrorOptions) {
        super(data.message ?? data.code, options);
        this.name = 'PluginError';
        this.code = data.code;
        this.retryable = data.retryable ?? false;
        this.details = data.details;
        this.remediation = data.remediation;
        this.diagnostics = data.diagnostics;
        this.data = {
            name: 'PluginError',
            code: data.code,
            ...(data.message === undefined ? {} : { message: data.message }),
            ...(data.retryable === undefined ? {} : { retryable: data.retryable }),
            ...(data.details === undefined ? {} : { details: data.details }),
            ...(data.remediation === undefined ? {} : { remediation: data.remediation }),
            ...(data.diagnostics === undefined ? {} : { diagnostics: data.diagnostics }),
        };
    }
}
