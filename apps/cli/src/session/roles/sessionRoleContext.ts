import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { readSessionWorkspaceWritesV1, resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { RoleEngineV1, ResolvedRolesSnapshotV1, SessionRolePromptContextV1, V2SessionByIdResponse } from '@happier-dev/protocol';
import type { RoleSelectionRefusalV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import type { RoleSourceReader } from './roleSources';

/** One live role resolver for the Session prompt plan, native ceilings and child snapshots. */
export function createSessionRoleContext(params: Readonly<{
  readMetadata: () => unknown;
  readOrganization: (signal?: AbortSignal) => Promise<Pick<V2SessionByIdResponse['session'], 'reportsTo' | 'origin'>>;
  readRoleSources: RoleSourceReader;
  readAccountRoleOverrides: () => AccountRoleOverridesReadV1;
  prepareAccountRoleOverrides?: (signal?: AbortSignal) => Promise<void>;
  readDefaultEngine?: () => RoleEngineV1;
}>) {
  let roleSourceInventory: Awaited<ReturnType<RoleSourceReader>> | undefined;
  let resolvedRoles: Readonly<{ status: 'ready' | 'partial'; roles: ResolvedRolesSnapshotV1; selectedRefusal?: RoleSelectionRefusalV1 }> = { status: 'partial', roles: {} };
  const prepare = async (signal?: AbortSignal, freshInventory = false) => {
    signal?.throwIfAborted();
    const sessionRoles = readSessionRolesV1(params.readMetadata());
    if (!freshInventory && sessionRoles?.roleId && sessionRoles.sessionRoles[sessionRoles.roleId]) return;
    await params.prepareAccountRoleOverrides?.(signal);
    signal?.throwIfAborted();
  };
  const resolveCurrentRoles = async (signal?: AbortSignal, complete = true) => {
    await prepare(signal, complete);
    const source = await params.readRoleSources(signal);
    signal?.throwIfAborted();
    if (complete && source.status !== 'ready') throw Object.assign(new Error('role_source_incomplete'), { code: 'role_source_incomplete' });
    const overrides = params.readAccountRoleOverrides();
    if (overrides.status !== 'ready') throw Object.assign(new Error('role_overrides_unavailable'), {
      code: 'role_overrides_unavailable', reason: overrides.reason,
    });
    roleSourceInventory = source;
    const sessionRoles = readSessionRolesV1(params.readMetadata()) ?? undefined;
    const roles: ResolvedRolesSnapshotV1 = {};
    let selectedRefusal: RoleSelectionRefusalV1 | undefined;
    for (const roleId of new Set([...Object.keys(BUILT_IN_ROLES_V1), ...source.entries.map(entry => entry.roleId),
      ...(sessionRoles?.roleId ? [sessionRoles.roleId] : []),
      ...Object.keys(sessionRoles?.sessionRoles ?? {}), ...Object.keys(sessionRoles?.overrides ?? {})])) {
      const resolved = resolveRoleSelectionV1({ roleId, roleSourceInventory: source, sessionRoles,
        settingsOverrides: overrides.overrides,
        defaultEngine: params.readDefaultEngine?.(),
      });
      if (resolved.ok) roles[roleId] = resolved.selection;
      else if (roleId === sessionRoles?.roleId) selectedRefusal = resolved.refusal;
    }
    resolvedRoles = { status: source.status, roles, ...(selectedRefusal ? { selectedRefusal } : {}) };
    return resolvedRoles;
  };
  const resolveRoles = async (signal?: AbortSignal): Promise<ResolvedRolesSnapshotV1> => (await resolveCurrentRoles(signal)).roles;
  const resolvePromptContext = async (signal?: AbortSignal, options?: Readonly<{ modality?: 'coding' | 'voice' }>): Promise<SessionRolePromptContextV1 | null> => {
    const organization = await params.readOrganization(signal);
    signal?.throwIfAborted();
    const before = params.readMetadata();
    const beforeRoles = readSessionRolesV1(before);
    if (!beforeRoles?.roleId && !beforeRoles?.notes && !organization.reportsTo) return null;
    const inherited = beforeRoles?.roleId ? beforeRoles.sessionRoles[beforeRoles.roleId] : undefined;
    let roles: ResolvedRolesSnapshotV1;
    let selectedRefusal: RoleSelectionRefusalV1 | undefined;
    if (options?.modality === 'voice' && !beforeRoles?.roleId) {
      // Voice renders Notes, not the coding-only available Role inventory.
      roles = {};
    } else if (inherited) {
      roles = {};
      for (const roleId of Object.keys(beforeRoles!.sessionRoles)) {
        const resolved = resolveRoleSelectionV1({ roleId, sessionRoles: beforeRoles, defaultEngine: params.readDefaultEngine?.() });
        if (resolved.ok) roles[roleId] = resolved.selection;
      }
    } else {
      const current = await resolveCurrentRoles(signal, false);
      roles = current.roles;
      selectedRefusal = current.selectedRefusal;
    }
    const metadata = params.readMetadata();
    const sessionRoles = readSessionRolesV1(metadata);
    const role = sessionRoles?.roleId ? roles[sessionRoles.roleId] : undefined;
    if (sessionRoles?.roleId && !role) {
      const code = selectedRefusal?.code ?? 'role_target_unavailable';
      throw Object.assign(new Error(code), { code });
    }
    const leadSessionId = organization.reportsTo?.sessionId;
    if (!role && !leadSessionId && !sessionRoles?.notes) return null;
    return {
      ...(role ? { role } : {}), availableRoles: Object.values(roles),
      ...(organization.origin ? { originKind: organization.origin.kind } : {}),
      ...(sessionRoles?.notes ? { notes: sessionRoles.notes } : {}),
      ...(leadSessionId ? { worker: { leadSessionId, taskBoundary: sessionRoles?.notes ?? '' } } : {}),
    };
  };
  return {
    resolvePromptContext, resolveRoles, prepare,
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
