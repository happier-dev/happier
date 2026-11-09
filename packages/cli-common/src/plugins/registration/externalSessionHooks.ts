import type { CapturedMethod } from './staticCapture.js';
import { captureStaticRegistrationMethod, requireStaticRegistrationObject } from './staticCapture.js';

export {
    invalid as invalidAgentExternalSessionHooks,
    readRecord as readAgentExternalSessionHookRecord,
    readArray as readAgentExternalSessionHookArray,
    normalizedString as normalizeAgentExternalSessionHookString,
    boundedString as readBoundedAgentExternalSessionHookString,
    safeInteger as readAgentExternalSessionHookSafeInteger,
    unique as requireUniqueAgentExternalSessionHookValues,
};

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
            /**
             * The shell the Agent runs this hook entry through. It selects the
             * host serializer that quotes the generated command, so a variant
             * whose dialect the current platform cannot execute is refused by
             * the host rather than installed as an unrunnable entry.
             */
            shellDialect: 'posix' | 'windows_cmd' | 'powershell_encoded';
            matcher?: string;
            timeoutMs?: number;
        }>;
    }>[];
}>;

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

export function snapshotVariant(value: unknown): AgentExternalSessionHookInstallationVariant {
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
            && command.shellDialect !== 'powershell_encoded'
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
) {
    readRecord(
        value,
        ['installationVariants', 'resolveInstallation', 'mapHookEvent'],
        ['installationVariants', 'resolveInstallation', 'mapHookEvent'],
        'contribution',
    );
    const receiver = requireStaticRegistrationObject(
        value,
        'External Session hooks contribution',
    );
    const resolveInstallation = captureStaticRegistrationMethod<CapturedMethod>(
        receiver,
        'resolveInstallation',
        'External Session hooks contribution.resolveInstallation',
        true,
    )!;
    const mapHookEvent = captureStaticRegistrationMethod<CapturedMethod>(
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
