/** @moduleRealm daemon */
import {
    ExternalAgentObservationLeafFactV1Schema,
    PluginAgentExternalSessionLinkDataSchema,
} from '@happier-dev/protocol/plugins/agents';

import type { PluginDiagnosticData } from './diagnostics.js';
import type {
    AgentExternalSessionLinkData,
    AgentExternalSessionSource,
    AgentExternalSessionsInvocationBounds,
    AgentExternalSessionsResult,
} from './externalSessions.js';
import type { JsonValue } from './identity.js';
import type { PluginInvocationContext } from './invocation.js';
import {
    captureStaticRegistrationMethod,
    requireStaticRegistrationObject,
} from './registration/staticCapture.js';
import type {
    AgentExternalSessionObservationLinkEvidenceBatchV1,
} from './externalSessionObservation.js';

type AgentExternalSessionHookObservationFact =
    AgentExternalSessionObservationLinkEvidenceBatchV1['items'][number]['facts'][number];

export const AGENT_EXTERNAL_SESSION_HOOK_LIMITS = Object.freeze({
    maxInstallationVariants: 8,
    maxTargetsPerVariant: 4,
    maxEventsPerVariant: 64,
    maxMappedFacts: 8,
    maxIdCodeUnits: 512,
    maxNativeNameCodeUnits: 128,
    maxInstalledVersionCodeUnits: 256,
    maxArchitectureCodeUnits: 256,
    maxTargetPathUtf8Bytes: 4_096,
    maxJsonDepth: 8,
    maxJsonNodes: 256,
    maxJsonUtf8Bytes: 64 * 1024,
    maxRemoteSessionIdCodeUnits: 2_000,
    maxDiagnosticMessageCodeUnits: 2_000,
    maxFailureMessageCodeUnits: 2_000,
    totalHookDeadlineMs: 500,
    callbacks: Object.freeze({
        resolveInstallation: Object.freeze({
            deadlineMs: 15_000,
            maxEnvelopeUtf8Bytes: 64 * 1024,
        }),
        mapHookEvent: Object.freeze({
            maxEnvelopeUtf8Bytes: 64 * 1024,
        }),
    }),
} as const);

export type AgentExternalSessionHookInstallationVariant = Readonly<{
    variantId: string;
    targets: readonly Readonly<{
        targetId: string;
        format: 'hook_event_json_arrays_v1';
        collectionId: string;
    }>[];
    events: readonly Readonly<{
        eventId: string;
        targetId: string;
        nativeEventName: string;
        command: Readonly<{
            kind: 'happier_observation_v1';
            shellDialect: 'posix' | 'windows_cmd';
            matcher?: string;
            timeoutMs?: number;
        }>;
    }>[];
}>;

export type AgentExternalSessionHookResolveInstallationRequest =
    AgentExternalSessionsInvocationBounds & Readonly<{
        installation: Readonly<{
            installationIdentity: string;
            executableIdentity: string;
            installedVersion: string;
            platform: 'darwin' | 'linux' | 'win32';
            architecture: string;
        }>;
        custody?: AgentExternalSessionHookCustodiedEntryProjection;
    }>;

export type AgentExternalSessionHookCustodiedEntryProjection = Readonly<{
    variantId: string;
    targets: readonly Readonly<{
        targetId: string;
        absolutePath: string;
        entries: readonly Readonly<{
            eventId: string;
            nativeEventName: string;
            entryIndex: number;
            entry: Readonly<{
                matcher: string | null;
                hooks: readonly [Readonly<{
                    type: 'command';
                    command: string;
                    timeout: number;
                }>];
            }>;
        }>[];
    }>[];
}>;

export type AgentExternalSessionHookResolveInstallationValue =
    | Readonly<{
        kind: 'supported';
        variantId: string;
        targets: readonly Readonly<{
            targetId: string;
            absolutePath: string;
        }>[];
        readiness:
            | Readonly<{ kind: 'ready' }>
            | Readonly<{
                kind: 'needs_attention';
                diagnostic: PluginDiagnosticData;
            }>;
    }>
    | Readonly<{
        kind: 'unsupported';
        reason: 'version_unsupported' | 'installation_unsupported';
    }>;

export type AgentExternalSessionHookResolveInstallationResult =
    AgentExternalSessionsResult<AgentExternalSessionHookResolveInstallationValue>;

export type AgentExternalSessionHookMapEventRequest =
    AgentExternalSessionsInvocationBounds & Readonly<{
        installationIdentity: string;
        variantId: string;
        eventId: string;
        observedAtMs: number;
        nativePayload: JsonValue;
    }>;

export type AgentExternalSessionHookMapEventValue =
    | Readonly<{ kind: 'ignored' }>
    | Readonly<{
        kind: 'mapped';
        sourceInput: AgentExternalSessionSource;
        remoteSessionId: string;
        linkData?: AgentExternalSessionLinkData;
        createdAtMs?: number;
        facts: Readonly<AgentExternalSessionObservationLinkEvidenceBatchV1['items'][number]['facts']>;
    }>;

