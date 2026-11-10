import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { SessionManagerV1Schema, SessionManagedSessionsV1Schema } from '../follow/sessionManagerV1.js';
import { SessionEffectiveAccessV1Schema } from '../access/sessionEffectiveAccessV1.js';
import { AccountEncryptionModeSchema } from '../../features/payload/capabilities/encryptionCapabilities.js';
import { SESSION_PERMISSION_MODES } from '../metadata/sessionPermissionModes.js';
import { TurnIdSchema } from '../idsV1.js';
import { PendingActivationAuthorizationV1Schema } from '../pending/pendingActivationAuthorizationV1.js';
import { PrimaryTurnStatusV1Schema, SessionRuntimeIssueV1Schema } from './runtimeIssueV1.js';
import { SessionRuntimeActivityStateSchema, refineRuntimeActivityProjectionFields } from '../runtime/activity/sessionRuntimeActivity.js';
import { SessionBotV1Schema, readSessionBotV1 } from '../identity/sessionBotV1.js';
import { SessionBotFaceV1Schema, readSessionBotFaceV1 } from '../identity/sessionBotFaceV1.js';

export const SessionSummarySchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.minLength(1)),
  manager: z.optional(SessionManagerV1Schema),
  managedSessions: z.optional(SessionManagedSessionsV1Schema),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
  active: z.boolean(),
  activeAt: z.number().check(z.int(), z.nonnegative()),
  archivedAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
  pendingCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  pendingBlockedCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  tag: z.optional(z.string()),
  title: z.optional(z.string().check(z.minLength(1))),
  bot: z.optional(SessionBotV1Schema),
  botFace: z.optional(SessionBotFaceV1Schema),
  path: z.optional(z.string()),
  host: z.optional(z.string()),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  permissionMode: z.optional((<const Values extends readonly string[], const Excluded extends readonly Values[number][]>(values: Values, excluded: Excluded) => { for (const value of excluded) if (!values.includes(value)) throw new Error(`Key ${value} not found in enum`); return z.enum(values.filter((value): value is Exclude<Values[number], Excluded[number]> => !excluded.some(item => item === value))); })(z.enum(SESSION_PERMISSION_MODES).options, ['acceptEdits', 'bypassPermissions'])),
  share: z.optional(z.nullable(z.object({
    accessLevel: z.string().check(z.minLength(1)),
    canApprovePermissions: z.boolean(),
  }))),
  effectiveAccess: z.optional(SessionEffectiveAccessV1Schema),
  isSystem: z.optional(z.boolean()),
  systemPurpose: z.optional(z.nullable(z.string())),
  encryptionMode: z.optional(AccountEncryptionModeSchema),
  // Reports the caller's available E2EE material without conflating it with the
  // persisted Session mode. Token-only callers use null, including when listing a
  // retained E2EE Session whose private metadata remains locked.
  encryption: z.nullable(z.looseObject({
    type: z.enum(['legacy', 'dataKey']),
  })),
  latestTurnId: z.optional(z.nullable(TurnIdSchema)),
  latestTurnStatus: z.optional(z.nullable(PrimaryTurnStatusV1Schema)),
  latestTurnStatusObservedAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
  lastRuntimeIssue: z.optional(z.nullable(SessionRuntimeIssueV1Schema)),
  runtimeActivityState: z.optional(SessionRuntimeActivityStateSchema),
  runtimeActivityActiveCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  runtimeActivityObservedAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
  runtimeActivityRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
  rollbackEligibleTurnStarts: z.optional(z.array(z.number().check(z.int(), z.nonnegative()))),
  pendingActivationAuthorization: z.optional(PendingActivationAuthorizationV1Schema),
}).check(z.superRefine(refineRuntimeActivityProjectionFields)));
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** Recipient-safe identity shared by full and privacy-filtered Session summaries. */
export function projectSessionSummaryIdentityV1(
  metadata: Readonly<{ bot?: unknown; botFace?: unknown }> | null | undefined,
): Pick<SessionSummary, 'bot' | 'botFace'> {
  const bot = readSessionBotV1(metadata?.bot);
  const botFace = readSessionBotFaceV1(metadata?.botFace);
  return { ...(bot ? { bot } : {}), ...(botFace ? { botFace } : {}) };
}

type SessionSummarySourceFieldsV1 = 'archivedAt' | 'pendingCount' | 'pendingBlockedCount' | 'effectiveAccess' | 'share'
    | 'encryptionMode' | 'latestTurnId' | 'latestTurnStatus' | 'latestTurnStatusObservedAt' | 'lastRuntimeIssue'
    | 'runtimeActivityState' | 'runtimeActivityActiveCount' | 'runtimeActivityObservedAt' | 'runtimeActivityRevision'
    | 'pendingActivationAuthorization' | 'manager' | 'managedSessions';
type SessionSummarySourceV1 = Pick<SessionSummary, 'id' | 'createdAt' | 'updatedAt' | 'active' | 'activeAt'> & {
  readonly [Key in SessionSummarySourceFieldsV1]?: SessionSummary[Key] | null;
} & { rollbackEligibleTurnStarts?: readonly number[] | null };

