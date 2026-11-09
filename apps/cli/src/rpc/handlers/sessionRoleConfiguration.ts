import { randomUUID } from 'node:crypto';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { SessionRolesConfigurationSetRpcV1Schema, readSessionRolesV1, writeSessionRoleConfigurationV1ToMetadata } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { readSessionWorkspaceWritesV1, resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
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
  readRoleSources: RoleSourceReader;
  prepareWorkspaceWritesPolicy?: RoleWorkspaceWritesPolicyPreparer;
  readSettingsOverrides?: (signal?: AbortSignal) => AccountRoleOverridesReadV1 | Promise<AccountRoleOverridesReadV1>;
  resolveAgentStartContext?: ActionExecutorDeps['resolveAgentStartContext'];
  sessionList?: ActionExecutorDeps['sessionList'];
  sessionRead?: ActionExecutorDeps['sessionRead'];
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
    let isCopyTargetCurrent: (() => Promise<boolean>) | undefined;
    if (context?.sessionActionOrigin) {
      const callerContext = buildActionExecutorContextForRpc({ sessionActionOrigin: context.sessionActionOrigin,
        callerInputAuthorization: context.callerInputAuthorization, callerAuthority: authority, signal: context.signal });
      const inheritedLead = request.configuration.inheritedFrom;
      const policy = SessionAgentSpawnPolicyV1StrictSchema.parse(callerContext.sessionAgentSpawnPolicyV1 ?? {});
      isCopyTargetCurrent = async () => {
        const currentLead = await params.readCurrentReportLead?.(context.signal);
        const resolved = await resolveActionAgentStartContextV1({
          resolveAgentStartContext: params.resolveAgentStartContext,
          ...(params.sessionList ? { sessionList: params.sessionList } : {}),
          ...(params.sessionRead ? { sessionRead: params.sessionRead } : {}),
        }, callerContext, inheritedLead ? [request.sessionId, inheritedLead] : request.sessionId, { purpose: 'session_scope' });
        return authority === 'account_automation' && !!inheritedLead && currentLead === inheritedLead
          && !!resolved && !('ok' in resolved) && admitAgentStartV1(policy, { kind: 'session_target', targetSessionId: request.sessionId }, resolved).ok
          && admitAgentStartV1(policy, { kind: 'session_target', targetSessionId: inheritedLead }, resolved).ok;
      };
      if (!await isCopyTargetCurrent()) {
        return { ok: false, errorCode: 'session_target_not_led', error: 'session_target_not_led' };
      }
      const currentWrites = await params.readCallerWorkspaceWrites?.(callerContext);
      if (!currentWrites) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      callerWrites = currentWrites === 'deny' || context.sessionActionOrigin?.workspaceWrites === 'deny' ? 'deny' : currentWrites;
    }
    const overridesRead = await params.readSettingsOverrides?.(context?.signal)
      ?? { status: 'unavailable' as const, reason: 'source-unavailable' };
    if (overridesRead.status !== 'ready') {
      return { ok: false, errorCode: 'account_role_overrides_unavailable', error: 'account_role_overrides_unavailable' };
    }
    const settingsOverrides = overridesRead.overrides;
    let roleSourceInventory: Awaited<ReturnType<RoleSourceReader>> | undefined;
    const readCandidate = async () => {
      const current = readSessionRolesV1(params.readSessionMetadata());
      const roleIds = authority === 'present_user' ? (current?.roleId ? [current.roleId] : [])
        : [...new Set([...Object.keys(request.configuration.overrides), ...Object.keys(request.configuration.sessionRoles),
          ...Object.keys(current?.overrides ?? {}), ...Object.keys(current?.sessionRoles ?? {}),
          ...(current?.roleId ? [current.roleId] : [])])];
      // A copied snapshot already carries complete inherited roles. Only policy
      // that still depends on an external source needs the Account inventory.
      if (!roleSourceInventory && roleIds.some(roleId => !Object.hasOwn(BUILT_IN_ROLES_V1, roleId)
        && (!current?.sessionRoles[roleId] || !request.configuration.sessionRoles[roleId]))) {
        roleSourceInventory = await params.readRoleSources(context?.signal);
      }
      const metadata = params.readSessionMetadata();
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return { ok: false, errorCode: 'session_target_unavailable', error: 'session_target_unavailable' } as const;
      }
      // Validate and enforce non-relaxation against the same current owner snapshot.
      const nextMetadata = writeSessionRoleConfigurationV1ToMetadata(metadata as Record<string, unknown>, request.configuration);
      if (authority !== 'present_user') {
        const current = readSessionRolesV1(metadata);
        if ((callerWrites === 'deny' || readSessionWorkspaceWritesV1(metadata, { roleSourceInventory, settingsOverrides }) === 'deny')
          && readSessionWorkspaceWritesV1(nextMetadata, { roleSourceInventory, settingsOverrides }) !== 'deny') {
          return { ok: false, errorCode: 'role_policy_denied', error: 'role_policy_denied' } as const;
        }
        const roleIds = new Set([...Object.keys(request.configuration.overrides), ...Object.keys(request.configuration.sessionRoles),
          ...Object.keys(current?.overrides ?? {}), ...Object.keys(current?.sessionRoles ?? {}),
          ...(current?.roleId ? [current.roleId] : [])]);
        for (const roleId of roleIds) {
          const before = resolveRoleSelectionV1({ roleId, roleSourceInventory, settingsOverrides, sessionRoles: current ?? undefined });
          const after = resolveRoleSelectionV1({ roleId, roleSourceInventory, settingsOverrides, sessionRoles: request.configuration });
          if (callerWrites === 'deny' && after.ok && after.selection.workspaceWrites === 'allow') {
            return { ok: false, errorCode: 'role_policy_denied', error: 'role_policy_denied' } as const;
          }
          if (before.ok && before.selection.workspaceWrites === 'deny' && (!after.ok || after.selection.workspaceWrites !== 'deny')) {
            return { ok: false, errorCode: 'role_policy_denied', error: 'role_policy_denied' } as const;
          }
        }
      }
      context?.signal.throwIfAborted();
      const workspaceWrites = readSessionWorkspaceWritesV1(nextMetadata, { roleSourceInventory, settingsOverrides });
      const previousWorkspaceWrites = readSessionWorkspaceWritesV1(metadata, { roleSourceInventory, settingsOverrides });
      return { ok: true, workspaceWrites, previousWorkspaceWrites } as const;
    };
    let candidate = await readCandidate();
    if (!candidate.ok) return candidate;
    let preparedDeny = false;
    // Never relax native policy until the registered metadata owner has accepted
    // the new configuration and the host synchronizes at prompt admission.
    if (candidate.workspaceWrites === 'deny' && candidate.previousWorkspaceWrites !== 'deny' && params.prepareWorkspaceWritesPolicy) {
      const prepared = await params.prepareWorkspaceWritesPolicy('deny', {
        authority, surface: context?.localActionContext?.surface ?? 'rpc', ...(context?.signal ? { signal: context.signal } : {}),
      });
      if (!prepared.ok) return { ok: false, errorCode: prepared.errorCode, error: prepared.errorCode };
      preparedDeny = true;
    } else if (candidate.workspaceWrites === 'deny' && candidate.previousWorkspaceWrites !== 'deny') {
      return { ok: false, errorCode: 'role_policy_unenforceable', error: 'role_policy_unenforceable' };
    }
    if (isCopyTargetCurrent && !await isCopyTargetCurrent()) {
      return { ok: false, errorCode: 'session_target_not_led', error: 'session_target_not_led' };
    }
    candidate = await readCandidate();
    if (!candidate.ok) return candidate;
    if (!preparedDeny && candidate.workspaceWrites === 'deny' && candidate.previousWorkspaceWrites !== 'deny') {
      if (!params.prepareWorkspaceWritesPolicy) {
        return { ok: false, errorCode: 'role_policy_unenforceable', error: 'role_policy_unenforceable' };
      }
      const prepared = await params.prepareWorkspaceWritesPolicy('deny', {
        authority, surface: context?.localActionContext?.surface ?? 'rpc', ...(context?.signal ? { signal: context.signal } : {}),
      });
      if (!prepared.ok) return { ok: false, errorCode: prepared.errorCode, error: prepared.errorCode };
      if (isCopyTargetCurrent && !await isCopyTargetCurrent()) {
        return { ok: false, errorCode: 'session_target_not_led', error: 'session_target_not_led' };
      }
      candidate = await readCandidate();
      if (!candidate.ok) return candidate;
    }
    await params.stageSessionStateMutation({ v: 1, sessionId: params.sessionId, mutationId: randomUUID(),
      fieldId: 'intent.sessionRoles', deliveryClass: 'durable_required', op: { kind: 'set', value: request.configuration },
      source: authority === 'present_user' ? 'ui' : 'runtime', observedAt: Date.now() });
    return { updated: true };
  });
}
