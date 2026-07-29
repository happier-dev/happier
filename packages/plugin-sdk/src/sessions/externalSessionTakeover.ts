import {
    ExternalSessionsSourceSchema,
    PluginAgentExternalSessionLinkDataSchema,
} from '@happier-dev/protocol';

import type {
    AgentExternalSessionLinkData,
    AgentExternalSessionSource,
    AgentExternalSessionsFailureCode,
    AgentExternalSessionsInvocation,
    AgentExternalSessionsResult,
} from '../externalSessions.js';

type MaybePromise<T> = T | Promise<T>;

export const AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS = Object.freeze({
    maxLinkedSessionIdCodeUnits: 2_000,
    maxRemoteSessionIdCodeUnits: 2_000,
    maxLinkedDirectoryCodeUnits: 10_000,
    maxDirectoryCodeUnits: 10_000,
    maxBackendModeHintCodeUnits: 256,
    maxEnvironmentVariableEntries: 64,
    maxEnvironmentVariableKeyCodeUnits: 128,
    maxEnvironmentVariableValueCodeUnits: 16_384,
    maxFailureMessageCodeUnits: 2_000,
    callbacks: Object.freeze({
        resolveLaunch: Object.freeze({
            deadlineMs: 15_000,
            maxEnvelopeUtf8Bytes: 262_144,
        }),
    }),
} as const);

export type AgentExternalSessionTakeoverLaunchPlan = Readonly<{
    directory: string;
    backendModeHint?: string;
    environmentVariables?: Readonly<Record<string, string>>;
}>;

export type AgentExternalSessionTakeoverResolveLaunchRequest =
    AgentExternalSessionsInvocation & Readonly<{
        linkedSessionId: string;
        source: AgentExternalSessionSource;
        remoteSessionId: string;
        linkData: AgentExternalSessionLinkData;
        linkedDirectory?: string;
    }>;

export type AgentExternalSessionTakeoverResolveLaunchResult =
    AgentExternalSessionsResult<AgentExternalSessionTakeoverLaunchPlan>;

export type AgentExternalSessionTakeoverResolveLaunchCallback = (
    request: AgentExternalSessionTakeoverResolveLaunchRequest,
) => MaybePromise<AgentExternalSessionTakeoverResolveLaunchResult>;

export type AgentExternalSessionTakeoverContribution = Readonly<{
    resolveLaunch: AgentExternalSessionTakeoverResolveLaunchCallback;
}>;

const FAILURE_CODES = new Set([
    'source_invalid',
    'source_unreachable',
    'candidate_not_found',
    'agent_unavailable',
    'unsupported',
    'unavailable',
    'not_authorized',
    'invalid_request',
    'cancelled',
    'agent_error',
    'timeout',
]);

function invalid(label: string, reason: string): never {
    throw new TypeError(`External Session takeover ${label}: ${reason}`);
}

function readRecord(
    value: unknown,
    allowedKeys: readonly string[],
    requiredKeys: readonly string[],
    label: string,
): Readonly<Record<string, unknown>> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return invalid(label, 'expected a plain object');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return invalid(label, 'expected a plain object');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
        return invalid(label, 'contains unknown fields');
    }
    for (const key of requiredKeys) {
        if (!ownKeys.includes(key)) return invalid(label, `missing '${key}'`);
    }
    const output: Record<string, unknown> = {};
    for (const key of ownKeys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            return invalid(label, `'${key}' must be an enumerable data property`);
        }
        Object.defineProperty(output, key, {
            configurable: false,
            enumerable: true,
            writable: false,
            value: descriptor.value,
        });
    }
    return Object.freeze(output);
}

function boundedString(
    value: unknown,
    minimum: number,
    maximum: number,
    label: string,
): string {
    if (typeof value !== 'string'
        || value.length < minimum
        || value.length > maximum) {
        return invalid(label, `must contain ${minimum}-${maximum} code units`);
    }
    return value;
}

function safeInteger(value: unknown, minimum: number, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        return invalid(label, `must be a safe integer >= ${minimum}`);
    }
    return value as number;
}

function snapshotInvocation(
    record: Readonly<Record<string, unknown>>,
): AgentExternalSessionsInvocation {
    if (!(record.signal instanceof AbortSignal)) {
        return invalid('resolveLaunch request signal', 'must be an AbortSignal');
    }
    const maxSerializedBytes = safeInteger(
        record.maxSerializedBytes,
        1,
        'resolveLaunch request maxSerializedBytes',
    );
    if (maxSerializedBytes
        > AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.callbacks.resolveLaunch
            .maxEnvelopeUtf8Bytes) {
        return invalid(
            'resolveLaunch request maxSerializedBytes',
            'exceeds the host-owned callback ceiling',
        );
    }
    return Object.freeze({
        signal: record.signal,
        deadlineAtMs: safeInteger(
            record.deadlineAtMs,
            0,
            'resolveLaunch request deadlineAtMs',
        ),
        maxSerializedBytes,
    });
}

function snapshotEnvironmentVariables(
    value: unknown,
): Readonly<Record<string, string>> {
    const allowedKeys = value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        ? Reflect.ownKeys(value).filter(
            (key): key is string => typeof key === 'string',
        )
        : [];
    const record = readRecord(
        value,
        allowedKeys,
        [],
        'launch plan environmentVariables',
    );
    const keys = Object.keys(record);
    if (keys.length
        > AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxEnvironmentVariableEntries) {
        return invalid(
            'launch plan environmentVariables',
            `must contain at most ${
                AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxEnvironmentVariableEntries
            } entries`,
        );
    }
    const snapshot: Record<string, string> = {};
    for (const key of keys) {
        boundedString(
            key,
            1,
            AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS
                .maxEnvironmentVariableKeyCodeUnits,
            'launch plan environment variable key',
        );
        const item = boundedString(
            record[key],
            0,
            AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS
                .maxEnvironmentVariableValueCodeUnits,
            `launch plan environmentVariables.${key}`,
        );
        Object.defineProperty(snapshot, key, {
            configurable: false,
            enumerable: true,
            writable: false,
            value: item,
        });
    }
    return Object.freeze(snapshot);
}