/** One content-filtered summary projection for CLI and UI status readers. Metadata is opened by its host. */
export function projectSessionSummaryV1(input: Readonly<{
  row: SessionSummarySourceV1;
  metadata: Readonly<Record<string, unknown>> | null;
  permissionMode?: SessionSummary['permissionMode'];
  systemPurpose?: string | null;
  encryption: SessionSummary['encryption'];
}>): SessionSummary {
  const { row, metadata } = input;
  const summary = metadata?.summary && typeof metadata.summary === 'object' && !Array.isArray(metadata.summary)
    ? metadata.summary as Readonly<Record<string, unknown>> : null;
  const tag = typeof metadata?.tag === 'string' ? metadata.tag : undefined;
  const title = typeof summary?.text === 'string' ? summary.text.trim() : undefined;
  const path = typeof metadata?.path === 'string' ? metadata.path : undefined;
  const host = typeof metadata?.host === 'string' ? metadata.host : undefined;
  const machineId = typeof metadata?.machineId === 'string' ? metadata.machineId.trim() : undefined;
  const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const nullableTimestamp = (value: unknown): value is number | null => value === null || timestamp(value);
  const share = row.share === null ? null : row.share && typeof row.share.accessLevel === 'string'
    && typeof row.share.canApprovePermissions === 'boolean'
    ? { accessLevel: row.share.accessLevel, canApprovePermissions: row.share.canApprovePermissions } : undefined;
  return {
    id: row.id.trim(), createdAt: row.createdAt, updatedAt: row.updatedAt, active: row.active, activeAt: row.activeAt,
    ...(row.manager != null ? { manager: row.manager } : {}),
    ...(row.managedSessions != null ? { managedSessions: row.managedSessions } : {}),
    ...(nullableTimestamp(row.archivedAt) ? { archivedAt: row.archivedAt } : {}),
    ...(typeof row.pendingCount === 'number' ? { pendingCount: row.pendingCount } : {}),
    ...(typeof row.pendingBlockedCount === 'number' ? { pendingBlockedCount: row.pendingBlockedCount } : {}),
    ...(tag ? { tag } : {}), ...(title ? { title } : {}), ...(path ? { path } : {}), ...(host ? { host } : {}),
    ...projectSessionSummaryIdentityV1(metadata),
    ...(machineId ? { machineId } : {}), ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    ...(input.systemPurpose !== undefined ? { isSystem: true, systemPurpose: input.systemPurpose } : {}),
    ...(row.effectiveAccess != null ? { effectiveAccess: row.effectiveAccess } : {}),
    ...(share !== undefined ? { share } : {}),
    ...(row.encryptionMode ? { encryptionMode: row.encryptionMode } : {}), encryption: input.encryption,
    ...(typeof row.latestTurnId === 'string' || row.latestTurnId === null ? { latestTurnId: row.latestTurnId } : {}),
    ...(row.latestTurnStatus != null ? { latestTurnStatus: row.latestTurnStatus } : {}),
    ...(nullableTimestamp(row.latestTurnStatusObservedAt) ? { latestTurnStatusObservedAt: row.latestTurnStatusObservedAt } : {}),
    ...(row.lastRuntimeIssue != null ? { lastRuntimeIssue: row.lastRuntimeIssue } : {}),
    ...(row.runtimeActivityState != null ? { runtimeActivityState: row.runtimeActivityState } : {}),
    ...(timestamp(row.runtimeActivityActiveCount) ? { runtimeActivityActiveCount: row.runtimeActivityActiveCount } : {}),
    ...(nullableTimestamp(row.runtimeActivityObservedAt) ? { runtimeActivityObservedAt: row.runtimeActivityObservedAt } : {}),
    ...(timestamp(row.runtimeActivityRevision) ? { runtimeActivityRevision: row.runtimeActivityRevision } : {}),
    ...(row.rollbackEligibleTurnStarts ? { rollbackEligibleTurnStarts: [...row.rollbackEligibleTurnStarts] } : {}),
    ...(row.pendingActivationAuthorization != null ? { pendingActivationAuthorization: row.pendingActivationAuthorization } : {}),
  };
}

/**
 * Candidate rows withheld pending their owner's metadata migration. Counts from
 * consumed pages may overlap: a positive value means incomplete coverage, not
 * an exact number of distinct missing Sessions. It does not imply another page.
 */
export const SessionListMetadataUpgradeRequiredCountSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

/** Candidates omitted because authorized metadata could not establish the selected Bot facet. */
export const SessionListBotFilterUnavailableCountSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

export const SessionListResultSchema = lazyZodSchema(() => z.looseObject({
  sessions: z.array(SessionSummarySchema),
  nextCursor: z.optional(z.nullable(z.string())),
  hasNext: z.optional(z.boolean()),
  metadataUpgradeRequiredCount: z.optional(SessionListMetadataUpgradeRequiredCountSchema),
  botFilterUnavailableCount: z.optional(SessionListBotFilterUnavailableCountSchema),
}));
export type SessionListResult = z.infer<typeof SessionListResultSchema>;
