import { redactBugReportSensitiveText } from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import {
    inspectOwnErrorCodeDataProperty,
} from '@/agent/runtime/session/process/agentRuntimeBridgeError';
import {
    RuntimeTranscriptRequiredAdmissionError,
} from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';

export const NATIVE_AGENT_SESSION_EFFECT_AUTHORITY_UNAVAILABLE_CODE =
    'native_agent_privileged_effect_authority_unavailable';
export const NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE =
    'native_agent_privileged_effect_outcome_unknown';

export type NativeAgentSessionEffectBoundaryKind =
    | 'authority_unavailable_before_effect'
    | 'outcome_unknown_after_dispatch';

export class NativeAgentSessionEffectBoundaryError extends Error {
    readonly code:
        | typeof NATIVE_AGENT_SESSION_EFFECT_AUTHORITY_UNAVAILABLE_CODE
        | typeof NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE;
    readonly kind: NativeAgentSessionEffectBoundaryKind;
    readonly retryable: boolean;

    constructor(kind: NativeAgentSessionEffectBoundaryKind) {
        const outcomeUnknown = kind === 'outcome_unknown_after_dispatch';
        super(
            outcomeUnknown
                ? 'The privileged Agent operation may have taken effect; its outcome is unknown'
                : 'Current daemon authority is unavailable before the privileged Agent operation',
        );
        this.name = 'NativeAgentSessionEffectBoundaryError';
        this.kind = kind;
        this.code = outcomeUnknown
            ? NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE
            : NATIVE_AGENT_SESSION_EFFECT_AUTHORITY_UNAVAILABLE_CODE;
        this.retryable = !outcomeUnknown;
    }
}

export function createNativeAgentSessionEffectBoundaryError(
    kind: NativeAgentSessionEffectBoundaryKind,
): NativeAgentSessionEffectBoundaryError {
    return new NativeAgentSessionEffectBoundaryError(kind);
}

export function classifyNativeAgentSessionEffectBoundaryError(
    error: unknown,
): NativeAgentSessionEffectBoundaryKind | null {
    const code = inspectOwnErrorCodeDataProperty(error);
    if (code.kind !== 'string') return null;
    if (
        code.value
        === NATIVE_AGENT_SESSION_EFFECT_AUTHORITY_UNAVAILABLE_CODE
    ) return 'authority_unavailable_before_effect';
    if (
        code.value
        === NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE
    ) return 'outcome_unknown_after_dispatch';
    return null;
}

/**
 * The exact-session host-services adapter is the public Plugin SDK boundary.
 * Keep only code-addressable expected failures in the PluginError ABI; ordinary
 * invariants remain ordinary errors for their owning caller to diagnose.
 */
export function projectNativeAgentSessionHostServiceError(error: unknown): unknown {
    // Plugin-corridor error owners (exec, sessionHooks, terminal host, context
    // services) construct canonical PluginErrors themselves, so only foreign host
    // domain errors are projected here.
    if (isPluginError(error)) return error;
    if (error instanceof RuntimeTranscriptRequiredAdmissionError) {
        return new PluginError({
            code: error.code,
            message: error.message,
            retryable: false,
            details: {
                reason: error.reason,
                eventKind: error.eventKind,
            },
        });
    }
    return error;
}

function readOwnDataProperty(value: object, property: string): unknown {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch {
        return undefined;
    }
}

function readCanonicalPluginError(error: Error, code: string | undefined): PluginError | null {
    if (code === undefined) return null;
    const retryable = readOwnDataProperty(error, 'retryable');
    const data = readOwnDataProperty(error, 'data');
    if (typeof retryable !== 'boolean' || data === null || typeof data !== 'object' || Array.isArray(data)) {
        return null;
    }
    const name = readOwnDataProperty(data, 'name');
    const dataCode = readOwnDataProperty(data, 'code');
    const message = readOwnDataProperty(data, 'message');
    const dataRetryable = readOwnDataProperty(data, 'retryable');
    const details = readOwnDataProperty(data, 'details');
    const remediation = readOwnDataProperty(data, 'remediation');
    const diagnostics = readOwnDataProperty(data, 'diagnostics');
    const actionHandlerInvocation = readOwnDataProperty(data, 'actionHandlerInvocation') === 'notStarted'
        ? 'notStarted' as const
        : undefined;
    const candidate = Object.assign(
        new Error(typeof message === 'string' ? message : code),
        {
            name,
            code,
            retryable,
            data: Object.freeze({
                name,
                code: dataCode,
                ...(message === undefined ? {} : { message }),
                retryable: dataRetryable,
                ...(details === undefined ? {} : { details }),
                ...(remediation === undefined ? {} : { remediation }),
                ...(diagnostics === undefined ? {} : { diagnostics }),
                ...(actionHandlerInvocation === undefined
                    ? {}
                    : { actionHandlerInvocation }),
            }),
            ...(details === undefined ? {} : { details }),
            ...(remediation === undefined ? {} : { remediation }),
            ...(diagnostics === undefined ? {} : { diagnostics }),
            ...(actionHandlerInvocation === undefined
                ? {}
                : { actionHandlerInvocation }),
        },
    );
    if (!isPluginError(candidate)) return null;
    return candidate;
}

function projectNativeAgentSessionBoundaryStack(error: Error): string | undefined {
    try {
        return typeof error.stack === 'string'
            ? projectPluginFailureText(new Error(error.stack))
            : undefined;
    } catch {
        return undefined;
    }
}

export function sanitizeNativeAgentSessionBoundaryError(
    error: unknown,
    forceSafeShape: boolean,
): unknown {
    if (!(error instanceof Error)) {
        return new Error(projectPluginFailureText(error));
    }
    const name =
        redactBugReportSensitiveText(error.name).trim()
        || 'Error';
    const message = projectPluginFailureText(error);
    const stack = projectNativeAgentSessionBoundaryStack(error);
    const codeProperty = inspectOwnErrorCodeDataProperty(error);
    const rawCode = codeProperty.kind === 'string'
        ? codeProperty.value
        : undefined;
    const pluginError = readCanonicalPluginError(error, rawCode);
    const code = typeof rawCode === 'string'
        ? projectPluginFailureText(new Error(rawCode))
        : undefined;
    const codePropertyIsSafeToRetain =
        codeProperty.kind === 'absent'
        || (
            codeProperty.kind === 'string'
            && code === codeProperty.value
        );
    const hasCause = 'cause' in error;
    if (
        !forceSafeShape
        && !hasCause
        && name === error.name
        && message === error.message
        && stack === error.stack
        && codePropertyIsSafeToRetain
    ) {
        return error;
    }
    if (pluginError) {
        const sanitized = new PluginError({
            code: code ?? pluginError.code,
            message,
            retryable: pluginError.retryable,
            ...(pluginError.details === undefined ? {} : { details: pluginError.details }),
            ...(pluginError.remediation === undefined ? {} : { remediation: pluginError.remediation }),
            ...(pluginError.diagnostics === undefined ? {} : { diagnostics: pluginError.diagnostics }),
            ...(pluginError.actionHandlerInvocation === undefined
                ? {}
                : { actionHandlerInvocation: pluginError.actionHandlerInvocation }),
        });
        if (stack !== undefined) {
            sanitized.stack = stack;
        }
        return sanitized;
    }
    const sanitized = new Error(message) as Error & { code?: string };
    sanitized.name = name;
    if (stack !== undefined) {
        sanitized.stack = stack;
    }
    if (code !== undefined) {
        sanitized.code = code;
    }
    return sanitized;
}
