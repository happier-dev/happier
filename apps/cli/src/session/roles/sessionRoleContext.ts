import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { readSessionWorkspaceWritesV1, resolveRoleSelectionV1, resolveRolesSnapshotV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { RoleEngineV1, ResolvedRolesSnapshotV1, SessionRolePromptContextV1, V2SessionByIdResponse } from '@happier-dev/protocol';
import type { RoleSelectionRefusalV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import type { RoleSourceReader } from './roleSources';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { classifyHomeReadPreparationError } from '@/agent/prompts/library/homeReadPreparationError';

/** Loading is a phase of the existing demand, never an empty override set. */
export async function readPreparedAccountRoleOverrides(params: Readonly<{
  read: () => AccountRoleOverridesReadV1;
  prepare?: (signal?: AbortSignal) => Promise<void>;
}>, signal?: AbortSignal): Promise<AccountRoleOverridesReadV1> {
  signal?.throwIfAborted();
  let read = params.read();
  if (read.status !== 'ready' && (read.reason === 'loading' || read.reason === 'catalog-unobserved')) {
    await params.prepare?.(signal);
    signal?.throwIfAborted();
    read = params.read();
  }
  return read;
}

/** One live role resolver for the Session prompt plan, native ceilings and child snapshots. */
export function createSessionRoleContext(params: Readonly<{
  readMetadata: () => unknown;
  readOrganization: (signal?: AbortSignal) => Promise<Pick<V2SessionByIdResponse['session'], 'manager' | 'origin'>>;
  readRoleSources: RoleSourceReader;
  readAccountRoleOverrides: () => AccountRoleOverridesReadV1;
  prepareAccountRoleOverrides?: (signal?: AbortSignal) => Promise<void>;
  readOperationContext?: () => SavedSecretOperationContextV1 | undefined;
  readDefaultEngine?: () => RoleEngineV1;
  /** Existing Session-admitted Agent registry; selection policy stays with inventory. */
  readAgentCatalogSnapshot?: typeof import('@/agent/catalog/snapshot').readAgentCatalogSnapshot;
  /** Read from the same admitted native-selection owner as child execution. */
  readAppliedChildSelection?: () => import('@/agent/runtime/bridges/executionRun/runtime/openInputs').ExecutionRunAppliedParentSelection
    | Promise<import('@/agent/runtime/bridges/executionRun/runtime/openInputs').ExecutionRunAppliedParentSelection>;
}>) {
  let roleSourceInventory: Awaited<ReturnType<RoleSourceReader>> | undefined;
  let resolvedRoles: Readonly<{ status: 'ready' | 'partial'; roles: ResolvedRolesSnapshotV1; selectedRefusal?: RoleSelectionRefusalV1 }> = { status: 'partial', roles: {} };
  let preparing: Promise<void> | undefined;
  const prepare = async (signal?: AbortSignal, freshInventory = false) => {
    signal?.throwIfAborted();
    const sessionRoles = readSessionRolesV1(params.readMetadata());
    if (!freshInventory && sessionRoles?.roleId && sessionRoles.sessionRoles[sessionRoles.roleId]) return;
    if (!preparing) {
      preparing = (async () => { await params.prepareAccountRoleOverrides?.(signal); })();
    }
    const pending = preparing;
    try { await pending; }
    finally { if (preparing === pending) preparing = undefined; }
    signal?.throwIfAborted();
  };
  const readAccountOverrides = (signal?: AbortSignal) => readPreparedAccountRoleOverrides({
    read: params.readAccountRoleOverrides, prepare: signal => prepare(signal, true),
  }, signal);
  const resolveCurrentRoles = async (signal?: AbortSignal, complete = true, roleIds?: readonly string[], snapshotInputs?: Readonly<{
    defaultEngine: RoleEngineV1; availableAgentTargetKeys: readonly string[];
  }>) => {
    if (complete && !snapshotInputs) throw Object.assign(new Error('role_target_unavailable'), { code: 'role_target_unavailable' });
    await prepare(signal, complete);
    const source = await params.readRoleSources(signal, roleIds === undefined ? undefined : { roleIds }).catch((error: unknown) => {
      signal?.throwIfAborted();
      throw classifyHomeReadPreparationError(error);
    });
    signal?.throwIfAborted();
    if (complete && source.status !== 'ready') throw Object.assign(new Error('role_source_incomplete'), { code: 'role_source_incomplete' });
    const overrides = await readAccountOverrides(signal);
    if (overrides.status !== 'ready') throw Object.assign(new Error('role_overrides_unavailable'), {
      code: 'role_overrides_unavailable', reason: overrides.reason,
    });
    roleSourceInventory = source;
    const sessionRoles = readSessionRolesV1(params.readMetadata()) ?? undefined;
    const roles: ResolvedRolesSnapshotV1 = complete && snapshotInputs
      ? resolveRolesSnapshotV1({ roleSourceInventory: source, settingsOverrides: overrides.overrides, sessionRoles, ...snapshotInputs }) : {};
    let selectedRefusal: RoleSelectionRefusalV1 | undefined;
    if (!complete) for (const roleId of roleIds ?? new Set([...Object.keys(BUILT_IN_ROLES_V1), ...source.entries.map(entry => entry.roleId),
      ...(sessionRoles?.roleId ? [sessionRoles.roleId] : []),
      ...Object.keys(sessionRoles?.sessionRoles ?? {}), ...Object.keys(sessionRoles?.overrides ?? {})])) {
      const resolved = resolveRoleSelectionV1({ roleId, roleSourceInventory: source, sessionRoles,
        settingsOverrides: overrides.overrides,
        defaultEngine: params.readDefaultEngine?.(),
      });
      if (resolved.ok) roles[roleId] = resolved.selection;
      else if (roleId === sessionRoles?.roleId) selectedRefusal = resolved.refusal;
    }
    // A ready selected read proves its own Roles, never a complete child snapshot.
    resolvedRoles = { status: complete ? source.status : 'partial', roles, ...(selectedRefusal ? { selectedRefusal } : {}) };
    return resolvedRoles;
  };
  const resolveRoles = async (inputs: Readonly<{ defaultEngine: RoleEngineV1; availableAgentTargetKeys: readonly string[] }>,
    signal?: AbortSignal): Promise<ResolvedRolesSnapshotV1> => (await resolveCurrentRoles(signal, true, undefined, inputs)).roles;
  const resolvePromptContext = async (signal?: AbortSignal, options?: Readonly<{ modality?: 'coding' | 'voice' }>): Promise<SessionRolePromptContextV1 | null> => {
    const organization = await params.readOrganization(signal);
    signal?.throwIfAborted();
    const before = params.readMetadata();
    const beforeRoles = readSessionRolesV1(before);
    if (!beforeRoles?.roleId && !beforeRoles?.notes && !readSessionManagerSessionIdV1(organization)) return null;
    const inherited = beforeRoles?.roleId ? beforeRoles.sessionRoles[beforeRoles.roleId] : undefined;
    let roles: ResolvedRolesSnapshotV1;
    let selectedRefusal: RoleSelectionRefusalV1 | undefined;
    if (!beforeRoles?.roleId) {
      // Notes and worker boundaries do not consume the available Role inventory.
      roles = {};
    } else if (beforeRoles && inherited) {
      roles = {};
      for (const roleId of Object.keys(beforeRoles.sessionRoles)) {
        const resolved = resolveRoleSelectionV1({ roleId, sessionRoles: beforeRoles, defaultEngine: params.readDefaultEngine?.() });
        if (resolved.ok) roles[roleId] = resolved.selection;
      }
    } else {
      let current = await resolveCurrentRoles(signal, false, [beforeRoles.roleId]);
      if (current.roles[beforeRoles.roleId]?.canDelegateToOtherRoles === true) {
        current = await resolveCurrentRoles(signal, false);
      }
      roles = current.roles;
      selectedRefusal = current.selectedRefusal;
    }
    const metadata = params.readMetadata();
    const sessionRoles = readSessionRolesV1(metadata);
    const role = sessionRoles?.roleId ? roles[sessionRoles.roleId] : undefined;
    if (sessionRoles?.roleId && !role) {
      // A selection changed while its exact source was being read. Prepare the
      // current selection through this same owner rather than refusing it as missing.
      if (sessionRoles.roleId !== beforeRoles?.roleId) return resolvePromptContext(signal, options);
      const code = selectedRefusal?.code ?? 'role_target_unavailable';
      throw Object.assign(new Error(code), { code });
    }
    const leadSessionId = readSessionManagerSessionIdV1(organization);
    if (!role && !leadSessionId && !sessionRoles?.notes) return null;
    return {
      ...(role ? { role } : {}), availableRoles: Object.values(roles),
      ...(organization.origin ? { originKind: organization.origin.kind } : {}),
      ...(sessionRoles?.notes ? { notes: sessionRoles.notes } : {}),
      ...(leadSessionId ? { worker: { leadSessionId, taskBoundary: sessionRoles?.notes ?? '' } } : {}),
    };
  };
  return {
    resolvePromptContext, resolveRoles, prepare, readAccountOverrides,
    readRoleSources: params.readRoleSources,
    readOperationContext: params.readOperationContext,
    readAppliedChildSelection: params.readAppliedChildSelection,
    readAgentCatalogSnapshot: params.readAgentCatalogSnapshot,
    readResolvedRoles: () => {
      if (resolvedRoles.status !== 'ready' || params.readAccountRoleOverrides().status !== 'ready') {
        throw Object.assign(new Error('role_source_incomplete'), { code: 'role_source_incomplete' });
      }
      return resolvedRoles.roles;
    },
    readWorkspaceWrites: () => {
      const metadata = params.readMetadata();
      const sessionRoles = readSessionRolesV1(metadata);
      if (!sessionRoles?.roleId || sessionRoles.sessionRoles[sessionRoles.roleId]) return readSessionWorkspaceWritesV1(metadata);
      const overrides = params.readAccountRoleOverrides();
      return overrides.status === 'ready' ? readSessionWorkspaceWritesV1(metadata, {
        roleSourceInventory, settingsOverrides: overrides.overrides,
      }) : 'deny';
    },
  };
}

export type SessionRoleContext = ReturnType<typeof createSessionRoleContext>;
