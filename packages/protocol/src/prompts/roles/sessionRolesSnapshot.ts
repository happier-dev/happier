import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { migrateRetainedSessionWorkContextV1 } from '../../sessions/context/sessionContextV1.js';
import { RoleInstructionsOverrideV1Schema, ResolvedRolesSnapshotV1Schema, type ResolvedRolesSnapshotV1 } from './rolesV1.js';

export const SessionRoleIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1)));
export const SessionRolesV1Schema = lazyZodSchema(() => z.strictObject({
  roleId: z.optional(SessionRoleIdV1Schema),
  answersWorkerQuestions: z.optional(z.boolean()),
  inheritedFrom: z.optional(z.string().check(z.minLength(1))),
  overrides: z.record(z.string().check(z.minLength(1)), RoleInstructionsOverrideV1Schema),
  sessionRoles: ResolvedRolesSnapshotV1Schema,
  notes: z.string(),
}));
export type SessionRolesV1 = z.infer<typeof SessionRolesV1Schema>;
export const SessionRoleConfigurationV1Schema = lazyZodSchema(() => z.omit(SessionRolesV1Schema, { roleId: true }));
/** Persistence restore only; configuration requests and writes use the canonical schema. */
export const StoredSessionRoleConfigurationV1Schema = createStoredReadSchema(SessionRoleConfigurationV1Schema);
export type SessionRoleConfigurationV1 = z.infer<typeof SessionRoleConfigurationV1Schema>;
export const SessionRolesConfigurationSetRpcV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1)), configuration: SessionRoleConfigurationV1Schema,
}));

function readRawSessionRolesV1(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || !('work' in metadata)) return undefined;
  const work = metadata.work;
  return work && typeof work === 'object' && 'sessionRolesV1' in work ? work.sessionRolesV1 : undefined;
}

export function readSessionRolesV1(metadata: unknown): SessionRolesV1 | null {
  const stored = readRawSessionRolesV1(metadata);
  if (stored === undefined) return null;
  const parsed = createStoredReadSchema(SessionRolesV1Schema).safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** Old and new sessions default on; malformed retained settings never grant answer authority. */
export function readSessionAnswersWorkerQuestionsV1(metadata: unknown): boolean {
  const snapshot = readSessionRolesV1(metadata);
  return snapshot ? snapshot.answersWorkerQuestions ?? true : readRawSessionRolesV1(metadata) === undefined;
}

/** No fallback to legacy work.roleId: the session roles owner is authoritative. */
export function readSessionRoleIdV1(metadata: unknown): string | null {
  return readSessionRolesV1(metadata)?.roleId ?? null;
}

/** Field-scoped replay preserves newer notes, overrides and the complete spawn snapshot. */
export function writeSessionRoleIdV1ToMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  roleId: string | null,
): TMetadata {
  if (roleId !== null) SessionRoleIdV1Schema.parse(roleId);
  const work = metadata.work;
  const currentWork = migrateRetainedSessionWorkContextV1(work);
  const existing = 'sessionRolesV1' in currentWork ? currentWork.sessionRolesV1 : undefined;
  // Malformed owner data must not be silently replaced with an empty snapshot.
  const current: SessionRolesV1 = existing === undefined
    ? { overrides: {}, sessionRoles: {}, notes: '' }
    : createStoredReadSchema(SessionRolesV1Schema).parse(existing);
  const { roleId: _previousRoleId, ...rest } = current;
  return {
    ...metadata,
    work: { ...currentWork, sessionRolesV1: SessionRolesV1Schema.parse({ ...rest, ...(roleId === null ? {} : { roleId }) }) },
  };
}

/** Role copies preserve the recipient's question preference unless explicitly edited. */
export function writeSessionRoleConfigurationV1ToMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  configuration: SessionRoleConfigurationV1,
): TMetadata {
  const parsed = SessionRoleConfigurationV1Schema.parse(configuration);
  const work = metadata.work;
  const currentWork = migrateRetainedSessionWorkContextV1(work);
  const current = 'sessionRolesV1' in currentWork
    ? createStoredReadSchema(SessionRolesV1Schema).parse(currentWork.sessionRolesV1) : undefined;
  const roleId = current?.roleId;
  const answersWorkerQuestions = parsed.answersWorkerQuestions ?? current?.answersWorkerQuestions;
  return { ...metadata, work: { ...currentWork, sessionRolesV1: { ...parsed,
    ...(answersWorkerQuestions === undefined ? {} : { answersWorkerQuestions }), ...(roleId ? { roleId } : {}) } } };
}

export function snapshotSessionRolesAtSpawnV1(input: Readonly<{
  leadSessionId: string;
  roles: ResolvedRolesSnapshotV1;
  notes?: string;
}>): SessionRolesV1 {
  return SessionRolesV1Schema.parse({
    inheritedFrom: input.leadSessionId,
    overrides: {},
    sessionRoles: input.roles,
    notes: input.notes ?? '',
  });
}
