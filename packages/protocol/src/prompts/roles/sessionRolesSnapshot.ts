import { z } from 'zod';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { RoleInstructionsOverrideV1Schema, ResolvedRolesSnapshotV1Schema, type ResolvedRolesSnapshotV1 } from './rolesV1.js';

export const RoleMemoryDocRefV1Schema = z.object({ kind: z.literal('doc'), artifactId: z.string().min(1) }).strict();
export type RoleMemoryDocRefV1 = z.infer<typeof RoleMemoryDocRefV1Schema>;
export const SessionRoleIdV1Schema = z.string().min(1);
export const SessionRolesV1Schema = z.object({
  roleId: SessionRoleIdV1Schema.optional(),
  inheritedFrom: z.string().min(1).optional(),
  overrides: z.record(z.string().min(1), RoleInstructionsOverrideV1Schema),
  sessionRoles: ResolvedRolesSnapshotV1Schema,
  notes: z.string(),
  memoryDocRef: RoleMemoryDocRefV1Schema.optional(),
}).strict();
export type SessionRolesV1 = z.infer<typeof SessionRolesV1Schema>;
export const SessionRoleConfigurationV1Schema = SessionRolesV1Schema.omit({ roleId: true });
/** Persistence restore only; configuration requests and writes use the canonical schema. */
export const StoredSessionRoleConfigurationV1Schema = createStoredReadSchema(SessionRoleConfigurationV1Schema);
export type SessionRoleConfigurationV1 = z.infer<typeof SessionRoleConfigurationV1Schema>;
export const SessionRolesConfigurationSetRpcV1Schema = z.object({
  sessionId: z.string().min(1), configuration: SessionRoleConfigurationV1Schema,
}).strict();

export function readSessionRolesV1(metadata: unknown): SessionRolesV1 | null {
  if (!metadata || typeof metadata !== 'object' || !('work' in metadata)) return null;
  const work = metadata.work;
  if (!work || typeof work !== 'object' || !('sessionRolesV1' in work)) return null;
  const parsed = createStoredReadSchema(SessionRolesV1Schema).safeParse(work.sessionRolesV1);
  return parsed.success ? parsed.data : null;
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
  const currentWork = work && typeof work === 'object' && !Array.isArray(work) ? work : {};
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

/** Configuration edits do not overwrite a separately queued current-role selection. */
export function writeSessionRoleConfigurationV1ToMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  configuration: SessionRoleConfigurationV1,
): TMetadata {
  const parsed = SessionRoleConfigurationV1Schema.parse(configuration);
  const work = metadata.work;
  const currentWork = work && typeof work === 'object' && !Array.isArray(work) ? work : {};
  if ('sessionRolesV1' in currentWork) createStoredReadSchema(SessionRolesV1Schema).parse(currentWork.sessionRolesV1);
  const roleId = readSessionRoleIdV1(metadata);
  return { ...metadata, work: { ...currentWork, sessionRolesV1: { ...parsed, ...(roleId ? { roleId } : {}) } } };
}

export function snapshotSessionRolesAtSpawnV1(input: Readonly<{
  leadSessionId: string;
  roles: ResolvedRolesSnapshotV1;
  notes?: string;
  memoryDocRef?: RoleMemoryDocRefV1;
  sameAccount: boolean;
}>): SessionRolesV1 {
  return SessionRolesV1Schema.parse({
    inheritedFrom: input.leadSessionId,
    overrides: {},
    sessionRoles: input.roles,
    notes: input.notes ?? '',
    ...(input.sameAccount && input.memoryDocRef ? { memoryDocRef: input.memoryDocRef } : {}),
  });
}