export type AgentExternalSessionHookMapEventResult =
    AgentExternalSessionsResult<AgentExternalSessionHookMapEventValue>;

export type AgentExternalSessionHooksContribution = Readonly<{
    installationVariants: readonly AgentExternalSessionHookInstallationVariant[];
    resolveInstallation(
        request: AgentExternalSessionHookResolveInstallationRequest,
        context: PluginInvocationContext,
    ): AgentExternalSessionHookResolveInstallationResult
        | Promise<AgentExternalSessionHookResolveInstallationResult>;
    mapHookEvent(
        request: AgentExternalSessionHookMapEventRequest,
    ): AgentExternalSessionHookMapEventResult
        | Promise<AgentExternalSessionHookMapEventResult>;
}>;

const textEncoder = new TextEncoder();
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
    throw new TypeError(`External Session hooks ${label}: ${reason}`);
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
        output[key] = descriptor.value;
    }
    return output;
}

function readArray(
    value: unknown,
    min: number,
    max: number,
    label: string,
): readonly unknown[] {
    if (!Array.isArray(value)) return invalid(label, 'expected an array');
    if (value.length < min || value.length > max) {
        return invalid(label, `must contain ${min}-${max} items`);
    }
    const expectedKeys = new Set<PropertyKey>([
        'length',
        ...Array.from({ length: value.length }, (_, index) => String(index)),
    ]);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.size
        || ownKeys.some((key) => !expectedKeys.has(key))) {
        return invalid(label, 'contains sparse, accessor, or extra fields');
    }
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            return invalid(label, `item ${index} must be an enumerable data property`);
        }
        output.push(descriptor.value);
    }
    return output;
}

function normalizedString(value: unknown, max: number, label: string): string {
    if (typeof value !== 'string') return invalid(label, 'expected a string');
    const normalized = value.trim();
    if (normalized.length === 0
        || normalized.length > max
        || normalized.includes('\u0000')) {
        return invalid(label, `must normalize to 1-${max} NUL-free code units`);
    }
    return normalized;
}

function boundedString(
    value: unknown,
    max: number,
    label: string,
    allowEmpty = false,
): string {
    if (typeof value !== 'string'
        || (!allowEmpty && value.length === 0)
        || value.length > max
        || value.includes('\u0000')) {
        return invalid(label, `must be a NUL-free string of at most ${max} code units`);
    }
    return value;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        return invalid(label, `must be a safe integer >= ${minimum}`);
    }
    return value as number;
}

function unique(values: readonly string[], label: string): void {
    const seen = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) return invalid(label, `contains duplicate '${value}'`);
        seen.add(value);
    }
}

function serializedUtf8Bytes(value: unknown): number {
    let serialized: string | undefined;
    try {
        serialized = JSON.stringify(value);
    } catch {
        return invalid('envelope', 'is not serializable JSON');
    }
    if (serialized === undefined) return invalid('envelope', 'is not serializable JSON');
    return textEncoder.encode(serialized).byteLength;
}

function enforceEnvelope(value: unknown, maxBytes: number, label: string): void {
    if (serializedUtf8Bytes(value) > maxBytes) {
        return invalid(label, `exceeds the ${maxBytes}-byte canonical UTF-8 envelope limit`);
    }
}

function snapshotStrictJsonValue(value: unknown, label: string): JsonValue {
    const limits = AGENT_EXTERNAL_SESSION_HOOK_LIMITS;
    const state = { nodes: 0 };
    const visit = (input: unknown, depth: number): JsonValue => {
        if (depth > limits.maxJsonDepth) return invalid(label, 'exceeds the JSON depth limit');
        if (input === null || typeof input === 'string' || typeof input === 'boolean') {
            return input;
        }
        if (typeof input === 'number') {
            if (!Number.isFinite(input)) return invalid(label, 'contains a non-finite number');
            return input;
        }
        if (Array.isArray(input)) {
            const expectedKeys = new Set<PropertyKey>([
                'length',
                ...Array.from({ length: input.length }, (_, index) => String(index)),
            ]);
            const ownKeys = Reflect.ownKeys(input);
            if (ownKeys.length !== expectedKeys.size
                || ownKeys.some((key) => !expectedKeys.has(key))) {
                return invalid(label, 'contains a sparse or decorated array');
            }
            state.nodes += input.length;
            if (state.nodes > limits.maxJsonNodes) {
                return invalid(label, 'exceeds the JSON node limit');
            }
            const snapshot = input.map((item, index) => {
                const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
                if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
                    return invalid(label, 'contains an accessor array item');
                }
                return visit(descriptor.value, depth + 1);
            });
            return Object.freeze(snapshot);
        }
        if (input === null || typeof input !== 'object') {
            return invalid(label, 'contains a non-JSON value');
        }
        const prototype = Object.getPrototypeOf(input);
        if (prototype !== Object.prototype && prototype !== null) {
            return invalid(label, 'contains a non-plain object');
        }
        const keys = Reflect.ownKeys(input);
        if (keys.some((key) => typeof key !== 'string')) {
            return invalid(label, 'contains a non-string object key');
        }
        state.nodes += keys.length;
        if (state.nodes > limits.maxJsonNodes) {
            return invalid(label, 'exceeds the JSON node limit');
        }
        const snapshot: Record<string, JsonValue> = {};
        for (const key of keys as string[]) {
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
                return invalid(label, 'contains an accessor object field');
            }
            Object.defineProperty(snapshot, key, {
                configurable: false,
                enumerable: true,
                writable: false,
                value: visit(descriptor.value, depth + 1),
            });
        }
        return Object.freeze(snapshot);
    };
    const snapshot = visit(value, 0);
    if (serializedUtf8Bytes(snapshot) > limits.maxJsonUtf8Bytes) {
        return invalid(label, 'exceeds the JSON byte limit');
    }
    return snapshot;
}

