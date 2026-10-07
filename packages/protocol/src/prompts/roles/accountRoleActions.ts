import { ArtifactCallerAccessV1Schema } from '../../artifacts/artifactAccessV1.js';
import { artifactSavedByFromActionContextV1 } from '../../artifacts/artifactBinaryV1.js';
import { RolesV1Schema, type RolesV1 } from '../../account/settings/rolesV1.js';
import { readLegacyRolesV1, saveRolesV1WithLegacyMigration } from '../../account/settings/rolesV1Migration.js';
import type { ActionExecutorDeps } from '../../actions/actionExecutor.js';
import type { ActionExecutorContext } from '../../actions/executor/types.js';
import type { WorkflowDefinitionArtifactOperations } from '../../actions/executor/workflowDefinitions.js';
import { BUILT_IN_ROLES_V1 } from './builtInRolesV1.js';
import { buildRoleArtifactHeaderV1, RoleArtifactV1Schema } from './roleArtifactV1.js';
import { RoleActionInputSchemasV1, type RoleActionEntryV1 } from './roleActionsV1.js';
import type { PluginRoleContributionV1 } from './rolesV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

export type RoleArtifactStoreV1 = Omit<WorkflowDefinitionArtifactOperations, 'read' | 'create'> & Readonly<{
  read: (artifactId: string, options?: Readonly<{ signal?: AbortSignal }>) => Promise<Readonly<{
    artifactId: string; header: Readonly<Record<string, unknown>>; body: unknown;
    revision: Readonly<{ headerVersion: number; bodyVersion: number }>;
  }> | null>;
  create: (input: Parameters<WorkflowDefinitionArtifactOperations['create']>[0]) => Promise<Readonly<{
    artifactId: string; revision: Readonly<{ headerVersion: number; bodyVersion: number }>;
  }>>;
}>;
export type RoleSourceReaderV1 = (signal?: AbortSignal) => Promise<RoleActionEntryV1[]>;
export type RoleSourceReaderParamsV1 = Readonly<{
  artifactStore?: Pick<RoleArtifactStoreV1, 'read' | 'list'>;
  readPluginRoles?: (signal?: AbortSignal) => readonly PluginRoleContributionV1[] | Promise<readonly PluginRoleContributionV1[]>;
  accountId?: string;
  readRawAccountSettings?: () => Promise<Readonly<Record<string, unknown>>>;
}>;

