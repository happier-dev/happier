import { ArtifactCallerAccessV1Schema } from '../../artifacts/artifactAccessV1.js';
import { artifactSavedByFromActionContextV1 } from '../../artifacts/artifactBinaryV1.js';
import { LegacyRolesInventoryIncompleteError, readLegacyRoleInventoryV1, retainLegacyRolesV1 } from '../../account/settings/rolesV1Migration.js';
import type { ActionExecutorDeps } from '../../actions/actionExecutor.js';
import type { ActionExecuteFailure } from '../../actions/actionExecutionResult.js';
import type { ActionExecutorContext } from '../../actions/executor/types.js';
import type { WorkflowDefinitionArtifactOperations } from '../../actions/executor/workflowDefinitions.js';
import { BUILT_IN_ROLES_V1 } from './builtInRolesV1.js';
import { buildRoleArtifactHeaderV1, RoleArtifactV1Schema, type RoleArtifactV1 } from './roleArtifactV1.js';
import { RoleActionInputSchemasV1, type RoleActionEntryV1, type RoleSourceDiagnosticV1 } from './roleActionsV1.js';
import type { PluginRoleContributionV1 } from './rolesV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import type { RoleOverrideMutationV1 } from './roleOverrideRecordV1.js';
import type { WorkflowArtifactRevisionV1 } from '../../workflows/workflowDefinitionV1.js';

export type RoleArtifactStoreV1 = Omit<WorkflowDefinitionArtifactOperations, 'create'> & Readonly<{
  create: (input: Parameters<WorkflowDefinitionArtifactOperations['create']>[0]) => Promise<Readonly<{
    artifactId: string; revision: Readonly<{ headerVersion: number; bodyVersion: number }>;
  }>>;
}>;

/** Reuses the generic host store while obtaining the committed create receipt. */
export function createRoleArtifactStoreV1(operations: WorkflowDefinitionArtifactOperations): RoleArtifactStoreV1 {
  return { ...operations, create: async input => {
    await operations.create(input);
    const created = await operations.read(input.artifactId, { signal: input.signal });
    if (!created) throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
    return { artifactId: created.artifactId, revision: created.revision };
  } };
}
export type RoleSourceInventoryV1 = Readonly<{
  status: 'ready' | 'partial';
  entries: readonly RoleActionEntryV1[];
  diagnostics: readonly RoleSourceDiagnosticV1[];
}>;
export type RoleSourceReaderV1 = (signal?: AbortSignal) => Promise<RoleSourceInventoryV1>;
export type RoleSourceReaderParamsV1 = Readonly<{
  artifactStore?: Pick<RoleArtifactStoreV1, 'read' | 'list'>;
  readPluginRoles?: (signal?: AbortSignal) => readonly PluginRoleContributionV1[] | Promise<readonly PluginRoleContributionV1[]>;
  accountId?: string;
  readRawAccountSettings?: () => Promise<Readonly<Record<string, unknown>>>;
}>;

function readStoredRoleBodyV1(body: unknown): RoleArtifactV1 | null {
  if (typeof body !== 'string') return null;
  let content: unknown;
  try { content = JSON.parse(body); } catch { return null; }
  const role = createStoredReadSchema(RoleArtifactV1Schema).safeParse(content);
  return role.success ? role.data : null;
}

export type RoleArtifactRetentionReceiptV1 = Readonly<{ artifactId: string; expectedRevision: WorkflowArtifactRevisionV1 }>;

class AccountRoleActionRefusalV1 extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function refuse(code: string): never {
  throw new AccountRoleActionRefusalV1(code);
}

/** Current guidance remains re-importable until its actual Settings source is cleaned. */
export async function assertAccountRoleArtifactDeletionV1(params: Readonly<{
  artifactId: string;
  readTargetArtifactKind: () => string | undefined | Promise<string | undefined>;
  accountId: string;
  rawSettings: Readonly<Record<string, unknown>>;
}>): Promise<void> {
  const inventory = readLegacyRoleInventoryV1(params.rawSettings, params.accountId);
  if (inventory.sourceArtifactIds.includes(params.artifactId)) refuse('role_source_incomplete');
  if (inventory.sourceIdentitiesComplete) return;
  const targetArtifactKind = await params.readTargetArtifactKind();
  if (targetArtifactKind === undefined || targetArtifactKind === 'role.v1') {
    refuse('role_source_incomplete');
  }
}

