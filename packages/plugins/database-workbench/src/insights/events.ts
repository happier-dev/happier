import { computeCanonicalDomainSeparatedDigest, createCanonicalJsonSigningInput, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { AutomationDatabaseSubjectV1ProtocolSchema, automationSubjectKeyV1, projectAutomationDatabaseSubjectV1,
    type AutomationDatabaseSubjectV1 } from '@happier-dev/plugin-sdk/events';
import { admitCheckpointedPluginEventObservationV1, createPluginEventAutomationSetupResultV1JsonSchema,
    type PluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import {
    DatabaseFindingObservationV1ProtocolSchema,
    type DatabaseFindingObservationV1,
} from '@happier-dev/plugin-sdk/database';
import { DATABASE_FINDING_EVENT_REF, DatabaseFindingEventSourceV1Schema, type DatabaseFindingEventSourceV1 } from './findingEventSource.js';

export { DATABASE_FINDING_EVENT_REF } from './findingEventSource.js';
export const DATABASE_FINDING_SETUP_LOCAL_ID = 'insights/observation/setup';
export const DATABASE_FINDING_SOURCE_CONTRACT_VERSION = 1;

export const DatabaseFindingEventPayloadV1Schema = defineProtocolObject({
    subject: AutomationDatabaseSubjectV1ProtocolSchema, observation: DatabaseFindingObservationV1ProtocolSchema,
}, { policy: 'closed' });

/** A source identifies this Machine's observations, not a global database incident. */
export function databaseFindingEventSourceInstanceId(source: DatabaseFindingEventSourceV1): string {
    return computeCanonicalDomainSeparatedDigest('happier.database.finding-source.v1', [
        source.subject === undefined ? '' : automationSubjectKeyV1(source.subject),
        createCanonicalJsonSigningInput(source.sourceScope),
    ]);
}

/** Arming observes future completed reads; setup performs no database operation. */
export const databaseFindingEventSetupAction = {
    title: 'Observe database findings', execution: { target: 'daemon' as const },
    scopes: ['global', 'machine'] as const, surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'] as const,
    dangerLevel: 'safe' as const, readOnly: true,
    inputSchema: DatabaseFindingEventSourceV1Schema,
    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(DATABASE_FINDING_SOURCE_CONTRACT_VERSION,
        DatabaseFindingEventSourceV1Schema.jsonSchema),
    async run(input: unknown) {
        const source = DatabaseFindingEventSourceV1Schema.parse(input);
        return { v: 1 as const, sourceInstanceId: databaseFindingEventSourceInstanceId(source),
            sourceContractVersion: DATABASE_FINDING_SOURCE_CONTRACT_VERSION,
            sourceConfig: source, displayLabel: 'Database observations' };
    },
};

export const databaseFindingEvent = {
    declaration: { kind: 'event' as const, title: 'Database finding observed',
        description: 'A completed database observation contains finding evidence.',
        payloadSchema: DatabaseFindingEventPayloadV1Schema.jsonSchema,
        automation: { v: 1 as const, eligible: true as const, subjectKinds: ['database' as const], source: {
            sourceContractVersion: DATABASE_FINDING_SOURCE_CONTRACT_VERSION,
            supportedObservationTransports: ['checkpointedPull' as const],
            sourceConfigSchema: DatabaseFindingEventSourceV1Schema.jsonSchema,
            setupActionRef: { pluginId: DATABASE_FINDING_EVENT_REF.pluginId, localId: DATABASE_FINDING_SETUP_LOCAL_ID },
        } },
    },
};

/** AE owns matching, conditions and occurrence dedupe. No source-local seen store. */
export async function emitDatabaseFindingObservation(input: Readonly<{
    observation: DatabaseFindingObservationV1;
    subject: AutomationDatabaseSubjectV1;
    /** The producer retains this fact when replaying the same evidence. */
    observationReceivedAt: number;
    observedDelta: 0 | 1;
}>, context: PluginInvocationContext): Promise<void> {
    const subject = projectAutomationDatabaseSubjectV1(input.subject);
    const observation = input.observation;
    const source = { v: 1 as const, subject, sourceScope: observation.sourceScope };
    const evidence: Omit<PluginEventObservationV1, 'sourceInstanceId'> = {
        eventRef: DATABASE_FINDING_EVENT_REF,
        sourceContractVersion: DATABASE_FINDING_SOURCE_CONTRACT_VERSION,
        occurrenceId: computeCanonicalDomainSeparatedDigest('happier.database.finding-evidence.v1', [
            createCanonicalJsonSigningInput(observation.sourceRef), observation.evidenceIdentity,
        ]),
        occurredAt: observation.observedWindow.toMs,
        observationReceivedAt: input.observationReceivedAt, observedDelta: input.observedDelta,
        payload: DatabaseFindingEventPayloadV1Schema.parse({ subject, observation }),
        subjectContexts: [{ role: 'operand', subject }],
    };
    // One completed read supplies the Machine-wide source and its exact Database source.
    await Promise.all([
        databaseFindingEventSourceInstanceId({ v: 1, sourceScope: observation.sourceScope }),
        databaseFindingEventSourceInstanceId(source),
    ].map(sourceInstanceId => admitCheckpointedPluginEventObservationV1({ ...evidence, sourceInstanceId }, context)));
}