function refuse(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/** Shared Account source owner; hosts supply only Artifact/settings and plugin projection boundaries. */
export function createRoleSourceReaderV1(params: RoleSourceReaderParamsV1): RoleSourceReaderV1 {
  return async (signal) => {
    signal?.throwIfAborted();
    const entries: RoleActionEntryV1[] = Object.entries(BUILT_IN_ROLES_V1).map(([roleId, role]) => ({
      roleId, role, shared: false, viewOnly: false, migratedFromV0_2: false,
    }));
    for (const entry of await params.readPluginRoles?.(signal) ?? []) entries.push({
      roleId: `plugin:${entry.pluginId}/${entry.localId}`, role: entry.role,
      shared: false, viewOnly: true, migratedFromV0_2: false,
    });
    if (params.artifactStore) {
      let cursor: string | undefined;
      do {
        // The Artifact list owner's maximum page is 500; consume every page.
        const page = await params.artifactStore.list({ limit: 500, ...(cursor ? { cursor } : {}), ...(signal ? { signal } : {}) });
        for (const header of page.items) {
          if (header.header.kind !== 'role.v1') continue;
          let artifact: Awaited<ReturnType<RoleArtifactStoreV1['read']>>;
          try { artifact = await params.artifactStore.read(header.artifactId, signal ? { signal } : undefined); }
          catch { signal?.throwIfAborted(); continue; }
          if (!artifact || typeof artifact.body !== 'string') continue;
          let content: unknown;
          try { content = JSON.parse(artifact.body); } catch { continue; }
          const role = createStoredReadSchema(RoleArtifactV1Schema).safeParse(content);
          if (!role.success) continue;
          const access = ArtifactCallerAccessV1Schema.parse(header.access);
          entries.push({ roleId: artifact.artifactId, role: role.data, revision: artifact.revision,
            shared: access !== 'owner', viewOnly: access === 'view', migratedFromV0_2: artifact.header.migratedFromV0_2 === true });
        }
        if (page.nextCursor === cursor && page.nextCursor !== undefined) refuse('artifact_list_cursor_invalid');
        cursor = page.nextCursor;
      } while (cursor);
    }
    if (params.accountId && params.readRawAccountSettings) {
      for (const entry of readLegacyRolesV1(await params.readRawAccountSettings(), params.accountId)) {
        if (!entries.some((item) => item.roleId === entry.artifactId)) entries.push({
          roleId: entry.artifactId, role: entry.role, shared: false, viewOnly: false, migratedFromV0_2: true,
        });
      }
    }
    signal?.throwIfAborted();
    return entries;
  };
}

export function createAccountRoleActionExecutorV1(params: RoleSourceReaderParamsV1 & Readonly<{
  artifactStore?: RoleArtifactStoreV1;
  readRoleSources?: RoleSourceReaderV1;
  generateId: () => string;
  mutateAccountSettings?: (mutate: (raw: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown> & { rolesV1: RolesV1 }>, signal?: AbortSignal) => Promise<void>;
}>): NonNullable<ActionExecutorDeps['roleActionExecute']> {
  const listEntries = params.readRoleSources ?? createRoleSourceReaderV1(params);
  const retainLegacy = async (raw: Readonly<Record<string, unknown>>, rolesV1: ReturnType<typeof RolesV1Schema.parse>, context: ActionExecutorContext) => {
    const { signal } = context;
    const savedBy = artifactSavedByFromActionContextV1(context);
    if (!params.artifactStore || !params.accountId) refuse('not_authenticated');
    let retainedRoles = rolesV1;
    await saveRolesV1WithLegacyMigration({ rawSettings: raw, accountId: params.accountId, rolesV1,
      ensureRoleArtifact: async (entry) => {
        const existing = await params.artifactStore!.read(entry.artifactId, signal ? { signal } : undefined);
        if (existing) {
          if (existing.header.kind !== 'role.v1') refuse('artifact_kind_mismatch');
          return;
        }
        try {
          await params.artifactStore!.create({ artifactId: entry.artifactId,
            header: { ...buildRoleArtifactHeaderV1(entry.role), migratedFromV0_2: true }, body: JSON.stringify(entry.role), ...(savedBy ? { savedBy } : {}), ...(signal ? { signal } : {}) });
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'conflict') throw error;
          const retained = await params.artifactStore!.read(entry.artifactId, signal ? { signal } : undefined);
          if (retained?.header.kind !== 'role.v1') throw error;
        }
      },
      saveSettings: async (roles) => { retainedRoles = roles; },
    });
    return { ...raw, rolesV1: retainedRoles };
  };
  return async ({ actionId, input, context }) => {
    context.signal?.throwIfAborted();
    RoleActionInputSchemasV1[actionId].parse(input);
    if (actionId === 'roles.list') return { items: await listEntries(context.signal) };
    if (actionId === 'roles.get') {
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      const entry = (await listEntries(context.signal)).find((item) => item.roleId === request.roleId);
      if (!entry) refuse('role_target_unavailable');
      return entry;
    }
    if (!actionId.startsWith('roles.')) refuse('unsupported_action');
    if (context.surface === 'agent' && !context.bypassApprovals) refuse('approval_required');
    if (!params.mutateAccountSettings || !params.artifactStore) refuse('not_authenticated');
    if (actionId === 'roles.override.set' || actionId === 'roles.override.reset') {
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      await params.mutateAccountSettings(async (raw) => {
        const rolesV1 = createStoredReadSchema(RolesV1Schema).parse(Object.hasOwn(raw, 'rolesV1') ? raw.rolesV1 : { overrides: {} });
        if (actionId === 'roles.override.reset') delete rolesV1.overrides[request.roleId];
        else rolesV1.overrides[request.roleId] = RoleActionInputSchemasV1['roles.override.set'].parse(input);
        return await retainLegacy(raw, rolesV1, context);
      }, context.signal);
      return { updated: true };
    }
    const request = RoleActionInputSchemasV1[actionId].parse(input);
    if ('roleId' in request && request.roleId && (Object.hasOwn(BUILT_IN_ROLES_V1, request.roleId) || request.roleId.startsWith('plugin:'))) refuse('role_read_only');
    await params.mutateAccountSettings(async (raw) => await retainLegacy(raw,
      createStoredReadSchema(RolesV1Schema).parse(Object.hasOwn(raw, 'rolesV1') ? raw.rolesV1 : { overrides: {} }), context), context.signal);
    if (actionId === 'roles.create') {
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      const roleId = request.roleId ?? params.generateId();
      if (Object.hasOwn(BUILT_IN_ROLES_V1, roleId) || roleId.startsWith('plugin:')) refuse('role_read_only');
      const created = await params.artifactStore.create({ artifactId: roleId,
        header: buildRoleArtifactHeaderV1(request.role), body: JSON.stringify(request.role), savedBy: artifactSavedByFromActionContextV1(context), ...(context.signal ? { signal: context.signal } : {}) });
      return { roleId: created.artifactId, revision: created.revision };
    }
    if (actionId === 'roles.delete') {
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      const existing = await params.artifactStore.read(request.roleId, context.signal ? { signal: context.signal } : undefined);
      if (!existing || existing.header.kind !== 'role.v1') refuse('role_target_unavailable');
      const deleted = await params.artifactStore.delete(request.roleId, { expectedRevision: request.expectedRevision,
        ...(context.signal ? { signal: context.signal } : {}) });
      if (!deleted.ok) refuse(deleted.errorCode === 'version_mismatch' ? 'currentness_conflict' : deleted.errorCode);
      return { deleted: true };
    }
    if (actionId === 'roles.update') {
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      const existing = await params.artifactStore.read(request.roleId, context.signal ? { signal: context.signal } : undefined);
      if (!existing || existing.header.kind !== 'role.v1') refuse('role_target_unavailable');
      const updated = await params.artifactStore.update({ artifactId: request.roleId, expectedRevision: request.expectedRevision,
        header: { ...existing.header, ...buildRoleArtifactHeaderV1(request.role) }, body: JSON.stringify(request.role), savedBy: artifactSavedByFromActionContextV1(context), ...(context.signal ? { signal: context.signal } : {}) });
      if (!updated.ok) refuse(updated.errorCode === 'version_mismatch' ? 'currentness_conflict' : updated.errorCode);
      return { roleId: request.roleId, revision: updated.revision };
    }
    return refuse('unsupported_action');
  };
}