/** Internal Action adapter: transport exceptions are not Role-owner refusals. */
export function projectAccountRoleActionRefusalV1(error: unknown): ActionExecuteFailure | null {
  return error instanceof AccountRoleActionRefusalV1 || error instanceof LegacyRolesInventoryIncompleteError
    ? { ok: false, errorCode: error.code, error: error.message }
    : null;
}

/** Shared Account source owner; hosts supply only Artifact/settings and plugin projection boundaries. */
export function createRoleSourceReaderV1(params: RoleSourceReaderParamsV1): RoleSourceReaderV1 {
  return async (signal) => {
    signal?.throwIfAborted();
    const entries: RoleActionEntryV1[] = Object.entries(BUILT_IN_ROLES_V1).map(([roleId, role]) => ({
      roleId, role, shared: false, viewOnly: false, migratedFromV0_2: false,
    }));
    const diagnostics: RoleSourceDiagnosticV1[] = [];
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
          catch { signal?.throwIfAborted(); diagnostics.push({ source: 'artifact', artifactId: header.artifactId, reason: 'unavailable' }); continue; }
          if (!artifact || typeof artifact.body !== 'string') {
            diagnostics.push({ source: 'artifact', artifactId: header.artifactId, reason: artifact ? 'invalid_stored_content' : 'unavailable' });
            continue;
          }
          const role = readStoredRoleBodyV1(artifact.body);
          if (!role) { diagnostics.push({ source: 'artifact', artifactId: header.artifactId, reason: 'invalid_stored_content' }); continue; }
          const access = ArtifactCallerAccessV1Schema.parse(header.access);
          entries.push({ roleId: artifact.artifactId, role, revision: artifact.revision,
            shared: access !== 'owner', viewOnly: access === 'view', migratedFromV0_2: artifact.header.migratedFromV0_2 === true });
        }
        if (page.nextCursor === cursor && page.nextCursor !== undefined) refuse('artifact_list_cursor_invalid');
        cursor = page.nextCursor;
      } while (cursor);
    }
    if (params.accountId && params.readRawAccountSettings) {
      let raw: Readonly<Record<string, unknown>> | undefined;
      try { raw = await params.readRawAccountSettings(); }
      catch { signal?.throwIfAborted(); diagnostics.push({ source: 'legacy-guidance', reason: 'unavailable' }); }
      const legacy = raw ? readLegacyRoleInventoryV1(raw, params.accountId) : null;
      diagnostics.push(...(legacy?.diagnostics.map(diagnostic => ({ source: 'legacy-guidance' as const, ...diagnostic })) ?? []));
      for (const entry of legacy?.entries ?? []) {
        if (!entries.some((item) => item.roleId === entry.artifactId)) entries.push({
          roleId: entry.artifactId, role: entry.role, shared: false, viewOnly: false, migratedFromV0_2: true,
        });
      }
    }
    signal?.throwIfAborted();
    return { status: diagnostics.length ? 'partial' : 'ready', entries, diagnostics };
  };
}