export function validateAgentExternalSessionTakeoverContribution(
    value: unknown,
): AgentExternalSessionTakeoverContribution {
    const record = readRecord(
        value,
        ['resolveLaunch'],
        ['resolveLaunch'],
        'contribution',
    );
    if (typeof record.resolveLaunch !== 'function') {
        return invalid('contribution', 'resolveLaunch must be a function');
    }
    return Object.freeze({
        resolveLaunch:
            record.resolveLaunch as AgentExternalSessionTakeoverResolveLaunchCallback,
    });
}

export function validateAgentExternalSessionTakeoverResolveLaunchRequest(
    value: unknown,
): AgentExternalSessionTakeoverResolveLaunchRequest {
    const record = readRecord(
        value,
        [
            'signal',
            'deadlineAtMs',
            'maxSerializedBytes',
            'linkedSessionId',
            'source',
            'remoteSessionId',
            'linkData',
            'linkedDirectory',
        ],
        [
            'signal',
            'deadlineAtMs',
            'maxSerializedBytes',
            'linkedSessionId',
            'source',
            'remoteSessionId',
            'linkData',
        ],
        'resolveLaunch request',
    );
    const source = ExternalSessionsSourceSchema.safeParse(record.source);
    if (!source.success) {
        return invalid('resolveLaunch request source', 'is not a valid bounded source');
    }
    const linkData = PluginAgentExternalSessionLinkDataSchema.safeParse(
        record.linkData,
    );
    if (!linkData.success) {
        return invalid('resolveLaunch request linkData', 'is not valid bounded link data');
    }
    const linkedDirectory = record.linkedDirectory === undefined
        ? undefined
        : boundedString(
            record.linkedDirectory,
            1,
            AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxLinkedDirectoryCodeUnits,
            'resolveLaunch request linkedDirectory',
        );
    return Object.freeze({
        ...snapshotInvocation(record),
        linkedSessionId: boundedString(
            record.linkedSessionId,
            1,
            AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxLinkedSessionIdCodeUnits,
            'resolveLaunch request linkedSessionId',
        ),
        source: source.data as AgentExternalSessionSource,
        remoteSessionId: boundedString(
            record.remoteSessionId,
            1,
            AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxRemoteSessionIdCodeUnits,
            'resolveLaunch request remoteSessionId',
        ),
        linkData: linkData.data,
        ...(linkedDirectory === undefined ? {} : { linkedDirectory }),
    });
}

export function validateAgentExternalSessionTakeoverLaunchPlan(
    value: unknown,
): AgentExternalSessionTakeoverLaunchPlan {
    const record = readRecord(
        value,
        ['directory', 'backendModeHint', 'environmentVariables'],
        ['directory'],
        'launch plan',
    );
    const backendModeHint = record.backendModeHint === undefined
        ? undefined
        : boundedString(
            record.backendModeHint,
            1,
            AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxBackendModeHintCodeUnits,
            'launch plan backendModeHint',
        );
    const environmentVariables = record.environmentVariables === undefined
        ? undefined
        : snapshotEnvironmentVariables(record.environmentVariables);
    return Object.freeze({
        directory: boundedString(
            record.directory,
            1,
            AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxDirectoryCodeUnits,
            'launch plan directory',
        ),
        ...(backendModeHint === undefined ? {} : { backendModeHint }),
        ...(environmentVariables === undefined ? {} : { environmentVariables }),
    });
}

function snapshotFailure(
    record: Readonly<Record<string, unknown>>,
): AgentExternalSessionTakeoverResolveLaunchResult {
    if (record.ok !== false || typeof record.code !== 'string'
        || !FAILURE_CODES.has(record.code)) {
        return invalid('resolveLaunch result', 'has an invalid failure code');
    }
    if (record.retryable !== undefined && typeof record.retryable !== 'boolean') {
        return invalid('resolveLaunch result retryable', 'must be a boolean');
    }
    const message = record.message === undefined
        ? undefined
        : boundedString(
            record.message,
            0,
            AGENT_EXTERNAL_SESSION_TAKEOVER_LIMITS.maxFailureMessageCodeUnits,
            'resolveLaunch result message',
        );
    return Object.freeze({
        ok: false,
        code: record.code as AgentExternalSessionsFailureCode,
        ...(message === undefined ? {} : { message }),
        ...(record.retryable === undefined
            ? {}
            : { retryable: record.retryable }),
    }) as AgentExternalSessionTakeoverResolveLaunchResult;
}

export function validateAgentExternalSessionTakeoverResolveLaunchResult(
    value: unknown,
): AgentExternalSessionTakeoverResolveLaunchResult {
    const record = readRecord(
        value,
        ['ok', 'value', 'code', 'message', 'retryable'],
        ['ok'],
        'resolveLaunch result',
    );
    if (record.ok === true) {
        if (!Object.hasOwn(record, 'value')
            || Object.hasOwn(record, 'code')
            || Object.hasOwn(record, 'message')
            || Object.hasOwn(record, 'retryable')) {
            return invalid('resolveLaunch result', 'has an invalid success envelope');
        }
        return Object.freeze({
            ok: true,
            value: validateAgentExternalSessionTakeoverLaunchPlan(record.value),
        });
    }
    if (Object.hasOwn(record, 'value')) {
        return invalid('resolveLaunch result', 'has an invalid failure envelope');
    }
    return snapshotFailure(record);
}
