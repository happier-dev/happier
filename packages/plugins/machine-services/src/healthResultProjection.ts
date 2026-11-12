import { HealthCheckResultV1ProtocolSchema, createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

/** A presentation of the observer's retained checkpoint, inside the existing encrypted Account KV row. */
export const HEALTH_RESULT_CHECKPOINT_PREFIX = 'health:';
export const healthResultProjectionSchema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    members: defineProtocolArray(defineProtocolObject({ automationId: defineProtocolString(), triggerId: defineProtocolString(),
        triggerRevision: defineProtocolNumber({ integer: true, minimum: 1 }), sourceSelectorId: defineProtocolString(),
    }, { policy: 'closed' })),
    checks: defineProtocolArray(defineProtocolObject({ checkId: defineProtocolString(), result: HealthCheckResultV1ProtocolSchema }, { policy: 'closed' })),
}, { policy: 'closed' });
export type HealthResultProjection = ReturnType<typeof healthResultProjectionSchema.parse>;

/** Observation clocks and latency are request freshness, not a changed health condition. */
export function healthResultProjectionIdentity(value: HealthResultProjection): string {
    return createCanonicalJsonSigningInput({ ...value, checks: value.checks.map(({ checkId, result }) => {
        const { observedAt: _clock, latencyMs: _latency, ...condition } = result;
        return { checkId, result: condition };
    }) });
}