function absolutePath(value: unknown): string {
    if (typeof value !== 'string'
        || value.length === 0
        || value.includes('\u0000')
        || textEncoder.encode(value).byteLength
            > AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxTargetPathUtf8Bytes) {
        return invalid('absolutePath', 'must be nonempty, NUL-free, and within the UTF-8 limit');
    }
    const isPosixAbsolute = value.startsWith('/');
    const isDriveAbsolute = /^[A-Za-z]:[\\/]/u.test(value);
    const isUncAbsolute = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(value);
    if (!isPosixAbsolute && !isDriveAbsolute && !isUncAbsolute) {
        return invalid('absolutePath', 'must be absolute');
    }
    return value;
}

function snapshotCustodyEntry(
    value: unknown,
): AgentExternalSessionHookCustodiedEntryProjection['targets'][number]['entries'][number] {
    const limits = AGENT_EXTERNAL_SESSION_HOOK_LIMITS;
    const record = readRecord(
        value,
        ['eventId', 'nativeEventName', 'entryIndex', 'entry'],
        ['eventId', 'nativeEventName', 'entryIndex', 'entry'],
        'resolveInstallation custody entry',
    );
    const entry = readRecord(
        record.entry,
        ['matcher', 'hooks'],
        ['matcher', 'hooks'],
        'resolveInstallation custody generated entry',
    );
    const matcher = entry.matcher === null
        ? null
        : normalizedString(
            entry.matcher,
            limits.maxIdCodeUnits,
            'resolveInstallation custody matcher',
        );
    const hookValue = readArray(
        entry.hooks,
        1,
        1,
        'resolveInstallation custody generated hooks',
    )[0];
    const hook = readRecord(
        hookValue,
        ['type', 'command', 'timeout'],
        ['type', 'command', 'timeout'],
        'resolveInstallation custody generated hook',
    );
    if (hook.type !== 'command') {
        return invalid(
            'resolveInstallation custody generated hook',
            'has an unsupported type',
        );
    }
    return Object.freeze({
        eventId: normalizedString(
            record.eventId,
            limits.maxIdCodeUnits,
            'resolveInstallation custody eventId',
        ),
        nativeEventName: boundedString(
            record.nativeEventName,
            limits.maxNativeNameCodeUnits,
            'resolveInstallation custody nativeEventName',
        ),
        entryIndex: safeInteger(
            record.entryIndex,
            'resolveInstallation custody entryIndex',
        ),
        entry: Object.freeze({
            matcher,
            hooks: Object.freeze([Object.freeze({
                type: 'command' as const,
                command: boundedString(
                    hook.command,
                    limits.maxJsonUtf8Bytes,
                    'resolveInstallation custody command',
                ),
                timeout: safeInteger(
                    hook.timeout,
                    'resolveInstallation custody timeout',
                    1,
                ),
            })]) as readonly [Readonly<{
                type: 'command';
                command: string;
                timeout: number;
            }>],
        }),
    });
}

