import { isPluginError as isCanonicalPluginError } from '@happier-dev/protocol/plugins/errors';

import type { PluginRemediationData } from './availability.js';
import type { PluginDiagnosticData } from './diagnostics.js';
import type { JsonValue } from './identity.js';

/**
 * A host-reported Action invocation marker. This is advisory outside the
 * canonical Action transport; absence deliberately means the outcome is
 * unknown.
 */
export type PluginActionHandlerInvocation = 'notStarted';

export type PluginErrorData = Readonly<{
    name: 'PluginError';
    code: string;
    message?: string;
    retryable?: boolean;
    details?: JsonValue;
    remediation?: PluginRemediationData;
    diagnostics?: readonly PluginDiagnosticData[];
    actionHandlerInvocation?: PluginActionHandlerInvocation;
}>;

export interface PluginError {
    readonly actionHandlerInvocation?: PluginActionHandlerInvocation;
}

export class PluginError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly details?: JsonValue;
    readonly remediation?: PluginRemediationData;
    readonly diagnostics?: readonly PluginDiagnosticData[];
    readonly data: PluginErrorData;

    constructor(
        data: Omit<PluginErrorData, 'name' | 'actionHandlerInvocation'>,
        options?: ErrorOptions,
    ) {
        super(data.message ?? data.code, options);
        // The recognizer uses this name as part of the structural contract. A
        // subclass that reassigns it would silently stop being a PluginError
        // everywhere; a non-writable own property turns that mistake into a loud
        // TypeError while keeping the enumerability a plain assignment produced.
        Object.defineProperty(this, 'name', {
            value: 'PluginError',
            enumerable: true,
            writable: false,
            configurable: false,
        });
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

/**
 * Recognizes the canonical public PluginError contract across separately
 * bundled SDK copies in the same JavaScript realm.
 *
 * Protocol owns the one structural decision, because the Action invocation
 * owner has to classify a handler rejection without importing the SDK. This
 * republishes it under the SDK's author-facing narrowing so a recognized error
 * still carries the author vocabulary (`details`, `remediation`,
 * `diagnostics`) that only the SDK declares.
 */
export function isPluginError(value: unknown): value is PluginError {
    return isCanonicalPluginError(value);
}

/**
 * Accepts the closed public PluginError shape rather than requiring one SDK
 * module instance, so an external plugin can consume the host-reported
 * advisory marker carried by the canonical Action transport.
 *
 * Recognition delegates to the canonical contract first. Presence of the
 * marker is advisory when reconstructed from a structural error carrier.
 * Callers must use it for retry/compensation only alongside the canonical
 * Action transport result; arbitrary thrown values cannot establish effect
 * provenance.
 */
export function isPluginActionHandlerInvocationNotStartedAdvisory(error: unknown): boolean {
    if (!isPluginError(error)) return false;
    const candidate = error as unknown as Readonly<Record<string, unknown>>;
    if (candidate.actionHandlerInvocation === 'notStarted') return true;
    const data = candidate.data as Readonly<Record<string, unknown>>;
    return data.actionHandlerInvocation === 'notStarted';
}
