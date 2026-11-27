import { computeCanonicalDomainSeparatedDigest, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { DatabaseCaptureFindingDetailV1ProtocolSchema, TELEMETRY_PRODUCTION_FINDING_SETUP_ACTION_LOCAL_ID_V1 as setupId,
    type DatabaseCaptureFindingDetailV1 } from '@happier-dev/plugin-sdk/database';
import { createPluginEventAutomationSetupResultV1JsonSchema, type PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { PRODUCTION_CAPTURE_FINDING_EVENT_REF_V1 as eventRef, readProductionCaptureFindingGroupKeyV1 } from '@happier-dev/database-protocol';
const sourceContractVersion = 1;
const id = defineProtocolString({ minLength: 1 });
const subjectSchema = defineProtocolObject({
    kind: defineProtocolLiteral('environment'), serverId: id, environmentId: id,
}, { policy: 'closed' });
const setupInputSchema = defineProtocolObject({
    v: defineProtocolLiteral(1), source: subjectSchema,
}, { policy: 'closed' });
const configSchema = defineProtocolObject({
    v: defineProtocolLiteral(1), subject: subjectSchema,
}, { policy: 'closed' });
const payloadSchema = defineProtocolObject({
    subject: subjectSchema, groupKey: id, observation: DatabaseCaptureFindingDetailV1ProtocolSchema,
}, { policy: 'closed' });
type ProductionFindingSubject = ReturnType<typeof subjectSchema.parse>;

export function productionFindingSourceInstanceId(subject: ProductionFindingSubject): string {
    return computeCanonicalDomainSeparatedDigest('happier.telemetry.production-finding-source.v1', [
        subject.serverId, subject.environmentId,
    ]);
}

export const productionFindingEventParts = {
    payloadSchema,
    eventRef,
    configSchema,
    actions: { [setupId]: {
        title: 'Watch production findings',
        description: 'Watch retained application findings in the selected Environment.',
        execution: { target: 'daemon' as const },
        scopes: ['global', 'machine'] as const,
        surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'] as const,
        dangerLevel: 'safe' as const,
        readOnly: true,
        inputSchema: setupInputSchema,
        resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(sourceContractVersion, configSchema.jsonSchema),
        async run(input: unknown, context: PluginInvocationContext) {
            const { source: subject } = setupInputSchema.parse(input);
            const admit = context.services.deploymentDatabases?.admitTelemetryRead;
            if (!admit) throw new PluginError({ code: 'deployment_target_role_unavailable' });
            await admit(subject);
            return { v: 1 as const, sourceInstanceId: productionFindingSourceInstanceId(subject), sourceContractVersion,
                sourceConfig: { v: 1 as const, subject }, displayLabel: 'Production findings' };
        },
    } },
    events: { [eventRef.localId]: { declaration: {
        kind: 'event' as const,
        title: 'Production finding observed',
        description: 'A distinct finding was captured in the selected Environment.',
        payloadSchema: payloadSchema.jsonSchema,
        automation: { v: 1 as const, eligible: true as const, subjectKinds: ['environment' as const], source: {
            sourceContractVersion,
            supportedObservationTransports: ['checkpointedPull' as const],
            sourceConfigSchema: configSchema.jsonSchema,
            setupActionRef: { pluginId: eventRef.pluginId, localId: setupId },
        } },
    } } },
} as const;

/** Collector grouping uses Environment plus the workload-reported label and stable shape.
 * AE turns this evidence key into its own admitted occurrence key. */
export function productionFindingObservation(subject: ProductionFindingSubject,
    observation: DatabaseCaptureFindingDetailV1, observationReceivedAt: number): PluginEventObservationV1 | null {
    const groupKey = readProductionCaptureFindingGroupKeyV1(observation);
    if (!groupKey) return null;
    const sourceInstanceId = productionFindingSourceInstanceId(subject);
    return {
        eventRef, sourceInstanceId, sourceContractVersion,
        occurrenceId: computeCanonicalDomainSeparatedDigest('happier.telemetry.production-finding-group.v1', [
            sourceInstanceId, groupKey,
        ]),
        occurredAt: observation.observedWindow.toMs,
        observationReceivedAt,
        observedDelta: 1,
        payload: payloadSchema.parse({ subject, groupKey, observation }),
        subjectContexts: [{ role: 'operand', subject }],
    };
}