function snapshotCustody(
    value: unknown,
): AgentExternalSessionHookCustodiedEntryProjection {
    const limits = AGENT_EXTERNAL_SESSION_HOOK_LIMITS;
    const record = readRecord(
        value,
        ['variantId', 'targets'],
        ['variantId', 'targets'],
        'resolveInstallation custody',
    );
    let totalEntries = 0;
    const targets = readArray(
        record.targets,
        1,
        limits.maxTargetsPerVariant,
        'resolveInstallation custody targets',
    ).map((targetValue) => {
        const target = readRecord(
            targetValue,
            ['targetId', 'absolutePath', 'entries'],
            ['targetId', 'absolutePath', 'entries'],
            'resolveInstallation custody target',
        );
        const entries = readArray(
            target.entries,
            1,
            limits.maxEventsPerVariant,
            'resolveInstallation custody target entries',
        ).map(snapshotCustodyEntry);
        totalEntries += entries.length;
        return Object.freeze({
            targetId: normalizedString(
                target.targetId,
                limits.maxIdCodeUnits,
                'resolveInstallation custody targetId',
            ),
            absolutePath: absolutePath(target.absolutePath),
            entries: Object.freeze(entries),
        });
    });
    if (totalEntries > limits.maxEventsPerVariant) {
        return invalid(
            'resolveInstallation custody',
            `must contain at most ${limits.maxEventsPerVariant} total entries`,
        );
    }
    unique(
        targets.map((target) => target.targetId),
        'resolveInstallation custody targets',
    );
    unique(
        targets.map((target) => target.absolutePath),
        'resolveInstallation custody target paths',
    );
    unique(
        targets.flatMap((target) => target.entries.map((entry) => entry.eventId)),
        'resolveInstallation custody entries',
    );
    return Object.freeze({
        variantId: normalizedString(
            record.variantId,
            limits.maxIdCodeUnits,
            'resolveInstallation custody variantId',
        ),
        targets: Object.freeze(targets),
    });
}

function snapshotVariant(value: unknown): AgentExternalSessionHookInstallationVariant {
    const limits = AGENT_EXTERNAL_SESSION_HOOK_LIMITS;
    const record = readRecord(
        value,
        ['variantId', 'targets', 'events'],
        ['variantId', 'targets', 'events'],
        'installation variant',
    );
    const targets = readArray(
        record.targets,
        1,
        limits.maxTargetsPerVariant,
        'installation variant targets',
    ).map((targetValue) => {
        const target = readRecord(
            targetValue,
            ['targetId', 'format', 'collectionId'],
            ['targetId', 'format', 'collectionId'],
            'installation variant target',
        );
        if (target.format !== 'hook_event_json_arrays_v1') {
            return invalid('installation variant target', 'has an unsupported format');
        }
        return Object.freeze({
            targetId: normalizedString(target.targetId, limits.maxIdCodeUnits, 'targetId'),
            format: 'hook_event_json_arrays_v1' as const,
            collectionId: normalizedString(
                target.collectionId,
                limits.maxIdCodeUnits,
                'collectionId',
            ),
        });
    });
    unique(targets.map((target) => target.targetId), 'installation variant targets');
    unique(
        targets.map((target) => target.collectionId),
        'installation variant collections',
    );
    const targetIds = new Set(targets.map((target) => target.targetId));
    const events = readArray(
        record.events,
        1,
        limits.maxEventsPerVariant,
        'installation variant events',
    ).map((eventValue) => {
        const event = readRecord(
            eventValue,
            ['eventId', 'targetId', 'nativeEventName', 'command'],
            ['eventId', 'targetId', 'nativeEventName', 'command'],
            'installation variant event',
        );
        const targetId = normalizedString(
            event.targetId,
            limits.maxIdCodeUnits,
            'event targetId',
        );
        if (!targetIds.has(targetId)) {
            return invalid('installation variant event', 'references an unknown target');
        }
        const command = readRecord(
            event.command,
            ['kind', 'shellDialect', 'matcher', 'timeoutMs'],
            ['kind', 'shellDialect'],
            'installation variant command',
        );
        if (command.kind !== 'happier_observation_v1') {
            return invalid('installation variant command', 'has an unsupported kind');
        }
        if (
            command.shellDialect !== 'posix'
            && command.shellDialect !== 'windows_cmd'
        ) {
            return invalid(
                'installation variant command',
                'has an unsupported shellDialect',
            );
        }
        const matcher = command.matcher === undefined
            ? undefined
            : normalizedString(command.matcher, limits.maxIdCodeUnits, 'matcher');
        const timeoutMs = command.timeoutMs === undefined
            ? undefined
            : safeInteger(command.timeoutMs, 'timeoutMs', 1);
        return Object.freeze({
            eventId: normalizedString(event.eventId, limits.maxIdCodeUnits, 'eventId'),
            targetId,
            nativeEventName: boundedString(
                event.nativeEventName,
                limits.maxNativeNameCodeUnits,
                'nativeEventName',
            ),
            command: Object.freeze({
                kind: 'happier_observation_v1' as const,
                shellDialect: command.shellDialect,
                ...(matcher === undefined ? {} : { matcher }),
                ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }),
        });
    });
    unique(events.map((event) => event.eventId), 'installation variant events');
    return Object.freeze({
        variantId: normalizedString(record.variantId, limits.maxIdCodeUnits, 'variantId'),
        targets: Object.freeze(targets),
        events: Object.freeze(events),
    });
}

