import { randomUUID } from 'node:crypto';
import { SessionRolesConfigurationSetRpcV1Schema, readSessionRolesV1, writeSessionRoleConfigurationV1ToMetadata } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { readSessionWorkspaceWritesV1, resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { RoleInstructionsOverrideV1, ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { resolveActionAgentStartContextV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { admitAgentStartV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { SessionAgentSpawnPolicyV1StrictSchema } from '@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type { RoleSourceReader } from '@/session/roles/roleSources';
import type { RoleWorkspaceWritesPolicyPreparer } from '@/session/actions/roleActions';
import { buildActionExecutorContextForRpc } from './_actionDispatchAdapter';

/** Remote role copies enter the same registered configuration outbox as local edits. */
export function registerSessionRoleConfigurationHandler(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  sessionId: string;
  readSessionMetadata: () => unknown;
  stageSessionStateMutation?: (mutation: RegisteredSessionStateFieldMutationV1) => Promise<void>;
  readRoleSources?: RoleSourceReader;
  prepareWorkspaceWritesPolicy?: RoleWorkspaceWritesPolicyPreparer;
  readSettingsOverrides?: () => Readonly<Record<string, RoleInstructionsOverrideV1>> | Promise<Readonly<Record<string, RoleInstructionsOverrideV1>>>;
  resolveAgentStartContext?: ActionExecutorDeps['resolveAgentStartContext'];
  sessionList?: ActionExecutorDeps['sessionList'];
  /** Current Home relation, not the copied configuration's descriptive inheritedFrom field. */
  readCurrentReportLead?: (signal: AbortSignal) => Promise<string | null>;
  readCallerWorkspaceWrites?: (context: ActionExecutorContext) => Promise<'allow' | 'deny' | null>;
}>): void {
  params.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET, async (input: unknown, context) => {
    const request = SessionRolesConfigurationSetRpcV1Schema.parse(input);
    if (request.sessionId !== params.sessionId || !params.stageSessionStateMutation) {
      return { ok: false, errorCode: 'session_target_unavailable', error: 'session_target_unavailable' };
    }
    const authority = context?.callerAuthority ?? context?.localActionContext?.authority;
    if (!authority) return { ok: false, errorCode: 'permission_denied', error: 'permission_denied' };
    if (authority !== 'present_user' && !context?.sessionActionOrigin && !context?.localActionContext) {
      return { ok: false, errorCode: 'role_rpc_origin_unavailable', error: 'role_rpc_origin_unavailable' };
    }
    context?.signal.throwIfAborted();
    let callerWrites = context?.localActionContext?.agentStartWorkspaceWrites;
    if (context?.sessionActionOrigin) {
      const callerContext = buildActionExecutorContextForRpc({ sessionActionOrigin: context.sessionActionOrigin,
        callerAuthority: authority, signal: context.signal });
      const inheritedLead = request.configuration.inheritedFrom;
      const currentLead = await params.readCurrentReportLead?.(context.signal);
      const resolved = await resolveActionAgentStartContextV1({
        resolveAgentStartContext: params.resolveAgentStartContext,
        ...(params.sessionList ? { sessionList: params.sessionList } : {}),
      }, callerContext, request.sessionId);
      const policy = SessionAgentSpawnPolicyV1StrictSchema.parse(callerContext.sessionAgentSpawnPolicyV1 ?? {});
      if (authority !== 'account_automation' || !inheritedLead || currentLead !== inheritedLead
        || !resolved || !admitAgentStartV1(policy, { kind: 'session_target', targetSessionId: request.sessionId }, resolved).ok
        || !admitAgentStartV1(policy, { kind: 'session_target', targetSessionId: inheritedLead }, resolved).ok) {
        return { ok: false, errorCode: 'session_target_not_led', error: 'session_target_not_led' };
      }
      const currentWrites = await params.readCallerWorkspaceWrites?.(callerContext);
      if (!currentWrites) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      callerWrites = currentWrites === 'deny' || context.sessionActionOrigin.workspaceWrites === 'deny' ? 'deny' : currentWrites;
    }
    const metadata = params.readSessionMetadata();
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return { ok: false, errorCode: 'session_target_unavailable', error: 'session_target_unavailable' };
    }
    // The metadata owner validates both the existing shape and the replacement before enqueue.
    const nextMetadata = writeSessionRoleConfigurationV1ToMetadata(metadata as Record<string, unknown>, request.configuration);
    const entries = await params.readRoleSources?.(context?.signal) ?? [];
    const settingsRoles = Object.fromEntries(entries.map((entry) => [entry.roleId, entry.role]));
    const settingsOverrides = await params.readSettingsOverrides?.();
    if (authority !== 'present_user') {
      const current = readSessionRolesV1(metadata);
      if ((callerWrites === 'deny' || readSessionWorkspaceWritesV1(metadata, { settingsRoles, settingsOverrides }) === 'deny')
        && readSessionWorkspaceWritesV1(nextMetadata, { settingsRoles, settingsOverrides }) !== 'deny') {
        return { ok: false, errorCode: 'role_policy_denied', error: 'role_policy_denied' };
      }
      const roleIds = new Set([...Object.keys(request.configuration.overrides), ...Object.keys(request.configuration.sessionRoles),
        ...Object.keys(current?.overrides ?? {}), ...Object.keys(current?.sessionRoles ?? {}),
        ...(current?.roleId ? [current.roleId] : [])]);
      for (const roleId of roleIds) {
        const before = resolveRoleSelectionV1({ roleId, settingsRoles, settingsOverrides, sessionRoles: current ?? undefined });
        const after = resolveRoleSelectionV1({ roleId, settingsRoles, settingsOverrides, sessionRoles: request.configuration });
        if (callerWrites === 'deny' && after.ok && after.selection.workspaceWrites === 'allow') {
          return { ok: false, errorCode: 'role_policy_denied', error: 'role_policy_denied' };
        }
        if (before.ok && before.selection.workspaceWrites === 'deny' && (!after.ok || after.selection.workspaceWrites !== 'deny')) {
          return { ok: false, errorCode: 'role_policy_denied', error: 'role_policy_denied' };
        }
      }
    }
    context?.signal.throwIfAborted();
    const workspaceWrites = readSessionWorkspaceWritesV1(nextMetadata, { settingsRoles, settingsOverrides });
    const previousWorkspaceWrites = readSessionWorkspaceWritesV1(metadata, { settingsRoles, settingsOverrides });
    // Never relax native policy until the registered metadata owner has accepted
    // the new configuration and the host synchronizes at prompt admission.
    if (workspaceWrites === 'deny' && previousWorkspaceWrites !== 'deny' && params.prepareWorkspaceWritesPolicy) {
      const prepared = await params.prepareWorkspaceWritesPolicy(workspaceWrites, {
        authority, surface: context?.localActionContext?.surface ?? 'rpc', ...(context?.signal ? { signal: context.signal } : {}),
      });
      if (!prepared.ok) return { ok: false, errorCode: prepared.errorCode, error: prepared.errorCode };
    } else if (workspaceWrites === 'deny' && previousWorkspaceWrites !== 'deny') {
      return { ok: false, errorCode: 'role_policy_unenforceable', error: 'role_policy_unenforceable' };
    }
    await params.stageSessionStateMutation({ v: 1, sessionId: params.sessionId, mutationId: randomUUID(),
      fieldId: 'intent.sessionRoles', deliveryClass: 'durable_required', op: { kind: 'set', value: request.configuration },
      source: authority === 'present_user' ? 'ui' : 'runtime', observedAt: Date.now() });
    return { updated: true };
  });
}
