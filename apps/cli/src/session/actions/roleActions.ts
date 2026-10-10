import { randomUUID } from 'node:crypto';
import { createAccountRoleActionExecutorV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { RoleActionInputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { readSessionRolesV1, writeSessionRoleIdV1ToMetadata, writeSessionRoleConfigurationV1ToMetadata, SessionRoleConfigurationV1Schema, snapshotSessionRolesAtSpawnV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRoleSelectionV1, readSessionWorkspaceWritesV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { ActionExecutorDeps, PluginRoleContributionV1, SessionRoleConfigurationV1, ActionExecutorContext } from '@happier-dev/protocol';
import type { AccountRoleOverridesReadV1, RoleOverrideMutationV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createRoleSourceReader, type RoleSourceReader } from '@/session/roles/roleSources';
import type { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';

type RoleArtifactStore = Pick<ReturnType<typeof createAccountArtifactStore>,
  'read' | 'list' | 'create' | 'update' | 'delete' | 'accessGrants'>;
export type RoleWorkspaceWritesPolicyPreparer = (
  workspaceWrites: 'allow' | 'deny', context: ActionExecutorContext,
) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; errorCode: string }>>;

function refuse(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/** Artifact and outbox ports are genuine storage boundaries; role resolution remains canonical. */
export function createRoleActionExecutor(params: Readonly<{
  sessionId: string;
  readSessionMetadata?: () => unknown;
  stageSessionStateMutation?: (mutation: RegisteredSessionStateFieldMutationV1) => Promise<void>;
  artifactStore?: RoleArtifactStore;
  readSettingsOverrides?: () => AccountRoleOverridesReadV1 | Promise<AccountRoleOverridesReadV1>;
  readPluginRoles?: () => readonly PluginRoleContributionV1[];
  accountId?: string;
  readRawAccountSettings?: () => Promise<Readonly<Record<string, unknown>>>;
  mutateAccountRoleOverrides?: (mutation: RoleOverrideMutationV1, context: ActionExecutorContext) => Promise<void>;
  readRoleSources?: RoleSourceReader;
  listReportSessions?: (leadSessionId: string, context: import('@happier-dev/protocol').ActionExecutorContext) => Promise<readonly Readonly<{ sessionId: string; ownerAccountId: string }>[]>;
  writeReportSessionRoles?: (sessionId: string, configuration: SessionRoleConfigurationV1, context: import('@happier-dev/protocol').ActionExecutorContext) => Promise<void>;
  forwardSessionRoleAction?: NonNullable<ActionExecutorDeps['roleActionExecute']>;
  prepareWorkspaceWritesPolicy?: RoleWorkspaceWritesPolicyPreparer;
}>): NonNullable<ActionExecutorDeps['roleActionExecute']> {
  const listEntries = params.readRoleSources ?? createRoleSourceReader(params);
  const accountScope = getActiveAccountSettingsSnapshot()?.scopeKey;
  const readOverrides = params.readSettingsOverrides ?? (accountScope
    ? createActionSettingsProvider({ scopeKey: accountScope }).getAccountRoleOverrides
    : () => ({ status: 'unavailable' as const, reason: 'source-unavailable' }));
  const readSettingsOverrides = async () => {
    const read = await readOverrides();
    if (read.status !== 'ready') refuse('account_role_overrides_unavailable');
    return read.overrides;
  };
  const accountActions = createAccountRoleActionExecutorV1({ ...params, readRoleSources: listEntries, generateId: randomUUID });
  return async ({ actionId, input, context }) => {
    context.signal?.throwIfAborted();
    const parsedInput = RoleActionInputSchemasV1[actionId].parse(input);
    if ('sessionId' in parsedInput && parsedInput.sessionId !== params.sessionId) {
      if (!params.forwardSessionRoleAction) refuse('session_target_unavailable');
      return await params.forwardSessionRoleAction({ actionId, input: parsedInput, context });
    }
    if (actionId.startsWith('roles.')) return await accountActions({ actionId, input: parsedInput, context });
    if (actionId === 'session.roles.apply_to_reports') {
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      if (request.sessionId !== params.sessionId || !params.accountId || !params.readSessionMetadata
        || !params.listReportSessions || !params.writeReportSessionRoles) refuse('session_target_unavailable');
      const metadata = params.readSessionMetadata();
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) refuse('session_target_unavailable');
      // Validate authoritative owner data even when there is no existing role selection.
      writeSessionRoleIdV1ToMetadata(metadata as Record<string, unknown>, readSessionRolesV1(metadata)?.roleId ?? null);
      const current = readSessionRolesV1(metadata) ?? undefined;
      const inventory = await listEntries(context.signal);
      if (inventory.status !== 'ready') refuse('role_source_incomplete');
      const entries = inventory.entries;
      const settingsOverrides = await readSettingsOverrides();
      const roles = Object.fromEntries([...new Set([...entries.map((entry) => entry.roleId), ...Object.keys(current?.sessionRoles ?? {}),
        ...Object.keys(current?.overrides ?? {})])].flatMap((roleId) => {
        const resolved = resolveRoleSelectionV1({ roleId, roleSourceInventory: inventory, settingsOverrides,
          sessionRoles: current, pluginRoles: params.readPluginRoles?.() });
        return resolved.ok ? [[roleId, resolved.selection]] : [];
      }));
      const configuration = SessionRoleConfigurationV1Schema.parse(snapshotSessionRolesAtSpawnV1({
        leadSessionId: request.sessionId, roles, notes: current?.notes,
      }));
      const updatedSessionIds: string[] = [];
      for (const report of await params.listReportSessions(request.sessionId, context)) {
        if (report.ownerAccountId !== params.accountId || report.sessionId === request.sessionId) continue;
        context.signal?.throwIfAborted();
        await params.writeReportSessionRoles(report.sessionId, configuration, context);
        updatedSessionIds.push(report.sessionId);
      }
      return { updatedSessionIds };
    }
    if (actionId === 'session.role.set') {
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      if (request.sessionId !== params.sessionId) refuse('session_target_unavailable');
      if (!params.stageSessionStateMutation || !params.readSessionMetadata) refuse('session_target_unavailable');
      const inventory = await listEntries(context.signal);
      const metadata = params.readSessionMetadata();
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) refuse('session_target_unavailable');
      writeSessionRoleIdV1ToMetadata(metadata as Record<string, unknown>, request.roleId);
      const snapshot = readSessionRolesV1(metadata) ?? undefined;
      const settingsOverrides = await readSettingsOverrides();
      const resolve = (roleId: string) => resolveRoleSelectionV1({ roleId, roleSourceInventory: inventory,
        settingsOverrides, sessionRoles: snapshot, pluginRoles: params.readPluginRoles?.() });
      const selection = resolve(request.roleId);
      if (!selection.ok) refuse(selection.refusal.code);
      if (context.authority !== 'present_user') {
        const current = snapshot?.roleId ? resolve(snapshot.roleId) : null;
        // A role change cannot clear the target's hands-off or exceed the caller's ceiling.
        if (selection.selection.workspaceWrites === 'allow'
          && (context.workspaceWrites === 'deny' || (current?.ok && current.selection.workspaceWrites === 'deny'))) refuse('role_policy_denied');
      }
      context.signal?.throwIfAborted();
      const previousWorkspaceWrites = readSessionWorkspaceWritesV1(metadata, { roleSourceInventory: inventory, settingsOverrides });
      // Relaxation is synchronized from accepted owner metadata, never before enqueue.
      if (selection.selection.workspaceWrites === 'deny' && previousWorkspaceWrites !== 'deny' && params.prepareWorkspaceWritesPolicy) {
        const prepared = await params.prepareWorkspaceWritesPolicy(selection.selection.workspaceWrites, context);
        if (!prepared.ok) refuse(prepared.errorCode);
      } else if (selection.selection.workspaceWrites === 'deny' && previousWorkspaceWrites !== 'deny') refuse('role_policy_unenforceable');
      await params.stageSessionStateMutation({ v: 1, sessionId: request.sessionId, mutationId: randomUUID(),
        fieldId: 'intent.role', deliveryClass: 'durable_required', op: { kind: 'set', value: request.roleId },
        source: context.authority === 'present_user' ? 'ui' : 'runtime', observedAt: Date.now() });
      return { updated: true };
    }
    if (actionId === 'session.roles.override.set' || actionId === 'session.roles.override.clear'
      || actionId === 'session.roles.add' || actionId === 'session.roles.remove' || actionId === 'session.notes.set') {
      if (!params.stageSessionStateMutation || !params.readSessionMetadata) refuse('session_target_unavailable');
      const request = RoleActionInputSchemasV1[actionId].parse(input);
      if (request.sessionId !== params.sessionId) refuse('session_target_unavailable');
      const metadata = params.readSessionMetadata();
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) refuse('session_target_unavailable');
      const current = readSessionRolesV1(metadata) ?? { overrides: {}, sessionRoles: {}, notes: '' };
      let configuration = SessionRoleConfigurationV1Schema.parse({
        overrides: current.overrides, sessionRoles: current.sessionRoles, notes: current.notes,
        ...(current.inheritedFrom ? { inheritedFrom: current.inheritedFrom } : {}),
      });
      switch (actionId) {
        case 'session.notes.set': {
          const request = RoleActionInputSchemasV1[actionId].parse(input);
          configuration.notes = request.notes;
          break;
        }
        case 'session.roles.override.set': {
          const { sessionId: _sessionId, ...override } = RoleActionInputSchemasV1[actionId].parse(input);
          configuration.overrides[override.roleId] = { ...configuration.overrides[override.roleId], ...override };
          break;
        }
        case 'session.roles.override.clear': {
          const request = RoleActionInputSchemasV1[actionId].parse(input);
          delete configuration.overrides[request.roleId];
          break;
        }
        case 'session.roles.add': {
          const request = RoleActionInputSchemasV1[actionId].parse(input);
          configuration.sessionRoles[request.roleId] = { ...request.role, roleId: request.roleId };
          break;
        }
        case 'session.roles.remove': {
          const request = RoleActionInputSchemasV1[actionId].parse(input);
          delete configuration.sessionRoles[request.roleId];
          break;
        }
      }
      if (context.authority !== 'present_user' && 'roleId' in request) {
        const inventory = await listEntries(context.signal);
        const settingsOverrides = await readSettingsOverrides();
        const before = resolveRoleSelectionV1({ roleId: request.roleId, roleSourceInventory: inventory, settingsOverrides, sessionRoles: current });
        const after = resolveRoleSelectionV1({ roleId: request.roleId, roleSourceInventory: inventory, settingsOverrides, sessionRoles: configuration });
        if (after.ok && after.selection.workspaceWrites === 'allow'
          && (context.workspaceWrites === 'deny' || (before.ok && before.selection.workspaceWrites === 'deny'))) refuse('role_policy_denied');
        if (before.ok && before.selection.workspaceWrites === 'deny' && !after.ok) refuse('role_policy_denied');
      }
      configuration = SessionRoleConfigurationV1Schema.parse(configuration);
      // Reject malformed authoritative data before acknowledging a queued edit, not only at replay.
      const nextMetadata = writeSessionRoleConfigurationV1ToMetadata(metadata as Record<string, unknown>, configuration);
      const inventory = await listEntries(context.signal);
      const layers = {
        roleSourceInventory: inventory,
        settingsOverrides: await readSettingsOverrides(),
      };
      const workspaceWrites = readSessionWorkspaceWritesV1(nextMetadata, layers);
      const previousWorkspaceWrites = readSessionWorkspaceWritesV1(metadata, layers);
      context.signal?.throwIfAborted();
      // Tightening is safe before enqueue; relaxation waits for the durable owner
      // value to be observed by the host at its next prompt admission.
      if (workspaceWrites === 'deny' && previousWorkspaceWrites !== 'deny' && params.prepareWorkspaceWritesPolicy) {
        const prepared = await params.prepareWorkspaceWritesPolicy(workspaceWrites, context);
        if (!prepared.ok) refuse(prepared.errorCode);
      } else if (workspaceWrites === 'deny' && previousWorkspaceWrites !== 'deny') refuse('role_policy_unenforceable');
      await params.stageSessionStateMutation({ v: 1, sessionId: request.sessionId, mutationId: randomUUID(),
        fieldId: 'intent.sessionRoles', deliveryClass: 'durable_required', op: { kind: 'set', value: configuration },
        source: context.authority === 'present_user' ? 'ui' : 'runtime', observedAt: Date.now() });
      return { updated: true };
    }
    return refuse('unsupported_action');
  };
}