export function validateAgentExternalSessionHooksContribution(
    value: unknown,
): AgentExternalSessionHooksContribution {
    const receiver = requireStaticRegistrationObject(
        value,
        'External Session hooks contribution',
    );
    const resolveInstallation = captureStaticRegistrationMethod<
        AgentExternalSessionHooksContribution['resolveInstallation']
    >(
        receiver,
        'resolveInstallation',
        'External Session hooks contribution.resolveInstallation',
        true,
    )!;
    const mapHookEvent = captureStaticRegistrationMethod<
        AgentExternalSessionHooksContribution['mapHookEvent']
    >(
        receiver,
        'mapHookEvent',
        'External Session hooks contribution.mapHookEvent',
        true,
    )!;
    const installationVariants = readArray(
        Reflect.get(receiver, 'installationVariants'),
        1,
        AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxInstallationVariants,
        'installationVariants',
    ).map(snapshotVariant);
    unique(
        installationVariants.map((variant) => variant.variantId),
        'installationVariants',
    );
    return Object.freeze({
        installationVariants: Object.freeze(installationVariants),
        resolveInstallation,
        mapHookEvent,
    });
}

type CallbackName = keyof typeof AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks;

function snapshotInvocation(
    record: Readonly<Record<string, unknown>>,
    callbackName: CallbackName,
): AgentExternalSessionsInvocationBounds {
    if (!(record.signal instanceof AbortSignal)) {
        return invalid(`${callbackName} request`, 'signal must be an AbortSignal');
    }
    const deadlineAtMs = safeInteger(record.deadlineAtMs, `${callbackName} deadlineAtMs`);
    const maxSerializedBytes = safeInteger(
        record.maxSerializedBytes,
        `${callbackName} maxSerializedBytes`,
        1,
    );
    const ceiling =
        AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks[callbackName].maxEnvelopeUtf8Bytes;
    if (maxSerializedBytes > ceiling) {
        return invalid(`${callbackName} request`, 'maxSerializedBytes exceeds the callback ceiling');
    }
    return Object.freeze({
        signal: record.signal,
        deadlineAtMs,
        maxSerializedBytes,
    });
}

function enforceRequestEnvelope(
    snapshot: Readonly<Record<string, unknown>>,
    callbackName: CallbackName,
): void {
    const { signal: _signal, ...serialized } = snapshot;
    enforceEnvelope(
        serialized,
        AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks[callbackName].maxEnvelopeUtf8Bytes,
        `${callbackName} request`,
    );
}

export function validateAgentExternalSessionHookResolveInstallationRequest(
    value: unknown,
): AgentExternalSessionHookResolveInstallationRequest {
    const record = readRecord(
        value,
        ['signal', 'deadlineAtMs', 'maxSerializedBytes', 'installation', 'custody'],
        ['signal', 'deadlineAtMs', 'maxSerializedBytes', 'installation'],
        'resolveInstallation request',
    );
    const invocation = snapshotInvocation(record, 'resolveInstallation');
    const installation = readRecord(
        record.installation,
        [
            'installationIdentity',
            'executableIdentity',
            'installedVersion',
            'platform',
            'architecture',
        ],
        [
            'installationIdentity',
            'executableIdentity',
            'installedVersion',
            'platform',
            'architecture',
        ],
        'resolveInstallation installation',
    );
    if (installation.platform !== 'darwin'
        && installation.platform !== 'linux'
        && installation.platform !== 'win32') {
        return invalid('resolveInstallation installation', 'has an unsupported platform');
    }
    const snapshot = Object.freeze({
        ...invocation,
        installation: Object.freeze({
            installationIdentity: normalizedString(
                installation.installationIdentity,
                AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxIdCodeUnits,
                'installationIdentity',
            ),
            executableIdentity: normalizedString(
                installation.executableIdentity,
                AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxIdCodeUnits,
                'executableIdentity',
            ),
            installedVersion: boundedString(
                installation.installedVersion,
                AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxInstalledVersionCodeUnits,
                'installedVersion',
            ),
            platform: installation.platform,
            architecture: boundedString(
                installation.architecture,
                AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxArchitectureCodeUnits,
                'architecture',
            ),
        }),
        ...(record.custody === undefined
            ? {}
            : { custody: snapshotCustody(record.custody) }),
    });
    enforceRequestEnvelope(snapshot, 'resolveInstallation');
    return snapshot;
}

