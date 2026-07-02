import {
    SessionStateUsageLimitRecoveryValueSchema,
    SessionStateWorkStateValueSchema,
} from '@happier-dev/protocol';

import {
    createRegisteredSessionStateFieldMutation,
    type RegisteredSessionStateFieldMutationV1,
} from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { resolveRegisteredSessionStateFieldDeliveryClass } from '@/agent/runtime/state/registeredFieldDurability';

type DurableRegisteredMetadataSpec = Readonly<{
    metadataKey: string;
    fieldId: RegisteredSessionStateFieldMutationV1['fieldId'];
    parse: (value: unknown) => unknown | null;
}>;

const DURABLE_REGISTERED_METADATA_SPECS: readonly DurableRegisteredMetadataSpec[] = Object.freeze([
    {
        metadataKey: 'sessionWorkStateV1',
        fieldId: 'runtime.workState',
        parse: (value) => {
            const parsed = SessionStateWorkStateValueSchema.safeParse(value);
            return parsed.success ? parsed.data : null;
        },
    },
    {
        metadataKey: 'sessionUsageLimitRecoveryV1',
        fieldId: 'runtime.usageLimitRecovery',
        parse: (value) => {
            const parsed = SessionStateUsageLimitRecoveryValueSchema.safeParse(value);
            return parsed.success ? parsed.data : null;
        },
    },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function areJsonEquivalent(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function splitDurableRegisteredSessionStateMetadata(params: Readonly<{
    sessionId: string;
    current: unknown;
    candidate: unknown;
    source: RegisteredSessionStateFieldMutationV1['source'];
}>): Readonly<{
    metadata: Record<string, unknown>;
    mutations: readonly RegisteredSessionStateFieldMutationV1[];
}> {
    const currentRecord = isRecord(params.current) ? params.current : {};
    const candidateRecord = isRecord(params.candidate) ? params.candidate : {};
    const metadata: Record<string, unknown> = { ...candidateRecord };
    const mutations: RegisteredSessionStateFieldMutationV1[] = [];

    for (const spec of DURABLE_REGISTERED_METADATA_SPECS) {
        if (!hasOwn(candidateRecord, spec.metadataKey)) continue;

        const candidateValue = candidateRecord[spec.metadataKey];
        const currentValue = currentRecord[spec.metadataKey];
        const deliveryClass = resolveRegisteredSessionStateFieldDeliveryClass(spec.fieldId);
        if (!deliveryClass) continue;
        if (candidateValue === null) {
            mutations.push(createRegisteredSessionStateFieldMutation({
                sessionId: params.sessionId,
                fieldId: spec.fieldId,
                deliveryClass,
                source: params.source,
                op: { kind: 'clear' },
            }));
        } else {
            const parsedCandidate = spec.parse(candidateValue);
            if (parsedCandidate === null) continue;
            const parsedCurrent = currentValue === null || currentValue === undefined
                ? null
                : spec.parse(currentValue);
            if (areJsonEquivalent(parsedCandidate, parsedCurrent)) {
                continue;
            }
            mutations.push(createRegisteredSessionStateFieldMutation({
                sessionId: params.sessionId,
                fieldId: spec.fieldId,
                deliveryClass,
                source: params.source,
                op: { kind: 'set', value: parsedCandidate },
            }));
        }

        if (hasOwn(currentRecord, spec.metadataKey)) {
            metadata[spec.metadataKey] = currentRecord[spec.metadataKey];
        } else {
            delete metadata[spec.metadataKey];
        }
    }

    return { metadata, mutations };
}