/** One Artifact retention boundary shared by Actions and Account catalog transfer. */
export async function retainLegacyRoleArtifactsV1(params: Readonly<{
  rawSettings: Readonly<Record<string, unknown>>;
  accountId: string;
  artifactStore: RoleArtifactStoreV1;
  signal?: AbortSignal;
  savedBy?: Parameters<RoleArtifactStoreV1['create']>[0]['savedBy'];
}>): Promise<readonly RoleArtifactRetentionReceiptV1[]> {
  const { signal, savedBy } = params;
  const receipts: RoleArtifactRetentionReceiptV1[] = [];
  const retainReceipt = (artifact: NonNullable<Awaited<ReturnType<RoleArtifactStoreV1['read']>>>, artifactId: string) => {
    if (artifact.header.kind !== 'role.v1') refuse('artifact_kind_mismatch');
    if (artifact.artifactId !== artifactId || artifact.ownerAccountId !== params.accountId || artifact.access !== 'owner'
      || !readStoredRoleBodyV1(artifact.body)) refuse('artifact_content_unavailable');
    receipts.push({ artifactId, expectedRevision: artifact.revision });
  };
  await retainLegacyRolesV1({ rawSettings: params.rawSettings, accountId: params.accountId,
    ensureRoleArtifact: async (entry) => {
      const existing = await params.artifactStore.read(entry.artifactId, signal ? { signal } : undefined);
      if (existing) {
        retainReceipt(existing, entry.artifactId);
        return;
      }
      try {
        await params.artifactStore.create({ artifactId: entry.artifactId,
          header: { ...buildRoleArtifactHeaderV1(entry.role), migratedFromV0_2: true }, body: JSON.stringify(entry.role),
          ...(savedBy ? { savedBy } : {}), ...(signal ? { signal } : {}) });
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'conflict') throw error;
        const retained = await params.artifactStore.read(entry.artifactId, signal ? { signal } : undefined);
        if (!retained) throw error;
        retainReceipt(retained, entry.artifactId);
        return;
      }
      const created = await params.artifactStore.read(entry.artifactId, signal ? { signal } : undefined);
      if (!created) refuse('artifact_content_unavailable');
      retainReceipt(created, entry.artifactId);
    },
  });
  return receipts;
}

export function createAccountRoleActionExecutorV1(params: RoleSourceReaderParamsV1 & Readonly<{
  artifactStore?: RoleArtifactStoreV1;
  readRoleSources?: RoleSourceReaderV1;
  generateId: () => string;
  mutateAccountRoleOverrides?: (mutation: RoleOverrideMutationV1, context: ActionExecutorContext) => Promise<void>;
}>): NonNullable<ActionExecutorDeps['roleActionExecute']> {
  const listEntries = params.readRoleSources ?? createRoleSourceReaderV1(params);
  const retainLegacy = async (context: ActionExecutorContext) => {
    const { signal } = context;
    const savedBy = artifactSavedByFromActionContextV1(context);
    if (!params.accountId || !params.readRawAccountSettings) return;
    if (!params.artifactStore) refuse('not_authenticated');
    const rawSettings = await params.readRawAccountSettings();
    await retainLegacyRoleArtifactsV1({ rawSettings, accountId: params.accountId, artifactStore: params.artifactStore,
      ...(savedBy ? { savedBy } : {}), ...(signal ? { signal } : {}),
    });
    return rawSettings;
  };
  return async ({ actionId, input, context }) => {
    context.signal?.throwIfAborted();
    RoleActionInputSchemasV1[actionId].parse(input);
    if (actionId === 'roles.list') { const source = await listEntries(context.signal); return { items: source.entries, diagnostics: source.diagnostics }; }
    if (actionId === 'roles.get') {
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      const source = await listEntries(context.signal);
      const entry = source.entries.find((item) => item.roleId === request.roleId);
      if (!entry) refuse(source.status === 'partial' ? 'role_source_incomplete' : 'role_target_unavailable');
      return entry;
    }
    if (!actionId.startsWith('roles.')) refuse('unsupported_action');
    if (context.surface === 'agent' && !context.bypassApprovals) refuse('approval_required');
    if (actionId === 'roles.override.set' || actionId === 'roles.override.reset') {
      if (!params.mutateAccountRoleOverrides) refuse('not_authenticated');
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      await params.mutateAccountRoleOverrides(actionId === 'roles.override.reset'
        ? { kind: 'reset', roleId: request.roleId }
        : { kind: 'set', override: RoleActionInputSchemasV1['roles.override.set'].parse(input) }, context);
      return { updated: true };
    }
    if (!params.artifactStore) refuse('not_authenticated');
    const request = RoleActionInputSchemasV1[actionId].parse(input);
    if ('roleId' in request && request.roleId && (Object.hasOwn(BUILT_IN_ROLES_V1, request.roleId) || request.roleId.startsWith('plugin:'))) refuse('role_read_only');
    const retainedRawSettings = await retainLegacy(context);
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
      if (retainedRawSettings && params.accountId) await assertAccountRoleArtifactDeletionV1({
        artifactId: request.roleId, readTargetArtifactKind: () => 'role.v1', accountId: params.accountId, rawSettings: retainedRawSettings,
      });
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