function snapshotRemediation(value: unknown): PluginDiagnosticData['remediation'] {
    const kindRecord = readRecord(
        value,
        ['kind', 'path', 'service', 'dependencyId', 'url'],
        ['kind'],
        'diagnostic remediation',
    );
    if (kindRecord.kind === 'retry') {
        readRecord(value, ['kind'], ['kind'], 'diagnostic remediation');
        return Object.freeze({ kind: 'retry' });
    }
    if (kindRecord.kind === 'openSettings') {
        const record = readRecord(
            value,
            ['kind', 'path'],
            ['kind', 'path'],
            'diagnostic remediation',
        );
        return Object.freeze({
            kind: 'openSettings',
            path: boundedString(record.path, 4_096, 'diagnostic settings path'),
        });
    }
    if (kindRecord.kind === 'installDependency') {
        const record = readRecord(
            value,
            ['kind', 'dependencyId'],
            ['kind', 'dependencyId'],
            'diagnostic remediation',
        );
        return Object.freeze({
            kind: 'installDependency',
            dependencyId: normalizedString(
                record.dependencyId,
                AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxIdCodeUnits,
                'diagnostic dependencyId',
            ),
        });
    }
    if (kindRecord.kind === 'openUrl') {
        const record = readRecord(
            value,
            ['kind', 'url'],
            ['kind', 'url'],
            'diagnostic remediation',
        );
        return Object.freeze({
            kind: 'openUrl',
            url: boundedString(record.url, 4_096, 'diagnostic URL'),
        });
    }
    if (kindRecord.kind === 'selectAccount') {
        const record = readRecord(
            value,
            ['kind', 'service'],
            ['kind', 'service'],
            'diagnostic remediation',
        );
        const service = readRecord(
            record.service,
            ['pluginId', 'localId'],
            ['pluginId', 'localId'],
            'diagnostic service',
        );
        return Object.freeze({
            kind: 'selectAccount',
            service: Object.freeze({
                pluginId: normalizedString(
                    service.pluginId,
                    AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxIdCodeUnits,
                    'diagnostic service pluginId',
                ),
                localId: normalizedString(
                    service.localId,
                    AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxIdCodeUnits,
                    'diagnostic service localId',
                ),
            }),
        });
    }
    return invalid('diagnostic remediation', 'has an unsupported kind');
}

function snapshotDiagnostic(value: unknown): PluginDiagnosticData {
    const record = readRecord(
        value,
        ['code', 'severity', 'message', 'details', 'remediation'],
        ['code', 'severity'],
        'diagnostic',
    );
    if (record.severity !== 'info'
        && record.severity !== 'warning'
        && record.severity !== 'error') {
        return invalid('diagnostic', 'has an unsupported severity');
    }
    return Object.freeze({
        code: normalizedString(
            record.code,
            AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxIdCodeUnits,
            'diagnostic code',
        ),
        severity: record.severity,
        ...(record.message === undefined
            ? {}
            : {
                message: boundedString(
                    record.message,
                    AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxDiagnosticMessageCodeUnits,
                    'diagnostic message',
                    true,
                ),
            }),
        ...(record.details === undefined
            ? {}
            : { details: snapshotStrictJsonValue(record.details, 'diagnostic details') }),
        ...(record.remediation === undefined
            ? {}
            : { remediation: snapshotRemediation(record.remediation) }),
    });
}

function snapshotFailure(
    record: Readonly<Record<string, unknown>>,
    label: string,
): AgentExternalSessionsResult<never> {
    if (typeof record.code !== 'string' || !FAILURE_CODES.has(record.code)) {
        return invalid(label, 'has an unsupported failure code');
    }
    if (record.message !== undefined) {
        boundedString(
            record.message,
            AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxFailureMessageCodeUnits,
            `${label} message`,
            true,
        );
    }
    if (record.retryable !== undefined && typeof record.retryable !== 'boolean') {
        return invalid(label, 'has an invalid retryable flag');
    }
    return Object.freeze({
        ok: false,
        code: record.code,
        ...(record.message === undefined ? {} : { message: record.message }),
        ...(record.retryable === undefined ? {} : { retryable: record.retryable }),
    }) as AgentExternalSessionsResult<never>;
}

function snapshotResult<T>(
    value: unknown,
    label: string,
    callbackName: CallbackName,
    snapshotValue: (input: unknown) => T,
): AgentExternalSessionsResult<T> {
    const record = readRecord(
        value,
        ['ok', 'value', 'code', 'message', 'retryable'],
        ['ok'],
        `${label} result`,
    );
    let snapshot: AgentExternalSessionsResult<T>;
    if (record.ok === true) {
        if (!Object.hasOwn(record, 'value')
            || Object.hasOwn(record, 'code')
            || Object.hasOwn(record, 'message')
            || Object.hasOwn(record, 'retryable')) {
            return invalid(`${label} result`, 'has an invalid success envelope');
        }
        snapshot = Object.freeze({ ok: true, value: snapshotValue(record.value) });
    } else if (record.ok === false) {
        if (Object.hasOwn(record, 'value') || !Object.hasOwn(record, 'code')) {
            return invalid(`${label} result`, 'has an invalid failure envelope');
        }
        snapshot = snapshotFailure(record, `${label} result`) as AgentExternalSessionsResult<T>;
    } else {
        return invalid(`${label} result`, 'ok must be boolean');
    }
    enforceEnvelope(
        snapshot,
        AGENT_EXTERNAL_SESSION_HOOK_LIMITS.callbacks[callbackName].maxEnvelopeUtf8Bytes,
        `${label} result`,
    );
    return snapshot;
}

