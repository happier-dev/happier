import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HealthCheckSubjectV1ProtocolSchema,
    computeCanonicalDomainSeparatedDigest, createCanonicalJsonSigningInput, type HealthCheckSubjectV1 } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

export { HealthCheckSetupInputV1ProtocolSchema, HealthCheckSetupDraftV1ProtocolSchema,
    HEALTH_CHECK_KINDS_V1 } from '@happier-dev/plugin-sdk';
export type { HealthCheckSetupInputV1, HealthCheckSetupDraftV1 } from '@happier-dev/plugin-sdk';

export const MACHINE_SERVICES_PLUGIN_ID = HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1;
export const HEALTH_STATUS_EVENT = 'health-status';
export const HEALTH_CHECK_FAILED_EVENT = 'health-check-failed';
export const HEALTH_CHECK_RECOVERED_EVENT = 'health-check-recovered';
export const HEALTH_SETUP_OPEN_ACTION_ID = 'health/open-setup';

export function createHealthCheckSourceInstanceIdV1(subject: HealthCheckSubjectV1): string {
    return `health:${computeCanonicalDomainSeparatedDigest('happier.health.subject.v1',
        [createCanonicalJsonSigningInput(subject)])}`;
}

/** Opening carries the watched subject; the existing editor chooses the observer independently. */
export const MachineServiceHealthSetupOpenInputV1Schema = defineProtocolObject({
    subject: HealthCheckSubjectV1ProtocolSchema,
    monitoringMachineId: defineProtocolString({ minLength: 1, pattern: '^\\S(?:.*\\S)?$' }).optional(),
}, { policy: 'closed' });

export function createMachineServiceHealthSetupSeedV1(input: ReturnType<typeof MachineServiceHealthSetupOpenInputV1Schema.parse>) {
    return {
        eventRef: { pluginId: MACHINE_SERVICES_PLUGIN_ID, localId: HEALTH_CHECK_FAILED_EVENT },
        sourceInstanceId: createHealthCheckSourceInstanceIdV1(input.subject),
        ...(input.monitoringMachineId ? { monitoringMachineId: input.monitoringMachineId } : {}),
        setupInput: { v: 1 as const, subject: input.subject },
    };
}
