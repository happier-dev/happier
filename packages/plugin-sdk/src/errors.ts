import { isPluginError as isCanonicalPluginError } from '@happier-dev/protocol/plugins/errors';

import type { PluginRemediationData } from './availability.js';
import type { PluginDiagnosticData } from './diagnostics.js';
import type { JsonValue } from './identity.js';

/**
 * Set only by the canonical Actions host when it proves that the target
 * handler did not begin. Absence deliberately means the outcome is unknown.
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

    constructor(data: Omit<PluginErrorData, 'name'>, options?: ErrorOptions) {
        super(data.message ?? data.code, options);
        // The recognizer proves the contract from this name, so a subclass that
        // reassigns it would silently stop being a PluginError everywhere. A
        // non-writable own property turns that mistake into a loud TypeError
        // while keeping the enumerability a plain assignment produced.
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
        if (data.actionHandlerInvocation !== undefined) {
            Object.defineProperty(this, 'actionHandlerInvocation', {
                value: data.actionHandlerInvocation,
                enumerable: true,
                writable: false,
                configurable: false,
            });
        }
        this.data = {
            name: 'PluginError',
            code: data.code,
            ...(data.message === undefined ? {} : { message: data.message }),
            ...(data.retryable === undefined ? {} : { retryable: data.retryable }),
            ...(data.details === undefined ? {} : { details: data.details }),
            ...(data.remediation === undefined ? {} : { remediation: data.remediation }),
            ...(data.diagnostics === undefined ? {} : { diagnostics: data.diagnostics }),
            ...(data.actionHandlerInvocation === undefined
                ? {}
                : { actionHandlerInvocation: data.actionHandlerInvocation }),
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
 * module instance, so an external plugin can consume the host's proof too.
 *
 * Recognition delegates to the canonical contract first. A false "the handler
 * never started" answer is not a cosmetic misread: callers use it to retry or
 * compensate, so an ordinary object that merely calls itself `PluginError`
 * must not be able to make an effect that did run look like one that did not.
 */
export function isPluginActionHandlerInvocationKnownNotStarted(error: unknown): boolean {
    if (!isPluginError(error)) return false;
    const candidate = error as unknown as Readonly<Record<string, unknown>>;
    if (candidate.actionHandlerInvocation === 'notStarted') return true;
    const data = candidate.data as Readonly<Record<string, unknown>>;
    return data.actionHandlerInvocation === 'notStarted';
}