export function validateAgentExternalSessionHookResolveInstallationResult(
    value: unknown,
    declaredVariant?: AgentExternalSessionHookInstallationVariant,
): AgentExternalSessionHookResolveInstallationResult {
    return snapshotResult(
        value,
        'resolveInstallation',
        'resolveInstallation',
        (input): AgentExternalSessionHookResolveInstallationValue => {
            const record = readRecord(
                input,
                ['kind', 'variantId', 'targets', 'readiness', 'reason'],
                ['kind'],
                'resolveInstallation value',
            );
            if (record.kind === 'unsupported') {
                if (Object.hasOwn(record, 'variantId')
                    || Object.hasOwn(record, 'targets')
                    || Object.hasOwn(record, 'readiness')
                    || (record.reason !== 'version_unsupported'
                        && record.reason !== 'installation_unsupported')) {
                    return invalid('resolveInstallation value', 'has an invalid unsupported shape');
                }
                return Object.freeze({ kind: 'unsupported', reason: record.reason });
            }
            if (record.kind !== 'supported'
                || !Object.hasOwn(record, 'variantId')
                || !Object.hasOwn(record, 'targets')
                || !Object.hasOwn(record, 'readiness')
                || Object.hasOwn(record, 'reason')) {
                return invalid('resolveInstallation value', 'has an invalid supported shape');
            }
            const variantId = normalizedString(
                record.variantId,
                AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxIdCodeUnits,
                'variantId',
            );
            const targets = readArray(
                record.targets,
                1,
                AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxTargetsPerVariant,
                'resolveInstallation targets',
            ).map((targetValue) => {
                const target = readRecord(
                    targetValue,
                    ['targetId', 'absolutePath'],
                    ['targetId', 'absolutePath'],
                    'resolveInstallation target',
                );
                return Object.freeze({
                    targetId: normalizedString(
                        target.targetId,
                        AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxIdCodeUnits,
                        'targetId',
                    ),
                    absolutePath: absolutePath(target.absolutePath),
                });
            });
            unique(targets.map((target) => target.targetId), 'resolveInstallation targets');
            unique(
                targets.map((target) => target.absolutePath),
                'resolveInstallation target paths',
            );
            if (declaredVariant !== undefined) {
                const expectedVariant = snapshotVariant(declaredVariant);
                if (variantId !== expectedVariant.variantId) {
                    return invalid(
                        'resolveInstallation value',
                        'does not select the declared variant',
                    );
                }
                const expectedTargetIds = expectedVariant.targets.map((target) => target.targetId);
                if (expectedTargetIds.length !== targets.length
                    || expectedTargetIds.some(
                        (targetId) => !targets.some((target) => target.targetId === targetId),
                    )) {
                    return invalid(
                        'resolveInstallation value',
                        'must resolve every declared target exactly once',
                    );
                }
            }
            const readinessRecord = readRecord(
                record.readiness,
                ['kind', 'diagnostic'],
                ['kind'],
                'resolveInstallation readiness',
            );
            let readiness: Extract<
                AgentExternalSessionHookResolveInstallationValue,
                Readonly<{ kind: 'supported' }>
            >['readiness'];
            if (readinessRecord.kind === 'ready') {
                if (Object.hasOwn(readinessRecord, 'diagnostic')) {
                    return invalid('resolveInstallation readiness', 'ready has a diagnostic');
                }
                readiness = Object.freeze({ kind: 'ready' });
            } else if (readinessRecord.kind === 'needs_attention'
                && Object.hasOwn(readinessRecord, 'diagnostic')) {
                readiness = Object.freeze({
                    kind: 'needs_attention',
                    diagnostic: snapshotDiagnostic(readinessRecord.diagnostic),
                });
            } else {
                return invalid('resolveInstallation readiness', 'has an invalid shape');
            }
            return Object.freeze({
                kind: 'supported',
                variantId,
                targets: Object.freeze(targets),
                readiness,
            });
        },
    );
}

