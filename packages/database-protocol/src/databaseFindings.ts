import { z } from 'zod/mini';
import { MachineTargetV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { AutomationOccurredAtV1Schema } from '@happier-dev/protocol/automations/automationOccurredAtV1';
import { AutomationEventSourceOrOccurrenceIdV1Schema } from '@happier-dev/protocol/automations/automationEventJsonBoundsV1';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { asProtocolZod, projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import { DatabaseEngineIdV1Schema, DatabaseTargetV1Schema, DatabaseWorktreeTargetV1Schema } from './databaseTargets.js';
import { DatabaseFailureV1Schema, DatabaseStatsOperationInputV1Schema } from './databaseOperations.js';
import { ProjectRepositoryObservationV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { SessionInputForgeEvidenceV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputForgeEvidenceV1';
import { PluginJsonSchemaV2Schema } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import { DatabaseStatsCoverageV1Schema, DatabaseStatsGroupV1Schema, DatabaseStatsIntervalBasisV1Schema,
    DatabaseStatsReadV1Schema, DatabaseStatsSizeV1Schema, DatabaseStatsStatementV1Schema,
    DatabaseStatsTableV1Schema, DatabaseStatsIndexV1Schema, DatabaseStatsActivityV1Schema,
    DatabaseStatsReasonV1Schema } from './databaseStats.js';

export const DATABASE_INSIGHT_SOURCES_POINT_ID_V1 = 'insight-sources';
export const DATABASE_INSIGHT_SOURCE_PROTOCOL_ID_V1 = 'happier.database/insight-source';
export const DATABASE_INSIGHT_SOURCES_POINT_REF_V1 = {
    pluginId: 'happier.database', pointId: DATABASE_INSIGHT_SOURCES_POINT_ID_V1,
    protocol: { id: DATABASE_INSIGHT_SOURCE_PROTOCOL_ID_V1, version: 1 },
} as const;

const records = z.number().check(z.int(), z.nonnegative());

/** Numeric evidence only. SQL, result cells and captured bodies have no Event field. */
export const DatabaseFindingSummaryV1Schema = z.extend(z.partial(z.pick(DatabaseStatsStatementV1Schema, {
    calls: true, totalTimeMs: true, rows: true,
})), {
    records,
    size: z.optional(z.pick(DatabaseStatsSizeV1Schema, { bytes: true })),
    maintenance: z.optional(z.pick(DatabaseStatsTableV1Schema, {
        estimatedRows: true, liveRows: true, deadRows: true, sequentialScans: true,
        indexScans: true, rowsRead: true, inserted: true, updated: true, deleted: true,
    })),
    index: z.optional(z.pick(DatabaseStatsIndexV1Schema, {
        scans: true, tuplesRead: true, tuplesFetched: true, bytes: true,
    })),
    blocking: z.optional(z.strictObject({ blockers: records })),
});

const observation = {
    v: z.literal(1), sourceRef: asProtocolZod(PluginContributionIdentityV1Schema),
    sourceScope: MachineTargetV1Schema,
    evidenceIdentity: AutomationEventSourceOrOccurrenceIdV1Schema,
    kind: DatabaseStatsGroupV1Schema,
    observedWindow: z.strictObject({ fromMs: AutomationOccurredAtV1Schema, toMs: AutomationOccurredAtV1Schema }),
    coverage: DatabaseStatsCoverageV1Schema, summary: DatabaseFindingSummaryV1Schema,
};

/** Content-free observation data. AE's subject is composed by the Event source. */
export const DatabaseFindingObservationV1Schema = z.strictObject(observation);
export type DatabaseFindingObservationV1 = z.infer<typeof DatabaseFindingObservationV1Schema>;
export const DatabaseFindingObservationV1ProtocolSchema = projectZodProtocolSchema(DatabaseFindingObservationV1Schema);
export const DatabaseFindingSourceScopeV1ProtocolSchema = projectZodProtocolSchema(MachineTargetV1Schema);

/** Structural names stay source-local; Event observations remain numeric only. */
const findingObject = z.discriminatedUnion('kind', [
    z.extend(z.pick(DatabaseStatsTableV1Schema, { relation: true }), { kind: z.literal('table') }),
    z.extend(z.pick(DatabaseStatsIndexV1Schema, { relation: true, name: true }), { kind: z.literal('index') }),
]);

/** Source-local detail, read on demand through the database Action owner. */
export const DatabaseFindingV1Schema = z.strictObject({
    ...observation, target: DatabaseTargetV1Schema,
    object: z.optional(findingObject),
    normalizedShape: z.optional(z.string()), omittedTextReason: z.optional(z.string()),
    activity: z.optional(z.pick(DatabaseStatsActivityV1Schema, {
        waitClass: true, waitEvent: true, transactionStartedAt: true, queryStartedAt: true, blockingKeys: true,
    })),
    verification: z.strictObject({ read: DatabaseStatsReadV1Schema, basis: DatabaseStatsIntervalBasisV1Schema }),
});
export type DatabaseFindingV1 = z.infer<typeof DatabaseFindingV1Schema>;
export const DatabaseFindingV1ProtocolSchema = projectZodProtocolSchema(DatabaseFindingV1Schema);

/** List demand is the existing typed stats read, under the same admission. */
export const DatabaseFindingsListInputV1Schema = z.omit(DatabaseStatsOperationInputV1Schema, { operation: true });
export type DatabaseFindingsListInputV1 = z.infer<typeof DatabaseFindingsListInputV1Schema>;

/** Detail rereads this scoped key for its current sanitized shape. It does not
 * promise to recover an old observation from the connection Resource. */
export const DatabaseFindingReadInputV1Schema = z.extend(DatabaseFindingsListInputV1Schema, {
    recordKey: z.string().check(z.minLength(1)),
});
export type DatabaseFindingReadInputV1 = z.infer<typeof DatabaseFindingReadInputV1Schema>;
/** Safe before numbers survive closing the pane without a daemon sample store. */
export const DatabaseFindingBaselineV1Schema = z.extend(DatabaseFindingObservationV1Schema, {
    basis: DatabaseStatsIntervalBasisV1Schema,
});
export type DatabaseFindingBaselineV1 = z.infer<typeof DatabaseFindingBaselineV1Schema>;
export const DatabaseFindingBriefBuildInputV1Schema = z.extend(DatabaseFindingReadInputV1Schema, {
    baseline: DatabaseFindingBaselineV1Schema,
});
export type DatabaseFindingBriefBuildInputV1 = z.infer<typeof DatabaseFindingBriefBuildInputV1Schema>;

/** Guided setup/connection/migration is task evidence, never an invented finding.
 * No URL, credential, SQL or unattended setup command belongs in this input. */
const databaseGuidedTask = z.strictObject({
    kind: z.enum(['setup', 'connection', 'migration']),
    target: DatabaseTargetV1Schema, sourceScope: MachineTargetV1Schema,
    engineId: z.optional(DatabaseEngineIdV1Schema),
    stats: z.optional(z.strictObject({ request: DatabaseStatsReadV1Schema, reason: DatabaseStatsReasonV1Schema })),
});
export const DatabaseTaskEvidenceV1Schema = z.union([
    databaseGuidedTask,
    z.strictObject({
        kind: z.literal('add_telemetry'),
        scope: z.omit(DatabaseWorktreeTargetV1Schema, { source: true }),
        sourceScope: MachineTargetV1Schema,
        repositoryObservation: z.optional(asProtocolZod(projectZodProtocolSchema(ProjectRepositoryObservationV1Schema))),
    }),
    z.strictObject({
        kind: z.literal('enable_pg_stat_statements'),
        target: DatabaseTargetV1Schema, sourceScope: MachineTargetV1Schema,
        engineId: z.literal('postgresql'),
        stats: z.strictObject({ request: DatabaseStatsReadV1Schema, reason: DatabaseStatsReasonV1Schema }),
    }),
]);
export type DatabaseTaskEvidenceV1 = z.infer<typeof DatabaseTaskEvidenceV1Schema>;
export const DatabaseTaskBriefBuildInputV1Schema = z.strictObject({ task: DatabaseTaskEvidenceV1Schema });
export type DatabaseTaskBriefBuildInputV1 = z.infer<typeof DatabaseTaskBriefBuildInputV1Schema>;
export const DatabaseInsightBriefBuildInputV1Schema = z.union([
    DatabaseFindingBriefBuildInputV1Schema, DatabaseTaskBriefBuildInputV1Schema,
]);
export type DatabaseInsightBriefBuildInputV1 = z.infer<typeof DatabaseInsightBriefBuildInputV1Schema>;

/** Lists contain safe rankings only; statement shapes are fetched on selection. */
export const DatabaseFindingListEntryV1Schema = z.strictObject({
    recordKey: z.string().check(z.minLength(1)), summary: DatabaseFindingSummaryV1Schema,
    object: z.optional(findingObject),
});
export const DatabaseFindingsListResultV1Schema = z.union([
    DatabaseFailureV1Schema,
    z.strictObject({ ok: z.literal(true), observation: DatabaseFindingObservationV1Schema,
        findings: z.array(DatabaseFindingListEntryV1Schema) }),
]);
export type DatabaseFindingsListResultV1 = z.infer<typeof DatabaseFindingsListResultV1Schema>;
export const DatabaseFindingReadResultV1Schema = z.union([
    DatabaseFailureV1Schema, z.strictObject({ ok: z.literal(true), finding: DatabaseFindingV1Schema }),
]);
export type DatabaseFindingReadResultV1 = z.infer<typeof DatabaseFindingReadResultV1Schema>;
export const DatabaseFindingBriefBuildResultV1Schema = z.union([
    DatabaseFailureV1Schema,
    z.strictObject({ ok: z.literal(true), brief: z.strictObject({ text: z.string(),
        evidence: asProtocolZod(SessionInputForgeEvidenceV1Schema) }) }),
]);
export type DatabaseFindingBriefBuildResultV1 = z.infer<typeof DatabaseFindingBriefBuildResultV1Schema>;

/** Existing targeted contributions bind list/detail Actions; the Resource is
 * the change signal, not a second finding lifecycle or a store. */
export const DatabaseInsightSourceDescriptorV1Schema = z.strictObject({
    displayName: z.string().check(z.minLength(1)),
    evidenceSchema: PluginJsonSchemaV2Schema,
    changeResourceRef: asProtocolZod(PluginContributionIdentityV1Schema),
});
export type DatabaseInsightSourceDescriptorV1 = z.infer<typeof DatabaseInsightSourceDescriptorV1Schema>;
// Contribution descriptors/results are parsed at JSON ingress; retain the
// owner's exact output and parser without requiring its authored input shape.
export const DatabaseInsightSourceDescriptorV1ProtocolSchema = projectZodProtocolSchema<
    z.core.$ZodType<DatabaseInsightSourceDescriptorV1, unknown>
>(DatabaseInsightSourceDescriptorV1Schema);
export const DatabaseFindingsListInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseFindingsListInputV1Schema);
export const DatabaseFindingReadInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseFindingReadInputV1Schema);
export const DatabaseFindingBaselineV1ProtocolSchema = projectZodProtocolSchema(DatabaseFindingBaselineV1Schema);
export const DatabaseFindingBriefBuildInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseFindingBriefBuildInputV1Schema);
export const DatabaseTaskEvidenceV1ProtocolSchema = projectZodProtocolSchema(DatabaseTaskEvidenceV1Schema);
export const DatabaseTaskBriefBuildInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseTaskBriefBuildInputV1Schema);
export const DatabaseInsightBriefBuildInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseInsightBriefBuildInputV1Schema);
export const DatabaseFindingsListResultV1ProtocolSchema = projectZodProtocolSchema<
    z.core.$ZodType<DatabaseFindingsListResultV1, unknown>
>(DatabaseFindingsListResultV1Schema);
export const DatabaseFindingReadResultV1ProtocolSchema = projectZodProtocolSchema<
    z.core.$ZodType<DatabaseFindingReadResultV1, unknown>
>(DatabaseFindingReadResultV1Schema);
export const DatabaseFindingBriefBuildResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseFindingBriefBuildResultV1Schema);
