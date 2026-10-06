import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { readSessionWorkspaceWritesV1, resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { AccountSettings, RoleEngineV1, RoleArtifactV1, ResolvedRolesSnapshotV1, SessionRolePromptContextV1, V2SessionByIdResponse } from '@happier-dev/protocol';
import type { RoleSourceReader } from './roleSources';

/** One live role resolver for the Session prompt plan, native ceilings and child snapshots. */
export function createSessionRoleContext(params: Readonly<{
  readMetadata: () => unknown;
  readOrganization: (signal?: AbortSignal) => Promise<Pick<V2SessionByIdResponse['session'], 'reportsTo' | 'origin'>>;
  readRoleSources: RoleSourceReader;
  readSettings: () => AccountSettings | null;
  readDefaultEngine: () => RoleEngineV1;
}>) {
  let settingsRoles: Record<string, RoleArtifactV1> = {};
  let resolvedRoles: ResolvedRolesSnapshotV1 = {};
  const resolveRoles = async (signal?: AbortSignal): Promise<ResolvedRolesSnapshotV1> => {
    signal?.throwIfAborted();
    const entries = await params.readRoleSources(signal);
    signal?.throwIfAborted();
    settingsRoles = Object.fromEntries(entries.map((entry) => [entry.roleId, entry.role]));
    const sessionRoles = readSessionRolesV1(params.readMetadata()) ?? undefined;
    const roles: ResolvedRolesSnapshotV1 = {};
    for (const roleId of new Set([...Object.keys(BUILT_IN_ROLES_V1), ...Object.keys(settingsRoles),
      ...Object.keys(sessionRoles?.sessionRoles ?? {}), ...Object.keys(sessionRoles?.overrides ?? {})])) {
      const resolved = resolveRoleSelectionV1({ roleId, settingsRoles, sessionRoles,
        settingsOverrides: params.readSettings()?.rolesV1.overrides,
        defaultEngine: params.readDefaultEngine(),
      });
      if (resolved.ok) roles[roleId] = resolved.selection;
    }
    resolvedRoles = roles;
    return roles;
  };
  const resolvePromptContext = async (signal?: AbortSignal): Promise<SessionRolePromptContextV1 | null> => {
    const organization = await params.readOrganization(signal);
    signal?.throwIfAborted();
    const before = params.readMetadata();
    const beforeRoles = readSessionRolesV1(before);
    if (!beforeRoles?.roleId && !beforeRoles?.notes && !organization.reportsTo) return null;
    const roles = await resolveRoles(signal);
    const metadata = params.readMetadata();
    const sessionRoles = readSessionRolesV1(metadata);
    const role = sessionRoles?.roleId ? roles[sessionRoles.roleId] : undefined;
    if (sessionRoles?.roleId && !role) throw Object.assign(new Error('role_target_unavailable'), { code: 'role_target_unavailable' });
    const leadSessionId = organization.reportsTo?.sessionId;
    if (!role && !leadSessionId && !sessionRoles?.notes) return null;
    return {
      ...(role ? { role } : {}), availableRoles: Object.values(roles),
      ...(organization.origin ? { originKind: organization.origin.kind } : {}),
      ...(sessionRoles?.notes ? { notes: sessionRoles.notes } : {}),
      ...(leadSessionId ? { worker: { leadSessionId, taskBoundary: sessionRoles?.notes ?? '',
        ...(sessionRoles?.memoryDocRef ? { memoryDocRef: sessionRoles.memoryDocRef } : {}) } } : {}),
    };
  };
  return {
    resolvePromptContext, resolveRoles,
    readResolvedRoles: () => resolvedRoles,
    readWorkspaceWrites: () => readSessionWorkspaceWritesV1(params.readMetadata(), {
      settingsRoles, settingsOverrides: params.readSettings()?.rolesV1.overrides,
    }),
  };
}