export function validateAgentExternalSessionHookMapEventRequest(
    value: unknown,
): AgentExternalSessionHookMapEventRequest {
    const record = readRecord(
        value,
        [
            'signal',
            'deadlineAtMs',
            'maxSerializedBytes',
            'installationIdentity',
            'variantId',
            'eventId',
            'observedAtMs',
            'nativePayload',
        ],
        [
            'signal',
            'deadlineAtMs',
            'maxSerializedBytes',
            'installationIdentity',
            'variantId',
            'eventId',
            'observedAtMs',
            'nativePayload',
        ],
        'mapHookEvent request',
    );
    const invocation = snapshotInvocation(record, 'mapHookEvent');
    const snapshot = Object.freeze({
        ...invocation,
        installationIdentity: normalizedString(
            record.installationIdentity,
            AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxIdCodeUnits,
            'installationIdentity',
        ),
        variantId: normalizedString(
            record.variantId,
            AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxIdCodeUnits,
            'variantId',
        ),
        eventId: normalizedString(
            record.eventId,
            AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxIdCodeUnits,
            'eventId',
        ),
        observedAtMs: safeInteger(record.observedAtMs, 'observedAtMs'),
        nativePayload: snapshotStrictJsonValue(
            record.nativePayload,
            'mapHookEvent nativePayload',
        ),
    });
    enforceRequestEnvelope(snapshot, 'mapHookEvent');
    return snapshot;
}

function snapshotSource(value: unknown): AgentExternalSessionSource {
    let source: AgentExternalSessionLinkData;
    try {
        source = PluginAgentExternalSessionLinkDataSchema.parse(value);
    } catch {
        return invalid('mapHookEvent sourceInput', 'must be strict bounded JSON');
    }
    const kindDescriptor = Object.getOwnPropertyDescriptor(source, 'kind');
    if (!kindDescriptor || !('value' in kindDescriptor)) {
        return invalid('mapHookEvent sourceInput', 'must contain kind');
    }
    boundedString(kindDescriptor.value, 256, 'mapHookEvent sourceInput kind');
    if (serializedUtf8Bytes(source) > AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxJsonUtf8Bytes) {
        return invalid('mapHookEvent sourceInput', 'exceeds the JSON byte limit');
    }
    return source as AgentExternalSessionSource;
}

function snapshotLinkData(value: unknown): AgentExternalSessionLinkData {
    let linkData: AgentExternalSessionLinkData;
    try {
        linkData = PluginAgentExternalSessionLinkDataSchema.parse(value);
    } catch {
        return invalid('mapHookEvent linkData', 'must be strict bounded JSON');
    }
    if (serializedUtf8Bytes(linkData) > AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxJsonUtf8Bytes) {
        return invalid('mapHookEvent linkData', 'exceeds the JSON byte limit');
    }
    return linkData;
}

function snapshotFact(value: unknown): AgentExternalSessionHookObservationFact {
    readRecord(
        value,
        [
            'kind',
            'value',
            'boundaryId',
            'emptyTurnPhase',
            'axis',
            'evidenceClass',
            'observedAtMs',
            'expiresAtMs',
        ],
        ['kind', 'evidenceClass', 'observedAtMs'],
        'mapHookEvent fact',
    );
    let fact: AgentExternalSessionHookObservationFact;
    try {
        fact = ExternalAgentObservationLeafFactV1Schema.parse(value);
    } catch {
        return invalid('mapHookEvent fact', 'has an invalid fact shape');
    }
    if (fact.evidenceClass !== 'qualified_hook') {
        return invalid('mapHookEvent fact', 'must use qualified_hook evidence');
    }
    return Object.freeze(fact);
}

export function validateAgentExternalSessionHookMapEventResult(
    value: unknown,
): AgentExternalSessionHookMapEventResult {
    return snapshotResult(
        value,
        'mapHookEvent',
        'mapHookEvent',
        (input): AgentExternalSessionHookMapEventValue => {
            const record = readRecord(
                input,
                [
                    'kind',
                    'sourceInput',
                    'remoteSessionId',
                    'linkData',
                    'createdAtMs',
                    'facts',
                ],
                ['kind'],
                'mapHookEvent value',
            );
            if (record.kind === 'ignored') {
                if (Reflect.ownKeys(record).length !== 1) {
                    return invalid('mapHookEvent value', 'ignored must contain only kind');
                }
                return Object.freeze({ kind: 'ignored' });
            }
            if (record.kind !== 'mapped'
                || !Object.hasOwn(record, 'sourceInput')
                || !Object.hasOwn(record, 'remoteSessionId')
                || !Object.hasOwn(record, 'facts')) {
                return invalid('mapHookEvent value', 'has an invalid mapped shape');
            }
            const facts = readArray(
                record.facts,
                0,
                AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxMappedFacts,
                'mapHookEvent facts',
            ).map(snapshotFact);
            return Object.freeze({
                kind: 'mapped',
                sourceInput: snapshotSource(record.sourceInput),
                remoteSessionId: normalizedString(
                    record.remoteSessionId,
                    AGENT_EXTERNAL_SESSION_HOOK_LIMITS.maxRemoteSessionIdCodeUnits,
                    'remoteSessionId',
                ),
                ...(record.linkData === undefined
                    ? {}
                    : { linkData: snapshotLinkData(record.linkData) }),
                ...(record.createdAtMs === undefined
                    ? {}
                    : { createdAtMs: safeInteger(record.createdAtMs, 'createdAtMs') }),
                facts: Object.freeze(facts),
            });
        },
    );
}
